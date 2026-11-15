"""Bounded-memory rhythmic-period estimates and pitch-preserving tempo changes."""

import math
import shutil
import wave
from pathlib import Path

import numpy as np

from backend.audio import AudioError, SAMPLE_RATE, run_ffmpeg
from backend.models import Tempo

ANALYSIS_RATE = SAMPLE_RATE // 4
WINDOW_SIZE = 1024
HOP_SIZE = 110
MAX_SEGMENT_SECONDS = 30
MIN_ANALYSIS_SECONDS = 8


def _onset_envelope(samples: np.ndarray) -> np.ndarray:
    # Averaging before decimation reduces high-frequency aliases. Timing remains
    # tied to the original sample rate and is never inferred from FFT bin numbers.
    usable = len(samples) // 4 * 4
    reduced = samples[:usable].reshape(-1, 4).mean(axis=1)
    frames = np.lib.stride_tricks.sliding_window_view(reduced, WINDOW_SIZE)[::HOP_SIZE]
    window = np.hanning(WINDOW_SIZE)
    envelope = np.zeros(len(frames), dtype=np.float64)
    previous = None
    total_magnitude = 0.0
    for start in range(0, len(frames), 64):
        batch = frames[start:start + 64] * window
        spectrum = np.log1p(np.abs(np.fft.rfft(batch, axis=1)) * 10)
        spectrum = spectrum[:, 4:465]
        differences = np.diff(spectrum, axis=0, prepend=spectrum[:1] if previous is None else previous[None, :])
        envelope[start:start + len(batch)] = np.maximum(differences, 0).sum(axis=1)
        total_magnitude += float(spectrum.sum())
        previous = spectrum[-1]
    if total_magnitude <= 0 or envelope.sum() / total_magnitude < 0.002:
        return np.zeros_like(envelope)
    return envelope


def _segment_period(samples: np.ndarray) -> tuple[float, float] | None:
    if len(samples) < MIN_ANALYSIS_SECONDS * SAMPLE_RATE or np.sqrt(np.mean(samples * samples)) < 0.0001:
        return None
    flux = _onset_envelope(samples)
    median = float(np.median(flux))
    upper = float(np.percentile(flux, 95))
    if upper <= max(0.001, median * 1.6):
        return None
    envelope = np.maximum(flux - median * 1.05, 0)
    envelope -= envelope.mean()
    variance = float(np.mean(envelope * envelope))
    if variance < 1e-8:
        return None
    length = len(envelope)
    fft_size = 1 << (2 * length - 1).bit_length()
    frequencies = np.fft.rfft(envelope, fft_size)
    correlation = np.fft.irfft(frequencies * frequencies.conj(), fft_size)[:length]
    correlation /= np.arange(length, 0, -1) * variance
    envelope_rate = ANALYSIS_RATE / HOP_SIZE
    minimum_lag = math.ceil(60 * envelope_rate / 240)
    maximum_lag = min(math.floor(60 * envelope_rate / 40), length - 2)
    candidates = []
    for lag in range(minimum_lag, maximum_lag + 1):
        left, center, right = correlation[lag - 1:lag + 2]
        if center <= left or center < right:
            continue
        curvature = left - 2 * center + right
        offset = 0.0
        if curvature < -1e-10:
            offset = float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5))
        strength = float(center - 0.25 * (left - right) * offset)
        bpm = 60 * envelope_rate / (lag + offset)
        candidates.append((bpm, strength))
    if not candidates:
        return None
    strongest = max(strength for _, strength in candidates)
    if strongest < 0.35:
        return None
    strong_candidates = [(bpm, strength) for bpm, strength in candidates if strength >= strongest * 0.85]
    preferred = [(bpm, strength) for bpm, strength in strong_candidates if 60 <= bpm <= 180]
    # The shortest well-supported period avoids choosing a two-bar repetition
    # merely because its peak lands closer to an integer envelope-frame lag.
    bpm, strength = max(preferred or strong_candidates, key=lambda candidate: candidate[0])
    return bpm, min(max(strength, 0), 1)


def analyze_tempo(path: Path) -> Tempo:
    with wave.open(str(path), "rb") as stream:
        frame_count = stream.getnframes()
        channels = stream.getnchannels()
        if stream.getframerate() != SAMPLE_RATE or stream.getsampwidth() != 2:
            raise AudioError("节奏分析需要标准化的 44.1 kHz PCM 音频")
        segment_frames = min(frame_count, MAX_SEGMENT_SECONDS * SAMPLE_RATE)
        if frame_count < MIN_ANALYSIS_SECONDS * SAMPLE_RATE:
            return Tempo(status="unavailable")
        offsets = sorted({0, max(0, (frame_count - segment_frames) // 2), max(0, frame_count - segment_frames)})
        estimates = []
        for offset in offsets:
            stream.setpos(offset)
            raw = stream.readframes(segment_frames)
            stereo = np.frombuffer(raw, dtype="<i2").reshape(-1, channels)
            # Select a channel by energy so phase-inverted stereo cannot cancel.
            channel_energy = np.mean(stereo.astype(np.float64) ** 2, axis=0)
            selected = int(np.argmax(channel_energy))
            samples = stereo[:, selected].astype(np.float64) / 32768
            estimate = _segment_period(samples)
            if estimate is not None:
                estimates.append(estimate)
    if not estimates:
        return Tempo(status="unavailable")
    anchor = max(estimates, key=lambda estimate: estimate[1])[0]
    aligned = []
    for bpm, strength in estimates:
        alternatives = [bpm / 2, bpm, bpm * 2]
        adjusted = min(alternatives, key=lambda candidate: abs(math.log(candidate / anchor)))
        aligned.append((adjusted, strength))
    bpm = float(np.median([value for value, _ in aligned]))
    deviation = float(np.mean([abs(value - bpm) / bpm for value, _ in aligned]))
    agreement = math.exp(-deviation / 0.06)
    coverage = len(estimates) / len(offsets)
    confidence = float(np.mean([strength for _, strength in aligned])) * agreement * coverage
    return Tempo(
        bpm=round(bpm, 2), confidence=round(min(max(confidence, 0), 1), 3),
        status="detected" if confidence >= 0.6 else "uncertain", source="analysis",
    )


def cadence_references(bpm: float) -> list[float]:
    return [bpm * multiplier for multiplier in (0.5, 1, 2) if 60 <= bpm * multiplier <= 240]


def tempo_filter(speed: float) -> str:
    if not math.isfinite(speed) or speed <= 0:
        raise AudioError("变速倍率必须是有效正数")
    factors = []
    remaining = speed
    while remaining > 2:
        factors.append(2.0)
        remaining /= 2
    while remaining < 0.5:
        factors.append(0.5)
        remaining *= 2
    factors.append(remaining)
    return ",".join(f"atempo={factor:.12g}" for factor in factors)


def change_tempo(source: Path, destination: Path, speed: float) -> None:
    if math.isclose(speed, 1, rel_tol=0, abs_tol=1e-12):
        shutil.copyfile(source, destination)
        return
    run_ffmpeg([
        "-i", str(source), "-map", "0:a:0", "-af", tempo_filter(speed),
        "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(destination),
    ])
