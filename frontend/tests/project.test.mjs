import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProject,
  restoreEntries,
  replaceEntryTrack,
  updateSharedTrack,
} from "../src/project.ts";

const track = (id, duration = 10) => ({
  id,
  duration,
  title: id,
  preview_url: `/api/media/${id}`,
  source: "test",
  waveform: [],
});

test("legacy projects get separate stable instances for repeated material", () => {
  const project = parseProject(JSON.stringify({ trackIds: ["same", "same"] }));
  assert.equal(new Set(project.entryIds).size, 2);
  const entries = restoreEntries(project, [track("same")]);
  assert.deepEqual(
    entries.map((entry) => entry.track.id),
    ["same", "same"],
  );
  assert.deepEqual(
    entries.map((entry) => entry.entryId),
    project.entryIds,
  );
  const restored = parseProject(JSON.stringify(project));
  assert.deepEqual(restored.entryIds, project.entryIds);
});

test("missing media does not change the remaining instance ID", () => {
  const project = parseProject(
    JSON.stringify({
      trackIds: ["missing", "present"],
      entryIds: ["first", "second"],
    }),
  );
  assert.deepEqual(
    restoreEntries(project, [track("present")]).map((entry) => entry.entryId),
    ["second"],
  );
});

test("bad data is filtered while preserving entry alignment and setting defaults", () => {
  const project = parseProject(
    JSON.stringify({
      trackIds: ["first", 3, "second", "third"],
      entryIds: ["stable", "invalid", "stable", "last"],
      settings: {
        cadence: 900,
        tone: "unknown",
        bgmVolume: -2,
        beatVolume: "bad",
      },
      format: "other",
    }),
  );
  assert.deepEqual(project.trackIds, ["first", "second", "third"]);
  assert.equal(project.entryIds[0], "stable");
  assert.equal(project.entryIds[2], "last");
  assert.equal(new Set(project.entryIds).size, 3);
  assert.deepEqual(project.settings, {
    cadence: 240,
    tone: "click",
    bgmVolume: 0,
    beatVolume: 0.55,
  });
  assert.equal(project.format, "mp3");
  assert.equal(parseProject("broken json"), null);
  assert.equal(parseProject("{}"), null);
});

test("adapt completion after reorder replaces only the chosen instance", () => {
  const source = track("same");
  const entries = [
    { entryId: "two", track: source },
    { entryId: "one", track: source },
  ];
  const result = replaceEntryTrack(entries, "one", "same", track("adapted", 9));
  assert.deepEqual(
    result.map((entry) => entry.track.id),
    ["same", "adapted"],
  );
  assert.deepEqual(
    result.map((entry) => entry.entryId),
    ["two", "one"],
  );
});

test("deleted or replaced entries cannot receive stale async results", () => {
  const entries = [{ entryId: "one", track: track("newer") }];
  assert.equal(
    replaceEntryTrack(entries, "deleted", "same", track("stale")),
    entries,
  );
  assert.equal(
    replaceEntryTrack(entries, "one", "same", track("stale")),
    entries,
  );
});

test("manual BPM updates all instances of the same material", () => {
  const source = track("same");
  const other = { entryId: "other", track: track("other") };
  const entries = [
    { entryId: "one", track: source },
    other,
    { entryId: "two", track: source },
  ];
  const updated = {
    ...source,
    tempo: { bpm: 82.5, confidence: 1, status: "detected", source: "manual" },
  };
  const result = updateSharedTrack(entries, updated);
  assert.equal(result[0].track.tempo.bpm, 82.5);
  assert.equal(result[2].track.tempo.bpm, 82.5);
  assert.equal(result[1], other);
});
