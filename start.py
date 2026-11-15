"""Set up and run StrideMix on this computer."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import venv
import webbrowser


ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup(force: bool) -> None:
    if not PYTHON.exists():
        print("Creating the project Python environment...", flush=True)
        venv.create(VENV, with_pip=False)

    temporary = VENV / "tmp"
    temporary.mkdir(exist_ok=True)
    install_environment = {**os.environ, "TEMP": str(temporary), "TMP": str(temporary), "TMPDIR": str(temporary)}
    pip_check = subprocess.run(
        [str(PYTHON), "-m", "pip", "--version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if pip_check.returncode:
        subprocess.run(
            [str(PYTHON), "-m", "ensurepip", "--upgrade", "--default-pip"],
            check=True,
            env=install_environment,
        )

    requirements = ROOT / "requirements.txt"
    fingerprint = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = VENV / ".requirements.sha256"
    installed = marker.read_text().strip() if marker.exists() else ""
    if force or installed != fingerprint:
        print("Installing audio dependencies...", flush=True)
        subprocess.run(
            [str(PYTHON), "-m", "pip", "install", "-r", str(requirements)],
            check=True,
            cwd=ROOT,
            env=install_environment,
        )
        marker.write_text(fingerprint, encoding="utf-8")

    if force or not (ROOT / "frontend/dist/index.html").exists():
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        if npm is None:
            raise RuntimeError("Install Node.js 22.12+ from https://nodejs.org, then run again.")
        frontend = ROOT / "frontend"
        install = "ci" if (frontend / "package-lock.json").exists() else "install"
        print("Building the editor...", flush=True)
        subprocess.run([npm, install], cwd=frontend, check=True)
        subprocess.run([npm, "run", "build"], cwd=frontend, check=True)


def open_when_ready(server, url: str) -> None:
    for _ in range(300):
        if server.should_exit:
            return
        if server.started:
            webbrowser.open(url)
            return
        time.sleep(0.1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local StrideMix music editor.")
    parser.add_argument("--setup", action="store_true", help="Reinstall dependencies and rebuild the editor.")
    parser.add_argument("--no-browser", action="store_true", help="Keep the browser closed at startup.")
    parser.add_argument("--port", type=int, default=8765, help="Local port, default 8765.")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required")
    os.chdir(ROOT)

    try:
        if not args.serve:
            setup(args.setup)
            return subprocess.call([str(PYTHON), str(Path(__file__).resolve()), *sys.argv[1:], "--serve"])

        import uvicorn

        url = f"http://127.0.0.1:{args.port}"
        print(f"\nStrideMix is starting at {url}\nPress Ctrl+C to stop.\n", flush=True)
        server = uvicorn.Server(uvicorn.Config("backend.app:app", host="127.0.0.1", port=args.port, log_level="info"))
        if not args.no_browser:
            threading.Thread(target=open_when_ready, args=(server, url), daemon=True).start()
        server.run()
        return 0
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"\nStartup failed: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
