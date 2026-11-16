import type { Track } from "./api";
import {
  beatPhaseSeconds,
  buildTimeline,
  nextBeatFrame,
  SAMPLE_RATE,
} from "./timeline.ts";
import type { TimelineTrack } from "./timeline.ts";

export interface MixSettings {
  cadence: number;
  tone: string;
  bgmVolume: number;
  beatVolume: number;
  gapSeconds: number;
}

export interface PlaybackState {
  playing: boolean;
  position: number;
  activeIndex: number;
  pulse: number;
}

interface ChunkRequest {
  key: string;
  trackId: string;
  startFrame: number;
}

const CHUNK_FRAMES = SAMPLE_RATE * 5;
const LOOKAHEAD_FRAMES = Math.round(SAMPLE_RATE * 0.15);

export class PreviewEngine {
  private context: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private beatGain: GainNode | null = null;
  private tones = new Map<string, AudioBuffer>();
  private pendingTones = new Map<string, Promise<AudioBuffer>>();
  private chunks = new Map<string, AudioBuffer>();
  private pendingChunks = new Map<
    string,
    { promise: Promise<AudioBuffer>; controller: AbortController }
  >();
  private wantedChunks = new Set<string>();
  private musicSources = new Set<AudioBufferSourceNode>();
  private beatSources = new Set<AudioBufferSourceNode>();
  private tracks: Track[] = [];
  private phaseOffsetsMs: number[] = [];
  private settings: MixSettings = {
    cadence: 165,
    tone: "click",
    bgmVolume: 0.65,
    beatVolume: 0.55,
    gapSeconds: 2,
  };
  private timeline = buildTimeline([], 2);
  private playing = false;
  private positionFrame = 0;
  private contextAnchor = 0;
  private positionAnchorFrame = 0;
  private musicCursorFrame = 0;
  private beatCursorFrame = 0;
  private pumpingVersion: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private version = 0;
  private onState: (state: PlaybackState) => void;
  private onError: (message: string) => void;

  constructor(
    onState: (state: PlaybackState) => void,
    onError: (message: string) => void,
  ) {
    this.onState = onState;
    this.onError = onError;
  }

  setTracks(tracks: Track[], phaseOffsetsMs: number[] = []) {
    const sameAudio =
      this.tracks.length === tracks.length &&
      this.tracks.every(
        (track, index) =>
          track.id === tracks[index].id &&
          track.duration === tracks[index].duration &&
          track.preview_url === tracks[index].preview_url,
      );
    const rhythmChanged = this.tracks.some(
      (track, index) =>
        track.alignment?.anchor_seconds !== tracks[index]?.alignment?.anchor_seconds ||
        (this.phaseOffsetsMs[index] ?? 0) !== (phaseOffsetsMs[index] ?? 0),
    );
    if (!sameAudio) this.pause();
    this.tracks = tracks;
    this.phaseOffsetsMs = phaseOffsetsMs;
    this.timeline = buildTimeline(tracks, this.settings.gapSeconds);
    if (sameAudio) {
      if (rhythmChanged) this.refreshBeats();
      return false;
    }
    this.chunks.clear();
    this.positionFrame = 0;
    this.emit();
    return true;
  }

  update(settings: MixSettings) {
    const gapChanged = settings.gapSeconds !== this.settings.gapSeconds;
    const rhythmChanged =
      settings.cadence !== this.settings.cadence ||
      settings.tone !== this.settings.tone;
    if (gapChanged) this.pause();
    this.settings = settings;
    if (this.context && this.bgmGain && this.beatGain) {
      this.bgmGain.gain.setTargetAtTime(settings.bgmVolume, this.context.currentTime, 0.015);
      this.beatGain.gain.setTargetAtTime(settings.beatVolume, this.context.currentTime, 0.015);
    }
    if (gapChanged) {
      this.timeline = buildTimeline(this.tracks, settings.gapSeconds);
      this.positionFrame = 0;
      this.emit();
    }
    if (rhythmChanged) this.refreshBeats();
  }

  async audition(tone: string) {
    const context = this.ensureContext();
    await context.resume();
    const buffer = await this.loadTone(tone);
    const source = this.createSource(buffer, this.beatGain!, this.beatSources);
    source.start();
  }

  async play() {
    if (this.playing) return;
    const version = ++this.version;
    const context = this.ensureContext();
    await context.resume();
    if (version !== this.version) return;
    if (
      this.timeline.durationFrames &&
      this.positionFrame >= this.timeline.durationFrames
    ) this.positionFrame = 0;
    try {
      const requests = this.selectChunks(this.positionFrame);
      await Promise.all([
        this.loadTone(this.settings.tone),
        ...requests.map((request) => this.loadChunk(request)),
      ]);
      while (version === this.version && !this.tones.has(this.settings.tone)) {
        await this.loadTone(this.settings.tone);
      }
      if (version !== this.version) return;
      this.positionAnchorFrame = this.positionFrame;
      this.contextAnchor = context.currentTime + 0.075;
      this.musicCursorFrame = this.positionFrame;
      this.beatCursorFrame = this.positionFrame;
      this.playing = true;
      await this.scheduleMusic(version);
      if (version !== this.version) return;
      this.timer = setInterval(() => this.tick(), 25);
      this.tick();
    } catch (error) {
      if (version !== this.version) return;
      this.pause();
      throw error;
    }
  }

  pause() {
    if (this.playing) this.positionFrame = this.currentFrame();
    this.version += 1;
    this.playing = false;
    clearInterval(this.timer);
    this.clearSources(this.musicSources);
    this.clearSources(this.beatSources);
    for (const pending of this.pendingChunks.values()) {
      pending.controller.abort();
    }
    this.pendingChunks.clear();
    this.emit();
  }

  async seek(position: number) {
    const resume = this.playing;
    this.pause();
    const frame = Math.round(Math.max(0, position) * SAMPLE_RATE);
    this.positionFrame = Math.min(frame, this.timeline.durationFrames);
    this.emit();
    if (resume && this.positionFrame < this.timeline.durationFrames) await this.play();
  }

  dispose() {
    this.pause();
    this.chunks.clear();
    this.tones.clear();
    void this.context?.close();
  }

  private currentFrame() {
    if (!this.playing || !this.context) return this.positionFrame;
    const elapsedFrames = Math.round(
      Math.max(0, this.context.currentTime - this.contextAnchor) * SAMPLE_RATE,
    );
    const frame = this.positionAnchorFrame + elapsedFrames;
    return this.tracks.length ? Math.min(frame, this.timeline.durationFrames) : frame;
  }

  private contextTime(frame: number) {
    return this.contextAnchor + (frame - this.positionAnchorFrame) / SAMPLE_RATE;
  }

  private ensureContext() {
    if (this.context) return this.context;
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.bgmGain = this.context.createGain();
    this.beatGain = this.context.createGain();
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    this.bgmGain.gain.value = this.settings.bgmVolume;
    this.beatGain.gain.value = this.settings.beatVolume;
    this.bgmGain.connect(limiter);
    this.beatGain.connect(limiter);
    limiter.connect(this.context.destination);
    return this.context;
  }

  private async loadTone(tone: string) {
    const existing = this.tones.get(tone);
    if (existing) return existing;
    const pending = this.pendingTones.get(tone);
    if (pending) return pending;
    const loading = (async () => {
      const response = await fetch(`/api/tones/${encodeURIComponent(tone)}.wav`);
      if (!response.ok) throw new Error("节拍音色加载失败，请检查本地服务。");
      const buffer = await this.ensureContext().decodeAudioData(await response.arrayBuffer());
      this.tones.set(tone, buffer);
      return buffer;
    })();
    this.pendingTones.set(tone, loading);
    try {
      return await loading;
    } finally {
      this.pendingTones.delete(tone);
    }
  }

  private chunkRequest(interval: TimelineTrack, frame: number): ChunkRequest {
    const localFrame = Math.max(0, frame - interval.startFrame);
    const startFrame = Math.floor(localFrame / CHUNK_FRAMES) * CHUNK_FRAMES;
    const trackId = this.tracks[interval.index].id;
    return { key: `${trackId}:${startFrame}`, trackId, startFrame };
  }

  private selectChunks(position: number) {
    const requests: ChunkRequest[] = [];
    for (const interval of this.timeline.tracks) {
      if (interval.endFrame <= position) continue;
      let frame = Math.max(position, interval.startFrame);
      while (frame < interval.endFrame && requests.length < 2) {
        const request = this.chunkRequest(interval, frame);
        requests.push(request);
        frame = interval.startFrame + request.startFrame + CHUNK_FRAMES;
      }
      if (requests.length === 2) break;
    }
    this.wantedChunks = new Set(requests.map((request) => request.key));
    for (const key of this.chunks.keys()) {
      if (!this.wantedChunks.has(key)) this.chunks.delete(key);
    }
    for (const [key, pending] of this.pendingChunks) {
      if (!this.wantedChunks.has(key)) {
        pending.controller.abort();
        this.pendingChunks.delete(key);
      }
    }
    return requests;
  }

  private async loadChunk(request: ChunkRequest) {
    const existing = this.chunks.get(request.key);
    if (existing) return existing;
    const pending = this.pendingChunks.get(request.key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fetch(
        `/api/media/${encodeURIComponent(request.trackId)}/chunk?start_frame=${request.startFrame}&frame_count=${CHUNK_FRAMES}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error("配乐分块加载失败，请检查本地服务后重新试听。");
      const buffer = await this.ensureContext().decodeAudioData(await response.arrayBuffer());
      controller.signal.throwIfAborted();
      if (this.wantedChunks.has(request.key)) this.chunks.set(request.key, buffer);
      return buffer;
    })();
    this.pendingChunks.set(request.key, { promise, controller });
    try {
      return await promise;
    } finally {
      if (this.pendingChunks.get(request.key)?.promise === promise) {
        this.pendingChunks.delete(request.key);
      }
    }
  }

  private createSource(
    buffer: AudioBuffer,
    gain: GainNode,
    sources: Set<AudioBufferSourceNode>,
  ) {
    const source = this.ensureContext().createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
    };
    return source;
  }

  private async scheduleMusic(version: number) {
    if (this.pumpingVersion === version) return;
    this.pumpingVersion = version;
    try {
      const horizon = this.currentFrame() + LOOKAHEAD_FRAMES;
      while (this.musicCursorFrame < horizon) {
        const interval = this.timeline.tracks.find(
          (track) => track.endFrame > this.musicCursorFrame,
        );
        if (!interval) break;
        const start = Math.max(this.musicCursorFrame, interval.startFrame);
        if (start >= horizon) break;
        const request = this.chunkRequest(interval, start);
        const buffer = await this.loadChunk(request);
        if (version !== this.version || !this.playing) return;
        const when = this.contextTime(start);
        if (when < this.context!.currentTime - 0.005) {
          throw new Error("配乐缓冲未及时完成，试听已暂停，请重新播放。");
        }
        const chunkStart = interval.startFrame + request.startFrame;
        const end = Math.min(
          interval.endFrame,
          chunkStart + Math.round(buffer.duration * SAMPLE_RATE),
        );
        if (end <= start) throw new Error("配乐分块长度异常，请重新导入后重试。");
        const source = this.createSource(buffer, this.bgmGain!, this.musicSources);
        source.start(
          when,
          (start - chunkStart) / SAMPLE_RATE,
          (end - start) / SAMPLE_RATE,
        );
        this.musicCursorFrame = end;
      }
    } finally {
      if (this.pumpingVersion === version) this.pumpingVersion = null;
    }
  }

  private refreshBeats() {
    this.clearSources(this.beatSources);
    this.beatCursorFrame = this.currentFrame();
    if (!this.playing) return;
    const version = this.version;
    void this.loadTone(this.settings.tone).then(() => {
      if (version === this.version && this.playing) this.tick();
    }).catch((error: unknown) => this.failPlayback(error, version));
  }

  private scheduleBeats(position: number) {
    const buffer = this.tones.get(this.settings.tone);
    if (!buffer) return;
    const from = Math.max(this.beatCursorFrame, position);
    const horizon = position + LOOKAHEAD_FRAMES;
    const intervals = this.tracks.length
      ? this.timeline.tracks
      : [{ index: -1, startFrame: 0, endFrame: horizon, durationFrames: horizon }];
    for (const interval of intervals) {
      if (interval.endFrame <= from || interval.startFrame >= horizon) continue;
      const track = this.tracks[interval.index];
      const offset = this.phaseOffsetsMs[interval.index] ?? 0;
      let beat = nextBeatFrame(
        Math.max(0, from - interval.startFrame),
        this.settings.cadence,
        track?.alignment?.anchor_seconds,
        offset,
      );
      const phase = beatPhaseSeconds(
        track?.alignment?.anchor_seconds,
        offset,
        this.settings.cadence,
      );
      while (interval.startFrame + beat.frame < Math.min(horizon, interval.endFrame)) {
        const frame = interval.startFrame + beat.frame;
        const source = this.createSource(buffer, this.beatGain!, this.beatSources);
        const when = Math.max(this.context!.currentTime, this.contextTime(frame));
        source.start(when);
        if (this.tracks.length) source.stop(this.contextTime(interval.endFrame));
        const nextIndex = beat.index + 1;
        beat = {
          index: nextIndex,
          frame: Math.round((phase + nextIndex * 60 / this.settings.cadence) * SAMPLE_RATE),
        };
      }
    }
    this.beatCursorFrame = horizon;
  }

  private tick() {
    if (!this.context || !this.playing) return;
    const position = this.currentFrame();
    if (this.tracks.length && position >= this.timeline.durationFrames) {
      this.pause();
      return;
    }
    const version = this.version;
    const insideTrack = this.timeline.tracks.some(
      (track) => position >= track.startFrame && position < track.endFrame,
    );
    if (insideTrack && position > this.musicCursorFrame + SAMPLE_RATE * 0.005) {
      this.failPlayback(
        new Error("配乐缓冲未及时完成，试听已暂停，请重新播放。"),
        version,
      );
      return;
    }
    const requests = this.selectChunks(position);
    for (const request of requests) {
      void this.loadChunk(request).catch((error: unknown) => this.failPlayback(error, version));
    }
    void this.scheduleMusic(version).catch((error: unknown) => this.failPlayback(error, version));
    this.scheduleBeats(position);
    this.emit();
  }

  private failPlayback(error: unknown, version: number) {
    if (version !== this.version || !this.playing) return;
    this.pause();
    this.onError(error instanceof Error ? error.message : "音频播放失败，请重试。");
  }

  private clearSources(sources: Set<AudioBufferSourceNode>) {
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* A finished source may already be stopped. */
      }
      source.disconnect();
    }
    sources.clear();
  }

  private emit() {
    const frame = this.currentFrame();
    const interval = this.timeline.tracks.find(
      (track) => frame >= track.startFrame && frame < track.endFrame,
    );
    const index = interval?.index ?? -1;
    const phase = beatPhaseSeconds(
      this.tracks[index]?.alignment?.anchor_seconds,
      this.phaseOffsetsMs[index] ?? 0,
      this.settings.cadence,
    );
    const localSeconds = (frame - (interval?.startFrame ?? 0)) / SAMPLE_RATE;
    this.onState({
      playing: this.playing,
      position: frame / SAMPLE_RATE,
      activeIndex: index,
      pulse:
        this.playing && (interval || !this.tracks.length)
          ? Math.floor((localSeconds - phase) * this.settings.cadence / 60)
          : -1,
    });
  }
}
