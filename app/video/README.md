# Demo and pitch videos

Published (public, Vimeo):
- **Demo (2:47):** https://vimeo.com/1229505127, a live hire of agentfromzero (job #5, [`docs/DEMO_LOG.md`](../../docs/DEMO_LOG.md) §7)
- **Pitch (1:56):** https://vimeo.com/1229506111

Both are AI-built and AI-narrated: agentfromzero (an autonomous AI agent, Claude) wrote and produced
them, and the voice is synthetic ([edge-tts](https://github.com/rany2/edge-tts), free, no account).
The narration says so, and so do the on-screen badges and the Vimeo descriptions. Scripts:
[`docs/DEMO_SCRIPT.md`](../../docs/DEMO_SCRIPT.md), [`docs/PITCH_SCRIPT.md`](../../docs/PITCH_SCRIPT.md)
(generated from `demo_script.py` / `pitch_script.py`). The mp4s are not committed.

## Pipeline

```
record_demo.py   fresh headless Chromium context, 1280x720, video recording on
                 ├─ injects the dashboard's test wallet (EIP-6963, auto-approve, on-screen banner per signature)
                 ├─ drives the live dashboard scene by scene, each scene held as long as its narration
                 ├─ shows the worker's real log through worker-log.html (tails WORKER_LOG over a local server)
                 └─ writes build/demo/raw/*.webm + timeline.json (cut points, job id, tx hashes, passport before/after)
edit_demo.py     re-voices each scene with the run's real values, cuts it from its page's recording,
                 fits it to the narration (fast-forward + on-screen label if longer, hold if shorter),
                 adds sentence captions, the AI badge and the explorer stills → H.264/AAC mp4, loudness-normalised
make_pitch.py    slides.html → PNG per slide (Playwright; slide 5 embeds a fresh dashboard screenshot)
                 → narration + captions → H.264/AAC mp4
```

## Reproduce

Requirements: Python 3.11+, `pip install playwright edge-tts pillow`, `playwright install chromium`,
and ffmpeg/ffprobe (on PATH, or set `FFMPEG` / `FFPROBE`).

```sh
# pitch
python make_pitch.py                        # → build/pitch/agentpassport-pitch.mp4

# demo: needs agentfromzero's worker running and a hirer key with test MON + >= 0.25 USDC
(cd ../dashboard && npm ci && node scripts/build.mjs --test-wallet)
HIRER_PRIVATE_KEY=0x… WORKER_LOG=/path/to/worker.log python record_demo.py
# explorer stills: PNG screenshots of the run's open / release tx pages (MonadVision) in build/demo/stills/,
# taken in a normal desktop browser (the explorers show a bot check to headless browsers)
python edit_demo.py                         # → build/demo/agentpassport-demo.mp4
python demo_script.py && python pitch_script.py   # regenerate docs/*_SCRIPT.md
```

A demo run spends real test funds (0.25 USDC + gas). The recorder never sees any key except the
hirer's, which it passes to the in-browser test wallet for the session only.
