import test from "node:test";
import assert from "node:assert/strict";
import { locateTrack, nextBeatPosition } from "../src/timeline.ts";

test("seek locates the next track exactly on a boundary", () => {
  assert.deepEqual(locateTrack([{ duration: 10 }, { duration: 20 }], 10), {
    index: 1,
    offset: 0,
  });
  assert.deepEqual(locateTrack([{ duration: 10 }, { duration: 20 }], 15.5), {
    index: 1,
    offset: 5.5,
  });
});

test("absolute cadence phase survives a seek", () => {
  const position = nextBeatPosition(1800 - 0.1, 165);
  assert.equal(position.index, 4950);
  assert.equal(position.time, 1800);
});

test("empty timeline and end position are safe", () => {
  assert.equal(locateTrack([], 1), null);
  assert.equal(locateTrack([{ duration: 10 }], 10), null);
});
