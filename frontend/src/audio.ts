import type { Track } from "./api";
import { locateTrack, nextBeatPosition } from "./timeline.ts";

export interface MixSettings {
  cadence: number;
  tone: string;
  bgmVolume: number;
  beatVolume: number;
}

export interface PlaybackState {
  playing: boolean;
  position: number;
  activeIndex: number;
  pulse: number;
}

export class PreviewEngine {
  private context: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private beatGain: GainNode | null = null;
  private audio = new Audio();
  private buffers = new Map<string, AudioBuffer>();
  private pendingBuffers = new Map<string, Promise<AudioBuffer>>();
  private scheduled = new Set<AudioBufferSourceNode>();
  private tracks: Track[] = [];
  private settings: MixSettings = {
    cadence: 165,
    tone: "click",
    bgmVolume: 0.65,
    beatVolume: 0.55,
  };
  private playing = false;
  private position = 0;
  private contextAnchor = 0;
  private positionAnchor = 0;
  private activeIndex = -1;
  private nextBeat = 0;
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
    this.audio.preload = "auto";
    this.audio.onended = () => {
      void this.advanceTrack();
    };
    this.audio.onerror = () => {
      if (this.playing) {
        this.pause();
        this.onError("这条音频暂时无法播放，请重新导入后重试。");
      }
    };
  }

  setTracks(tracks: Track[]) {
    const sameAudio =
      this.tracks.length === tracks.length &&
      this.tracks.every(
        (track, index) =>
          track.id === tracks[index].id &&
          track.duration === tracks[index].duration &&
          track.preview_url === tracks[index].preview_url,
      );
    if (sameAudio) {
      this.tracks = tracks;
      return false;
    }
    this.pause();
    this.tracks = tracks;
    this.position = 0;
    this.activeIndex = -1;
    this.emit();
    return true;
  }

  update(settings: MixSettings) {
    const rhythmChanged =
      settings.cadence !== this.settings.cadence ||
      settings.tone !== this.settings.tone;
    this.settings = settings;
    if (this.context && this.bgmGain && this.beatGain) {
      this.bgmGain.gain.setTargetAtTime(
        settings.bgmVolume,
        this.context.currentTime,
        0.015,
      );
      this.beatGain.gain.setTargetAtTime(
        settings.beatVolume,
        this.context.currentTime,
        0.015,
      );
    }
    if (rhythmChanged && this.playing) {
      this.clearScheduled();
      this.nextBeat = nextBeatPosition(
        this.currentPosition(),
        settings.cadence,
      ).index;
      void this.loadTone(settings.tone).catch((error: Error) =>
        this.onError(error.message),
      );
    }
  }

  async audition(tone: string) {
    const context = this.ensureContext();
    await context.resume();
    const buffer = await this.loadTone(tone);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.beatGain!);
    node.start();
  }

  async play() {
    if (this.playing) return;
    const version = ++this.version;
    const context = this.ensureContext();
    await context.resume();
    await this.loadTone(this.settings.tone);
    if (version !== this.version) return;
    const total = this.duration();
    if (total && this.position >= total) this.position = 0;
    const location = locateTrack(this.tracks, this.position);
    if (location) {
      this.activeIndex = location.index;
      this.audio.src = this.tracks[location.index].preview_url;
      this.audio.currentTime = location.offset;
      try {
        await this.audio.play();
      } catch (error) {
        if (version !== this.version) return;
        throw error;
      }
      if (version !== this.version) return;
    }
    this.positionAnchor = this.position;
    this.contextAnchor = context.currentTime;
    this.nextBeat = nextBeatPosition(
      this.position,
      this.settings.cadence,
    ).index;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
    this.emit();
  }

  pause() {
    this.version += 1;
    if (this.playing) this.position = this.currentPosition();
    this.playing = false;
    this.audio.pause();
    clearInterval(this.timer);
    this.clearScheduled();
    this.emit();
  }

  async seek(position: number) {
    const resume = this.playing;
    this.pause();
    const duration = this.duration();
    this.position = Math.max(0, Math.min(position, duration));
    this.activeIndex = locateTrack(this.tracks, this.position)?.index ?? -1;
    this.emit();
    if (resume && (!duration || this.position < duration)) await this.play();
  }

  dispose() {
    this.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    void this.context?.close();
  }

  private duration() {
    return this.tracks.reduce((total, track) => total + track.duration, 0);
  }

  private currentPosition() {
    if (!this.playing || !this.context) return this.position;
    return this.positionAnchor + this.context.currentTime - this.contextAnchor;
  }

  private ensureContext() {
    if (this.context) return this.context;
    this.context = new AudioContext();
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
    this.context.createMediaElementSource(this.audio).connect(this.bgmGain);
    this.bgmGain.connect(limiter);
    this.beatGain.connect(limiter);
    limiter.connect(this.context.destination);
    return this.context;
  }

  private async loadTone(tone: string) {
    const existing = this.buffers.get(tone);
    if (existing) return existing;
    const pending = this.pendingBuffers.get(tone);
    if (pending) return pending;
    const loading = (async () => {
      const response = await fetch(
        `/api/tones/${encodeURIComponent(tone)}.wav`,
      );
      if (!response.ok) throw new Error("节拍音色加载失败，请检查本地服务。");
      const buffer = await this.ensureContext().decodeAudioData(
        await response.arrayBuffer(),
      );
      this.buffers.set(tone, buffer);
      return buffer;
    })();
    this.pendingBuffers.set(tone, loading);
    try {
      return await loading;
    } finally {
      this.pendingBuffers.delete(tone);
    }
  }

  private tick() {
    if (!this.context || !this.playing) return;
    const position = this.currentPosition();
    const duration = this.duration();
    if (duration && position >= duration) {
      this.pause();
      this.position = duration;
      this.activeIndex = -1;
      this.emit();
      return;
    }
    const buffer = this.buffers.get(this.settings.tone);
    if (buffer) {
      const firstFutureBeat = nextBeatPosition(
        Math.max(0, position - 0.005),
        this.settings.cadence,
      ).index;
      this.nextBeat = Math.max(this.nextBeat, firstFutureBeat);
      while ((this.nextBeat * 60) / this.settings.cadence < position + 0.12) {
        const beatPosition = (this.nextBeat * 60) / this.settings.cadence;
        if (duration && beatPosition >= duration) break;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.beatGain!);
        source.onended = () => this.scheduled.delete(source);
        this.scheduled.add(source);
        source.start(
          Math.max(
            this.context.currentTime,
            this.contextAnchor + beatPosition - this.positionAnchor,
          ),
        );
        this.nextBeat += 1;
      }
    }
    this.emit();
  }

  private async advanceTrack() {
    if (!this.playing) return;
    const nextIndex = this.activeIndex + 1;
    if (nextIndex >= this.tracks.length) return;
    const version = this.version;
    const start = this.tracks
      .slice(0, nextIndex)
      .reduce((sum, track) => sum + track.duration, 0);
    this.activeIndex = nextIndex;
    this.audio.src = this.tracks[nextIndex].preview_url;
    this.audio.currentTime = Math.max(0, this.currentPosition() - start);
    try {
      await this.audio.play();
      if (version !== this.version) return;
    } catch (error) {
      if (version !== this.version) return;
      this.pause();
      this.onError(error instanceof Error ? error.message : "音频播放失败。");
    }
  }

  private clearScheduled() {
    for (const source of this.scheduled) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* A finished node can already be stopped. */
      }
      source.disconnect();
    }
    this.scheduled.clear();
  }

  private emit() {
    const position = this.currentPosition();
    this.onState({
      playing: this.playing,
      position,
      activeIndex: this.activeIndex,
      pulse: this.playing
        ? Math.floor((position * this.settings.cadence) / 60)
        : -1,
    });
  }
}
