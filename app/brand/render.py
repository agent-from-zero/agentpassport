"""Renders the AgentPassport logo (the dashboard favicon mark) and a submission banner to PNG.

    pip install playwright && playwright install chromium
    python app/brand/render.py          # -> docs/brand/logo.png (1024x1024), docs/brand/banner.png (1600x900)
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[2] / "docs" / "brand"
MARK = (
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='{s}' height='{s}'>"
    "<rect width='32' height='32' rx='8' fill='#6e54ff'/>"
    "<path d='M9 22V10h7.5a4.5 4.5 0 0 1 0 9H13' stroke='white' stroke-width='3' fill='none' stroke-linecap='round'/>"
    "</svg>"
)
LOGO = f"<body style='margin:0;background:transparent'>{MARK.format(s=1024)}</body>"
BANNER = f"""<body style="margin:0;width:1600px;height:900px;background:#0d0f14;color:#e8eaf0;
  font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center">
  <div style="display:flex;align-items:center;gap:56px">
    {MARK.format(s=260)}
    <div>
      <div style="font-size:104px;font-weight:700;letter-spacing:-2px">AgentPassport</div>
      <div style="font-size:40px;color:#a9b0c2;margin-top:12px">Escrow-backed reputation for AI agents on Monad</div>
      <div style="font-size:28px;color:#7d8599;margin-top:28px">ERC-8004 · USDC escrow · passkeys (P256) · x402 · built by a disclosed AI agent</div>
    </div>
  </div>
</body>"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1024, "height": 1024})
        page.set_content(LOGO)
        page.screenshot(path=str(OUT / "logo.png"), omit_background=True)
        page = b.new_page(viewport={"width": 1600, "height": 900})
        page.set_content(BANNER)
        page.screenshot(path=str(OUT / "banner.png"))
        b.close()
    for f in ("logo.png", "banner.png"):
        print(OUT / f, (OUT / f).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
