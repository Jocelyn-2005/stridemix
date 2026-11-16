"""Bounded PCM envelopes and measured percussion attacks for visual alignment."""

import math
import wave
from pathlib import Path

import numpy as np

from backend.alignment import _onsets
from backend.audio import AudioError, SAMPLE_RATE
from backend.tempo import WINDOW_SIZE, _segment_period

MAX_WINDOW_SECONDS = 30
CONTEXT_FRAMES = round(SAMPLE_RATE * 0.16)
ENVELOPE_POINTS = 512


def _envelope(samples: np.ndarray) -> list[float]:
    if not len(samples):
        return []
    points = min(ENVELOPE_POINTS, len(samples))
    starts = np.arange(points) * len(samples) // points
    peaks = np.maximum.reduceat(np.abs(samples), starts)
    maximum = float(peaks.max())
    if maximum == 0:
        return [0.0] * points
    return np.round(peaks / maximum, 6).tolist()


def _has_transients(samples: np.ndarray) -> bool:
    block = round(SAMPLE_RATE * 0.01)
    usable = len(samples) // block * block
    if usable < block * 2:
        return False
    power = np.mean(samples[:usable].reshape(-1, block) ** 2, axis=1)
    average = float(power.mean())
    if average < 1e-8:
        return False
    # Sustained tones retain a waveform while contributing no percussion nodes.
    return float(np.std(power)) / average >= 0.12


def _low_frequency_fraction(samples: np.ndarray, frame: int) -> float:
    attack = samples[max(0, frame):frame + round(SAMPLE_RATE * 0.075)]
    if len(attack) < 8:
        return 0.0
    spectrum = np.abs(np.fft.rfft(attack * np.hanning(len(attack)))) ** 2
    frequencies = np.fft.rfftfreq(len(attack), 1 / SAMPLE_RATE)
    broad = float(spectrum[(frequencies >= 40) & (frequencies <= 5000)].sum())
    low = float(spectrum[(frequencies >= 40) & (frequencies <= 250)].sum())
    return low / broad if broad > 0 else 0.0


def _reliability(onsets: list[dict], samples: np.ndarray, bpm: float | None) -> float:
    strong = [onset for onset in onsets if onset["strong"]]
    evidence = strong if len(strong) >= 4 else onsets
    if len(evidence) < 4:
        return 0.0
    times = np.array([onset["time"] for onset in evidence])
    weights = np.array([onset["strength"] for onset in evidence])
    if bpm is None:
        estimate = _segment_period(samples)
        period = 60 / estimate[0] if estimate else float(np.median(np.diff(times)))
    else:
        period = 60 / bpm
    # The estimate can describe a sparse or dense percussion layer. Let the
    # evidence choose its coherent period while the metronome keeps its cadence.
    coherence = max(
        abs(np.sum(weights * np.exp(2j * np.pi * times / candidate))) / weights.sum()
        for candidate in (period / 2, period, period * 2)
    )
    coverage = min(1.0, float(times[-1] - times[0]) / 2)
    count = min(1.0, (len(evidence) - 2) / 8)
    return round(float(np.clip(coherence * coverage * count, 0, 1)), 3)


def rhythm_window(
    path: Path,
    start_seconds: float = 0,
    duration_seconds: float = 12,
    bpm: float | None = None,
) -> dict:
    """Return a real audio window with absolute attack times and local envelope.

    A request beyond the end returns the final requested-length window. At most
    30 seconds plus 320 ms of analysis context are read. Strong nodes identify
    prominent low-frequency attacks. Reliability measures rhythmic evidence in
    this window and can be zero while its audio waveform remains available.
    """
    if not math.isfinite(start_seconds) or start_seconds < 0:
        raise AudioError("片段起点必须为非负秒数")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise AudioError("片段时长必须为正数")
    if bpm is not None and (not math.isfinite(bpm) or not 30 <= bpm <= 480):
        bpm = None
    requested_frames = max(1, round(min(duration_seconds, MAX_WINDOW_SECONDS) * SAMPLE_RATE))
    try:
        with wave.open(str(path), "rb") as stream:
            if stream.getframerate() != SAMPLE_RATE or stream.getsampwidth() != 2:
                raise AudioError("节拍可视化需要标准化的 44.1 kHz PCM 音频")
            total_frames = stream.getnframes()
            start_frame = round(start_seconds * SAMPLE_RATE)
            if start_frame >= total_frames:
                start_frame = max(0, total_frames - requested_frames)
            end_frame = min(total_frames, start_frame + requested_frames)
            read_start = max(0, start_frame - CONTEXT_FRAMES)
            read_end = min(total_frames, end_frame + CONTEXT_FRAMES)
            stream.setpos(read_start)
            raw = stream.readframes(read_end - read_start)
            channels = stream.getnchannels()
    except (wave.Error, EOFError) as error:
        raise AudioError("无法读取节拍可视化所需的音频") from error

    pcm = np.frombuffer(raw, dtype="<i2").reshape(-1, channels).astype(np.float64) / 32768
    if len(pcm):
        energy = np.mean(pcm * pcm, axis=0)
        mono = pcm[:, int(np.argmax(energy))]
    else:
        mono = np.array([], dtype=np.float64)
    local_start = start_frame - read_start
    visible = mono[local_start:local_start + end_frame - start_frame]
    result = {
        "start_seconds": start_frame / SAMPLE_RATE,
        "duration_seconds": (end_frame - start_frame) / SAMPLE_RATE,
        "envelope": _envelope(visible),
        "onsets": [],
        "reliability": 0.0,
    }
    if not _has_transients(visible):
        return result

    # Leading context also lets an attack at sample zero enter an FFT window.
    leading_padding = CONTEXT_FRAMES if read_start == 0 else 0
    analysis = np.pad(mono, (leading_padding, CONTEXT_FRAMES))
    if len(analysis) < WINDOW_SIZE * 4:
        return result
    period = 60 / bpm if bpm is not None else 0.4
    times, weights = _onsets(analysis, period)
    if not len(times):
        return result
    maximum = max(float(weights.max()), 1e-12)
    onsets = []
    for time, weight in zip(times, weights):
        absolute_frame = read_start + round(time * SAMPLE_RATE) - leading_padding
        if not start_frame <= absolute_frame < end_frame:
            continue
        strength = float(np.clip(weight / maximum, 0, 1))
        low_fraction = _low_frequency_fraction(analysis, round(time * SAMPLE_RATE))
        onsets.append({
            "time": round(absolute_frame / SAMPLE_RATE, 9),
            "strength": round(strength, 4),
            "strong": low_fraction >= 0.18 and strength >= 0.15,
        })
    result["onsets"] = onsets
    result["reliability"] = _reliability(onsets, visible, bpm)
    return result
