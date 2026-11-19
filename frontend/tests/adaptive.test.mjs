import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentAt, processingAt, signedMilliseconds } from '../src/adaptive.ts';

const segments = [
  {source_start:0, source_end:10, output_start:0, output_end:8, speed:1.25, correction_ms:12, confidence:.9, drift_ms:8},
  {source_start:10, source_end:19, output_start:8, output_end:18, speed:.9, correction_ms:-20, confidence:.3, drift_ms:null},
];

test('live processing follows output time, including a seek and exact boundary', () => {
  const track = {adaptation:{speed:1.05,segments}};
  assert.equal(processingAt(track,7.999).speed,1.25);
  assert.equal(processingAt(track,8).speed,.9);
  assert.equal(processingAt(track,12).correctionMs,-20);
  assert.equal(processingAt(track,2).driftMs,8);
  assert.equal(processingAt(track,12).driftMs,null);
  assert.equal(segmentAt(segments,18),null);
});

test('originals and old adaptations retain honest neutral defaults', () => {
  assert.equal(processingAt({},30).speed,1);
  assert.equal(processingAt({adaptation:{speed:.8}},30).speed,.8);
  assert.equal(processingAt(undefined,30).driftMs,null);
  assert.equal(segmentAt(segments,NaN),null);
  assert.equal(segmentAt(segments,-1),null);
  assert.equal(signedMilliseconds(-.1),'0 ms');
  assert.equal(signedMilliseconds(24.4),'+24 ms');
});
