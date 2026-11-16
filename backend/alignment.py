"""Measure a fixed musical beat grid from attacks in the actual PCM file.

Spectral flux proposes attack regions. Their timestamps are refined from the
original samples, so an STFT window timestamp never becomes the final anchor.
Only three bounded excerpts are decoded, and fitting uses absolute file times.
"""

import math
import wave
from pathlib import Path

import numpy as np

from backend.audio import AudioError, SAMPLE_RATE
from backend.models import Alignment
from backend.tempo import ANALYSIS_RATE, HOP_SIZE, MAX_SEGMENT_SECONDS, MIN_ANALYSIS_SECONDS, WINDOW_SIZE


def _attack_time(samples: np.ndarray, coarse_frame: int) -> float:
    start = max(0, coarse_frame - round(SAMPLE_RATE * 0.012))
    end = min(len(samples), coarse_frame + round(SAMPLE_RATE * 0.11))
    region = samples[start:end]
    width = max(1, round(SAMPLE_RATE * 0.002))
    energy = np.concatenate(([0.0], np.cumsum(region * region)))
    smooth = (energy[width:] - energy[:-width]) / width
    if len(smooth) < width * 2:
        return coarse_frame / SAMPLE_RATE
    rise = smooth[width:] - smooth[:-width]
    peak = int(np.argmax(rise)) + width // 2
    search_start = max(0, peak - round(SAMPLE_RATE * 0.012))
    floor = float(np.min(smooth[search_start:peak + 1]))
    high = float(smooth[min(len(smooth) - 1, peak + width)])
    threshold = floor + max(0.0, high - floor) * 0.1
    crossing = np.flatnonzero(smooth[search_start:peak + 1] >= threshold)
    position = search_start + int(crossing[0]) if len(crossing) else peak
    return (start + position + width / 2) / SAMPLE_RATE


def _onsets(samples: np.ndarray, period: float) -> tuple[np.ndarray, np.ndarray]:
    usable = len(samples) // 4 * 4
    reduced = samples[:usable].reshape(-1, 4).mean(axis=1)
    frames = np.lib.stride_tricks.sliding_window_view(reduced, WINDOW_SIZE)[::HOP_SIZE]
    window = np.hanning(WINDOW_SIZE)
    low = np.zeros(len(frames))
    broad = np.zeros(len(frames))
    previous = None
    magnitude_sum = 0.0
    low_power = 0.0
    total_power = 0.0
    for start in range(0, len(frames), 64):
        spectrum = np.abs(np.fft.rfft(frames[start:start + 64] * window, axis=1))
        low_power += float(np.sum(spectrum[:, 4:43] ** 2))
        total_power += float(np.sum(spectrum[:, 4:465] ** 2))
        spectrum = np.log1p(spectrum * 10)
        difference = np.diff(spectrum, axis=0, prepend=spectrum[:1] if previous is None else previous[None, :])
        positive = np.maximum(difference, 0)
        low[start:start + len(spectrum)] = positive[:, 4:43].sum(axis=1)
        broad[start:start + len(spectrum)] = positive[:, 4:465].sum(axis=1)
        magnitude_sum += float(spectrum[:, 4:465].sum())
        previous = spectrum[-1]
    if magnitude_sum <= 0 or broad.sum() / magnitude_sum < 0.002:
        return np.array([]), np.array([])
    broad_scale = max(float(np.percentile(broad, 95)), 0.0001)
    novelty = broad / broad_scale
    if low_power / max(total_power, 1e-12) > 0.015:
        low_scale = max(float(np.percentile(low, 95)), 0.0001)
        novelty += 3 * low / low_scale
    median = float(np.median(novelty))
    threshold = median + max(0.05, (float(np.percentile(novelty, 95)) - median) * 0.2)
    peaks = np.flatnonzero(
        (novelty[1:-1] > novelty[:-2]) & (novelty[1:-1] >= novelty[2:]) & (novelty[1:-1] > threshold)
    ) + 1
    selected = []
    minimum_spacing = max(0.045, min(0.12, period * 0.2)) * ANALYSIS_RATE / HOP_SIZE
    for peak in peaks:
        if selected and peak - selected[-1] < minimum_spacing:
            if novelty[peak] > novelty[selected[-1]]:
                selected[-1] = int(peak)
        else:
            selected.append(int(peak))
    times = []
    weights = []
    for peak in selected:
        coarse_frame = round(peak * HOP_SIZE / ANALYSIS_RATE * SAMPLE_RATE)
        times.append(_attack_time(samples, coarse_frame))
        weights.append(float(novelty[peak]))
    return np.asarray(times), np.asarray(weights)


def _phase(times: np.ndarray, weights: np.ndarray, period: float) -> float:
    bins = 256
    indices = np.floor((times % period) / period * bins).astype(int) % bins
    histogram = np.bincount(indices, weights=weights, minlength=bins)
    distances = np.minimum(np.arange(bins), bins - np.arange(bins))
    sigma = min(0.025, period * 0.07) / period * bins
    kernel = np.exp(-0.5 * (distances / max(sigma, 1)) ** 2)
    smoothed = np.fft.irfft(np.fft.rfft(histogram) * np.fft.rfft(kernel), bins)
    return (int(np.argmax(smoothed)) + 0.5) / bins * period


def _fit_grid(times: np.ndarray, weights: np.ndarray, period: float) -> tuple[float, float, np.ndarray]:
    phase = _phase(times, weights, period)
    indices = np.rint((times - phase) / period)
    residuals = times - (phase + indices * period)
    selected = np.abs(residuals) < min(0.06, period * 0.18)
    # Keep one attack per beat, choosing the stronger attack in each neighborhood.
    best = {}
    for position in np.flatnonzero(selected):
        beat = int(indices[position])
        if beat not in best or weights[position] > weights[best[beat]]:
            best[beat] = int(position)
    selected[:] = False
    selected[list(best.values())] = True
    fitted_period = period
    intercept = phase
    for _ in range(3):
        if np.count_nonzero(selected) < 6:
            break
        x = indices[selected]
        y = times[selected]
        weight = np.minimum(weights[selected], np.percentile(weights[selected], 80))
        x_center = np.average(x, weights=weight)
        y_center = np.average(y, weights=weight)
        denominator = float(np.sum(weight * (x - x_center) ** 2))
        if denominator <= 0:
            break
        slope = float(np.sum(weight * (x - x_center) * (y - y_center)) / denominator)
        if abs(slope / period - 1) > 0.02:
            break
        fitted_period = slope
        intercept = float(y_center - slope * x_center)
        residuals = times - (intercept + indices * fitted_period)
        limit = max(0.008, min(0.035, period * 0.08))
        selected &= np.abs(residuals) < limit
    return fitted_period, intercept, selected


def analyze_alignment(path: Path, bpm: float | None) -> Alignment:
    if bpm is None or not math.isfinite(bpm) or not 30 <= bpm <= 480:
        return Alignment(status="unavailable")
    initial_period = 60 / bpm
    segments = []
    with wave.open(str(path), "rb") as stream:
        total_frames = stream.getnframes()
        if stream.getframerate() != SAMPLE_RATE or stream.getsampwidth() != 2:
            raise AudioError("起拍分析需要标准化的 44.1 kHz PCM 音频")
        if total_frames < MIN_ANALYSIS_SECONDS * SAMPLE_RATE:
            return Alignment(status="unavailable")
        segment_frames = min(total_frames, MAX_SEGMENT_SECONDS * SAMPLE_RATE)
        offsets = sorted({0, (total_frames - segment_frames) // 2, total_frames - segment_frames})
        for offset in offsets:
            stream.setpos(offset)
            samples = np.frombuffer(stream.readframes(segment_frames), dtype="<i2").reshape(-1, stream.getnchannels())
            energy = np.mean(samples.astype(np.float64) ** 2, axis=0)
            mono = samples[:, int(np.argmax(energy))].astype(np.float64) / 32768
            times, weights = _onsets(mono, initial_period)
            if len(times) >= 8:
                local_period, _, matched = _fit_grid(times, weights, initial_period)
                if np.count_nonzero(matched) >= 6:
                    segments.append((times + offset / SAMPLE_RATE, weights, local_period))
    if not segments:
        return Alignment(status="unavailable")
    period = float(np.median([segment[2] for segment in segments]))
    times = np.concatenate([segment[0] for segment in segments])
    weights = np.concatenate([segment[1] for segment in segments])
    period, intercept, selected = _fit_grid(times, weights, period)
    if np.count_nonzero(selected) < 6:
        return Alignment(status="unavailable")
    matched_fraction = float(weights[selected].sum() / weights.sum())
    phase_score = float(np.clip((matched_fraction - 0.18) / 0.72, 0, 1))
    indices = np.rint((times - intercept) / period)
    residuals = times - (intercept + indices * period)
    rms = float(np.sqrt(np.average(residuals[selected] ** 2, weights=weights[selected])))
    segment_errors = []
    for segment_times, segment_weights, _ in segments:
        local_phase = _phase(segment_times, segment_weights, period)
        error = (local_phase - intercept + period / 2) % period - period / 2
        segment_errors.append(error)
    drift = max(rms, float(np.sqrt(np.mean(np.asarray(segment_errors) ** 2))))
    period_variation = float(np.mean([abs(segment[2] / period - 1) for segment in segments]))
    confidence = phase_score * math.exp(-((drift / 0.025) ** 2)) * math.exp(-period_variation / 0.003)
    confidence *= len(segments) / len(offsets)
    if phase_score < 0.1:
        return Alignment(status="unavailable")
    # A single early/late attack must not offset every later click. Preserve the
    # absolute beat number while using the phase fitted across the whole file.
    first_beat = indices[np.flatnonzero(selected)[0]]
    anchor = max(0.0, float(intercept + first_beat * period))
    return Alignment(
        anchor_seconds=round(anchor, 9), bpm=round(60 / period, 6),
        confidence=round(min(max(confidence, 0), 1), 3), drift_ms=round(drift * 1000, 3),
        status="detected" if confidence >= 0.6 and drift < 0.025 else "uncertain",
    )
