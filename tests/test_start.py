from types import SimpleNamespace

import start


def test_setup_recovers_an_environment_without_pip(tmp_path, monkeypatch):
    environment = tmp_path / ".venv"
    environment.mkdir()
    interpreter = environment / "python"
    interpreter.touch()
    (tmp_path / "requirements.txt").write_text("fastapi\n")
    built = tmp_path / "frontend" / "dist"
    built.mkdir(parents=True)
    (built / "index.html").write_text("ready")
    monkeypatch.setattr(start, "ROOT", tmp_path)
    monkeypatch.setattr(start, "VENV", environment)
    monkeypatch.setattr(start, "PYTHON", interpreter)
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=1 if command[-1] == "--version" else 0)

    monkeypatch.setattr(start.subprocess, "run", run)
    start.setup(force=False)
    assert calls[1][2] == "ensurepip"
    assert calls[2][2:4] == ["pip", "install"]
    assert (environment / ".requirements.sha256").exists()


def test_browser_waits_for_this_server_to_start(monkeypatch):
    server = SimpleNamespace(started=False, should_exit=False)
    opened = []
    monkeypatch.setattr(start.webbrowser, "open", opened.append)
    monkeypatch.setattr(start.time, "sleep", lambda _: setattr(server, "should_exit", True))
    start.open_when_ready(server, "http://127.0.0.1:8765")
    assert opened == []


def test_browser_opens_after_this_server_starts(monkeypatch):
    server = SimpleNamespace(started=True, should_exit=False)
    opened = []
    monkeypatch.setattr(start.webbrowser, "open", opened.append)
    start.open_when_ready(server, "http://127.0.0.1:8765")
    assert opened == ["http://127.0.0.1:8765"]
