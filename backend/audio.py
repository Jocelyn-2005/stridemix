"""Small tone synthesis and file-based audio processing.

Long tracks stay on disk. A metronome is rendered at absolute sample positions,
so rounding error never accumulates between beats.
"""

import os
import shutil
import subprocess
import tempfile
import threading
import wave
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterator

import imageio_ffmpeg
import numpy as np

SAMPLE_RATE = 44100
TONES = [
    {"id": "click", "name": "清脆点击", "description": "短促、清晰的经典节拍"},
    {"id": "wood", "name": "木块", "description": "温暖的木质敲击"},
    {"id": "rim", "name": "鼓边", "description": "利落、有穿透力的边击"},
    {"id": "soft", "name": "柔和脉冲", "description": "低调柔和，适合长距离"},
    {"id": "beep", "name": "电子哔声", "description": "明亮干净的电子音"},
    {"id": "shaker", "name": "沙锤", "description": "细腻、轻盈的沙沙声"},
]


class AudioError(RuntimeError):
    pass


class ExportCancelled(RuntimeError):
    pass


@lru_cache(maxsize=1)
def ffmpeg_executable() -> str:
    configured = os.environ.get("FFMPEG_BINARY")
    if configured:
        resolved = shutil.which(configured) or str(Path(configured).resolve())
        if not Path(resolved).is_file():
            raise AudioError("FFMPEG_BINARY 指向的程序不存在")
        return resolved
    return shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()


def process_options() -> dict:
    """Avoid opening console windows for background audio jobs on Windows."""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def run_ffmpeg(arguments: list[str], timeout: float = 600) -> None:
    try:
        result = subprocess.run(
            [ffmpeg_executable(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *arguments],
            capture_output=True,
            timeout=timeout,
            **process_options(),
        )
    except subprocess.TimeoutExpired as exc:
        raise AudioError("音频处理超时，请尝试较短的文件") from exc
    except OSError as exc:
        raise AudioError("无法启动 FFmpeg，请检查安装") from exc
    if result.returncode:
        details = result.stderr.decode("utf-8", errors="replace").strip()[-1200:]
        raise AudioError(f"无法处理此音频文件。{details}")


def normalize_audio(source: Path, destination: Path) -> None:
    run_ffmpeg([
        "-i", str(source), "-map", "0:a:0", "-vn",
        "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(destination),
    ])
    try:
        with wave.open(str(destination), "rb") as stream:
            if stream.getnframes() < 1:
                raise AudioError("此文件没有可用的音频")
    except (wave.Error, EOFError) as exc:
        raise AudioError("无法读取转换后的音频") from exc


def audio_frame_count(path: Path) -> int:
    with wave.open(str(path), "rb") as stream:
        return stream.getnframes()


def waveform_peaks(path: Path, count: int = 80) -> list[float]:
    """Read at most one second from every display bucket, never the whole file."""
    peaks = []
    with wave.open(str(path), "rb") as stream:
        frames = stream.getnframes()
        for index in range(count):
            start = index * frames // count
            end = (index + 1) * frames // count
            stream.setpos(min(start, frames))
            raw = stream.readframes(min(max(1, end - start), SAMPLE_RATE))
            samples = np.frombuffer(raw, dtype="<i2")
            peak = float(np.max(np.abs(samples.astype(np.int32)))) / 32768 if samples.size else 0
            peaks.append(round(peak, 4))
    return peaks


@lru_cache(maxsize=6)
def tone_samples(tone: str) -> np.ndarray:
    if tone not in {entry["id"] for entry in TONES}:
        raise AudioError("未知节拍音色")
    time = np.arange(round(SAMPLE_RATE * 0.12), dtype=np.float64) / SAMPLE_RATE
    random = np.random.default_rng(1807)
    noise = random.uniform(-1, 1, len(time))
    attack = np.minimum(time / 0.0015, 1)
    if tone == "wood":
        signal = (np.sin(2 * np.pi * 830 * time) + 0.45 * np.sin(2 * np.pi * 1370 * time)) * np.exp(-time * 90)
    elif tone == "rim":
        signal = (0.6 * np.sin(2 * np.pi * 1750 * time) + 0.4 * noise) * np.exp(-time * 130)
    elif tone == "soft":
        signal = np.sin(2 * np.pi * 430 * time) * np.exp(-time * 45)
    elif tone == "beep":
        signal = np.sin(2 * np.pi * 1200 * time) * np.exp(-time * 55)
    elif tone == "shaker":
        high_noise = noise - np.roll(noise, 1)
        signal = high_noise * np.exp(-time * 60)
    else:
        signal = (0.65 * noise + np.sin(2 * np.pi * 2400 * time)) * np.exp(-time * 190)
    signal *= attack
    signal[-120:] *= np.linspace(1, 0, 120)
    signal = signal / max(float(np.max(np.abs(signal))), 0.001) * 0.8
    signal.setflags(write=False)
    return signal


def write_tone(path: Path, tone: str) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes((tone_samples(tone) * 32767).astype("<i2").tobytes())


def beat_positions(frame_count: int, cadence: float, phase_seconds: float = 0) -> Iterator[int]:
    period = 60 / cadence
    phase = phase_seconds % period
    index = 0
    while True:
        position = round((phase + index * period) * SAMPLE_RATE)
        if position >= frame_count:
            return
        yield position
        index += 1


def render_metronome(
    path: Path,
    frame_count: int,
    cadence: float,
    tone: str,
    cancelled: threading.Event,
    progress: Callable[[float], None] | None = None,
    *,
    segments: list[tuple[int, int, float]] | None = None,
) -> None:
    samples = (tone_samples(tone) * 32767).astype("<i2").tobytes()
    tone_frames = len(samples) // 2
    silence = bytes(SAMPLE_RATE * 2)
    cursor = 0
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        beat_index = 0
        intervals = segments if segments is not None else [(0, frame_count, 0)]
        for start, end, phase in intervals:
            for local_position in beat_positions(end - start, cadence, phase):
                if cancelled.is_set():
                    raise ExportCancelled()
                position = start + local_position
                gap = position - cursor
                while gap > 0:
                    length = min(gap, SAMPLE_RATE)
                    stream.writeframesraw(silence[:length * 2])
                    gap -= length
                length = min(tone_frames, end - position)
                stream.writeframesraw(samples[:length * 2])
                cursor = position + length
                if progress and beat_index % 50 == 0:
                    progress(cursor / frame_count)
                beat_index += 1
        remainder = frame_count - cursor
        while remainder > 0:
            if cancelled.is_set():
                raise ExportCancelled()
            length = min(remainder, SAMPLE_RATE)
            stream.writeframesraw(silence[:length * 2])
            remainder -= length


def write_silence(path: Path, frame_count: int, cancelled: threading.Event) -> None:
    block = bytes(SAMPLE_RATE * 4)
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        remaining = frame_count
        while remaining > 0:
            if cancelled.is_set():
                raise ExportCancelled()
            count = min(remaining, SAMPLE_RATE)
            stream.writeframesraw(block[:count * 4])
            remaining -= count


def mix_audio(
    concat_file: Path,
    metronome_file: Path,
    destination: Path,
    frame_count: int,
    bgm_volume: float,
    beat_volume: float,
    cancelled: threading.Event,
    progress: Callable[[float], None],
) -> None:
    filters = (
        f"[0:a]volume={bgm_volume}[bgm];"
        f"[1:a]pan=stereo|c0=c0|c1=c0,volume={beat_volume}[beat];"
        "[bgm][beat]amix=inputs=2:duration=first:normalize=0,"
        f"alimiter=limit=0.95:level=false:latency=true,atrim=end_sample={frame_count}[out]"
    )
    codec = ["-c:a", "libmp3lame", "-b:a", "192k"]
    if destination.suffix == ".wav":
        codec = ["-c:a", "pcm_s16le", "-rf64", "auto"]
    command = [
        ffmpeg_executable(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-i", str(metronome_file), "-filter_complex", filters,
        "-map", "[out]", "-ar", str(SAMPLE_RATE), "-ac", "2", *codec,
        "-progress", "pipe:1", "-nostats", str(destination),
    ]
    with tempfile.TemporaryFile(dir=destination.parent) as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True, **process_options())
        try:
            assert process.stdout is not None
            for line in process.stdout:
                if cancelled.is_set():
                    raise ExportCancelled()
                if line.startswith("out_time_us="):
                    value = line.strip().split("=", 1)[1]
                    if value.isdigit():
                        progress(min(int(value) / 1_000_000 / (frame_count / SAMPLE_RATE), 1))
            process.wait()
            if cancelled.is_set():
                raise ExportCancelled()
            if process.returncode:
                log_size = errors.seek(0, os.SEEK_END)
                errors.seek(max(0, log_size - 4800))
                details = errors.read().decode("utf-8", errors="replace")[-1200:]
                raise AudioError(f"合成失败。{details}")
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait()
            if process.stdout is not None:
                process.stdout.close()
