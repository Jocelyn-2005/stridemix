import test from "node:test";
import assert from "node:assert/strict";
import { auditionFrame } from "../src/audition.ts";

test("one alternating foot landing follows each actual metronome click, including phase adjustment", () => {
  const cadence = 170;
  const anchor = 0.173;
  for (let beat = 0; beat < 20; beat++) {
    const frame = auditionFrame(anchor + 0.01 + beat * 60 / cadence, cadence, anchor, 10, true);
    assert.equal(frame.landingFoot, beat % 2 === 0 ? "left" : "right");
    assert.ok(frame.pulse > 0.999);
    assert.ok(Math.abs(frame[frame.landingFoot].lift) < 1e-8);
  }
});

test("pose is a pure function of the audio position, so seek and pause do not drift", () => {
  const expected = auditionFrame(45.78, 165, 0.08, -50, true);
  auditionFrame(900, 165, 0.08, -50, true);
  assert.deepEqual(auditionFrame(45.78, 165, 0.08, -50, true), expected);
  assert.ok(expected.left.lift === 0 || expected.right.lift === 0);
});

test("silent song gaps and pre-roll keep the character and ground still", () => {
  assert.deepEqual(auditionFrame(1, 170, 0, 0, false), auditionFrame(20, 170, 0, 0, false));
  const before = auditionFrame(0.05, 165, 0.173, 0, true);
  assert.equal(before.pulse, 0);
  assert.equal(before.groundOffset, 0);
});

test("changing cadence changes stride timing while keeping finite scene coordinates", () => {
  assert.notDeepEqual(auditionFrame(0.2, 60), auditionFrame(0.2, 240));
  for (const cadence of [60, 165, 240]) {
    for (let time = 0; time < 4; time += 0.025) {
      const frame = auditionFrame(time, cadence);
      assert.ok(Number.isFinite(frame.groundOffset));
      assert.ok(frame.left.lift >= 0 && frame.left.lift <= 36);
      assert.ok(frame.right.lift >= 0 && frame.right.lift <= 36);
    }
  }
});
