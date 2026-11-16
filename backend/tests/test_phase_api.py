import io
import json
import threading
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from backend import storage
from backend.alignment import analyze_alignment
from backend.audio import SAMPLE_RATE
from backend.models import Alignment, Tempo
from backend.tests.test_alignment import offset_pulses
from backend.tests.test_api import client, read_samples, upload
from backend.tests.test_tempo import write_audio


def import_offset_pulses(client, tmp_path, bpm=120, duration=24):
    path = tmp_path / "offset.wav"
    write_audio(path, offset_pulses(bpm, 0.173, duration))
    response = client.post("/api/tracks/upload", files={"file": (path.name, path.read_bytes(), "audio/wav")})
    assert response.status_code == 200, response.text
    return response.json()


def remove_metadata_field(client, track, field):
    metadata = client.app.state.library.tracks_dir / track["id"] / "metadata.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    data.pop(field)
    metadata.write_text(json.dumps(data), encoding="utf-8")


def test_import_measures_pcm_phase_and_refines_automatic_bpm(client, tmp_path):
    track = import_offset_pulses(client, tmp_path, 165, 90)
    assert track["alignment"]["status"] == "detected"
    assert track["alignment"]["anchor_seconds"] == pytest.approx(0.173, abs=0.004)
    assert track["tempo"]["bpm"] == track["alignment"]["bpm"]
    assert track["tempo"]["bpm"] == pytest.approx(165, abs=0.003)
    assert track["tempo"]["source"] == "analysis"


def test_uncertain_phase_with_stable_period_can_refine_automatic_bpm(client, monkeypatch):
    track = upload(client)
    remove_metadata_field(client, track, "tempo")
    monkeypatch.setattr(storage, "analyze_tempo", lambda path: Tempo(bpm=149.98, confidence=0.58, status="uncertain"))
    alignment = Alignment(anchor_seconds=0.173, bpm=149.998, confidence=0.16, drift_ms=14, status="uncertain")
    monkeypatch.setattr(storage, "analyze_alignment", lambda path, bpm: alignment)
    result = client.post(f"/api/tracks/{track['id']}/analyze").json()
    assert result["tempo"]["bpm"] == 149.998
    assert result["tempo"]["status"] == "uncertain"
    assert result["alignment"]["status"] == "uncertain"


@pytest.mark.parametrize("confidence,drift,bpm", [(0.01, 14, 149.998), (0.16, 45, 149.998), (0.16, 14, 145)])
def test_weak_unstable_or_different_period_does_not_refine_bpm(client, monkeypatch, confidence, drift, bpm):
    track = upload(client)
    remove_metadata_field(client, track, "tempo")
    monkeypatch.setattr(storage, "analyze_tempo", lambda path: Tempo(bpm=149.98, confidence=0.58, status="uncertain"))
    alignment = Alignment(anchor_seconds=0.173, bpm=bpm, confidence=confidence, drift_ms=drift, status="uncertain")
    monkeypatch.setattr(storage, "analyze_alignment", lambda path, value: alignment)
    assert client.post(f"/api/tracks/{track['id']}/analyze").json()["tempo"]["bpm"] == 149.98


@pytest.mark.parametrize("source", ["adapted", "manual"])
def test_adapted_period_precision_controls_new_speed_and_manual_bpm_has_priority(client, monkeypatch, source):
    original = upload(client)
    client.patch(f"/api/tracks/{original['id']}/tempo", json={"bpm": 120})
    first = client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 180, "reference_cadence": 120}).json()
    metadata = client.app.state.library.tracks_dir / first["id"] / "metadata.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    data["tempo"]["source"] = source
    data["alignment"] = Alignment(anchor_seconds=0.173, bpm=180.03, confidence=0.16, drift_ms=14, status="uncertain").model_dump()
    metadata.write_text(json.dumps(data), encoding="utf-8")
    captured_speeds = []
    actual_change = storage.change_tempo

    def capture_change(path, destination, speed):
        captured_speeds.append(speed)
        actual_change(path, destination, speed)

    monkeypatch.setattr(storage, "change_tempo", capture_change)
    response = client.post(f"/api/tracks/{first['id']}/adapt", json={"cadence": 180, "reference_cadence": 180})
    assert response.status_code == 200, response.text
    expected = 1.5 * 180 / 180.03 if source == "adapted" else 1.5
    assert captured_speeds == [pytest.approx(expected)]
    assert response.json()["tempo"]["bpm"] == 180
    assert response.json()["adaptation"]["reference_cadence"] == 180


def test_adapt_keeps_requested_tempo_family_when_legacy_backfill_refines_bpm(client, monkeypatch):
    original = upload(client)
    metadata = client.app.state.library.tracks_dir / original["id"] / "metadata.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    data["tempo"] = Tempo(bpm=149.8, confidence=0.58, status="uncertain").model_dump()
    data.pop("alignment")
    metadata.write_text(json.dumps(data), encoding="utf-8")
    alignment = Alignment(anchor_seconds=0.173, bpm=149.998, confidence=0.16, drift_ms=14, status="uncertain")
    monkeypatch.setattr(storage, "analyze_alignment", lambda path, bpm: alignment)
    response = client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 180, "reference_cadence": 149.8})
    assert response.status_code == 200, response.text
    assert response.json()["adaptation"]["speed"] == pytest.approx(180 / 149.998)
    assert response.json()["adaptation"]["reference_cadence"] == 149.8


def test_adaptation_reanalyzes_actual_atempo_pcm(client, tmp_path):
    original = import_offset_pulses(client, tmp_path)
    corrected = client.patch(f"/api/tracks/{original['id']}/tempo", json={"bpm": 120}).json()
    response = client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 165, "reference_cadence": 120})
    assert response.status_code == 200, response.text
    adapted = response.json()
    actual = analyze_alignment(client.app.state.library.track_path(adapted["id"]), adapted["tempo"]["bpm"])
    assert adapted["alignment"] == actual.model_dump()
    assert actual.anchor_seconds is not None
    scaled_anchor = corrected["alignment"]["anchor_seconds"] / adapted["adaptation"]["speed"]
    assert abs(actual.anchor_seconds - scaled_anchor) > 0.003
    assert adapted["tempo"]["source"] == "adapted"


def test_legacy_alignment_backfill_reuses_existing_tempo(client, tmp_path, monkeypatch):
    track = import_offset_pulses(client, tmp_path)
    remove_metadata_field(client, track, "alignment")
    assert client.get(f"/api/tracks/{track['id']}").json()["alignment"]["status"] == "pending"
    monkeypatch.setattr(storage, "analyze_tempo", lambda path: pytest.fail("Existing tempo must be reused"))
    response = client.post(f"/api/tracks/{track['id']}/analyze")
    assert response.status_code == 200, response.text
    assert response.json()["alignment"]["status"] == "detected"
    assert response.json()["tempo"] == track["tempo"]


def test_legacy_pending_tempo_refreshes_existing_alignment(client, tmp_path, monkeypatch):
    track = import_offset_pulses(client, tmp_path)
    remove_metadata_field(client, track, "tempo")
    alignment = Alignment(anchor_seconds=0.3, bpm=150, confidence=0.8, drift_ms=2, status="detected")
    monkeypatch.setattr(storage, "analyze_tempo", lambda path: Tempo(bpm=150, confidence=0.9, status="detected"))
    monkeypatch.setattr(storage, "analyze_alignment", lambda path, bpm: alignment)
    response = client.post(f"/api/tracks/{track['id']}/analyze")
    assert response.status_code == 200, response.text
    assert response.json()["alignment"] == alignment.model_dump()
    assert response.json()["tempo"]["bpm"] == 150


def test_manual_bpm_refreshes_alignment_from_actual_file(client, monkeypatch):
    track = upload(client)
    captured = []
    alignment = Alignment(anchor_seconds=0.173, bpm=150, confidence=0.7, drift_ms=4, status="detected")

    def measure(path, bpm):
        captured.append((path, bpm))
        return alignment

    monkeypatch.setattr(storage, "analyze_alignment", measure)
    response = client.patch(f"/api/tracks/{track['id']}/tempo", json={"bpm": 150})
    assert response.status_code == 200, response.text
    assert captured == [(client.app.state.library.track_path(track["id"]), 150)]
    assert response.json()["alignment"] == alignment.model_dump()
    assert response.json()["tempo"]["source"] == "manual"


def test_slow_manual_phase_analysis_cannot_overwrite_newer_manual_bpm(client, monkeypatch):
    track = upload(client)
    library = client.app.state.library
    started = threading.Event()
    release = threading.Event()

    def measure(path, bpm):
        if bpm == 120:
            started.set()
            assert release.wait(5)
        return Alignment(anchor_seconds=bpm / 1000, bpm=bpm, confidence=0.8, drift_ms=2, status="detected")

    monkeypatch.setattr(storage, "analyze_alignment", measure)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(library.set_manual_tempo, track["id"], 120)
        assert started.wait(5)
        latest = library.set_manual_tempo(track["id"], 150)
        release.set()
        assert pending.result(timeout=5) == latest
    assert library.get(track["id"]).alignment.bpm == 150


def test_automatic_alignment_finishing_after_manual_change_keeps_manual_phase(client, monkeypatch):
    track = upload(client)
    remove_metadata_field(client, track, "alignment")
    library = client.app.state.library
    started = threading.Event()
    release = threading.Event()

    def measure(path, bpm):
        if bpm is None:
            started.set()
            assert release.wait(5)
            return Alignment(status="unavailable")
        return Alignment(anchor_seconds=0.25, bpm=bpm, confidence=0.8, drift_ms=2, status="detected")

    monkeypatch.setattr(storage, "analyze_alignment", measure)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(library.analyze, track["id"])
        assert started.wait(5)
        latest = library.set_manual_tempo(track["id"], 150)
        release.set()
        assert pending.result(timeout=5) == latest
    assert library.get(track["id"]).alignment.anchor_seconds == 0.25


def test_chunk_returns_exact_stereo_pcm_range_and_truncates_eof(client):
    track = upload(client, duration=6)
    source = read_samples(client.get(track["preview_url"]).content)
    response = client.get(f"/api/media/{track['id']}/chunk", params={"start_frame": 1234, "frame_count": 777})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(response.content), "rb") as stream:
        assert (stream.getnchannels(), stream.getsampwidth(), stream.getframerate()) == (2, 2, SAMPLE_RATE)
    assert np.array_equal(read_samples(response.content), source[1234:2011])
    response = client.get(f"/api/media/{track['id']}/chunk", params={"start_frame": len(source) - 19, "frame_count": 220500})
    assert response.status_code == 200
    assert np.array_equal(read_samples(response.content), source[-19:])
    response = client.get(f"/api/media/{track['id']}/chunk", params={"start_frame": 0})
    assert len(read_samples(response.content)) == 220500
    assert len(response.content) <= 44 + 220500 * 4
    assert client.get(f"/api/media/{track['id']}/chunk", params={"start_frame": len(source)}).status_code == 416


@pytest.mark.parametrize("params", [{"start_frame": -1}, {"start_frame": 1.5}, {"frame_count": 0}, {"frame_count": 441001}])
def test_chunk_rejects_invalid_ranges(client, params):
    track = upload(client)
    assert client.get(f"/api/media/{track['id']}/chunk", params=params).status_code == 422


@pytest.mark.parametrize("track_id", ["invalid", "f" * 32])
def test_chunk_rejects_missing_media(client, track_id):
    assert client.get(f"/api/media/{track_id}/chunk", params={"start_frame": 0}).status_code == 404
