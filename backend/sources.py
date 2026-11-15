import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

from backend.audio import AudioError, ffmpeg_executable, process_options


def validate_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise AudioError("请输入有效的 http 或 https 视频链接")
    return value


def run_ytdlp(arguments: list[str], timeout: int) -> str:
    command = [
        sys.executable, "-X", "utf8", "-m", "yt_dlp", "--ignore-config", "--no-warnings",
        "--socket-timeout", "20", "--retries", "2", *arguments,
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, **process_options())
    except subprocess.TimeoutExpired as exc:
        raise AudioError("视频服务响应超时，请检查网络后重试") from exc
    if result.returncode:
        message = result.stderr.decode("utf-8", errors="replace").strip()[-1200:]
        raise AudioError(f"此来源暂时无法导入，请检查链接、网络或站点登录要求。{message}")
    return result.stdout.decode("utf-8", errors="replace")


def search_music(query: str) -> list[dict]:
    output = run_ytdlp([
        "--flat-playlist", "--skip-download", "--dump-single-json", "--", f"ytsearch5:{query}",
    ], timeout=90)
    try:
        data = json.loads(output)
    except json.JSONDecodeError as exc:
        raise AudioError("无法读取搜索结果，请稍后重试") from exc
    results = []
    for entry in data.get("entries") or []:
        if not entry:
            continue
        url = entry.get("webpage_url") or entry.get("url")
        if url and url.startswith(("https://", "http://")):
            results.append({
                "title": entry.get("title") or "未命名音乐",
                "url": url,
                "duration": entry.get("duration") or 0,
                "channel": entry.get("channel") or entry.get("uploader") or "YouTube",
            })
    return results


def download_video(url: str, directory: Path) -> tuple[Path, str]:
    url = validate_url(url)
    output = run_ytdlp([
        "--no-playlist", "--no-part", "--no-simulate", "--write-info-json",
        "--ffmpeg-location", ffmpeg_executable(),
        "--js-runtimes", "node",
        "--match-filter", "!is_live",
        "-f", "bestaudio/best", "-o", str(directory / "download.%(ext)s"),
        "--print", "after_move:filepath", "--", url,
    ], timeout=1800)
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        raise AudioError("未找到可导入的音频，直播链接需要先保存为文件")
    downloaded = Path(lines[-1]).resolve()
    if not downloaded.is_relative_to(directory.resolve()) or not downloaded.is_file():
        raise AudioError("视频下载未生成可用文件")
    metadata_file = directory / "download.info.json"
    title = "视频配乐"
    if metadata_file.is_file():
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        title = metadata.get("title") or title
    return downloaded, title


def generate_music(prompt: str, duration: float, destination: Path) -> None:
    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise AudioError("AI 配乐需要在本机 .env 文件配置 ELEVENLABS_API_KEY，然后重启应用")
    try:
        with httpx.stream(
            "POST", "https://api.elevenlabs.io/v1/music",
            headers={"xi-api-key": api_key},
            json={
                "prompt": prompt,
                "music_length_ms": round(duration * 1000),
                "model_id": "music_v1",
                "force_instrumental": True,
            },
            timeout=httpx.Timeout(600, connect=20),
        ) as response:
            if response.status_code != 200:
                response.read()
                message = response.text[:800]
                raise AudioError(f"AI 配乐服务返回 {response.status_code}。请检查密钥、服务额度和描述。{message}")
            with destination.open("wb") as output:
                for chunk in response.iter_bytes():
                    output.write(chunk)
    except httpx.HTTPError as exc:
        raise AudioError("无法连接 AI 配乐服务，请检查网络后重试") from exc
