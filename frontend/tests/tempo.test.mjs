import test from "node:test";
import assert from "node:assert/strict";
import { cadenceReferences, chooseCadenceReference } from "../src/tempo.ts";

test("82.5 BPM maps to 165 steps per minute at original speed", () => {
  const reference = chooseCadenceReference(82.5, 165);
  assert.equal(reference.multiplier, 2);
  assert.equal(reference.cadence, 165);
  assert.equal(165 / reference.cadence, 1);
  assert.equal(chooseCadenceReference(165, 82.5).multiplier, 0.5);
});

test("40 BPM adapts to 85 musical BPM for a 170 step cadence", () => {
  const reference = chooseCadenceReference(40, 170);
  const speed = 170 / reference.cadence;
  assert.equal(reference.multiplier, 2);
  assert.equal(speed, 2.125);
  assert.equal(40 * speed, 85);
  assert.equal(85 * (170 / chooseCadenceReference(85, 170).cadence), 85);
});

test("references include valid half, original and double cadence", () => {
  assert.deepEqual(
    cadenceReferences(120).map((item) => item.cadence),
    [60, 120, 240],
  );
  assert.deepEqual(
    cadenceReferences(30).map((item) => item.cadence),
    [60],
  );
  assert.deepEqual(
    cadenceReferences(480).map((item) => item.cadence),
    [240],
  );
  assert.deepEqual(cadenceReferences(null), []);
  assert.deepEqual(cadenceReferences(Number.NaN), []);
});

test("closest tempo uses proportional change with original-beat tie preference", () => {
  assert.equal(chooseCadenceReference(120, 165).cadence, 120);
  assert.equal(chooseCadenceReference(120, 180).cadence, 240);
  assert.equal(chooseCadenceReference(120, 120 * Math.SQRT1_2).multiplier, 1);
  assert.equal(chooseCadenceReference(120, 120 * Math.SQRT2).multiplier, 1);
});
