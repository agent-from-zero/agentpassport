"""Read-only smoke test of a deployed (or local) dashboard in a fresh headless Chromium.

    python test/smoke.py [URL]          # default https://agentpassport-monad.netlify.app

Checks, desktop and mobile: no page errors; the scorecard for agent 1908 renders with the chain's
verdict; the live job table and the trust index have rows; the network pill shows a block; no
horizontal overflow at 390 px. With TEST_WALLET_KEY set (and `node scripts/build.mjs --test-wallet`
run), it also connects the injected test wallet and checks the chain/balance line. It sends no
transaction.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

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
    res = {
        "verdict": (await page.inner_text("#agent .verdict .badge")).strip(),
        "jobs": await page.locator("#jobs tbody tr").count(),
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
