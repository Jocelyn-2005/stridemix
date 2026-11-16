import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProject,
  restoreEntries,
  replaceEntryTrack,
  updateSharedTrack,
  toggleHalfBeatOffset,
} from "../src/project.ts";

const track = (id, duration = 10) => ({
  id,
  duration,
  title: id,
  preview_url: `/api/media/${id}`,
  source: "test",
  waveform: [],
});

test("half beat toggles preserve fine adjustment and stay inside offset limits", () => {
  for (const cadence of [60, 165, 240]) {
    for (const offset of [-1000, -990, -80, 0, 80, 990, 1000]) {
      const toggled = toggleHalfBeatOffset(offset, cadence);
      assert.ok(toggled >= -1000 && toggled <= 1000);
      const restored = toggleHalfBeatOffset(toggled, cadence);
      const period = 60000 / cadence;
      const phaseDifference = (restored - offset) / period;
      assert.ok(Math.abs(phaseDifference - Math.round(phaseDifference)) < 1e-8);
    }
  }
  assert.ok(Math.abs(toggleHalfBeatOffset(0, 165) - 60000 / 165 / 2) < 1e-8);
  assert.ok(Math.abs(toggleHalfBeatOffset(toggleHalfBeatOffset(80, 165), 165) - 80) < 1e-8);
});

test("legacy projects get separate stable instances for repeated material", () => {
  const project = parseProject(JSON.stringify({ trackIds: ["same", "same"] }));
  assert.equal(new Set(project.entryIds).size, 2);
  assert.deepEqual(project.phaseOffsetsMs, [0, 0]);
  assert.equal(project.settings.gapSeconds, 2);
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
    gapSeconds: 2,
  });
  assert.equal(project.format, "mp3");
  assert.equal(parseProject("broken json"), null);
  assert.equal(parseProject("{}"), null);
});

test("phase offsets stay paired with duplicate entries through restore and filtering", () => {
  const project = parseProject(
    JSON.stringify({
      trackIds: ["same", 7, "missing", "same"],
      entryIds: ["first", "invalid", "missing", "second"],
      phaseOffsetsMs: [-80, 150, 20, 181.818],
      settings: { gapSeconds: 0.75 },
    }),
  );
  assert.deepEqual(project.phaseOffsetsMs, [-80, 20, 181.818]);
  assert.equal(project.settings.gapSeconds, 0.75);
  const restored = restoreEntries(project, [track("same")]);
  assert.deepEqual(restored.map((entry) => entry.phaseOffsetMs), [-80, 181.818]);
  assert.deepEqual(restored.map((entry) => entry.entryId), ["first", "second"]);
  const adapted = replaceEntryTrack(restored, "second", "same", track("adapted"));
  assert.equal(adapted[1].phaseOffsetMs, 181.818);
});

test("invalid phase offsets and gap values use bounded defaults", () => {
  const project = parseProject(
    JSON.stringify({
      trackIds: ["first", "second", "third", "fourth"],
      phaseOffsetsMs: [-2000, 2000, "bad"],
      settings: { gapSeconds: 100 },
    }),
  );
  assert.deepEqual(project.phaseOffsetsMs, [-1000, 1000, 0, 0]);
  assert.equal(project.settings.gapSeconds, 30);
  assert.equal(parseProject(JSON.stringify({ trackIds: [], settings: { gapSeconds: -1 } })).settings.gapSeconds, 0);
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
