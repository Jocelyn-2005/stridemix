import test from "node:test";
import assert from "node:assert/strict";
import { PreviewEngine } from "../src/audio.ts";

function createPreview(t) {
  const originals = {
    Audio: globalThis.Audio,
    AudioContext: globalThis.AudioContext,
    fetch: globalThis.fetch,
  };
  const media = [];

  globalThis.Audio = class {
    currentTime = 0;
    playCalls = 0;
    constructor() {
      media.push(this);
    }
    async play() {
      this.playCalls += 1;
    }
    pause() {}
    load() {}
    removeAttribute() {}
  };
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    async resume() {}
    async close() {}
    async decodeAudioData() {
      return {};
    }
    createGain() {
      return { gain: { value: 0, setTargetAtTime() {} }, connect() {} };
    }
    createMediaElementSource() {
      return { connect() {} };
    }
    createDynamicsCompressor() {
      return {
        threshold: {},
        knee: {},
        ratio: {},
        attack: {},
        release: {},
        connect() {},
      };
    }
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, disconnect() {} };
    }
  };
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const states = [];
  const errors = [];
  const engine = new PreviewEngine(
    (state) => states.push(state),
    (message) => errors.push(message),
  );
  const tracks = [10, 20].map((duration, index) => ({
    id: `track-${index}`,
    title: `Track ${index}`,
    duration,
    source: "test",
    preview_url: `/api/media/track-${index}`,
    waveform: [],
  }));
  engine.setTracks(tracks);
  t.after(() => {
    engine.dispose();
    Object.assign(globalThis, originals);
    assert.deepEqual(errors, []);
  });
  return { engine, states, audio: media[0], tracks };
}

test("seeking to the end stops there without starting another play", async (t) => {
  const { engine, states, audio } = createPreview(t);
  await engine.play();
  await engine.seek(30);
  assert.equal(states.at(-1).playing, false);
  assert.equal(states.at(-1).position, 30);
  assert.equal(states.at(-1).activeIndex, -1);
  assert.equal(audio.playCalls, 1);
});

test("seeking within the playlist preserves playing state", async (t) => {
  const { engine, states, audio } = createPreview(t);
  await engine.play();
  await engine.seek(15);
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 15);
  assert.equal(states.at(-1).activeIndex, 1);
  assert.equal(audio.currentTime, 5);
});

test("seeking just before the end preserves that position", async (t) => {
  const { engine, states } = createPreview(t);
  await engine.play();
  await engine.seek(29.999);
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 29.999);
});

test("an explicit play after reaching the end restarts from the first track", async (t) => {
  const { engine, states, audio } = createPreview(t);
  await engine.play();
  await engine.seek(30);
  await engine.play();
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 0);
  assert.equal(states.at(-1).activeIndex, 0);
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.playCalls, 2);
});

test("BPM metadata updates preserve the current transport", async (t) => {
  const { engine, states, audio, tracks } = createPreview(t);
  await engine.play();
  await engine.seek(5);
  const calls = audio.playCalls;
  engine.setTracks(
    tracks.map((track) => ({
      ...track,
      tempo: { bpm: 82.5, confidence: 1, status: "detected", source: "manual" },
    })),
  );
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 5);
  assert.equal(audio.playCalls, calls);
});
