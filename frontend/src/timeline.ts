export const SAMPLE_RATE = 44100;

export interface TimelineTrack {
  index: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
}

export function buildTimeline(tracks: { duration: number }[], gapSeconds = 0) {
  const gapFrames = Math.round(Math.max(0, gapSeconds) * SAMPLE_RATE);
  let durationFrames = 0;
  const intervals = tracks.map((track, index) => {
    const startFrame = durationFrames;
    const frames = Math.round(Math.max(0, track.duration) * SAMPLE_RATE);
    durationFrames += frames;
    const interval = {
      index,
      startFrame,
      endFrame: durationFrames,
      durationFrames: frames,
    };
    if (index < tracks.length - 1) durationFrames += gapFrames;
    return interval;
  });
  return { tracks: intervals, gapFrames, durationFrames };
}

export function locateTrack(
  tracks: { duration: number }[],
  position: number,
  gapSeconds = 0,
) {
  const frame = Math.round(Math.max(0, position) * SAMPLE_RATE);
  const interval = buildTimeline(tracks, gapSeconds).tracks.find(
    (track) => frame >= track.startFrame && frame < track.endFrame,
  );
  return interval
    ? { index: interval.index, offset: (frame - interval.startFrame) / SAMPLE_RATE }
    : null;
}

export function beatPhaseSeconds(
  anchorSeconds: number | null | undefined,
  offsetMs: number,
  cadence: number,
) {
  const period = 60 / cadence;
  const anchor = Number.isFinite(anchorSeconds) ? anchorSeconds! : 0;
  const phase = (anchor + offsetMs / 1000) % period;
  return phase < 0 ? phase + period : phase;
}

export function nextBeatFrame(
  localFrame: number,
  cadence: number,
  anchorSeconds?: number | null,
  offsetMs = 0,
) {
  const period = 60 / cadence;
  const phase = beatPhaseSeconds(anchorSeconds, offsetMs, cadence);
  const earliestSeconds = (Math.max(0, localFrame) - 0.5) / SAMPLE_RATE;
  let index = Math.max(0, Math.ceil((earliestSeconds - phase) / period - 1e-8));
  let frame = Math.round((phase + index * period) * SAMPLE_RATE);
  // Round the final position once so fractional periods never accumulate error.
  if (frame < localFrame) {
    index += 1;
    frame = Math.round((phase + index * period) * SAMPLE_RATE);
  }
  return { index, frame };
}

export function countTrackBeats(
  durationFrames: number,
  cadence: number,
  anchorSeconds?: number | null,
  offsetMs = 0,
) {
  return nextBeatFrame(durationFrames, cadence, anchorSeconds, offsetMs).index;
}

export function nextBeatPosition(position: number, cadence: number) {
  const index = Math.ceil((Math.max(0, position) * cadence) / 60 - 1e-8);
  return { index, time: (index * 60) / cadence };
}

export function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = String(value % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${String(minutes).padStart(2, "0")}:${remainder}`;
}
