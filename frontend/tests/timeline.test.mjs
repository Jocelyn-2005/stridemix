import test from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE_RATE,
  beatPhaseSeconds,
  buildTimeline,
  countTrackBeats,
  locateTrack,
  nextBeatFrame,
  nextBeatPosition,
} from "../src/timeline.ts";

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

test("timeline rounds each song and gap to exact PCM frames", () => {
  const timeline = buildTimeline([{ duration: 1.00001 }, { duration: 2.00001 }], 0.12345);
  assert.deepEqual(timeline.tracks, [
    { index: 0, startFrame: 0, endFrame: 44100, durationFrames: 44100 },
    { index: 1, startFrame: 49544, endFrame: 137744, durationFrames: 88200 },
  ]);
  assert.equal(timeline.durationFrames, 137744);
  assert.equal(buildTimeline([], 2).durationFrames, 0);
  assert.equal(buildTimeline([{ duration: 1 }], 2).durationFrames, SAMPLE_RATE);
  assert.equal(locateTrack([{ duration: 10 }, { duration: 20 }], 11, 2), null);
  assert.deepEqual(locateTrack([{ duration: 10 }, { duration: 20 }], 12, 2), { index: 1, offset: 0 });
});

test("song beat grids use their anchor, signed offsets and positive modulo", () => {
  assert.ok(Math.abs(beatPhaseSeconds(0.173, -500, 165) - 0.03663636363636363) < 1e-10);
  assert.equal(nextBeatFrame(0, 165, 0.173, 0).frame, Math.round(0.173 * SAMPLE_RATE));
  const beat = nextBeatFrame(1800 * SAMPLE_RATE, 165, 0.173, 10);
  assert.equal(beat.frame, Math.round((1800 + 0.183) * SAMPLE_RATE));
  assert.equal(countTrackBeats(SAMPLE_RATE, 120, 0.173, 0), 2);
  assert.equal(countTrackBeats(Math.round(0.173 * SAMPLE_RATE), 120, 0.173, 0), 0);
});

test("a rounded beat on the exact seek frame is included once", () => {
  const anchor = 0.17301;
  const frame = Math.round(anchor * SAMPLE_RATE);
  assert.equal(nextBeatFrame(frame, 165, anchor).frame, frame);
  assert.equal(nextBeatFrame(frame, 165, anchor).index, 0);
  assert.equal(countTrackBeats(frame, 165, anchor), 0);
  assert.equal(countTrackBeats(frame + 1, 165, anchor), 1);
});
