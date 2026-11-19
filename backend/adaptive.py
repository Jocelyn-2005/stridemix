"""Whole-file musical tempo tracking and bounded-memory, pitch-preserving warps.

The map follows locally fitted musical grids, never every individual drum hit.
Unreliable windows contribute no anchors. Rubato is corrected between anchors;
small renderer phase errors are corrected in overlapping audio, without inserting
silence between phrases. All quality figures are measured again from final PCM.
"""

from dataclasses import dataclass
from functools import lru_cache
import math
from pathlib import Path
import subprocess
import tempfile
import wave

import numpy as np

from backend.alignment import _fit_grid, _onsets, _phase
from backend.audio import AudioError, SAMPLE_RATE, ffmpeg_executable, process_options, run_ffmpeg
from backend.models import AdaptationSegment
from backend.tempo import _segment_period, tempo_filter

WINDOW = 12.0
STRIDE = 4.0


@dataclass
class Observation:
    center: float
    period: float
    anchor: float
    confidence: float


def _mono(stream: wave.Wave_read, start: float, duration: float) -> np.ndarray:
    stream.setpos(min(stream.getnframes(), max(0, round(start * SAMPLE_RATE))))
    raw = np.frombuffer(stream.readframes(max(0, round(duration * SAMPLE_RATE))), dtype="<i2")
    if not len(raw):
        return np.array([])
    channels = raw.reshape(-1, stream.getnchannels()).astype(np.float64) / 32768
    return channels[:, int(np.argmax(np.mean(channels ** 2, axis=0)))]


def observe_song(path: Path, bpm: float) -> tuple[float, list[Observation]]:
    """Visit every part of the file, retaining only compact local grid summaries."""
    observations = []
    with wave.open(str(path), "rb") as stream:
        if stream.getframerate() != SAMPLE_RATE or stream.getsampwidth() != 2:
            raise AudioError("分段分析需要标准化的 44.1 kHz PCM 音频")
        duration = stream.getnframes() / SAMPLE_RATE
        if duration < 8:
            return duration, observations
        starts = sorted(set([*np.arange(0, max(0.0, duration - WINDOW), STRIDE), max(0, duration - WINDOW)]))
        for start in starts:
            samples = _mono(stream, start, WINDOW)
            estimate = _segment_period(samples)
            if estimate is None:
                continue
            # A single half/double interpretation is kept throughout the song.
            local_bpm = min((estimate[0] / 2, estimate[0], estimate[0] * 2), key=lambda value: abs(math.log(value / bpm)))
            if not 0.65 <= local_bpm / bpm <= 1.5:
                continue
            times, weights = _onsets(samples, 60 / local_bpm)
            if len(times) < 6:
                continue
            period, phase, selected = _fit_grid(times, weights, 60 / local_bpm)
            if np.count_nonzero(selected) < 6:
                continue
            fraction = float(weights[selected].sum() / max(weights.sum(), 1e-12))
            residual = times[selected] - (phase + np.rint((times[selected] - phase) / period) * period)
            scatter = float(np.median(np.abs(residual)))
            confidence = min(1.0, fraction / 0.65) * math.exp(-(scatter / 0.025) ** 2) * min(1.0, estimate[1] / 0.5)
            if fraction < 0.28 or confidence < 0.25:
                continue
            center = start + len(samples) / SAMPLE_RATE / 2
            anchor = start + phase + round((center - start - phase) / period) * period
            observations.append(Observation(center, period, anchor, confidence))
    return duration, observations


def plan_segments(path: Path, source_bpm: float, target_bpm: float, speed: float) -> tuple[list[AdaptationSegment], float | None]:
    duration, observations = observe_song(path, source_bpm)
    if len(observations) < 3:
        return [], None
    target_period = 60 / target_bpm
    first = observations[0]
    # Mid-beat boundaries keep crossfades away from the principal attack.
    anchors = [(first.anchor + first.period / 2, (first.anchor + first.period / 2) / speed, first)]
    for observation in observations[1:]:
        prior_source, prior_output, prior = anchors[-1]
        source = observation.anchor + observation.period / 2
        if source - prior_source < 1.5:
            continue
        expected_period = (prior.period + observation.period) / 2
        count = round((source - prior_source) / expected_period)
        if count < 1:
            continue
        phase_error = source - prior_source - count * expected_period
        # Do not turn an isolated syncopated passage into a half-beat jump.
        if abs(phase_error) > expected_period * 0.28 and abs(observation.period / prior.period - 1) < 0.035:
            continue
        output = prior_output + count * target_period
        local_speed = (source - prior_source) / (output - prior_output)
        if not 0.6 <= local_speed / speed <= 1.65:
            continue
        anchors.append((source, output, observation))
    if len(anchors) < 3:
        return [], None
    # Only invoke the more expensive warp when actual long-range phase or rate
    # changes exceed noise. Stable files keep the original, transparent renderer.
    residuals = [output - source / speed for source, output, _ in anchors]
    if max(residuals) - min(residuals) < 0.018:
        return [], None
    first_source, first_output, first_observation = anchors[0]
    beginning = (0.0, 0.0, first_observation)
    last_source, last_output, last_observation = anchors[-1]
    # FFmpeg tempo/rubberband factors are output-tempo factors. A local source
    # beat period of P rendered at target musical BPM T therefore uses P*T/60.
    tail_speed = last_observation.period * target_bpm / 60
    end = (duration, last_output + (duration - last_source) / tail_speed, last_observation)
    anchors = [beginning, *anchors, end]
    segments = []
    for (s0, o0, left), (s1, o1, right) in zip(anchors, anchors[1:]):
        if s1 <= s0 or o1 <= o0:
            continue
        local_speed = (s1 - s0) / (o1 - o0)
        tempo_speed = (left.period + right.period) * target_bpm / 120
        correction = (o1 - o0 - (s1 - s0) / tempo_speed) * 1000
        confidence = min(left.confidence, right.confidence)
        if s1 - s0 > WINDOW + STRIDE:
            confidence = 0  # Interpolated through a region without reliable beats.
        segments.append(AdaptationSegment(
            source_start=s0, source_end=s1, output_start=o0, output_end=o1,
            speed=local_speed, correction_ms=correction, confidence=confidence,
        ))
    # Mid-beat boundaries have a fixed half-period offset from the musical grid.
    return segments, (first_output - target_period / 2) % target_period


@lru_cache(maxsize=1)
def _rubberband_available() -> bool:
    try:
        result = subprocess.run([ffmpeg_executable(), "-hide_banner", "-filters"], capture_output=True, timeout=15, **process_options())
        return result.returncode == 0 and b" rubberband " in result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return False


def _render_filter(speed: float) -> str:
    if _rubberband_available():
        return f"rubberband=tempo={speed:.12g}:pitch=1:transients=crisp:detector=compound:phase=laminar:channels=together"
    return tempo_filter(speed)


def _phase_correction(samples: np.ndarray, virtual_start: float, period: float, anchor: float) -> float:
    if len(samples) < SAMPLE_RATE * 2:
        return 0
    channel = int(np.argmax(np.mean(samples.astype(np.float64) ** 2, axis=0)))
    mono = samples[:, channel].astype(np.float64) / 32768
    times, weights = _onsets(mono, period)
    keep = (times > 0.2) & (times < len(samples) / SAMPLE_RATE - 0.2)
    times, weights = times[keep], weights[keep]
    if len(times) < 4:
        return 0
    phase = _phase(times + virtual_start, weights, period)
    errors = (times + virtual_start - phase + period / 2) % period - period / 2
    coherent = np.abs(errors) < 0.04
    if float(weights[coherent].sum() / max(weights.sum(), 1e-12)) < 0.3:
        return 0
    shift = (anchor - phase + period / 2) % period - period / 2
    # A phase ambiguity is not sufficient reason to cut or shift half a beat.
    return float(shift) if abs(shift) <= 0.08 else 0.0


def render_segments(source: Path, destination: Path, segments: list[AdaptationSegment], target_bpm: float, anchor: float) -> None:
    """Render overlapping independent stretches, streaming crossfades to disk."""
    overlap = round(SAMPLE_RATE * 0.018)
    pending = np.zeros((0, 2), dtype=np.float64)
    written = 0
    with tempfile.TemporaryDirectory(prefix="adaptive-", dir=destination.parent) as temporary, wave.open(str(destination), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        for index, segment in enumerate(segments):
            core_start = round(segment.output_start * SAMPLE_RATE)
            core_end = round(segment.output_end * SAMPLE_RATE)
            start_frame = max(0, core_start - overlap)
            end_frame = core_end + (overlap if index < len(segments) - 1 else 0)
            read_start = max(0, segment.source_start - 0.35 * segment.speed)
            read_end = min(segments[-1].source_end, segment.source_end + 0.35 * segment.speed)
            stretched = Path(temporary) / "part.wav"
            run_ffmpeg([
                "-ss", f"{read_start:.9f}", "-t", f"{read_end - read_start:.9f}", "-i", str(source),
                "-map", "0:a:0", "-af", _render_filter(segment.speed),
                "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(stretched),
            ])
            with wave.open(str(stretched), "rb") as stream:
                samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").reshape(-1, 2)
            virtual_start = segment.output_start - (segment.source_start - read_start) / segment.speed
            shift = _phase_correction(samples, virtual_start, 60 / target_bpm, anchor) if segment.confidence >= 0.25 else 0
            segment.correction_ms += shift * 1000
            crop = round((start_frame / SAMPLE_RATE - virtual_start - shift) * SAMPLE_RATE)
            count = end_frame - start_frame
            chunk = np.zeros((count, 2), dtype=np.float64)
            lo, hi = max(0, crop), min(len(samples), crop + count)
            if hi > lo:
                chunk[lo - crop:hi - crop] = samples[lo:hi]
            if len(pending):
                blend_count = min(len(pending), len(chunk))
                # Complementary raised-cosine weights avoid an overlap gain bump.
                weight = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, blend_count)))[:, None]
                chunk[:blend_count] = pending[:blend_count] * (1 - weight) + chunk[:blend_count] * weight
            keep_end = count if index == len(segments) - 1 else max(0, count - 2 * overlap)
            output.writeframesraw(np.clip(np.rint(chunk[:keep_end]), -32768, 32767).astype("<i2").tobytes())
            written += keep_end
            pending = chunk[keep_end:].copy()
        expected = round(segments[-1].output_end * SAMPLE_RATE)
        if written != expected:
            raise AudioError("分段处理后的音频长度校验失败")


def measure_segments(path: Path, segments: list[AdaptationSegment], bpm: float, cadence: float, anchor: float | None) -> tuple[float | None, float]:
    """Measure supported beat attacks from final PCM, independent of the plan.

    Segment error is median absolute error to the audible metronome grid.
    Overall error is duration-weighted mean of those medians. Coverage counts
    windows with coherent observations and never promotes interpolated regions.
    """
    total = sum(s.output_end - s.output_start for s in segments)
    observed_duration = 0.0
    weighted_error = 0.0
    with wave.open(str(path), "rb") as stream:
        duration = stream.getnframes() / SAMPLE_RATE
        for segment in segments:
            center = (segment.output_start + segment.output_end) / 2
            start = max(0, min(center - 6, duration - WINDOW))
            samples = _mono(stream, start, WINDOW)
            if len(samples) < 2 * SAMPLE_RATE or anchor is None:
                segment.confidence = 0
                continue
            times, weights = _onsets(samples, 60 / bpm)
            if len(times) < 6:
                segment.confidence = 0
                continue
            period, phase, selected = _fit_grid(times, weights, 60 / bpm)
            in_segment = (times + start >= segment.output_start) & (times + start < segment.output_end)
            supported = selected & in_segment
            if np.count_nonzero(supported) < 3:
                segment.confidence = 0
                continue
            fraction = float(weights[selected].sum() / max(weights.sum(), 1e-12))
            scatter = float(np.median(np.abs(times[selected] - (phase + np.rint((times[selected] - phase) / period) * period))))
            confidence = min(1.0, fraction / 0.65) * math.exp(-(scatter / 0.025) ** 2)
            segment.confidence = round(min(segment.confidence, confidence), 3)
            if segment.confidence < 0.2:
                continue
            click_period = 60 / cadence
            errors = (times[supported] + start - anchor + click_period / 2) % click_period - click_period / 2
            segment.drift_ms = round(float(np.median(np.abs(errors))) * 1000, 3)
            length = segment.output_end - segment.output_start
            observed_duration += length
            weighted_error += length * segment.drift_ms
    return (round(weighted_error / observed_duration, 3) if observed_duration else None, round(observed_duration / total, 3) if total else 0)
