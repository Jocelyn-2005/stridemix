import wave

import numpy as np
import pytest

from backend.audio import SAMPLE_RATE, AudioError
from backend.rhythm import rhythm_window
from backend.tests.test_alignment import offset_pulses
from backend.tests.test_tempo import write_audio


def test_actual_nonzero_attacks_use_absolute_file_times(tmp_path):
    path = tmp_path / "attacks.wav"
    write_audio(path, offset_pulses(165, 0.173, 18))
    result = rhythm_window(path, start_seconds=5.2, duration_seconds=6, bpm=165)

    assert result["start_seconds"] == pytest.approx(5.2, abs=1 / SAMPLE_RATE)
    assert result["duration_seconds"] == pytest.approx(6)
    assert 1 <= len(result["envelope"]) <= 512
    assert all(0 <= value <= 1 for value in result["envelope"])
    expected = [0.173 + index * 60 / 165 for index in range(50) if 5.2 <= 0.173 + index * 60 / 165 < 11.2]
    assert len(result["onsets"]) == len(expected), result
    for onset, time in zip(result["onsets"], expected):
        assert onset["time"] == pytest.approx(time, abs=0.006)
        assert 0 < onset["strength"] <= 1
        assert onset["strong"]
    assert result["reliability"] >= 0.7


def test_loud_high_frequency_offbeats_are_visible_without_becoming_strong_kicks(tmp_path):
    path = tmp_path / "offbeats.wav"
    write_audio(path, offset_pulses(165, 0.173, 12, hihat=True))
    result = rhythm_window(path, bpm=165)
    assert result["reliability"] >= 0.5
    for index in range(30):
        kick = 0.173 + index * 60 / 165
        hat = kick + 30 / 165
        kick_node = min(result["onsets"], key=lambda node: abs(node["time"] - kick))
        hat_node = min(result["onsets"], key=lambda node: abs(node["time"] - hat))
        assert kick_node["time"] == pytest.approx(kick, abs=0.008)
        assert kick_node["strong"]
        assert hat_node["time"] == pytest.approx(hat, abs=0.012)
        assert not hat_node["strong"]


def test_antiphase_stereo_keeps_real_attacks(tmp_path):
    path = tmp_path / "antiphase.wav"
    samples = offset_pulses(120, 0.091, 12)
    stereo = np.column_stack([samples, -samples])
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes((stereo * 32767).astype("<i2").tobytes())
    result = rhythm_window(path, bpm=120)
    assert result["onsets"][0]["time"] == pytest.approx(0.091, abs=0.006)
    assert result["reliability"] >= 0.7


@pytest.mark.parametrize("duration", [0.4, 12])
@pytest.mark.parametrize("kind", ["silence", "tone"])
def test_nonrhythmic_pcm_has_no_invented_drum_nodes_or_reliability(tmp_path, duration, kind):
    samples = np.zeros(round(SAMPLE_RATE * duration))
    if kind == "tone":
        samples = np.sin(np.arange(len(samples)) * 2 * np.pi * 440 / SAMPLE_RATE) * 0.5
    path = tmp_path / "weak.wav"
    write_audio(path, samples)
    result = rhythm_window(path, bpm=165)
    assert result["onsets"] == []
    assert result["reliability"] == 0
    assert result["duration_seconds"] == pytest.approx(duration)
    if kind == "silence":
        assert max(result["envelope"], default=0) == 0
    else:
        assert max(result["envelope"]) > 0


def test_short_recording_can_show_attack_with_insufficient_scoring_evidence(tmp_path):
    path = tmp_path / "short.wav"
    write_audio(path, offset_pulses(165, 0.173, 0.35))
    result = rhythm_window(path, bpm=165)
    assert len(result["onsets"]) == 1
    assert result["onsets"][0]["time"] == pytest.approx(0.173, abs=0.006)
    assert result["reliability"] == 0


def test_periodic_drums_can_be_inspected_without_known_bpm(tmp_path):
    path = tmp_path / "unknown.wav"
    write_audio(path, offset_pulses(120, 0.091, 12))
    result = rhythm_window(path)
    assert len(result["onsets"]) >= 20
    assert result["reliability"] >= 0.7


def test_request_at_eof_returns_last_bounded_window(tmp_path):
    path = tmp_path / "end.wav"
    write_audio(path, offset_pulses(120, 0.091, 18))
    result = rhythm_window(path, start_seconds=99, duration_seconds=6, bpm=120)
    assert result["start_seconds"] == pytest.approx(12)
    assert result["duration_seconds"] == pytest.approx(6)
    assert all(12 <= onset["time"] < 18 for onset in result["onsets"])


def test_window_duration_stays_bounded_and_rejects_invalid_inputs(tmp_path):
    path = tmp_path / "bounded.wav"
    write_audio(path, offset_pulses(120, 0.091, 40))
    result = rhythm_window(path, duration_seconds=600, bpm=120)
    assert result["duration_seconds"] <= 30
    assert len(result["envelope"]) <= 512
    with pytest.raises(AudioError):
        rhythm_window(path, start_seconds=float("nan"))
    with pytest.raises(AudioError):
        rhythm_window(path, duration_seconds=-1)


def test_unsupported_pcm_format_reports_audio_error(tmp_path):
    path = tmp_path / "wrong-rate.wav"
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(22050)
        stream.writeframes(bytes(22050 * 2))
    with pytest.raises(AudioError):
        rhythm_window(path)
