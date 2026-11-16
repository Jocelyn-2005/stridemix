import json
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from backend import storage
from backend.audio import AudioError, SAMPLE_RATE
from backend.models import Tempo
from backend.tempo import analyze_tempo
from backend.tests.test_api import client, export, read_samples, upload
from backend.tests.test_tempo import pulse_audio, write_audio


def import_pulses(client, tmp_path, bpm=120):
    path = tmp_path / "rhythm.wav"
    write_audio(path, pulse_audio(bpm, 18))
    result = client.post("/api/tracks/upload", files={"file": ("rhythm.wav", path.read_bytes(), "audio/wav")})
    assert result.status_code == 200, result.text
    return result.json()


def set_bpm(client, track, bpm):
    result = client.patch(f"/api/tracks/{track['id']}/tempo", json={"bpm": bpm})
    assert result.status_code == 200, result.text
    return result.json()


def adapt(client, track, cadence, reference):
    result = client.post(f"/api/tracks/{track['id']}/adapt", json={"cadence": cadence, "reference_cadence": reference})
    assert result.status_code == 200, result.text
    return result.json()


def test_import_automatically_analyzes_and_old_metadata_is_compatible(client, tmp_path, monkeypatch):
    track = import_pulses(client, tmp_path)
    assert track["tempo"]["status"] == "detected"
    assert track["tempo"]["bpm"] == pytest.approx(120, abs=1)
    assert track["adaptation"] is None
    metadata = client.app.state.library.tracks_dir / track["id"] / "metadata.json"
    old_record = json.loads(metadata.read_text(encoding="utf-8"))
    old_record.pop("tempo")
    old_record.pop("adaptation")
    metadata.write_text(json.dumps(old_record), encoding="utf-8")
    old_track = client.get(f"/api/tracks/{track['id']}").json()
    assert old_track["tempo"]["status"] == "pending"
    analyzed = client.post(f"/api/tracks/{track['id']}/analyze").json()
    assert analyzed["tempo"]["status"] == "detected"
    monkeypatch.setattr(storage, "analyze_tempo", lambda path: pytest.fail("Cached analysis should be reused"))
    assert client.post(f"/api/tracks/{track['id']}/analyze").json() == analyzed


def test_double_time_reference_does_not_double_audio_speed(client):
    original = upload(client, duration=2)
    original = set_bpm(client, original, 82.5)
    variant = adapt(client, original, 165, 165)
    assert variant["id"] != original["id"]
    assert variant["adaptation"]["speed"] == 1
    assert variant["tempo"]["bpm"] == 82.5
    assert variant["duration"] == original["duration"]
    assert client.get(variant["preview_url"]).content == client.get(original["preview_url"]).content
    assert client.get(original["preview_url"]).status_code == 200


def test_slow_music_uses_half_cadence_musical_tempo(client, tmp_path):
    original = set_bpm(client, import_pulses(client, tmp_path, bpm=40), 40)
    variant = adapt(client, original, 170, 80)
    assert variant["adaptation"]["speed"] == pytest.approx(2.125)
    assert variant["tempo"]["bpm"] == pytest.approx(85, abs=0.01)
    assert variant["duration"] == pytest.approx(original["duration"] / 2.125, abs=0.08)
    measured = analyze_tempo(client.app.state.library.track_path(variant["id"]))
    assert measured.bpm == pytest.approx(85, abs=1)


def test_repeated_adaptation_renders_original_and_preserves_pitch(client, monkeypatch):
    original = set_bpm(client, upload(client, duration=8), 120)
    calls = []
    actual_change = storage.change_tempo

    def capture_change(source, destination, speed):
        calls.append((source, speed))
        actual_change(source, destination, speed)

    monkeypatch.setattr(storage, "change_tempo", capture_change)
    first = adapt(client, original, 165, 120)
    second = adapt(client, first, 180, 165)
    assert second["adaptation"]["original_id"] == original["id"]
    assert second["adaptation"]["speed"] == pytest.approx(1.5)
    assert second["tempo"]["bpm"] == 180
    assert all(source == client.app.state.library.track_path(original["id"]) for source, _ in calls)
    assert second["duration"] == pytest.approx(8 / 1.5, abs=0.06)
    samples = read_samples(client.get(second["preview_url"]).content)[:, 0]
    middle = samples[SAMPLE_RATE:3 * SAMPLE_RATE].astype(float)
    spectrum = np.abs(np.fft.rfft(middle * np.hanning(len(middle))))
    dominant = np.argmax(spectrum) * SAMPLE_RATE / len(middle)
    assert dominant == pytest.approx(440, abs=1)
    exported = read_samples(export(client, [second], bgm_volume=0.5, beat_volume=0))
    assert len(exported) == len(samples)


def test_manual_correction_on_variant_controls_next_total_speed(client):
    original = set_bpm(client, upload(client, duration=8), 120)
    first = adapt(client, original, 165, 120)
    corrected = set_bpm(client, first, 160)
    assert corrected["tempo"]["source"] == "manual"
    second = adapt(client, corrected, 180, 160)
    assert second["adaptation"]["speed"] == pytest.approx(1.375 * 1.125)
    assert second["tempo"]["bpm"] == 180
    assert second["duration"] == pytest.approx(8 / (1.375 * 1.125), abs=0.06)
    assert client.get(f"/api/tracks/{original['id']}").json()["tempo"]["bpm"] == 120


def test_half_time_reference_and_actual_stretched_rhythm(client, tmp_path):
    original = import_pulses(client, tmp_path, 165)
    original = set_bpm(client, original, 165)
    variant = adapt(client, original, 100, 82.5)
    assert variant["tempo"]["bpm"] == 200
    assert variant["adaptation"]["speed"] == pytest.approx(100 / 82.5)
    actual = analyze_tempo(client.app.state.library.track_path(variant["id"]))
    assert actual.bpm is not None
    # The detector may select the half-time family for faster rhythms.
    assert min(abs(actual.bpm - 200), abs(actual.bpm * 2 - 200)) < 2


def test_all_import_processing_has_bounded_concurrency(client, tmp_path, monkeypatch):
    source = tmp_path / "source.wav"
    write_audio(source, pulse_audio(120, 1))
    active = 0
    maximum = 0
    lock = threading.Lock()

    def delayed_analysis(path):
        import time

        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return Tempo(status="unavailable")

    monkeypatch.setattr(storage, "analyze_tempo", delayed_analysis)
    library = client.app.state.library
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda index: library.import_file(source, f"track {index}", "本地"), range(4)))
    assert len({track.id for track in results}) == 4
    assert maximum <= 2
    assert len(library.list()) == 4


def test_invalid_reference_and_missing_bpm_fail_without_creating_variants(client):
    original = upload(client)
    result = client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 165, "reference_cadence": 120})
    assert result.status_code == 400
    set_bpm(client, original, 120)
    result = client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 165, "reference_cadence": 166})
    assert result.status_code == 400
    assert len(client.get("/api/tracks").json()) == 1
    assert client.patch(f"/api/tracks/{original['id']}/tempo", json={"bpm": 0}).status_code == 422
    assert client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 0, "reference_cadence": 120}).status_code == 422
    assert client.post(f"/api/tracks/{'f' * 32}/analyze").status_code == 404


def test_failed_transform_removes_partial_variant(client, monkeypatch):
    original = set_bpm(client, upload(client), 120)
    original_directories = set(client.app.state.library.tracks_dir.iterdir())

    def fail_transform(source, destination, speed):
        destination.write_bytes(b"partial")
        raise AudioError("模拟转换失败")

    monkeypatch.setattr(storage, "change_tempo", fail_transform)
    result = client.post(f"/api/tracks/{original['id']}/adapt", json={"cadence": 165, "reference_cadence": 120})
    assert result.status_code == 400
    assert set(client.app.state.library.tracks_dir.iterdir()) == original_directories


def test_analysis_finishing_after_manual_correction_keeps_manual(client, monkeypatch):
    original = upload(client)
    library = client.app.state.library
    metadata = library.tracks_dir / original["id"] / "metadata.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    data.pop("tempo")
    metadata.write_text(json.dumps(data), encoding="utf-8")
    started = threading.Event()
    finish = threading.Event()

    def delayed_analysis(path):
        started.set()
        assert finish.wait(5)
        return Tempo(bpm=120, confidence=0.9, status="detected")

    monkeypatch.setattr(storage, "analyze_tempo", delayed_analysis)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(library.analyze, original["id"])
        assert started.wait(5)
        manual = library.set_manual_tempo(original["id"], 150)
        finish.set()
        assert pending.result(timeout=5).tempo == manual.tempo
    assert library.get(original["id"]).tempo.source == "manual"
    assert not list(metadata.parent.glob("*.tmp"))
