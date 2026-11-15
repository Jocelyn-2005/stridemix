import type { Track } from "./api";
import type { MixSettings } from "./audio";

export const DEFAULT_SETTINGS: MixSettings = {
  cadence: 165,
  tone: "click",
  bgmVolume: 0.65,
  beatVolume: 0.55,
};

export interface PlaylistEntry {
  entryId: string;
  track: Track;
}

export interface SavedProject {
  trackIds: string[];
  entryIds: string[];
  settings: MixSettings;
  format: "mp3" | "wav";
}

export function createEntry(track: Track): PlaylistEntry {
  return { entryId: crypto.randomUUID(), track };
}

export function parseProject(raw: string | null): SavedProject | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || !Array.isArray(value.trackIds)) return null;
    const settings = value.settings ?? {};
    const clamp = (
      number: unknown,
      minimum: number,
      maximum: number,
      fallback: number,
    ) =>
      typeof number === "number" && Number.isFinite(number)
        ? Math.min(maximum, Math.max(minimum, number))
        : fallback;
    const trackIds: string[] = [];
    const entryIds: string[] = [];
    const seen = new Set<string>();
    for (const [index, trackId] of value.trackIds.entries()) {
      if (typeof trackId !== "string") continue;
      const candidate = Array.isArray(value.entryIds)
        ? value.entryIds[index]
        : null;
      const entryId =
        typeof candidate === "string" &&
        candidate.length > 0 &&
        !seen.has(candidate)
          ? candidate
          : crypto.randomUUID();
      seen.add(entryId);
      trackIds.push(trackId);
      entryIds.push(entryId);
    }
    return {
      trackIds,
      entryIds,
      settings: {
        cadence: Math.round(
          clamp(settings.cadence, 60, 240, DEFAULT_SETTINGS.cadence),
        ),
        tone: ["click", "wood", "rim", "soft", "beep", "shaker"].includes(
          settings.tone,
        )
          ? settings.tone
          : DEFAULT_SETTINGS.tone,
        bgmVolume: clamp(settings.bgmVolume, 0, 1, DEFAULT_SETTINGS.bgmVolume),
        beatVolume: clamp(
          settings.beatVolume,
          0,
          1,
          DEFAULT_SETTINGS.beatVolume,
        ),
      },
      format: value.format === "wav" ? "wav" : "mp3",
    };
  } catch {
    return null;
  }
}

export function restoreEntries(
  project: SavedProject,
  library: Track[],
): PlaylistEntry[] {
  const byId = new Map(library.map((track) => [track.id, track]));
  return project.trackIds.flatMap((trackId, index) => {
    const track = byId.get(trackId);
    return track ? [{ entryId: project.entryIds[index], track }] : [];
  });
}

export function replaceEntryTrack(
  entries: PlaylistEntry[],
  entryId: string,
  expectedTrackId: string,
  track: Track,
): PlaylistEntry[] {
  const index = entries.findIndex(
    (entry) => entry.entryId === entryId && entry.track.id === expectedTrackId,
  );
  if (index < 0) return entries;
  const updated = [...entries];
  updated[index] = { ...entries[index], track };
  return updated;
}

export function updateSharedTrack(
  entries: PlaylistEntry[],
  track: Track,
): PlaylistEntry[] {
  return entries.map((entry) =>
    entry.track.id === track.id ? { ...entry, track } : entry,
  );
}
