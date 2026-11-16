import test from "node:test";
import assert from "node:assert/strict";
import { PreviewEngine } from "../src/audio.ts";

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

function createPreview(t, durations = [10, 20]) {
  const originals = { AudioContext: globalThis.AudioContext, fetch: globalThis.fetch };
  const sources = [];
  const requests = [];
  const tracks = durations.map((duration, index) => ({
    id: `track-${index}`, title: `Track ${index}`, duration, source: "test",
    preview_url: `/api/media/track-${index}`, waveform: [],
    alignment: { anchor_seconds: index ? 0.291 : 0.173, bpm: 165, confidence: 1, drift_ms: 0, status: "detected" },
  }));
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    async resume() {}
    async close() {}
    async decodeAudioData(data) { return data; }
    createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {} }; }
    createDynamicsCompressor() {
      return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect() {} };
    }
    createBufferSource() {
      const source = {
        connect() {},
        start(...args) { this.startArgs = args; },
        stop(...args) { this.stopArgs = args; },
        disconnect() {},
      };
      sources.push(source);
      return source;
    }
  };
  globalThis.fetch = async (path) => {
    requests.push(path);
    const url = new URL(path, "http://localhost");
    const match = url.pathname.match(/^\/api\/media\/(track-\d+)\/chunk$/);
    if (!match) return { ok: true, arrayBuffer: async () => ({ kind: "tone", duration: 0.4, length: 17640 }) };
    const track = tracks.find((item) => item.id === match[1]);
    const startFrame = Number(url.searchParams.get("start_frame"));
    const length = Math.min(220500, Math.round(track.duration * 44100) - startFrame);
    return { ok: true, arrayBuffer: async () => ({ kind: "music", id: match[1], startFrame, duration: length / 44100, length }) };
  };
  const states = [];
  const errors = [];
  const engine = new PreviewEngine((state) => states.push(state), (message) => errors.push(message));
  engine.setTracks(tracks);
  t.after(() => { engine.dispose(); Object.assign(globalThis, originals); });
  return { engine, states, tracks, sources, requests, errors };
}

test("PCM music and anchored clicks share one scheduling clock", async (t) => {
  const { engine, sources, requests } = createPreview(t);
  await engine.play();
  const music = sources.find((source) => source.buffer.kind === "music");
  assert.ok(music);
  assert.equal(music.buffer.startFrame, 0);
  assert.equal(music.startArgs[1], 0);
  engine.context.currentTime = engine.contextAnchor + 0.1;
  engine.tick();
  const click = sources.find((source) => source.buffer.kind === "tone");
  assert.ok(click);
  assert.ok(Math.abs(click.startArgs[0] - music.startArgs[0] - 0.173) <= 1 / 44100);
  assert.ok(requests.some((path) => path.includes("/chunk?start_frame=0&frame_count=220500")));
});

test("seeking to the end stops and explicit play restarts", async (t) => {
  const { engine, states } = createPreview(t);
  await engine.play();
  await engine.seek(32);
  assert.deepEqual(states.at(-1), { playing: false, position: 32, activeIndex: -1, pulse: -1 });
  await engine.play();
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 0);
  assert.equal(states.at(-1).activeIndex, 0);
});

test("gap seeks mute both lanes and second-song seeks use that song's phase", async (t) => {
  const { engine, sources, states } = createPreview(t);
  await engine.play();
  await engine.seek(11);
  assert.equal(states.at(-1).activeIndex, -1);
  const afterGap = sources.length;
  engine.tick();
  await flush();
  assert.equal(sources.length, afterGap);
  await engine.seek(12.2);
  assert.equal(states.at(-1).activeIndex, 1);
  const music = sources.findLast((source) => source.buffer.kind === "music");
  assert.equal(music.buffer.id, "track-1");
  assert.ok(Math.abs(music.startArgs[1] - 0.2) < 1e-8);
  const click = sources.findLast((source) => source.buffer.kind === "tone");
  assert.ok(Math.abs(click.startArgs[0] - music.startArgs[0] - 0.091) <= 1 / 44100);
});

test("natural transition clips click tails and resets at the second song", async (t) => {
  const { engine, sources, states } = createPreview(t, [0.3, 1]);
  await engine.play();
  const origin = engine.contextAnchor;
  engine.context.currentTime = origin + 0.1;
  engine.tick();
  const firstClick = sources.find((source) => source.buffer.kind === "tone");
  assert.ok(Math.abs(firstClick.stopArgs[0] - origin - 0.3) <= 1 / 44100);
  engine.context.currentTime = origin + 1;
  engine.tick();
  assert.equal(states.at(-1).activeIndex, -1);
  engine.context.currentTime = origin + 2.2;
  engine.tick();
  await flush();
  engine.context.currentTime = origin + 2.5;
  engine.tick();
  await flush();
  const nextMusic = sources.find((source) => source.buffer.id === "track-1");
  const secondClick = sources.find((source) => source.buffer.kind === "tone" && source.startArgs[0] > origin + 2);
  assert.ok(nextMusic);
  assert.ok(Math.abs(nextMusic.startArgs[0] - origin - 2.3) <= 1 / 44100);
  assert.ok(Math.abs(secondClick.startArgs[0] - origin - 2.591) <= 1 / 44100);
});

test("alignment and phase edits refresh click scheduling while music continues", async (t) => {
  const { engine, sources, tracks, states } = createPreview(t);
  await engine.play();
  await engine.seek(5);
  const music = sources.filter((source) => source.buffer.kind === "music");
  const stops = music.map((source) => source.stopArgs);
  const reset = engine.setTracks(tracks.map((track) => ({ ...track, alignment: { ...track.alignment, anchor_seconds: 0.2 } })), [10, -10]);
  assert.equal(reset, false);
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 5);
  assert.deepEqual(sources.filter((source) => source.buffer.kind === "music"), music);
  assert.deepEqual(music.map((source) => source.stopArgs), stops);
});

test("long-track PCM cache stays bounded to current and next chunks", async (t) => {
  const { engine, errors } = createPreview(t, [3600]);
  await engine.play();
  for (let index = 1; index <= 100; index += 1) {
    engine.context.currentTime = engine.contextAnchor + index * 0.1;
    engine.tick();
    await flush();
    assert.ok(engine.chunks.size <= 2);
    assert.ok(engine.pendingChunks.size <= 2);
  }
  assert.deepEqual(errors, []);
});

test("buffer failures stop music and click together", async (t) => {
  const { engine, sources, errors } = createPreview(t, [30]);
  await engine.play();
  globalThis.fetch = async () => ({ ok: false });
  engine.context.currentTime = engine.contextAnchor + 5.1;
  engine.tick();
  await flush();
  assert.equal(engine.playing, false);
  assert.equal(errors.length, 1);
  assert.ok(sources.every((source) => source.stopArgs));
});

test("a stalled chunk stops both lanes when scheduled music runs out", async (t) => {
  const { engine, sources, states, errors } = createPreview(t, [30]);
  const fetch = globalThis.fetch;
  let stalledRequests = 0;
  globalThis.fetch = (path, options) => {
    if (path.includes("start_frame=441000&")) {
      stalledRequests += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      });
    }
    return fetch(path, options);
  };
  await engine.play();
  engine.context.currentTime = engine.contextAnchor + 4.9;
  engine.tick();
  await flush();
  assert.equal(engine.musicCursorFrame, 10 * 44100);
  engine.context.currentTime = engine.contextAnchor + 9.9;
  engine.tick();
  await flush();
  assert.equal(stalledRequests, 1);
  assert.equal(engine.pendingChunks.size, 1);
  engine.context.currentTime = engine.contextAnchor + 10.5;
  engine.tick();
  await flush();
  assert.equal(states.at(-1).playing, false);
  assert.equal(states.at(-1).position, 10.5);
  assert.equal(errors.length, 1);
  assert.equal(engine.pendingChunks.size, 0);
  assert.equal(engine.musicSources.size, 0);
  assert.equal(engine.beatSources.size, 0);
  assert.ok(sources.every((source) => source.stopArgs));
  const scheduledSources = sources.length;
  engine.context.currentTime = engine.contextAnchor + 11;
  engine.tick();
  assert.equal(sources.length, scheduledSources);
});

test("silent gaps continue after the preceding music buffer ends", async (t) => {
  const { engine, states, errors } = createPreview(t, [1, 1]);
  await engine.play();
  assert.equal(engine.musicCursorFrame, 44100);
  engine.context.currentTime = engine.contextAnchor + 2;
  engine.tick();
  await flush();
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).activeIndex, -1);
  assert.equal(states.at(-1).position, 2);
  assert.deepEqual(errors, []);
});

test("metronome-only playback continues without any music buffers", async (t) => {
  const { engine, sources, states, errors } = createPreview(t, []);
  await engine.play();
  engine.context.currentTime = engine.contextAnchor + 10.5;
  engine.tick();
  assert.equal(states.at(-1).playing, true);
  assert.equal(states.at(-1).position, 10.5);
  assert.equal(states.at(-1).activeIndex, -1);
  assert.ok(sources.length > 0);
  assert.ok(sources.every((source) => source.buffer.kind === "tone"));
  assert.deepEqual(errors, []);
});

test("pause while PCM is loading prevents a delayed playback restart", async (t) => {
  const { engine, states, sources } = createPreview(t);
  const fetch = globalThis.fetch;
  const release = [];
  globalThis.fetch = async (path, options) => {
    if (path.includes("/chunk?")) await new Promise((resolve) => release.push(resolve));
    return fetch(path, options);
  };
  const playing = engine.play();
  await flush();
  engine.pause();
  release.forEach((resolve) => resolve());
  await playing;
  assert.equal(states.at(-1).playing, false);
  assert.equal(sources.length, 0);
});

test("changing the tone during startup waits for the selected tone", async (t) => {
  const { engine, sources } = createPreview(t);
  const fetch = globalThis.fetch;
  let release;
  globalThis.fetch = async (path, options) => {
    if (path.includes("/tones/click")) await new Promise((resolve) => { release = resolve; });
    const response = await fetch(path, options);
    const data = await response.arrayBuffer();
    data.tone = path.includes("/tones/") ? path : undefined;
    return { ...response, arrayBuffer: async () => data };
  };
  const playing = engine.play();
  await flush();
  engine.update({ cadence: 165, tone: "wood", bgmVolume: 0.65, beatVolume: 0.55, gapSeconds: 2 });
  release();
  await playing;
  engine.context.currentTime = engine.contextAnchor + 0.1;
  engine.tick();
  const click = sources.find((source) => source.buffer.kind === "tone");
  assert.ok(click?.buffer.tone.includes("/wood.wav"));
});

test("zero-gap tracks use independent beat anchors at their shared boundary", async (t) => {
  const { engine, sources } = createPreview(t, [0.3, 1]);
  engine.update({ cadence: 165, tone: "click", bgmVolume: 0.65, beatVolume: 0.55, gapSeconds: 0 });
  await engine.play();
  engine.context.currentTime = engine.contextAnchor + 0.2;
  engine.tick();
  await flush();
  engine.context.currentTime = engine.contextAnchor + 0.5;
  engine.tick();
  const secondClick = sources.find((source) => source.buffer.kind === "tone" && source.startArgs[0] > engine.contextAnchor + 0.3);
  assert.ok(Math.abs(secondClick.startArgs[0] - engine.contextAnchor - 0.591) <= 1 / 44100);
});
