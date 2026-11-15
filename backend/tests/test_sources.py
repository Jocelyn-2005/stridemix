import json
from contextlib import closing

import httpx
import pytest

from backend.audio import AudioError
from backend import sources


def test_ai_provider_uses_server_key_and_requested_duration(monkeypatch, tmp_path):
    calls = []

    def mock_stream(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return closing(httpx.Response(200, content=b"generated audio"))

    monkeypatch.setenv("ELEVENLABS_API_KEY", "local-test-key")
    monkeypatch.setattr(sources.httpx, "stream", mock_stream)
    destination = tmp_path / "music.mp3"
    sources.generate_music("轻盈的器乐跑步配乐", 42.5, destination)
    method, url, options = calls[0]
    assert method == "POST"
    assert url == "https://api.elevenlabs.io/v1/music"
    assert options["headers"]["xi-api-key"] == "local-test-key"
    assert options["json"] == {
        "prompt": "轻盈的器乐跑步配乐",
        "music_length_ms": 42500,
        "model_id": "music_v1",
        "force_instrumental": True,
    }
    assert destination.read_bytes() == b"generated audio"


def test_ai_provider_errors_are_explained_without_creating_audio(monkeypatch, tmp_path):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "local-test-key")
    monkeypatch.setattr(sources.httpx, "stream", lambda *args, **kwargs: closing(httpx.Response(401, json={"detail": "invalid API key"})))
    destination = tmp_path / "music.mp3"
    with pytest.raises(AudioError, match="401"):
        sources.generate_music("ambient", 30, destination)
    assert not destination.exists()


def test_search_returns_selectable_versions(monkeypatch):
    def mock_ytdlp(arguments, timeout):
        assert arguments[-1] == "ytsearch5:测试音乐"
        assert "--skip-download" in arguments
        return json.dumps({"entries": [
            {"title": "测试音乐 · 现场版", "url": "https://www.youtube.com/watch?v=example", "duration": 182, "channel": "艺术家"},
            None,
        ]})

    monkeypatch.setattr(sources, "run_ytdlp", mock_ytdlp)
    assert sources.search_music("测试音乐") == [{
        "title": "测试音乐 · 现场版",
        "url": "https://www.youtube.com/watch?v=example",
        "duration": 182,
        "channel": "艺术家",
    }]


def test_video_download_uses_one_source_and_generated_paths(monkeypatch, tmp_path):
    downloaded = tmp_path / "download.webm"
    downloaded.write_bytes(b"audio")
    (tmp_path / "download.info.json").write_text(json.dumps({"title": "视频原声"}), encoding="utf-8")

    def mock_ytdlp(arguments, timeout):
        assert "--no-playlist" in arguments
        assert arguments[-1] == "https://example.com/video"
        return str(downloaded) + "\n"

    monkeypatch.setattr(sources, "run_ytdlp", mock_ytdlp)
    actual, title = sources.download_video("https://example.com/video", tmp_path)
    assert actual == downloaded.resolve()
    assert title == "视频原声"
