import type { RhythmWindow } from "./api";
import { beatPhaseSeconds } from "./timeline.ts";

export interface RhythmMatch {
  score: number;
  errorMs: number;
  matched: number;
  total: number;
}

export function metronomeTimes(
  start: number,
  duration: number,
  cadence: number,
  anchor: number | null | undefined,
  offsetMs: number,
) {
  if (!Number.isFinite(cadence) || cadence <= 0 || duration <= 0) {
    return [];
  }
  const period = 60 / cadence;
  const phase = beatPhaseSeconds(anchor, offsetMs, cadence);
  const first = Math.max(0, Math.ceil((start - phase) / period - 1e-8));
  const times: number[] = [];
  for (
    let index = first;
    phase + index * period < start + duration - 1e-8;
    index += 1
  ) {
    times.push(phase + index * period);
  }
  return times;
}

export function matchRhythm(
  window: RhythmWindow,
  cadence: number,
  anchor: number | null | undefined,
  offsetMs: number,
): RhythmMatch | null {
  const observed = window.onsets.filter((node) =>
    Number.isFinite(node.time) &&
    Number.isFinite(node.strength) &&
    node.strength > 0 &&
    node.time >= window.start_seconds &&
    node.time < window.start_seconds + window.duration_seconds,
  );
  const strong = observed.filter((node) => node.strong);
  const nodes = strong.length >= 4 ? strong : observed;
  if (
    !Number.isFinite(cadence) ||
    cadence <= 0 ||
    window.reliability < 0.2 ||
    nodes.length < 4 ||
    window.duration_seconds < 2
  ) {
    return null;
  }
  const period = 60 / cadence;
  const phase = beatPhaseSeconds(anchor, offsetMs, cadence);
  const tolerance = Math.min(0.04, period * 0.12);
  let weightSum = 0;
  let squaredError = 0;
  let fit = 0;
  let matched = 0;
  for (const node of nodes) {
    const beat = Math.max(0, Math.round((node.time - phase) / period));
    const error = Math.abs(node.time - (phase + beat * period));
    const weight = Math.min(1, node.strength) * (node.strong ? 2 : 1);
    weightSum += weight;
    squaredError += error * error * weight;
    fit += Math.exp(-0.5 * (error / tolerance) ** 2) * weight;
    if (error <= tolerance) {
      matched += 1;
    }
  }
  return {
    score: Math.round(100 * fit / weightSum),
    errorMs: 1000 * Math.sqrt(squaredError / weightSum),
    matched,
    total: nodes.length,
  };
}
