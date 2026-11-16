import wave

import numpy as np
import pytest

from backend.alignment import analyze_alignment
from backend.audio import SAMPLE_RATE
from backend.tests.test_tempo import pulse_audio, write_audio


def offset_pulses(bpm, offset, duration=24, hihat=False):
    samples = np.zeros(round(SAMPLE_RATE * duration))
    pulse_time = np.arange(round(SAMPLE_RATE * 0.06)) / SAMPLE_RATE
    pulse = np.sin(2 * np.pi * 110 * pulse_time) * np.exp(-pulse_time * 75) * 0.6
    random = np.random.default_rng(79)
    hat = random.normal(0, 0.15, len(pulse))
    hat = np.diff(hat, prepend=hat[:1]) * np.exp(-pulse_time * 100)
    index = 0
    while offset + index * 60 / bpm < duration:
        position = round((offset + index * 60 / bpm) * SAMPLE_RATE)
        count = min(len(pulse), len(samples) - position)
        samples[position:position + count] += pulse[:count]
        if hihat:
            offbeat = round((offset + (index + 0.5) * 60 / bpm) * SAMPLE_RATE)
            if offbeat < len(samples):
                count = min(len(hat), len(samples) - offbeat)
                samples[offbeat:offbeat + count] += hat[:count] * 2
        index += 1
    return samples


@pytest.mark.parametrize("bpm,offset", [(165, 0.173), (120, 0.091)])
def test_finds_nonzero_attack_anchor_from_pcm(tmp_path, bpm, offset):
    path = tmp_path / "phase.wav"
    write_audio(path, offset_pulses(bpm, offset))
    result = analyze_alignment(path, bpm)
    assert result.status == "detected", result
    assert result.anchor_seconds == pytest.approx(offset, abs=0.004)
    assert result.bpm == pytest.approx(bpm, abs=0.01)
    assert result.drift_ms < 4


def test_refines_three_minute_period_without_drift(tmp_path):
    path = tmp_path / "long.wav"
    write_audio(path, offset_pulses(165, 0.173, 180))
    result = analyze_alignment(path, 164.93)
    assert result.status == "detected", result
    assert result.bpm == pytest.approx(165, abs=0.002)
    predicted_last = result.anchor_seconds + 490 * 60 / result.bpm
    actual_last = 0.173 + 490 * 60 / 165
    assert abs(predicted_last - actual_last) < 0.004


def test_louder_high_frequency_offbeats_do_not_replace_kick_phase(tmp_path):
    path = tmp_path / "hihat.wav"
    write_audio(path, offset_pulses(165, 0.173, hihat=True))
    result = analyze_alignment(path, 165)
    assert result.anchor_seconds is not None
    period = 60 / 165
    error = (result.anchor_seconds - 0.173 + period / 2) % period - period / 2
    assert abs(error) < 0.006, result


def test_single_late_attack_does_not_shift_the_fitted_beat_grid(tmp_path):
    samples = offset_pulses(165, 0.173)
    start = round(0.173 * SAMPLE_RATE)
    length = round(0.06 * SAMPLE_RATE)
    pulse = samples[start:start + length].copy()
    samples[start:start + length] = 0
    delay = round(0.025 * SAMPLE_RATE)
    samples[start + delay:start + delay + length] = pulse
    path = tmp_path / "late-first-attack.wav"
    write_audio(path, samples)
    result = analyze_alignment(path, 165)
    period = 60 / result.bpm
    error = (result.anchor_seconds - 0.173 + period / 2) % period - period / 2
    assert abs(error) < 0.004, result


def test_changing_tempo_is_reported_with_low_alignment_confidence(tmp_path):
    path = tmp_path / "unstable.wav"
    write_audio(path, np.concatenate([offset_pulses(bpm, 0.173, 30) for bpm in (165, 167, 163)]))
    result = analyze_alignment(path, 165)
    assert result.status != "detected", result
    assert result.confidence < 0.6


@pytest.mark.parametrize("kind", ["silence", "tone"])
def test_no_anchor_for_non_rhythmic_material(tmp_path, kind):
    samples = np.zeros(SAMPLE_RATE * 12)
    if kind == "tone":
        samples = np.sin(np.arange(len(samples)) / SAMPLE_RATE * 2 * np.pi * 440) * 0.5
    path = tmp_path / "weak.wav"
    write_audio(path, samples)
    result = analyze_alignment(path, 165)
    assert result.anchor_seconds is None
    assert result.status == "unavailable"
