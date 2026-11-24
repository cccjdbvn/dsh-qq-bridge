#!/usr/bin/env python
# 一次性听写脚本：ffmpeg 解码成 16k 单声道数组 → faster-whisper → JSON。
#
# 为什么不直接把文件交给 faster-whisper：它内部用 av.open(metadata_errors=...)，
# 而 PyAV 19 已经去掉这个参数，会直接报错。这里用 ffmpeg 解码绕开。
import json
import os
import subprocess
import sys

# Windows 控制台默认按系统编码写 stdout，中文会变乱码；强制 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少音频路径"}, ensure_ascii=False))
        return 2
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
    language = (sys.argv[3] or "zh").strip() if len(sys.argv) > 3 else "zh"
    download_root = sys.argv[4] if len(sys.argv) > 4 else ""
    ffmpeg = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else "ffmpeg"

    if download_root:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.makedirs(download_root, exist_ok=True)

    try:
        import numpy as np

        decoded = subprocess.run(
            [ffmpeg, "-v", "error", "-i", audio, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
            capture_output=True,
        )
        if decoded.returncode != 0:
            raise RuntimeError("ffmpeg 解码失败：" + decoded.stderr.decode("utf-8", "ignore")[:300])
        samples = np.frombuffer(decoded.stdout, np.float32)
        if samples.size == 0:
            raise RuntimeError("音频里没有可解码的声音")

        from faster_whisper import WhisperModel

        model = WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            download_root=download_root or None,
        )
        segments, info = model.transcribe(
            samples,
            language=language if language != "auto" else None,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            # whisper 默认会输出繁体；给一句话把它拉回简体口语。
            initial_prompt="以下是普通话内容，请用简体中文转写。",
        )
        rows = []
        total = 0.0
        prompt_text = "以下是普通话内容，请用简体中文转写。"
        for seg in segments:
            text = (seg.text or "").strip()
            # 纯音乐/无人声时，模型偶尔把 initial_prompt 本身当成一句台词吐出来。
            if not text or prompt_text in text:
                continue
            rows.append({"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text})
            total += max(0.0, float(seg.end) - float(seg.start))
        print(json.dumps({
            "ok": True,
            "model": model_name,
            "language": getattr(info, "language", language),
            "duration": round(samples.size / 16000.0, 2),
            "speechSeconds": round(total, 2),
            "segments": rows,
        }, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - 统一回报给 Node
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
