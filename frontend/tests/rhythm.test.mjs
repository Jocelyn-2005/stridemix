import test from "node:test";
import assert from "node:assert/strict";
import { matchRhythm, metronomeTimes } from "../src/rhythm.ts";

const cadence = 165;
const anchor = 0.173;
const period = 60 / cadence;
const fixture = {
  start_seconds: 0,
  duration_seconds: 10,
  envelope: [],
  reliability: 0.9,
  onsets: Array.from({ length: 26 }, (_, index) => ({ time: anchor + index * period, strength: 1, strong: true })),
};

test("actual nonzero drum attacks match the shared metronome grid", () => {
  const match = matchRhythm(fixture, cadence, anchor, 0);
  assert.equal(match.score, 100);
  assert.ok(match.errorMs < 1e-8);
  assert.equal(match.matched, 26);
  assert.ok(matchRhythm(fixture, cadence, anchor, 60000 / cadence / 2).score < 1);
  assert.ok(matchRhythm(fixture, cadence, anchor, 40).score < match.score);
});

test("offbeat ornamentation preserves a matching strong musical pulse", () => {
  const ornamented = {
    ...fixture,
    onsets: fixture.onsets.flatMap(node => [
      node,
      { time: node.time + period / 2, strength: 0.9, strong: false },
    ]),
  };
  const match = matchRhythm(ornamented, cadence, anchor, 0);
  assert.equal(match.score, 100);
  assert.equal(match.total, fixture.onsets.length);
});

test("match reference requires sufficient actual evidence", () => {
  assert.equal(matchRhythm({ ...fixture, onsets: [] }, cadence, anchor, 0), null);
  assert.equal(matchRhythm({ ...fixture, reliability: 0.1 }, cadence, anchor, 0), null);
  assert.equal(matchRhythm({ ...fixture, onsets: fixture.onsets.slice(0, 3) }, cadence, anchor, 0), null);
  assert.equal(matchRhythm(fixture, Number.NaN, anchor, 0), null);
});

test("nodes before the first real click cannot match a negative beat index", () => {
  const early = {
    ...fixture,
    duration_seconds: 2,
    onsets: [0.01, 0.02, 0.03, 0.04].map(time => ({ time, strength: 1, strong: true })),
  };
  const match = matchRhythm(early, 60, 0.9, 0);
  assert.ok(match.errorMs > 800);
  assert.equal(match.score, 0);
});

test("visible metronome ticks retain global phase across segment changes", () => {
  const first = metronomeTimes(0, 4, cadence, anchor, -20);
  const later = metronomeTimes(4, 4, cadence, anchor, -20);
  assert.ok(Math.abs(first[0] - 0.153) < 1e-8);
  assert.ok(later.every((time) => time >= 4 && time < 8));
  assert.ok(Math.abs((later[0] - first[0]) / period - Math.round((later[0] - first[0]) / period)) < 1e-8);
  assert.deepEqual(metronomeTimes(0, 0, cadence, anchor, 0), []);
});
