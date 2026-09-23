"""Read-only smoke test of a deployed (or local) dashboard in a fresh headless Chromium.

    python test/smoke.py [URL]          # default https://agentpassport-monad.netlify.app

Checks, desktop and mobile: no page errors; the scorecard for agent 1908 renders with the chain's
verdict; the live job table has JobEscrow v1 history rows ("v1 #1".."v1 #5", linking the v1 escrow)
plus v2 rows or the empty-v2 note, and every open v2 job shows its acceptance state; the contracts
table lists JobEscrow v2 and v1 and links docs/SECURITY.md; the trust index has rows; the network pill
shows a block; no horizontal overflow at 390 px. With TEST_WALLET_KEY set (and `node scripts/build.mjs --test-wallet`
run), it also connects the injected test wallet and checks the chain/balance line. It sends no
transaction.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

V2 = "0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355"
V1 = "0x5b197edD258572DEe7C923A6D38D6Db268A266BC"
sys.stdout.reconfigure(encoding="utf-8")  # the verdict badge prints a check mark
URL = sys.argv[1] if len(sys.argv) > 1 else "https://agentpassport-monad.netlify.app"
WALLET_JS = Path(__file__).resolve().parents[1] / ".test-build" / "test-wallet.js"


async def check(browser, viewport, wallet_key=None):
    ctx = await browser.new_context(viewport=viewport)
    if wallet_key:
        await ctx.add_init_script("window.__AP_TEST_WALLET__ = " + json.dumps({"privateKey": wallet_key, "name": "Smoke test wallet"}) + ";\n" + WALLET_JS.read_text(encoding="utf8"))
    page = await ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    await page.goto(URL)
    await page.wait_for_selector("#agent .verdict", timeout=60000)
    await page.wait_for_selector("#jobs tbody .status", timeout=60000)
    await page.wait_for_selector("#index tbody tr[data-agent]", timeout=60000)
    await page.wait_for_selector('#jobs tbody tr[data-job="v1:5"]', timeout=60000)
    jobs = await page.evaluate(r"""() => [...document.querySelectorAll('#jobs tbody tr[data-job]')].map(tr => ({
        key: tr.dataset.job, ref: tr.querySelector('.jobref').innerText.trim(), href: tr.querySelector('.jobref').href,
        status: tr.cells[4].innerText.replace(/\s+/g, ' ').trim() }))""")
    contracts = await page.inner_text("#contracts")
    security = await page.locator('#contracts a[href$="docs/SECURITY.md"]').count()
    v2_empty = await page.locator("#jobs tbody", has_text="No jobs on JobEscrow v2 yet").count()
    res = {
        "verdict": (await page.inner_text("#agent .verdict .badge")).strip(),
        "jobs": len(jobs),
        "v1": [j["ref"] for j in jobs if j["key"].startswith("v1:")],
        "v2": [f'{j["ref"]} {j["status"]}' for j in jobs if j["key"].startswith("v2:")],
        "sep": await page.locator("#jobs tbody tr.sep").count(),
        "indexed": await page.locator("#index tbody tr[data-agent]").count(),
        "net": (await page.inner_text("#net")).strip(),
        "overflow": await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"),
    }
    if wallet_key:
        await page.click("#connect")
        await page.wait_for_function("document.querySelector('#wallet').innerText.includes('on Monad testnet')", timeout=20000)
        res["wallet"] = (await page.inner_text("#wallet .wallet-line")).replace("\n", " ")
    await ctx.close()
    assert not errors, errors
    assert "meets" in res["verdict"], res
    assert res["jobs"] >= 1 and res["indexed"] >= 1, res
    assert all(f"v1 #{i}" in res["v1"] for i in range(1, 6)), res
    assert res["sep"] == 1, res
    assert res["v2"] or v2_empty, res
    for j in jobs:
        escrow = V1 if j["key"].startswith("v1:") else V2
        assert j["href"].lower().endswith(escrow.lower()), j
        assert j["ref"] == j["key"].replace(":", " #"), j
        if j["key"].startswith("v2:") and j["status"].startswith("Open"):
            assert any(s in j["status"] for s in ("waiting for agent", "accepted", "never accepted")), j
    assert "JobEscrow v2 (current)" in contracts and V2 in contracts, contracts
    assert "JobEscrow v1 (history)" in contracts and V1 in contracts, contracts
    assert security == 1, "no docs/SECURITY.md link"
    assert "block" in res["net"], res
    assert not res["overflow"], res
    return res


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        print("desktop", await check(browser, {"width": 1280, "height": 720}, os.environ.get("TEST_WALLET_KEY")))
        print("mobile ", await check(browser, {"width": 390, "height": 844}))
        await browser.close()
    print("OK")


asyncio.run(main())
