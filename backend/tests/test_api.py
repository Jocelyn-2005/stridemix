import io
import threading
import time
import wave
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.audio import SAMPLE_RATE, audio_frame_count
from backend.sources import validate_url


def sine_wav(frequency: float, duration: float) -> bytes:
    time_axis = np.arange(round(SAMPLE_RATE * duration)) / SAMPLE_RATE
    mono = (np.sin(time_axis * 2 * np.pi * frequency) * 6000).astype("<i2")
    stereo = np.repeat(mono[:, None], 2, axis=1)
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes(stereo.tobytes())
    return output.getvalue()


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "media")) as session:
        yield session


def upload(client: TestClient, frequency=440, duration=0.5):
    response = client.post("/api/tracks/upload", files={"file": ("test.wav", sine_wav(frequency, duration), "audio/wav")})
    assert response.status_code == 200, response.text
    return response.json()


def export(client: TestClient, tracks, **settings):
    request = {
        "tracks": [{"id": track["id"]} for track in tracks],
        "cadence": 165,
        "tone": "wood",
        "bgm_volume": 0.5,
        "beat_volume": 0,
        "format": "wav",
        "gap_seconds": 0,
        **settings,
    }
    response = client.post("/api/exports", json=request)
    assert response.status_code == 200, response.text
    job = response.json()
    deadline = time.monotonic() + 30
    while job["status"] in ("queued", "processing") and time.monotonic() < deadline:
        time.sleep(0.05)
        job = client.get(f"/api/exports/{job['id']}").json()
    assert job["status"] == "completed", job
    response = client.get(job["download_url"])
    assert response.status_code == 200
    return response.content


def read_samples(data: bytes):
    with wave.open(io.BytesIO(data), "rb") as stream:
        channels = stream.getnchannels()
        count = stream.getnframes()
        return np.frombuffer(stream.readframes(count), dtype="<i2").reshape(-1, channels)


def test_upload_lists_persistently_and_streams_ranges(client):
    track = upload(client)
    assert track["title"] == "test"
    assert track["duration"] == 0.5
    assert len(track["waveform"]) == 80
    assert client.get("/api/tracks").json() == [track]
    ranged = client.get(track["preview_url"], headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206
    assert len(ranged.content) == 100


def test_export_preserves_order_repeats_duration_and_bgm_gain(client):
    first = upload(client, 440, 0.35)
    second = upload(client, 880, 0.55)
    actual = read_samples(export(client, [second, first, second]))
    expected = np.concatenate([
        read_samples(client.get(second["preview_url"]).content),
        read_samples(client.get(first["preview_url"]).content),
        read_samples(client.get(second["preview_url"]).content),
    ])
    assert actual.shape == expected.shape
    assert np.max(np.abs(actual.astype(np.float64) - expected * 0.5)) <= 2


def test_both_volumes_zero_produces_silence(client):
    track = upload(client)
    actual = read_samples(export(client, [track], bgm_volume=0, beat_volume=0))
    assert np.max(np.abs(actual)) == 0


def test_metronome_remains_when_bgm_is_muted(client):
    track = upload(client, duration=1)
    actual = read_samples(export(client, [track], bgm_volume=0, beat_volume=0.5))
    assert np.max(np.abs(actual[:4000])) > 1000
    assert np.max(np.abs(actual[6000:12000])) == 0
    next_position = round(SAMPLE_RATE * 60 / 165)
    assert np.max(np.abs(actual[next_position:next_position + 4000])) > 1000


def test_mp3_export_is_playable_and_downloadable(client, tmp_path):
    track = upload(client)
    content = export(client, [track], format="mp3", beat_volume=0.5)
    assert len(content) > 1000
    from backend.audio import normalize_audio
    source = tmp_path / "output.mp3"
    source.write_bytes(content)
    decoded = tmp_path / "decoded.wav"
    normalize_audio(source, decoded)
    assert abs(audio_frame_count(decoded) - SAMPLE_RATE * 0.5) < 100


def test_invalid_requests_and_missing_tracks_fail_cleanly(client, monkeypatch):
    response = client.post("/api/exports", json={"tracks": [{"id": "a" * 32}], "cadence": 165})
    assert response.status_code == 404
    response = client.post("/api/exports", json={"tracks": [], "cadence": 0})
    assert response.status_code == 422
    response = client.get("/api/media/not-a-valid-id")
    assert response.status_code == 404
    assert client.get("/api/tones/unknown.wav").status_code == 404
    assert client.get("/api/does-not-exist").status_code == 404
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    response = client.post("/api/tracks/generate", json={"prompt": "ambient running music", "duration": 30})
    assert response.status_code == 400
    assert "ELEVENLABS_API_KEY" in response.json()["detail"]


def test_invalid_upload_does_not_leave_half_imported_tracks(client):
    response = client.post("/api/tracks/upload", files={"file": ("broken.mp3", b"invalid audio", "audio/mpeg")})
    assert response.status_code == 400
    assert client.get("/api/tracks").json() == []


def test_cancel_export_reaches_terminal_state(client, monkeypatch):
    from backend import jobs
    from backend.audio import ExportCancelled

    track = upload(client)
    started = threading.Event()

    def wait_for_cancel(path, frames, cadence, tone, cancelled, progress, **kwargs):
        started.set()
        assert cancelled.wait(5)
        raise ExportCancelled()

    monkeypatch.setattr(jobs, "render_metronome", wait_for_cancel)
    job = client.post("/api/exports", json={"tracks": [{"id": track["id"]}]}).json()
    assert started.wait(5)
    assert client.delete(f"/api/exports/{job['id']}").status_code == 200
    deadline = time.monotonic() + 5
    while job["status"] in ("queued", "processing") and time.monotonic() < deadline:
        time.sleep(0.01)
        job = client.get(f"/api/exports/{job['id']}").json()
    assert job["status"] == "cancelled"
    assert client.get(f"/api/exports/{job['id']}/download").status_code == 409


def test_export_directory_failure_is_reported_and_keeps_existing_files(client, monkeypatch):
    from backend import jobs

    track = upload(client)
    job_id = "a" * 32
    existing = client.app.state.library.exports_dir / job_id
    existing.mkdir()
    preserved = existing / "stridemix.mp3"
    preserved.write_bytes(b"existing output")
    monkeypatch.setattr(jobs.uuid, "uuid4", lambda: SimpleNamespace(hex=job_id))
    job = client.post("/api/exports", json={"tracks": [{"id": track["id"]}]}).json()
    deadline = time.monotonic() + 5
    while job["status"] in ("queued", "processing") and time.monotonic() < deadline:
        time.sleep(0.01)
        job = client.get(f"/api/exports/{job['id']}").json()
    assert job["status"] == "failed"
    assert job["error"]
    assert preserved.read_bytes() == b"existing output"


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/a", "http://user:password@example.com/a", "hello"])
def test_video_urls_require_http_without_embedded_credentials(url):
    with pytest.raises(Exception):
        validate_url(url)
