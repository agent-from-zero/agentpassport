"""Shared helpers for the demo and pitch videos: TTS narration, ffmpeg calls, subtitles.

Narration uses edge-tts (free, no account). Everything else is plain ffmpeg. Set FFMPEG / FFPROBE
to the binaries if they are not on PATH.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

VOICE = os.environ.get("TTS_VOICE", "en-US-AndrewNeural")
RATE = os.environ.get("TTS_RATE", "+4%")
W, H, FPS = 1280, 720, 30
BG = "0x0d0d12"
FONT = os.environ.get("CAPTION_FONT", "Segoe UI")


def _bin(name: str) -> str:
    env = os.environ.get(name.upper())
    if env:
        return env
    found = shutil.which(name)
    if not found:
        raise SystemExit(f"{name} not found: put it on PATH or set {name.upper()}=<path to {name}>")
    return found


def run(args: list[str], cwd: Path | None = None) -> None:
    subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def ffmpeg(args: list[str], cwd: Path | None = None) -> None:
    try:
        run([_bin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", *args], cwd=cwd)
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"ffmpeg failed: {' '.join(args)}\n{e.stderr.decode(errors='replace')}") from e


def duration(path: Path) -> float:
    out = subprocess.run(
        [_bin("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        check=True, capture_output=True,
    ).stdout
    return float(json.loads(out)["format"]["duration"])


async def _tts(text: str, out: Path) -> None:
    import edge_tts  # pip install edge-tts

    await edge_tts.Communicate(text, VOICE, rate=RATE).save(str(out))


def tts(text: str, out: Path) -> float:
    """Synthesises `text` to `out` (mp3) unless a file for the same text already exists."""
    stamp = out.with_suffix(".txt")
    if not (out.exists() and stamp.exists() and stamp.read_text(encoding="utf8") == text + VOICE + RATE):
        asyncio.run(_tts(text, out))
        stamp.write_text(text + VOICE + RATE, encoding="utf8")
    return duration(out)


def sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?:])\s+", text) if s.strip()]


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def write_srt(text: str, start: float, speech: float, out: Path) -> None:
    """Captions timed by sentence, in proportion to sentence length (close enough for TTS speech)."""
    parts = sentences(text)
    total = sum(len(p) for p in parts) or 1
    t, lines = start, []
    for i, p in enumerate(parts, 1):
        d = speech * len(p) / total
        lines.append(f"{i}\n{srt_time(t)} --> {srt_time(t + d - 0.05)}\n{wrap(p)}\n")
        t += d
    out.write_text("\n".join(lines), encoding="utf8")


def wrap(s: str, width: int = 78) -> str:
    words, rows, cur = s.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width and cur:
            rows.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    rows.append(cur)
    return "\n".join(rows)


SUB_STYLE = (
    f"FontName={FONT},FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H99000000,"
    "BorderStyle=4,Outline=1,Shadow=0,MarginV=22,Alignment=2"
)


def subtitles_filter(srt_name: str) -> str:
    # Paths inside the subtitles filter are painful on Windows; callers run ffmpeg with cwd = the srt's dir.
    return f"subtitles={srt_name}:force_style='{SUB_STYLE}'"


def concat(parts: list[Path], out: Path) -> None:
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{Path(os.path.relpath(p, out.parent)).as_posix()}'\n" for p in parts), encoding="utf8")
    ffmpeg(["-f", "concat", "-safe", "0", "-i", lst.name, "-c", "copy", "-movflags", "+faststart", out.name], cwd=out.parent)


ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS),
          "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]


def loudnorm(path: Path) -> None:
    """Normalises speech loudness (EBU R128, -16 LUFS) in place; the video stream is copied."""
    tmp = path.with_name(path.stem + ".norm" + path.suffix)
    ffmpeg(["-i", path.name, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k",
            "-ar", "48000", "-movflags", "+faststart", tmp.name], cwd=path.parent)
    tmp.replace(path)
