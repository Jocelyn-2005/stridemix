import wave

import numpy as np
import pytest

from backend.audio import SAMPLE_RATE
from backend.tempo import analyze_tempo, tempo_filter


def write_audio(path, samples):
    if samples.ndim == 1:
        samples = np.repeat(samples[:, None], 2, axis=1)
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(samples.shape[1])
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def pulse_audio(bpm, duration=24):
    samples = np.zeros(round(SAMPLE_RATE * duration))
    pulse_time = np.arange(round(SAMPLE_RATE * 0.06)) / SAMPLE_RATE
    pulse = np.sin(2 * np.pi * 700 * pulse_time) * np.exp(-pulse_time * 80) * 0.8
    position = 0
    index = 0
    while position < len(samples):
        length = min(len(pulse), len(samples) - position)
        samples[position:position + length] += pulse[:length]
        index += 1
        position = round(index * SAMPLE_RATE * 60 / bpm)
    return samples


@pytest.mark.parametrize("bpm", [82.5, 120, 165])
def test_detects_periodic_pulses(tmp_path, bpm):
    path = tmp_path / "pulses.wav"
    write_audio(path, pulse_audio(bpm))
    result = analyze_tempo(path)
    assert result.status == "detected", result
    assert result.bpm == pytest.approx(bpm, abs=1.0)
    assert result.confidence >= 0.6


def test_detects_antiphase_stereo(tmp_path):
    path = tmp_path / "antiphase.wav"
    mono = pulse_audio(165)
    write_audio(path, np.column_stack((mono, -mono)))
    result = analyze_tempo(path)
    assert result.bpm == pytest.approx(165, abs=1)


@pytest.mark.parametrize("kind", ["silence", "tone", "noise", "short"])
def test_does_not_invent_bpm_for_weak_material(tmp_path, kind):
    duration = 3 if kind == "short" else 18
    times = np.arange(SAMPLE_RATE * duration) / SAMPLE_RATE
    samples = np.zeros(len(times))
    if kind == "tone":
        samples = np.sin(2 * np.pi * 440 * times) * 0.5
    elif kind == "noise":
        samples = np.random.default_rng(17).normal(0, 0.08, len(times))
    elif kind == "short":
        samples = pulse_audio(165, duration)
    path = tmp_path / "weak.wav"
    write_audio(path, samples)
    result = analyze_tempo(path)
    assert result.bpm is None
    assert result.status == "unavailable"


def test_atempo_chain_preserves_total_ratio():
    for factor in [0.2, 0.5, 1, 1.375, 2, 5.5]:
        filters = tempo_filter(factor).split(",")
        values = [float(item.split("=")[1]) for item in filters]
        assert all(0.5 <= value <= 2 for value in values)
        assert np.prod(values) == pytest.approx(factor)


@pytest.mark.parametrize("tempos", [(120, 90, 120), (80, 120, 160), (None, 120, None)])
def test_partial_or_conflicting_windows_reduce_confidence(tmp_path, tempos):
    sections = [pulse_audio(bpm, 30) if bpm else np.zeros(SAMPLE_RATE * 30) for bpm in tempos]
    path = tmp_path / "changing.wav"
    write_audio(path, np.concatenate(sections))
    result = analyze_tempo(path)
    assert result.bpm is not None
    assert result.status == "uncertain", result
    assert result.confidence < 0.6
