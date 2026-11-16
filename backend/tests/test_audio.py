import threading
import wave

import numpy as np
import pytest

from backend.audio import (
    SAMPLE_RATE,
    ExportCancelled,
    beat_positions,
    mix_audio,
    render_metronome,
    tone_samples,
    write_silence,
)


def test_exact_cadence_has_no_accumulated_rounding():
    positions = list(beat_positions(30 * 60 * SAMPLE_RATE, 165))
    assert len(positions) == 4950
    assert positions[0] == 0
    assert positions[-1] == round(4949 * SAMPLE_RATE * 60 / 165)
    assert max(abs(position - index * SAMPLE_RATE * 60 / 165) for index, position in enumerate(positions)) <= 0.5


def test_tones_are_distinct_and_deterministic():
    tones = [tone_samples(name) for name in ("click", "wood", "rim", "soft", "beep", "shaker")]
    assert all(np.array_equal(samples, tone_samples(name)) for name, samples in zip(("click", "wood", "rim", "soft", "beep", "shaker"), tones))
    assert len({samples.tobytes() for samples in tones}) == 6
    assert all(np.max(np.abs(samples)) <= 0.9 for samples in tones)


def test_metronome_writes_exact_frame_count(tmp_path):
    target = tmp_path / "clicks.wav"
    frame_count = SAMPLE_RATE * 2 + 17
    render_metronome(target, frame_count, 165, "click", threading.Event())
    with wave.open(str(target), "rb") as stream:
        assert stream.getnframes() == frame_count
        assert stream.getframerate() == SAMPLE_RATE
        assert stream.getnchannels() == 1


def test_cancelling_ffmpeg_mix_preserves_cancellation_and_cleans_stderr(tmp_path):
    cancelled = threading.Event()
    frames = 180 * SAMPLE_RATE
    music = tmp_path / "music.wav"
    metronome = tmp_path / "metronome.wav"
    write_silence(music, frames, cancelled)
    write_silence(metronome, frames, cancelled)
    concat = tmp_path / "inputs.txt"
    concat.write_text(f"file '{music.as_posix()}'\n", encoding="utf-8")
    destination = tmp_path / "stridemix.mp3"

    with pytest.raises(ExportCancelled):
        mix_audio(
            concat, metronome, destination, frames, 0.65, 0.55, cancelled,
            lambda fraction: cancelled.set(),
        )

    assert cancelled.is_set()
    assert set(tmp_path.iterdir()) <= {music, metronome, concat, destination}
