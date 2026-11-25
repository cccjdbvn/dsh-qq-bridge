# 音频分析：BPM / 包络 / 静音比例。
#
# 输入是 ffmpeg 解出来的 raw f32le 单声道（22050 Hz），输出一行 JSON。
# 只用 numpy：不引 librosa（那个要拉一堆东西，而且这台机器是 CPU）。
#
# 算法：短时能量 → 去均值 → 自相关找 60–200 BPM 的周期。
# 对「有明显节拍的流行歌」够用；对古典/散板/纯人声会把置信度压低，
# 置信度低时干脆不报 BPM —— 报一个错的数字比不报更糟。
import json
import sys

import numpy as np


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: analyze.py <pcm_f32le> <sample_rate>"}, ensure_ascii=False))
        return

    path, sample_rate = sys.argv[1], int(sys.argv[2])
    try:
        audio = np.fromfile(path, dtype=np.float32)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"读不了 pcm：{error}"}, ensure_ascii=False))
        return

    if audio.size == 0:
        print(json.dumps({"ok": False, "error": "pcm 是空的"}, ensure_ascii=False))
        return

    # 截到 180 秒：再长也不会让 BPM 更准，只会更慢。
    audio = audio[: sample_rate * 180]
    frame, hop = 1024, 512
    count = max(1, (audio.size - frame) // hop)
    energy = np.array(
        [float(np.mean(audio[i * hop : i * hop + frame] ** 2)) for i in range(count)],
        dtype=np.float64,
    )
    if energy.size < 8:
        print(json.dumps({"ok": False, "error": "音频太短，算不出节拍"}, ensure_ascii=False))
        return

    rms = float(np.sqrt(np.mean(audio ** 2)))
    peak = float(np.max(np.abs(audio)))
    # 静音比例：能量低于整体 RMS 的 5% 的帧算静音。
    silence = float(np.mean(energy < (rms ** 2) * 0.05)) if rms > 0 else 1.0

    env = np.log(energy + 1e-9)
    env = env - env.mean()
    if float(np.std(env)) < 1e-6:
        print(
            json.dumps(
                {
                    "ok": True,
                    "bpm": None,
                    "bpmConfidence": 0,
                    "rms": round(rms, 6),
                    "peak": round(peak, 6),
                    "silenceRatio": round(silence, 3),
                    "note": "能量几乎不变（可能是静音或持续音）",
                },
                ensure_ascii=False,
            )
        )
        return

    env = env / float(np.std(env))
    corr = np.correlate(env, env, mode="full")[len(env) - 1 :]
    # 重叠归一化：不除的话短 lag 天然更高（重叠样本多），会系统性地把 BPM 报快。
    overlap = np.maximum(len(env) - np.arange(len(corr)), 1)
    corr = corr / overlap
    corr = corr / (corr[0] if corr[0] else 1.0)

    frames_per_second = sample_rate / hop
    # 只在 70–180 BPM 里找。范围放太宽时，120 BPM 的歌会一直报到 60（2 倍 lag 的相关更高），
    # 而绝大多数流行/摇滚/电子都在这个区间；慢板会被报成两倍快，这是已知取舍。
    min_lag = int(np.ceil(frames_per_second * 60 / 180))  # 180 BPM
    max_lag = int(np.floor(frames_per_second * 60 / 70))  # 70 BPM
    if max_lag <= min_lag:
        print(json.dumps({"ok": False, "error": "音频太短，算不出节拍"}, ensure_ascii=False))
        return

    window = corr[min_lag : max_lag + 1]
    index = int(np.argmax(window))
    lag = index + min_lag
    confidence = float(np.clip(window[index], 0, 1))

    # 倍频歧义：自相关在 2 倍 lag 处也高，argmax 常挑到「半速」那个
    # （120 BPM 的曲子报成 60）。规则是：如果 lag/2 处的相关几乎一样高，
    # 就取更快的那个 —— 人打的拍子一般就是这个值。
    half = lag // 2
    if half >= min_lag:
        candidates = [corr[lag] if 0 <= lag < len(corr) else 0.0]
        for probe in (half - 1, half, half + 1):
            if min_lag <= probe < len(corr):
                candidates.append(float(corr[probe]))
        alt = max(candidates[1:]) if len(candidates) > 1 else 0.0
        if alt >= 0.95 * confidence:
            lag = max(min_lag, min((half - 1, half, half + 1), key=lambda p: abs(p - half) + abs(float(corr[p]) - alt)))
            confidence = float(corr[lag])

    # 显著性：峰相对这段窗口的中位数有多突出（用标准差归一）。
    # 语音/散板的自相关很平，峰值不突出；有拍子的歌会在一个 lag 上明显尖起来。
    baseline = float(np.median(window))
    prominence = (confidence - baseline) / (float(np.std(window)) + 1e-9)

    bpm = 60.0 * frames_per_second / lag
    # 只用自相关峰值做判据：语音那种散板峰值上不到 0.5，有拍子的歌过得很干净。
    # （试过再加"显著性"门槛，但对完美节拍的合成音反而误伤，所以 prominence 只作参考输出。）
    has_beat = confidence >= 0.5 and 55 <= bpm <= 205

    print(
        json.dumps(
            {
                "ok": True,
                "bpm": round(bpm, 1) if has_beat else None,
                "bpmConfidence": round(confidence, 2),
                "bpmProminence": round(prominence, 2),
                "rms": round(rms, 6),
                "peak": round(peak, 6),
                "silenceRatio": round(silence, 3),
                "note": "" if has_beat else "节拍不明显，不报 BPM",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
