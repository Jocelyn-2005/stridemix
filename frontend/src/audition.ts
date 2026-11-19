import { beatPhaseSeconds } from "./timeline.ts";

function fraction(value: number) {
  return ((value % 1) + 1) % 1;
}

function foot(cycle: number) {
  const phase = fraction(cycle);
  // Each foot remains planted for slightly more than half a two-step cycle.
  // During stance it moves backwards with the ground; the other foot swings.
  if (phase < 0.58) return { x: 34 - (phase / 0.58) * 68, lift: 0 };
  const swing = (phase - 0.58) / 0.42;
  return { x: -34 + swing * 68, lift: 36 * Math.sin(swing * Math.PI) };
}

/** All motion comes from the same song-local time used by the audio click grid. */
export function auditionFrame(
  localPosition: number,
  cadence: number,
  anchorSeconds?: number | null,
  phaseOffsetMs = 0,
  active = true,
) {
  const period = 60 / cadence;
  const phase = beatPhaseSeconds(anchorSeconds, phaseOffsetMs, cadence);
  const started = active && localPosition >= phase - 1e-8;
  const beats = started ? Math.max(0, (localPosition - phase) / period) : 0;
  // Snap floating-point noise only at exact clicks, not ordinary animation frames.
  const stableBeats = Math.abs(beats - Math.round(beats)) < 1e-8 ? Math.round(beats) : beats;
  const step = fraction(stableBeats);
  return {
    beats: stableBeats,
    left: started ? foot(stableBeats / 2) : { x: -9, lift: 0 },
    right: started ? foot((stableBeats + 1) / 2) : { x: 9, lift: 0 },
    bodyLift: started ? Math.sin(step * Math.PI) ** 2 * 4 : 0,
    armSwing: started ? Math.sin(stableBeats * Math.PI) * 23 : 0,
    groundOffset: started ? fraction(stableBeats / 2) * 136 : 0,
    pulse: started ? Math.max(0, 1 - step / 0.24) : 0,
    landingFoot: Math.floor(stableBeats) % 2 === 0 ? "left" as const : "right" as const,
  };
}

/** Two-segment inverse kinematics keeps the knees joined through each stride. */
export function kneePoint(hipX: number, hipY: number, footX: number, footY: number) {
  const dx = footX - hipX;
  const dy = footY - hipY;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.sqrt(Math.max(0, 75 ** 2 - (distance / 2) ** 2));
  return { x: (hipX + footX) / 2 + (dy / distance) * bend,
    y: (hipY + footY) / 2 - (dx / distance) * bend };
}
