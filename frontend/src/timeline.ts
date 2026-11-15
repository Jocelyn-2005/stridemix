export function locateTrack(tracks: { duration: number }[], position: number) {
  let offset = Math.max(0, position);
  for (let index = 0; index < tracks.length; index += 1) {
    if (offset < tracks[index].duration) return { index, offset };
    offset -= tracks[index].duration;
  }
  return null;
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
