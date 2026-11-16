import io
import shutil
import threading
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.audio import SAMPLE_RATE, AudioError
from backend.models import Adaptation, Alignment, Tempo
from backend.storage import MediaLibrary


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "media")) as session:
        yield session


def upload(client):
    output = io.BytesIO()
    samples = (np.sin(np.arange(SAMPLE_RATE // 2) * 440 * 2 * np.pi / SAMPLE_RATE) * 5000).astype("<i2")
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(samples.tobytes())
    response = client.post("/api/tracks/upload", files={"file": ("owned.wav", output.getvalue(), "audio/wav")})
    assert response.status_code == 200, response.text
    return client.app.state.library.get(response.json()["id"])


def variant(library, original):
    track_id = uuid.uuid4().hex
    directory = library.tracks_dir / track_id
    directory.mkdir()
    shutil.copyfile(library.track_path(original.id), directory / "audio.wav")
    adaptation = Adaptation(original_id=original.id, speed=1, reference_cadence=165, target_cadence=165)
    return library._save(original.model_copy(update={
        "id": track_id,
        "title": "owned variant",
        "preview_url": f"/api/media/{track_id}",
        "adaptation": adaptation,
    }))


def test_original_deletion_preview_and_confirm_remove_dependent_versions(client):
    original = upload(client)
    library = client.app.state.library
    adapted = variant(library, original)
    unrelated = upload(client)
    preview = client.get(f"/api/tracks/{original.id}/deletion")
    assert preview.status_code == 200
    assert set(preview.json()["track_ids"]) == {original.id, adapted.id}
    assert set(preview.json()["titles"]) == {original.title, adapted.title}
    response = client.request("DELETE", f"/api/tracks/{original.id}", json={"expected_ids":preview.json()["track_ids"]})
    assert response.status_code == 200, response.text
    assert set(response.json()["deleted_ids"]) == {original.id, adapted.id}
    assert [track["id"] for track in client.get("/api/tracks").json()] == [unrelated.id]
    assert not (library.tracks_dir / original.id).exists()
    assert not (library.tracks_dir / adapted.id).exists()
    assert client.get(f"/api/media/{original.id}").status_code == 404
    assert client.delete(f"/api/tracks/{original.id}").status_code == 200


def test_deleting_variant_keeps_original_and_siblings(client):
    original = upload(client)
    library = client.app.state.library
    first = variant(library, original)
    second = variant(library, original)
    assert client.get(f"/api/tracks/{first.id}/deletion").json()["track_ids"] == [first.id]
    assert client.delete(f"/api/tracks/{first.id}").json() == {"deleted_ids":[first.id]}
    assert {track["id"] for track in client.get("/api/tracks").json()} == {original.id, second.id}


def test_disk_cleanup_delayed_by_file_lock_is_retried_on_reopen(client, monkeypatch):
    original = upload(client)
    library = client.app.state.library
    with monkeypatch.context() as patch:
        patch.setattr(shutil, "rmtree", lambda *args, **kwargs: None)
        assert library.delete(original.id) == [original.id]
    assert len(list(library.tracks_dir.glob(".deleted-*"))) == 1
    reopened = MediaLibrary(library.root)
    assert reopened.list() == []
    assert list(reopened.tracks_dir.glob(".deleted-*")) == []


def test_changed_dependency_set_requires_new_confirmation(client):
    original = upload(client)
    adapted = variant(client.app.state.library, original)
    response = client.request("DELETE", f"/api/tracks/{original.id}", json={"expected_ids":[original.id]})
    assert response.status_code == 409
    assert {track["id"] for track in client.get("/api/tracks").json()} == {original.id, adapted.id}


def test_media_lease_blocks_cascade_until_released(client):
    original = upload(client)
    library = client.app.state.library
    adapted = variant(library, original)
    with library.use_tracks([adapted.id]):
        response = client.delete(f"/api/tracks/{original.id}")
        assert response.status_code == 409
        assert client.get(f"/api/tracks/{adapted.id}").status_code == 200
    assert client.delete(f"/api/tracks/{original.id}").status_code == 200


@pytest.mark.parametrize("failure", [False, True])
def test_queued_export_holds_media_and_terminal_jobs_release_it(client, monkeypatch, failure):
    from backend import jobs

    original = upload(client)
    manager = client.app.state.jobs
    submitted = []
    monkeypatch.setattr(manager.executor, "submit", lambda function, *args: submitted.append((function, args)))
    job = client.post("/api/exports", json={"tracks":[{"id":original.id}], "format":"wav"}).json()
    assert job["status"] == "queued"
    assert client.delete(f"/api/tracks/{original.id}").status_code == 409
    if failure:
        def broken_render(*args, **kwargs):
            raise AudioError("controlled failure")
        monkeypatch.setattr(jobs, "render_metronome", broken_render)
    function, args = submitted[0]
    function(*args)
    final = client.get(f"/api/exports/{job['id']}").json()
    assert final["status"] == ("failed" if failure else "completed")
    assert client.delete(f"/api/tracks/{original.id}").status_code == 200
    if not failure:
        assert client.get(final["download_url"]).status_code == 200


def test_pending_analysis_cannot_be_deleted_mid_read(client, monkeypatch):
    from backend import storage

    original = upload(client)
    library = client.app.state.library
    library._save(original.model_copy(update={"tempo":Tempo(), "alignment":Alignment()}))
    entered = threading.Event()
    finish = threading.Event()

    def slow_analysis(path):
        entered.set()
        assert finish.wait(5)
        return Tempo(status="unavailable")

    monkeypatch.setattr(storage, "analyze_tempo", slow_analysis)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(library.analyze, original.id)
        try:
            assert entered.wait(5)
            assert client.delete(f"/api/tracks/{original.id}").status_code == 409
        finally:
            finish.set()
        pending.result(timeout=5)
    assert client.delete(f"/api/tracks/{original.id}").status_code == 200


def test_directory_rename_failure_rolls_back_the_whole_family(client, monkeypatch):
    from pathlib import Path

    original = upload(client)
    library = client.app.state.library
    adapted = variant(library, original)
    rename = Path.rename
    attempts = 0

    def blocked_second(source, target):
        nonlocal attempts
        if source.parent == library.tracks_dir and source.name in {original.id, adapted.id}:
            attempts += 1
            if attempts == 2:
                raise PermissionError("controlled open file")
        return rename(source, target)

    monkeypatch.setattr(Path, "rename", blocked_second)
    assert client.delete(f"/api/tracks/{original.id}").status_code == 409
    assert {track["id"] for track in client.get("/api/tracks").json()} == {original.id, adapted.id}


@pytest.mark.parametrize("track_id", ["invalid", "..\\tracks", "x" * 32])
def test_invalid_deletion_does_not_touch_the_library(client, track_id):
    original = upload(client)
    assert client.delete(f"/api/tracks/{track_id}").status_code == 404
    assert client.get(f"/api/tracks/{original.id}").status_code == 200
