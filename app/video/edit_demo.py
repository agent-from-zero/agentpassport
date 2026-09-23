"""Cuts the recorded demo into the final video: narration + captions per scene, H.264 mp4.

    python edit_demo.py [--build build/demo] [--stills build/demo/stills] [--out agentpassport-demo.mp4]

Reads build/demo/timeline.json (from record_demo.py). Each scene is cut from its page's recording
and fitted to its narration: a scene longer than its narration is fast-forwarded (and labelled so on
screen), a shorter one holds its last frame. The explorer scene is built from the stills directory
(PNG screenshots of this run's transactions, in file-name order).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import lib
from demo_script import SCENES, narration

HERE = Path(__file__).resolve().parent
LEAD = 0.3   # silence before each scene's narration
TAIL = 0.6   # silence after it


def font(size: int, bold: bool = False):
    for name in (["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def badge(text: str, out: Path, accent: str = "#6e54ff") -> Path:
    """A rounded label rendered to PNG (overlaid by ffmpeg; avoids drawtext font-path quirks)."""
    f = font(20, bold=True)
    w = int(f.getlength(text)) + 36
    img = Image.new("RGBA", (w, 42), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, 41), radius=12, fill=(20, 18, 34, 230), outline=accent, width=2)
    d.text((18, 8), text, font=f, fill="white")
    img.save(out)
    return out


def still_clip(images: list[Path], seconds: float, out: Path) -> None:
    """Explorer screenshots, each shown for an equal share with a slow push-in."""
    each = seconds / len(images)
    parts = []
    for i, img in enumerate(images):
        part = out.with_name(f"{out.stem}_{i}.mp4")
        frames = int(each * lib.FPS) + 1
        lib.ffmpeg([
            "-loop", "1", "-i", str(img), "-t", f"{each:.3f}",
            "-vf", (f"scale={lib.W}:{lib.H}:force_original_aspect_ratio=decrease,pad={lib.W}:{lib.H}:(ow-iw)/2:(oh-ih)/2:color={lib.BG},"
                    f"scale={lib.W * 2}:{lib.H * 2},zoompan=z='min(1+0.0006*on,1.06)':x='iw/2-(iw/zoom/2)':y='0':d={frames}:s={lib.W}x{lib.H}:fps={lib.FPS},"
                    f"fade=t=in:st=0:d=0.25"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(lib.FPS), part.name,
        ], cwd=out.parent)
        parts.append(part)
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf8")
    lib.ffmpeg(["-f", "concat", "-safe", "0", "-i", lst.name, "-c", "copy", out.name], cwd=out.parent)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", default=str(HERE / "build" / "demo"))
    ap.add_argument("--stills", default=None)
    ap.add_argument("--out", default="agentpassport-demo.mp4")
    args = ap.parse_args()
    build = Path(args.build)
    tl = json.loads((build / "timeline.json").read_text(encoding="utf8"))
    values = {k: v for k, v in tl["values"].items() if isinstance(v, str)}
    # How long the worker took, from the dashboard's own progress log ("Delivered after 193s").
    for tx in tl["values"].get("txs", []):
        m = re.search(r"Delivered after (\d+)s", tx["label"])
        if m:
            secs = int(m.group(1))
            values["wait"] = "about a minute" if secs < 90 else f"about {round(secs / 60)} minutes"
    marks = {m["id"]: m for m in tl["scenes"]}
    stills_dir = Path(args.stills) if args.stills else build / "stills"
    work = build / "cut"
    work.mkdir(exist_ok=True)
    ai_badge = badge("AI-built and AI-narrated · agentfromzero (autonomous AI agent, Claude)", work / "badge_ai.png")

    segments, total = [], 0.0
    for i, scene in enumerate(SCENES, 1):
        sid = scene["id"]
        text = narration(scene, values)
        speech = lib.tts(text, build / "audio" / f"{sid}.mp3")
        last_scene = i == len(SCENES)
        T = LEAD + speech + TAIL + (2.5 if last_scene else 0.0)  # let the closing frame breathe
        lib.write_srt(text, LEAD, speech, work / f"{i:02}_{sid}.srt")
        seg = work / f"{i:02}_{sid}.mp4"
        subs = lib.subtitles_filter(f"{i:02}_{sid}.srt")
        audio = ["-i", str((build / "audio" / f"{sid}.mp3").resolve())]
        afilter = f"adelay={int(LEAD * 1000)}|{int(LEAD * 1000)},apad,atrim=0:{T:.3f}"

        if scene["source"] == "stills":
            images = sorted(stills_dir.glob("*.png"))
            if not images:
                raise SystemExit(f"no explorer stills in {stills_dir}")
            silent = work / f"{i:02}_{sid}_v.mp4"
            still_clip(images, T, silent)
            lib.ffmpeg(["-i", silent.name, *audio, "-filter_complex", f"[0:v]{subs}[v];[1:a]{afilter}[a]",
                        "-map", "[v]", "-map", "[a]", "-t", f"{T:.3f}", *lib.ENCODE, seg.name], cwd=work)
        else:
            m = marks[sid]
            src = (build / "raw" / m["video"]).resolve()
            clip = m["end"] - m["start"]
            speed = clip / T if clip > T * 1.08 else 1.0
            hold = max(0.0, T - clip / speed)
            v = (f"[0:v]trim=start={m['start']:.3f}:end={m['end']:.3f},setpts=(PTS-STARTPTS)/{speed:.4f},fps={lib.FPS},"
                 f"scale={lib.W}:{lib.H},tpad=stop_mode=clone:stop_duration={hold:.3f},fade=t=in:st=0:d=0.25"
                 + (f",fade=t=out:st={T - 0.8:.3f}:d=0.8" if last_scene else "") + "[base]")
            inputs = ["-i", str(src), *audio]
            chain = v
            last = "base"
            overlays = []
            if i == 1:
                overlays.append((ai_badge, "x=W-w-24:y=76"))
            if speed > 1.0:
                overlays.append((badge(f"fast-forward ×{speed:.1f}", work / f"badge_ff_{sid}.png", accent="#f5b84b"), "x=W-w-24:y=74"))
            for k, (png, pos) in enumerate(overlays):
                inputs += ["-i", str(png.resolve())]
                chain += f";[{last}][{2 + k}:v]overlay={pos}[o{k}]"
                last = f"o{k}"
            chain += f";[{last}]{subs}[v];[1:a]{afilter}[a]"
            lib.ffmpeg([*inputs, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-t", f"{T:.3f}", *lib.ENCODE, seg.name], cwd=work)
            print(f"{sid}: clip {clip:.1f}s -> {T:.1f}s (speed {speed:.2f}, hold {hold:.1f}s)")
        total += T
        segments.append(seg)

    out = build / args.out
    lib.concat(segments, out)
    lib.loudnorm(out)
    size = out.stat().st_size / 1e6
    print(f"{out}: {lib.duration(out):.1f}s, {size:.1f} MB (narration total {total:.1f}s)")


if __name__ == "__main__":
    main()
