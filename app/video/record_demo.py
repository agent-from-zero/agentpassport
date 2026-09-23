"""Records the demo: a real hire of agentfromzero through the live dashboard on Monad testnet.

    HIRER_PRIVATE_KEY=0x...  WORKER_LOG=path/to/worker.log  python record_demo.py [--out build/demo]

Needs: the worker running (it must deliver the job), a hirer key holding test MON + >= 0.25 USDC,
the dashboard test wallet bundle (`cd ../dashboard && node scripts/build.mjs --test-wallet`),
`pip install playwright edge-tts` and `playwright install chromium`.

It opens a fresh headless Chromium context (1280x720, video recording on), injects the test wallet
(EIP-6963, auto-approves, shows a banner for every signature), and drives the dashboard scene by
scene, holding each scene as long as its narration. The worker's log is shown by a local page
that tails WORKER_LOG. Output: one .webm per page plus timeline.json (scene cut points + values
from the run such as the job id and tx hashes) for edit_demo.py.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import Page, async_playwright

import lib
from demo_script import DASHBOARD, SCENES, narration

HERE = Path(__file__).resolve().parent
WALLET_JS = HERE.parent / "dashboard" / ".test-build" / "test-wallet.js"
LOG_PORT = 8799

CURSOR_JS = """
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.setAttribute('style', 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
    'background:rgba(255,255,255,.25);border:2px solid #fff;z-index:2147483647;pointer-events:none;transition:transform .12s;' +
    'box-shadow:0 0 0 1px rgba(0,0,0,.4)');
  document.body.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; c.style.background = 'rgba(143,123,255,.7)'; }, true);
  addEventListener('mouseup', () => { c.style.transform = ''; c.style.background = 'rgba(255,255,255,.25)'; }, true);
});
"""


def serve_log(path: Path) -> ThreadingHTTPServer:
    html = (HERE / "worker-log.html").read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            u = urlparse(self.path)
            if u.path == "/":
                body, ctype = html, "text/html; charset=utf-8"
            elif u.path == "/log":
                since = int(parse_qs(u.query).get("since", ["0"])[0])
                data = path.read_bytes()[since:] if path.exists() else b""
                complete = data[: data.rfind(b"\n") + 1]
                lines = [ln for ln in complete.decode("utf8", "replace").splitlines() if ln.strip()]
                body = json.dumps({"file": f"worker-run/{path.name}", "lines": lines, "next": since + len(complete)}).encode()
                ctype = "application/json"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("content-type", ctype)
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", LOG_PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


async def glide_click(page: Page, selector: str) -> None:
    box = await page.locator(selector).first.bounding_box()
    if not box:
        raise RuntimeError(f"not visible: {selector}")
    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=25)
    await page.wait_for_timeout(250)
    await page.mouse.down()
    await page.wait_for_timeout(90)
    await page.mouse.up()


async def scroll_to(page: Page, selector: str, block: str = "start") -> None:
    await page.evaluate("([s, b]) => document.querySelector(s).scrollIntoView({behavior: 'smooth', block: b})", [selector, block])
    await page.wait_for_timeout(1300)


async def type_into(page: Page, selector: str, text: str) -> None:
    await glide_click(page, selector)
    await page.keyboard.press("Control+A")
    await page.keyboard.type(text, delay=110)


async def wait_text(page: Page, selector: str, pattern: str, timeout: float) -> str:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        txt = await page.inner_text(selector)
        if re.search(pattern, txt):
            return txt
        await asyncio.sleep(0.5)
    raise TimeoutError(f"{selector} never matched /{pattern}/")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build" / "demo"))
    ap.add_argument("--url", default=DASHBOARD)
    ap.add_argument("--amount", default="0.25")
    args = ap.parse_args()
    key = os.environ["HIRER_PRIVATE_KEY"]
    worker_log = Path(os.environ["WORKER_LOG"])
    out = Path(args.out)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    (out / "audio").mkdir(parents=True, exist_ok=True)

    # Scene lengths come from the narration (placeholder values; the editor re-voices with real ones).
    dur = {s["id"]: lib.tts(narration(s), out / "audio" / f"pre_{s['id']}.mp3") + 0.8 for s in SCENES}
    print("scene lengths:", {k: round(v, 1) for k, v in dur.items()})

    log_offset = worker_log.stat().st_size if worker_log.exists() else 0
    srv = serve_log(worker_log)
    marks: list[dict] = []
    values: dict = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": lib.W, "height": lib.H}, device_scale_factor=1,
            record_video_dir=str(out / "raw"), record_video_size={"width": lib.W, "height": lib.H},
        )
        await ctx.add_init_script(CURSOR_JS)
        await ctx.add_init_script(
            "window.__AP_TEST_WALLET__ = " + json.dumps({"privateKey": key, "name": "Demo test wallet (recording script)"}) + ";\n"
            + WALLET_JS.read_text(encoding="utf8")
        )
        pages: dict[str, dict] = {}

        async def open_page(name: str, url: str) -> Page:
            pg = await ctx.new_page()
            pages[name] = {"page": pg, "t0": time.monotonic()}
            await pg.goto(url)
            return pg

        def mark(scene: str, page: str, start: float, end: float) -> None:
            t0 = pages[page]["t0"]
            marks.append({"id": scene, "page": page, "start": round(start - t0, 3), "end": round(end - t0, 3)})
            print(f"scene {scene}: {end - start:.1f}s")

        async def hold(start: float, scene: str) -> None:
            left = start + dur[scene] - time.monotonic()
            if left > 0:
                await asyncio.sleep(left)

        dash = await open_page("dashboard", args.url)
        await dash.wait_for_selector("#agent .verdict", timeout=60000)
        await dash.wait_for_selector("#jobs tbody tr td .status", timeout=60000)
        await dash.mouse.move(640, 360)
        await dash.wait_for_timeout(2500)
        before = (await dash.inner_text("#agent .stats .stat b")).strip()
        values["before"] = before

        # 1. intro
        t = time.monotonic()
        await dash.mouse.move(980, 240, steps=40)
        await hold(t, "intro")
        mark("intro", "dashboard", t, time.monotonic())

        # 2. lookup
        t = time.monotonic()
        await scroll_to(dash, "#lookup-section")
        await type_into(dash, "#agentId", "1908")
        await glide_click(dash, "#lookup button[type=submit]")
        await dash.wait_for_timeout(600)
        await dash.wait_for_selector("#agent .verdict")
        await dash.mouse.move(250, 420, steps=30)
        await asyncio.sleep(max(0.0, t + dur["lookup"] * 0.62 - time.monotonic()))
        await glide_click(dash, "#policy")
        await dash.select_option("#policy", "active")
        await wait_text(dash, "#agent", r"does not meet active", 20)
        await hold(t, "lookup")
        mark("lookup", "dashboard", t, time.monotonic())

        # 3. trust index
        t = time.monotonic()
        await dash.select_option("#policy", "proven")
        await scroll_to(dash, "#index-section")
        await dash.wait_for_timeout(1500)
        await glide_click(dash, '#index tr[data-agent="1891"] td')
        await wait_text(dash, "#agent", r"1891", 20)
        await dash.wait_for_timeout(800)
        await wait_text(dash, "#agent", r"does not meet proven", 20)
        await dash.mouse.move(900, 300, steps=30)
        await hold(t, "index")
        mark("index", "dashboard", t, time.monotonic())

        # 4. hire
        t = time.monotonic()
        await scroll_to(dash, "#hire-section")
        await glide_click(dash, "#connect2")
        await wait_text(dash, "#wallet", r"on Monad testnet", 20)
        await dash.wait_for_timeout(700)
        await glide_click(dash, '#presets input[value="named-agents"]')
        await type_into(dash, "#amount", args.amount)
        await glide_click(dash, "#hire")
        txt = await wait_text(dash, "#progress", r"Job #(\d+) is open", 90)
        values["job"] = re.search(r"Job #(\d+) is open", txt).group(1)
        await scroll_to(dash, "#progress", "center")
        await hold(t, "hire")
        mark("hire", "dashboard", t, time.monotonic())

        # 5. worker (real log, live; the editor fast-forwards it to the narration)
        log = await open_page("worker-log", f"http://127.0.0.1:{LOG_PORT}/?since={log_offset}")
        t = time.monotonic()
        await log.bring_to_front()
        await wait_text(dash, "#progress", r"Delivered", 300)
        await asyncio.sleep(3)
        mark("worker", "worker-log", t, time.monotonic())

        # 6. verify + release
        await dash.bring_to_front()
        t = time.monotonic()
        await wait_text(dash, "#progress", r"matches the hash on chain|hash mismatch", 60)
        await dash.wait_for_selector("#release", timeout=30000)
        await scroll_to(dash, "#release", "center")
        await asyncio.sleep(max(0.0, t + dur["verify"] * 0.45 - time.monotonic()))
        await glide_click(dash, "#release")
        txt = await wait_text(dash, "#progress", r"Paid\.", 90)
        m = re.search(r"settled jobs (\d+) → (\d+)", txt)
        if m:
            values["before"], values["after"] = m.group(1), m.group(2)
        await scroll_to(dash, "#progress", "end")
        await hold(t, "verify")
        mark("verify", "dashboard", t, time.monotonic())

        # tx hashes of this run, in order, from the progress log
        values["txs"] = await dash.evaluate(
            """() => [...document.querySelectorAll('#progress .line')].map(l => {
                 const a = l.querySelector('a[href*="/tx/"]');
                 return a ? { label: l.innerText.split(':')[0].replace(/^\\+[\\d.]+s\\s*/, '').trim(), hash: a.title } : null;
               }).filter(Boolean)"""
        )

        # 8. outro (7 = explorer stills, added by the editor)
        t = time.monotonic()
        await scroll_to(dash, "#jobs-section")
        await dash.wait_for_timeout(max(2500, int(dur["outro"] * 380)))
        await scroll_to(dash, "#lookup-section")
        await type_into(dash, "#agentId", "1908")
        await glide_click(dash, "#lookup button[type=submit]")
        await dash.wait_for_timeout(1500)
        await hold(t, "outro")
        mark("outro", "dashboard", t, time.monotonic())

        videos = {name: pg["page"].video for name, pg in pages.items()}
        await ctx.close()
        await browser.close()
        files = {name: Path(await v.path()).name for name, v in videos.items()}

    srv.shutdown()
    for m_ in marks:
        m_["video"] = files[m_["page"]]
    timeline = {"url": args.url, "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "values": values, "scenes": marks}
    (out / "timeline.json").write_text(json.dumps(timeline, indent=2), encoding="utf8")
    print(json.dumps(values, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
