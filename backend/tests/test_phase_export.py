import json
import threading
import time
import wave

import numpy as np
import pytest

from backend import jobs
from backend.audio import (
    SAMPLE_RATE,
    beat_positions,
    normalize_audio,
    render_metronome,
    tone_samples,
)
from backend.models import ExportRequest
from backend.tests.test_api import client, read_samples, upload


def set_anchor(client, track, anchor):
    metadata = client.app.state.library.tracks_dir / track["id"] / "metadata.json"
    record = json.loads(metadata.read_text(encoding="utf-8"))
    record["alignment"] = {
        "anchor_seconds": anchor,
        "bpm": 165,
        "confidence": 1,
        "drift_ms": 0,
        "status": "detected",
    }
    metadata.write_text(json.dumps(record), encoding="utf-8")


def wait_for_job(client, job):
    deadline = time.monotonic() + 30
    while job["status"] in ("queued", "processing") and time.monotonic() < deadline:
        time.sleep(0.02)
        response = client.get(f"/api/exports/{job['id']}")
        assert response.status_code == 200
        job = response.json()
    assert job["status"] == "completed", job
    return job


def export_audio(client, ordered_tracks, **settings):
    response = client.post("/api/exports", json={
        "tracks": [{"id": track["id"]} for track in ordered_tracks],
        "cadence": 165,
        "tone": "wood",
        "bgm_volume": 0,
        "beat_volume": 0.4,
        "format": "wav",
        **settings,
    })
    assert response.status_code == 200, response.text
    job = wait_for_job(client, response.json())
    output = client.get(job["download_url"])
    assert output.status_code == 200
    return output.content, job


def expected_clicks(frame_count, cadence, segments):
    expected = np.zeros(frame_count, dtype=np.int16)
    tone = (tone_samples("wood") * 32767).astype("<i2")
    period = 60 / cadence
    for start, end, phase in segments:
        index = 0
        while True:
            position = start + round(((phase % period) + index * period) * SAMPLE_RATE)
            if position >= end:
                break
            length = min(len(tone), end - position)
            expected[position:position + length] = tone[:length]
            index += 1
    return expected


@pytest.mark.parametrize("cadence,phase", [(165, 0.173), (82.5, -0.121), (165, 1.173)])
def test_phase_grid_uses_absolute_sample_positions(cadence, phase):
    frame_count = 30 * 60 * SAMPLE_RATE
    positions = list(beat_positions(frame_count, cadence, phase_seconds=phase))
    period = 60 / cadence
    expected = [round(((phase % period) + index * period) * SAMPLE_RATE) for index in range(len(positions))]
    assert positions == expected
    assert all(position < frame_count for position in positions)


def test_segment_rendering_resets_phase_and_clips_tail_before_gap(tmp_path):
    first_end = round(0.94 * SAMPLE_RATE)
    second_start = first_end + round(0.7 * SAMPLE_RATE)
    frame_count = second_start + round(1.03 * SAMPLE_RATE)
    segments = [(0, first_end, 0.173), (second_start, frame_count, 0.281)]
    destination = tmp_path / "segmented.wav"
    render_metronome(
        destination, frame_count, 165, "wood", threading.Event(), segments=segments,
    )
    with wave.open(str(destination), "rb") as stream:
        actual = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2")
    assert np.array_equal(actual, expected_clicks(frame_count, 165, segments))
    assert not np.any(actual[first_end:second_start])
    assert np.any(actual[first_end - 200:first_end])


@pytest.mark.parametrize("offsets", [(0, -250), (130, 190), (-1000, 1000)])
def test_wav_export_has_independent_track_phases_and_completely_silent_gap(client, offsets):
    first = upload(client, duration=0.94)
    second = upload(client, duration=1.03)
    set_anchor(client, first, 0.173)
    set_anchor(client, second, 0.281)
    references = [
        {"id": first["id"], "phase_offset_ms": offsets[0]},
        {"id": second["id"], "phase_offset_ms": offsets[1]},
    ]
    content, job = export_audio(client, [first, second], tracks=references, gap_seconds=0.7)
    actual = read_samples(content)
    first_end = round(first["duration"] * SAMPLE_RATE)
    second_start = first_end + round(0.7 * SAMPLE_RATE)
    frame_count = second_start + round(second["duration"] * SAMPLE_RATE)
    segments = [
        (0, first_end, 0.173 + offsets[0] / 1000),
        (second_start, frame_count, 0.281 + offsets[1] / 1000),
    ]
    expected = expected_clicks(frame_count, 165, segments).astype(float) * 0.4
    assert actual.shape == (frame_count, 2)
    assert np.max(np.abs(actual[:, 0].astype(float) - expected)) <= 2
    assert np.array_equal(actual[:, 0], actual[:, 1])
    assert not np.any(actual[first_end:second_start])
    directory = client.app.state.library.exports_dir / job["id"]
    assert sorted(path.name for path in directory.iterdir()) == ["stridemix.wav"]


@pytest.mark.parametrize("count", [1, 3])
def test_default_gap_is_two_seconds_only_between_tracks_and_keeps_bgm_order(client, count):
    first = upload(client, 440, 0.35)
    second = upload(client, 880, 0.55)
    ordered = [first] if count == 1 else [second, first, second]
    content, _ = export_audio(client, ordered, bgm_volume=0.5, beat_volume=0)
    actual = read_samples(content)
    expected_parts = []
    for index, track in enumerate(ordered):
        if index:
            expected_parts.append(np.zeros((2 * SAMPLE_RATE, 2)))
        original = read_samples(client.get(track["preview_url"]).content)
        expected_parts.append(original.astype(float) * 0.5)
    expected = np.concatenate(expected_parts)
    assert actual.shape == expected.shape
    assert np.max(np.abs(actual.astype(float) - expected)) <= 2


def test_queued_export_snapshots_metadata_offsets_duration_and_gap(client, monkeypatch):
    first = upload(client, duration=0.81)
    second = upload(client, duration=0.93)
    set_anchor(client, first, 0.173)
    set_anchor(client, second, 0.279)
    entered = threading.Event()
    resume = threading.Event()
    original_renderer = jobs.render_metronome

    def pause_before_render(*args, **kwargs):
        entered.set()
        assert resume.wait(10)
        return original_renderer(*args, **kwargs)

    monkeypatch.setattr(jobs, "render_metronome", pause_before_render)
    request = ExportRequest(
        tracks=[
            {"id": first["id"], "phase_offset_ms": 100},
            {"id": second["id"], "phase_offset_ms": -130},
        ],
        cadence=165, tone="wood", bgm_volume=0, beat_volume=0.4,
        gap_seconds=0.7, format="wav",
    )
    manager = client.app.state.jobs
    job = manager.create(request)
    try:
        assert entered.wait(10)
        set_anchor(client, first, 0.01)
        set_anchor(client, second, 0.02)
        request.tracks[0].phase_offset_ms = -900
        request.cadence = 90
        request.gap_seconds = 12
    finally:
        resume.set()
    finished = wait_for_job(client, job.model_dump())
    actual = read_samples(client.get(finished["download_url"]).content)
    first_end = round(first["duration"] * SAMPLE_RATE)
    second_start = first_end + round(0.7 * SAMPLE_RATE)
    frame_count = second_start + round(second["duration"] * SAMPLE_RATE)
    expected = expected_clicks(frame_count, 165, [
        (0, first_end, 0.273), (second_start, frame_count, 0.149),
    ]).astype(float) * 0.4
    assert actual.shape == (frame_count, 2)
    assert np.max(np.abs(actual[:, 0].astype(float) - expected)) <= 2


def test_mp3_gap_export_remains_playable_with_silent_gap_interior(client, tmp_path):
    first = upload(client, duration=1.01)
    second = upload(client, duration=1.03)
    set_anchor(client, first, 0.173)
    set_anchor(client, second, 0.281)
    content, _ = export_audio(client, [first, second], gap_seconds=0.7, format="mp3", bgm_volume=0.3)
    source = tmp_path / "mixed.mp3"
    source.write_bytes(content)
    decoded = tmp_path / "decoded.wav"
    normalize_audio(source, decoded)
    actual = read_samples(decoded.read_bytes())
    expected_frames = round((1.01 + 0.7 + 1.03) * SAMPLE_RATE)
    assert abs(len(actual) - expected_frames) < 100
    interior_start = round((1.01 + 0.1) * SAMPLE_RATE)
    interior_end = round((1.01 + 0.7 - 0.1) * SAMPLE_RATE)
    assert np.max(np.abs(actual[interior_start:interior_end])) <= 2
