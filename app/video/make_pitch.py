"""Builds the pitch video (2 minutes max): HTML slides -> PNG (Playwright) -> narration (edge-tts) -> mp4.

    python make_pitch.py [--out build/pitch] [--dashboard https://agentpassport-monad.netlify.app]

Slide 5 embeds a fresh screenshot of the live dashboard, taken in a new headless context.
"""
from __future__ import annotations

import argparse
import asyncio
import shutil
from pathlib import Path

from playwright.async_api import async_playwright

import lib
from edit_demo import still_clip
from pitch_script import SLIDES

HERE = Path(__file__).resolve().parent
LEAD, TAIL = 0.3, 0.45


async def render(out: Path, dashboard: str) -> list[Path]:
    shutil.copy(HERE / "pitch" / "slides.html", out / "slides.html")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": lib.W, "height": lib.H})
        page = await ctx.new_page()
        await page.goto(dashboard)
        await page.wait_for_selector("#agent .verdict", timeout=60000)
        await page.wait_for_timeout(2500)
        await page.screenshot(path=str(out / "dashboard.png"))
        await page.goto((out / "slides.html").resolve().as_uri())
        await page.wait_for_timeout(800)
        pngs = []
        for i, s in enumerate(SLIDES, 1):
            png = out / f"slide_{i:02}_{s['id']}.png"
            await page.locator(f"#{s['id']}").screenshot(path=str(png))
            pngs.append(png)
        await browser.close()
    return pngs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build" / "pitch"))
    ap.add_argument("--dashboard", default="https://agentpassport-monad.netlify.app")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pngs = asyncio.run(render(out, args.dashboard))
    segments, total = [], 0.0
    for i, (s, png) in enumerate(zip(SLIDES, pngs), 1):
        mp3 = out / f"{i:02}_{s['id']}.mp3"
        speech = lib.tts(s["text"], mp3)
        T = LEAD + speech + TAIL + (1.0 if i == len(SLIDES) else 0.0)
        silent = out / f"{i:02}_{s['id']}_v.mp4"
        still_clip([png], T, silent)
        srt = f"{i:02}_{s['id']}.srt"
        lib.write_srt(s["text"], LEAD, speech, out / srt)
        seg = out / f"{i:02}_{s['id']}.mp4"
        fade = f",fade=t=out:st={T - 0.8:.3f}:d=0.8" if i == len(SLIDES) else ""
        lib.ffmpeg(["-i", silent.name, "-i", mp3.name, "-filter_complex",
                    f"[0:v]{lib.subtitles_filter(srt)}{fade}[v];[1:a]adelay={int(LEAD * 1000)}|{int(LEAD * 1000)},apad,atrim=0:{T:.3f}[a]",
                    "-map", "[v]", "-map", "[a]", "-t", f"{T:.3f}", *lib.ENCODE, seg.name], cwd=out)
        segments.append(seg)
        total += T
        print(f"{s['id']}: {T:.1f}s")
    final = out / "agentpassport-pitch.mp4"
    lib.concat(segments, final)
    lib.loudnorm(final)
    print(f"{final}: {lib.duration(final):.1f}s, {final.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
