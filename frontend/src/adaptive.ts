import type { AdaptationSegment, Track } from "./api.ts";

/** Output positions are from the same PCM clock used by playback/export. */
export function segmentAt(segments: AdaptationSegment[], position: number) {
  if (!Number.isFinite(position) || position < 0) return null;
  return segments.find((segment) => position >= segment.output_start && position < segment.output_end) ?? null;
}

export function processingAt(track: Track | undefined, position: number) {
  const adaptation = track?.adaptation;
  const segment = segmentAt(adaptation?.segments ?? [], position);
  return {
    speed: segment?.speed ?? adaptation?.speed ?? 1,
    correctionMs: segment?.correction_ms ?? 0,
    driftMs: segment?.drift_ms ?? null,
    confidence: segment?.confidence ?? null,
    segment,
  };
}

export function signedMilliseconds(value: number) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded || 0} ms`;
}
