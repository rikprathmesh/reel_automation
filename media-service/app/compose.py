"""Final reel assembly: xfade-joined scenes, mixed/ducked/normalized audio, burned ASS captions."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

from .config import ffmpeg_bin, ffprobe_bin, get_settings
from .ffmpeg import probe_duration, run_ffmpeg
from .models import ComposeRequest, TimelineScene, TimelineVoice
from .storage import ensure_parent, existing, key_for, path_for

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def find_font() -> Path | None:
    custom = path_for("library/fonts")
    if custom.is_dir():
        for f in sorted(custom.iterdir()):
            if f.suffix.lower() in (".ttf", ".otf"):
                return f
    env = os.environ.get("CAPTION_FONT")
    if env and Path(env).is_file():
        return Path(env)
    return next((Path(c) for c in FONT_CANDIDATES if Path(c).is_file()), None)


def font_family(font: Path | None) -> str:
    if not font:
        return "Arial"
    b = font.name.lower()
    if b.startswith("dejavu"):
        return "DejaVu Sans"
    if b.startswith("arial"):
        return "Arial"
    return re.sub(r"[-_ ]?(bold|regular|black|semibold|bd)?\.(ttf|otf)$", "", font.name, flags=re.I)


# ------------------------------- subtitles -------------------------------

def ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    h, m, s, c = cs // 360000, (cs % 360000) // 6000, (cs % 6000) // 100, cs % 100
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def ass_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\r", " ").replace("\n", " ")


def build_ass(voices: list[TimelineVoice], scenes: list[TimelineScene], end_card: str, total: float, font_name: str) -> str:
    """Word-by-word "active word" captions + scene overlays + end card."""
    s = get_settings()
    W, H = s.video_width, s.video_height
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{font_name},86,&H00FFFFFF,&H0000E5FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,2,80,80,560,1
Style: Overlay,{font_name},72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,18,0,8,90,90,260,1
Style: EndCard,{font_name},78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev: list[str] = []
    for v in voices:
        words = [(w.word, w.start + v.start, w.end + v.start) for w in v.words]
        for i in range(0, len(words), 3):
            chunk = words[i:i + 3]
            for j, (_, ws, we) in enumerate(chunk):
                end = chunk[j + 1][1] if j < len(chunk) - 1 else max(we, ws + 0.12)
                text = " ".join(
                    f"{{\\c&H0000E5FF&\\fscx108\\fscy108}}{ass_escape(x[0])}{{\\r}}" if k == j else ass_escape(x[0])
                    for k, x in enumerate(chunk)
                )
                ev.append(f"Dialogue: 1,{ass_time(ws)},{ass_time(end)},Caption,,0,0,0,,{{\\an2}}{text.upper()}")
    for sc in scenes:
        if sc.on_screen_text.strip():
            ev.append(f"Dialogue: 2,{ass_time(sc.start + 0.2)},{ass_time(sc.start + min(sc.duration - 0.2, 3))},Overlay,,0,0,0,,{{\\fad(150,150)}}{ass_escape(sc.on_screen_text.strip())}")
    if end_card.strip():
        ev.append(f"Dialogue: 3,{ass_time(max(0.0, total - 2.6))},{ass_time(total)},EndCard,,0,0,0,,{{\\fad(250,0)}}{ass_escape(end_card.strip())}")
    return header + "\n".join(ev) + "\n"


# -------------------------------- assembly --------------------------------

def join_scenes(scenes: list[TimelineScene], out: Path) -> None:
    fps = get_settings().video_fps
    clips = [existing(sc.clip_key) for sc in scenes]
    if len(scenes) == 1:
        shutil.copyfile(clips[0], out)
        return
    inputs: list[str] = []
    for c in clips:
        inputs += ["-i", str(c)]
    parts: list[str] = []
    prev = "[0:v]"
    for k in range(1, len(scenes)):
        t = scenes[k - 1]
        label = "[vout]" if k == len(scenes) - 1 else f"[v{k}]"
        trans_sec = max(0.04, t.transition_sec)
        parts.append(f"{prev}[{k}:v]xfade=transition={t.transition}:duration={trans_sec:.3f}:offset={scenes[k].start:.3f}{label}")
        prev = label
    run_ffmpeg([*inputs, "-filter_complex", ";".join(parts), "-map", "[vout]", "-r", str(fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", str(out)])


def mix_audio(req: ComposeRequest, out: Path) -> None:
    """Voices + SFX + transition whooshes over a sidechain-ducked music bed, normalized to -14 LUFS."""
    args: list[str] = ["-f", "lavfi", "-t", f"{req.total_sec:.3f}", "-i", "anullsrc=r=44100:cl=stereo"]
    filters: list[str] = []
    fg = ["[0:a]"]
    idx = 1

    def add(path: Path, loop: bool = False) -> int:
        nonlocal idx
        if loop:
            args.extend(["-stream_loop", "-1"])
        args.extend(["-i", str(path)])
        idx += 1
        return idx - 1

    for v in req.voices:
        i = add(existing(v.key))
        ms = round(v.start * 1000)
        filters.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay={ms}|{ms},volume=1.0[vo{i}]")
        fg.append(f"[vo{i}]")
    for sc in req.scenes:
        if sc.sfx_key:
            i = add(existing(sc.sfx_key))
            ms = round((sc.start + 0.15) * 1000)
            filters.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:3,afade=t=out:st=2.4:d=0.6,adelay={ms}|{ms},volume=0.55[sx{i}]")
            fg.append(f"[sx{i}]")
    if req.whoosh_key:
        whoosh = existing(req.whoosh_key)
        for sc in req.scenes[1:]:
            i = add(whoosh)
            ms = max(0, round((sc.start - 0.15) * 1000))
            filters.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:1.2,adelay={ms}|{ms},volume=0.35[wh{i}]")
            fg.append(f"[wh{i}]")
    filters.append(f"{''.join(fg)}amix=inputs={len(fg)}:normalize=0:duration=first[fgraw]")

    if req.music_key:
        i = add(existing(req.music_key), loop=True)
        fade_out = max(0.0, req.total_sec - 1.5)
        filters.append("[fgraw]asplit=2[fg][key]")
        filters.append(f"[{i}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:{req.total_sec:.3f},afade=t=in:d=0.8,afade=t=out:st={fade_out:.2f}:d=1.5,volume=0.22[mus]")
        filters.append("[mus][key]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350:makeup=1[ducked]")
        filters.append("[fg][ducked]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    else:
        filters.append("[fgraw]loudnorm=I=-14:TP=-1.5:LRA=11[aout]")
    run_ffmpeg([*args, "-filter_complex", ";".join(filters), "-map", "[aout]", "-t", f"{req.total_sec:.3f}", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", str(out)])


def compose(req: ComposeRequest) -> dict:
    if not req.scenes:
        raise ValueError("At least one scene is required")
    s = get_settings()
    work = path_for(req.work_key)
    work.mkdir(parents=True, exist_ok=True)
    join_scenes(req.scenes, work / "joined.mp4")
    mix_audio(req, work / "mix.m4a")

    # Relative paths + cwd sidestep filtergraph escaping of drive letters / colons.
    font = find_font()
    fonts_dir = work / "fonts"
    fonts_dir.mkdir(exist_ok=True)
    if font:
        shutil.copyfile(font, fonts_dir / font.name)
    (work / "subs.ass").write_text(build_ass(req.voices, req.scenes, req.end_card, req.total_sec, font_family(font)), encoding="utf-8")

    out = ensure_parent(req.out_key)
    tmp_name = "final.mp4"
    run_ffmpeg([
        "-i", "joined.mp4", "-i", "mix.m4a",
        "-vf", "ass=subs.ass:fontsdir=fonts,format=yuv420p",
        "-map", "0:v", "-map", "1:a", "-t", f"{req.total_sec:.3f}",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "19", "-r", str(s.video_fps),
        "-c:a", "copy", "-movflags", "+faststart", tmp_name,
    ], cwd=work)
    shutil.move(str(work / tmp_name), out)
    report = validate(out, req.total_sec)
    return {"key": key_for(out), "duration": round(report.get("duration") or 0.0, 3), "validation": report}


def validate(path: Path, expected_sec: float) -> dict:
    """Checks the rendered reel against the required output spec before it can be marked ready."""
    import json as _json

    s = get_settings()
    problems: list[str] = []
    probe_bin = ffprobe_bin()
    if not probe_bin:
        return {"ok": False, "problems": ["ffprobe not available; cannot validate"]}
    p = subprocess.run([probe_bin, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, timeout=120)
    info = _json.loads(p.stdout or "{}")
    v = next((x for x in info.get("streams", []) if x.get("codec_type") == "video"), None)
    a = next((x for x in info.get("streams", []) if x.get("codec_type") == "audio"), None)
    dur = float(info.get("format", {}).get("duration") or 0)
    fps = None
    if v:
        num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
        fps = round(float(num) / float(den or 1), 2) if float(den or 1) else None
        if (v.get("width"), v.get("height")) != (s.video_width, s.video_height):
            problems.append(f"resolution {v.get('width')}x{v.get('height')} (expected {s.video_width}x{s.video_height})")
        if v.get("codec_name") != "h264":
            problems.append(f"video codec {v.get('codec_name')} (expected h264)")
        if fps is None or abs(fps - s.video_fps) > 0.5:
            problems.append(f"frame rate {fps} (expected {s.video_fps})")
    else:
        problems.append("no video stream")
    if not a:
        problems.append("no audio stream")
    elif a.get("codec_name") != "aac":
        problems.append(f"audio codec {a.get('codec_name')} (expected aac)")
    if abs(dur - expected_sec) > 1.0:
        problems.append(f"duration {dur:.2f}s differs from timeline {expected_sec:.2f}s")
    # share of near-black frames (a broken render often comes out black)
    bd = subprocess.run([ffmpeg_bin(), "-hide_banner", "-i", str(path), "-vf", "scale=270:-2,blackdetect=d=0.2:pix_th=0.08", "-an", "-f", "null", "-"],
                        capture_output=True, text=True, timeout=600, errors="replace")
    black = sum(float(m) for m in re.findall(r"black_duration:([\d.]+)", bd.stderr))
    ratio = round(black / dur, 3) if dur else 1.0
    if ratio > 0.2:
        problems.append(f"{ratio:.0%} of the video is black")
    return {
        "ok": not problems, "problems": problems, "width": v.get("width") if v else None, "height": v.get("height") if v else None,
        "fps": fps, "video_codec": v.get("codec_name") if v else None, "audio_codec": a.get("codec_name") if a else None,
        "duration": round(dur, 3), "black_ratio": ratio,
    }


def thumbnail(image_key: str, text: str, out_key: str) -> dict:
    s = get_settings()
    W, H = s.video_width, s.video_height
    image = existing(image_key)
    out = ensure_parent(out_key)
    work = out.parent
    vf = [f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"]
    font = find_font()
    tmp_font, tmp_txt = work / "_thumbfont.ttf", work / "_thumb.txt"
    try:
        if font and text.strip():
            shutil.copyfile(font, tmp_font)
            tmp_txt.write_text(text.strip().upper(), encoding="utf-8")
            vf.append("drawtext=fontfile=_thumbfont.ttf:textfile=_thumb.txt:fontsize=120:fontcolor=white:borderw=10:bordercolor=black:x=(w-text_w)/2:y=h*0.12")
        run_ffmpeg(["-i", str(image), "-frames:v", "1", "-vf", ",".join(vf), "-q:v", "3", out.name], cwd=work)
    finally:
        tmp_font.unlink(missing_ok=True)
        tmp_txt.unlink(missing_ok=True)
    return {"key": key_for(out)}
