import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, DragEvent, FormEvent } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  FolderOpen,
  Github,
  Headphones,
  Link,
  LoaderCircle,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  SkipBack,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { request } from "./api";
import type { ExportJob, Health, SearchResult, Tone, Track } from "./api";
import { PreviewEngine } from "./audio";
import type { MixSettings, PlaybackState } from "./audio";
import { formatTime } from "./timeline";
import TrackTempo from "./TrackTempo";
import {
  createEntry,
  DEFAULT_SETTINGS,
  parseProject,
  replaceEntryTrack,
  restoreEntries,
  updateSharedTrack,
} from "./project";
import type { PlaylistEntry } from "./project";

const STORAGE_KEY = "stridemix.project.v1";
const FALLBACK_TONES: Tone[] = [
  { id: "click", name: "经典点击", description: "清脆、直接" },
  { id: "wood", name: "木块敲击", description: "温暖、有质感" },
  { id: "rim", name: "鼓边轻击", description: "短促、有穿透力" },
  { id: "soft", name: "柔和脉冲", description: "轻盈、不刺耳" },
  { id: "beep", name: "电子提示", description: "明亮、易辨识" },
  { id: "shaker", name: "沙锤", description: "细腻的颗粒感" },
];

interface ExportSnapshot {
  cadence: number;
  toneName: string;
  duration: number;
  format: "mp3" | "wav";
}

function readProject() {
  try {
    return parseProject(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function Waveform({
  values,
  active = false,
}: {
  values: number[];
  active?: boolean;
}) {
  return (
    <div className={`waveform ${active ? "active" : ""}`} aria-hidden="true">
      {values.map((value, index) => (
        <i key={index} style={{ height: `${Math.max(8, value * 100)}%` }} />
      ))}
    </div>
  );
}

function VolumeControl({
  label,
  value,
  onChange,
  kind,
}: {
  label: string;
  value: number;
  onChange: (volume: number) => void;
  kind: "bgm" | "beat";
}) {
  const [previous, setPrevious] = useState(value || 0.65);
  function toggle() {
    if (value > 0) {
      setPrevious(value);
      onChange(0);
    } else onChange(previous);
  }
  return (
    <div className={`volume-control ${kind}`}>
      <div className="volume-label">
        <span>
          {kind === "bgm" ? <Music2 size={15} /> : <AudioLines size={15} />}
          {label}
        </span>
        <strong>
          {Math.round(value * 100)}
          <small>%</small>
        </strong>
      </div>
      <div className="volume-range">
        <button
          className="icon-button mute-button"
          onClick={toggle}
          aria-label={`${value === 0 ? "取消静音" : "静音"}${label}`}
        >
          {value === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <input
          aria-label={`${label}音量`}
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          style={{ "--fill": `${value * 100}%` } as CSSProperties}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [saved] = useState(readProject);
  const [settings, setSettings] = useState<MixSettings>(
    saved?.settings ?? DEFAULT_SETTINGS,
  );
  const [cadenceDraft, setCadenceDraft] = useState(
    String(saved?.settings.cadence ?? 165),
  );
  const [entries, setEntries] = useState<PlaylistEntry[]>([]);
  const tracks = useMemo(() => entries.map((entry) => entry.track), [entries]);
  const [tones, setTones] = useState<Tone[]>(FALLBACK_TONES);
  const [health, setHealth] = useState<Health | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [mode, setMode] = useState<"upload" | "url" | "search" | "ai">(
    "upload",
  );
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [aiDuration, setAiDuration] = useState(120);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [format, setFormat] = useState<"mp3" | "wav">(saved?.format ?? "mp3");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [exportSnapshot, setExportSnapshot] = useState<ExportSnapshot | null>(
    null,
  );
  const [exportStarting, setExportStarting] = useState(false);
  const [playback, setPlayback] = useState<PlaybackState>({
    playing: false,
    position: 0,
    activeIndex: -1,
    pulse: -1,
  });
  const [playPending, setPlayPending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const engine = useRef<PreviewEngine | null>(null);
  const playOperation = useRef(0);
  const importRef = useRef<HTMLElement>(null);
  const totalDuration = tracks.reduce((sum, track) => sum + track.duration, 0);
  const exportActive = job?.status === "processing" || job?.status === "queued";
  const selectedTone = tones.find((tone) => tone.id === settings.tone);

  useEffect(() => {
    const preview = new PreviewEngine(setPlayback, setError);
    engine.current = preview;
    let active = true;
    Promise.all([
      request<Health>("/api/health"),
      request<Track[]>("/api/tracks"),
      request<Tone[]>("/api/tones"),
    ])
      .then(([status, library, availableTones]) => {
        if (!active) return;
        setHealth(status);
        setTones(availableTones);
        const restored = saved ? restoreEntries(saved, library) : [];
        setEntries(restored);
        setReady(true);
        if (saved && restored.length !== saved.trackIds.length)
          setNotice("部分本地素材已不存在，已从编排中移除。");
      })
      .catch((reason: Error) => {
        if (active) setError(`连接本地服务失败。${reason.message}`);
      });
    return () => {
      active = false;
      preview.dispose();
      engine.current = null;
    };
  }, [saved]);

  useEffect(() => {
    if (engine.current?.setTracks(tracks)) {
      playOperation.current += 1;
      setPlayPending(false);
    }
  }, [tracks]);
  useEffect(() => {
    engine.current?.update(settings);
  }, [settings]);
  useEffect(() => {
    setCadenceDraft(String(settings.cadence));
  }, [settings.cadence]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          trackIds: tracks.map((track) => track.id),
          entryIds: entries.map((entry) => entry.entryId),
          settings,
          format,
        }),
      );
    } catch {
      /* Editing remains available if browser storage is full or disabled. */
    }
  }, [ready, tracks, entries, settings, format]);

  const handleTrackUpdate = useCallback((updated: Track) => {
    setEntries((current) => updateSharedTrack(current, updated));
  }, []);

  useEffect(() => {
    if (!exportActive || !job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const update = await request<ExportJob>(`/api/exports/${job.id}`);
        if (!active) return;
        setJob(update);
        if (update.status === "failed")
          setError(update.error ?? "导出失败，请重试。");
        if (update.status === "queued" || update.status === "processing")
          timer = setTimeout(poll, 700);
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : "获取导出进度失败。",
        );
        timer = setTimeout(poll, 2500);
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [exportActive, job?.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function changeSetting<Key extends keyof MixSettings>(
    key: Key,
    value: MixSettings[Key],
  ) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function commitCadence() {
    const value = Number(cadenceDraft);
    if (!cadenceDraft.trim() || !Number.isFinite(value)) {
      setCadenceDraft(String(settings.cadence));
      return;
    }
    const cadence = Math.max(60, Math.min(240, Math.round(value)));
    changeSetting("cadence", cadence);
    setCadenceDraft(String(cadence));
  }

  async function runImport(label: string, action: () => Promise<void>) {
    if (busy) return;
    setError("");
    setBusy(label);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setBusy("");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (!selected.length) return;
    await runImport("正在导入音频…", async () => {
      let added = 0;
      for (const file of selected) {
        setBusy(`正在导入 ${added + 1}/${selected.length} · ${file.name}`);
        const form = new FormData();
        form.append("file", file);
        const track = await request<Track>("/api/tracks/upload", {
          method: "POST",
          body: form,
        });
        setEntries((current) => [...current, createEntry(track)]);
        added += 1;
      }
      setNotice(`已添加 ${added} 条配乐`);
    });
    if (fileInput.current) fileInput.current.value = "";
  }

  async function importUrl(value: string) {
    await runImport("正在解析链接并提取音频…", async () => {
      const track = await request<Track>("/api/tracks/url", {
        method: "POST",
        body: JSON.stringify({ url: value }),
      });
      setEntries((current) => [...current, createEntry(track)]);
      setUrl("");
      setNotice("配乐已加入编排");
    });
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    await runImport("正在搜索候选版本…", async () => {
      const data = await request<{ results: SearchResult[] }>("/api/search", {
        method: "POST",
        body: JSON.stringify({ query: query.trim() }),
      });
      setResults(data.results);
    });
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    await runImport("AI 正在生成配乐，可能需要几分钟…", async () => {
      const track = await request<Track>("/api/tracks/generate", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim(), duration: aiDuration }),
      });
      setEntries((current) => [...current, createEntry(track)]);
      setNotice("AI 配乐已加入编排");
    });
  }

  async function togglePlayback() {
    if (playback.playing || playPending) {
      playOperation.current += 1;
      engine.current?.pause();
      setPlayPending(false);
      return;
    }
    setError("");
    setPlayPending(true);
    const operation = ++playOperation.current;
    try {
      await engine.current?.play();
    } catch (reason) {
      if (operation === playOperation.current) {
        setError(
          reason instanceof Error ? reason.message : "无法播放，请重试。",
        );
      }
    } finally {
      if (operation === playOperation.current) setPlayPending(false);
    }
  }

  async function audition(tone: string) {
    changeSetting("tone", tone);
    try {
      await engine.current?.audition(tone);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法试听音色。");
    }
  }

  function moveTrack(index: number, direction: number) {
    setEntries((current) => {
      const next = [...current];
      const destination = index + direction;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  async function startExport() {
    if (!tracks.length || exportActive || exportStarting) return;
    setError("");
    setExportStarting(true);
    const parameters = {
      tracks: tracks.map((track) => ({ id: track.id })),
      cadence: settings.cadence,
      tone: settings.tone,
      bgm_volume: settings.bgmVolume,
      beat_volume: settings.beatVolume,
      format,
    };
    const snapshot: ExportSnapshot = {
      cadence: parameters.cadence,
      toneName:
        tones.find((tone) => tone.id === parameters.tone)?.name ??
        parameters.tone,
      duration: totalDuration,
      format: parameters.format,
    };
    try {
      const result = await request<ExportJob>("/api/exports", {
        method: "POST",
        body: JSON.stringify(parameters),
      });
      setJob(result);
      setExportSnapshot(snapshot);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建导出任务失败。");
    } finally {
      setExportStarting(false);
    }
  }

  async function cancelExport() {
    if (!job) return;
    try {
      setJob(
        await request<ExportJob>(`/api/exports/${job.id}`, {
          method: "DELETE",
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消失败，请重试。");
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    void uploadFiles(event.dataTransfer.files);
  }

  const beatCount = Math.max(
    0,
    Math.ceil((totalDuration * settings.cadence) / 60 - 1e-8),
  );
  let trackStart = 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="StrideMix 首页">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            STRIDE<span className="brand-light">MIX</span>
            <small>跑步混音台</small>
          </span>
        </a>
        <div className="header-actions">
          <span className={`connection ${health ? "online" : ""}`}>
            <i />
            {health ? "本地工作台" : "连接中"}
          </span>
          <button
            className="text-button help-button"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={16} />
            使用指南
          </button>
          <a
            className="icon-button github-link"
            href="https://github.com/Jocelyn-2005/stridemix"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub 开源项目"
          >
            <Github size={20} />
          </a>
        </div>
      </header>

      <main>
        <section className="page-heading">
          <div>
            <h1>
              制作你的跑步配乐<span className="heading-dot">.</span>
            </h1>
          </div>
          <div className="project-summary">
            <span>
              <strong>{tracks.length.toString().padStart(2, "0")}</strong>条配乐
            </span>
            <i />
            <span>
              <strong>{formatTime(totalDuration)}</strong>总时长
            </span>
          </div>
        </section>

        <div className="workspace">
          <aside className="cadence-panel panel">
            <div className="section-title">
              <span className="title-icon">
                <AudioLines size={18} />
              </span>
              <h2>设定步频</h2>
            </div>
            <div
              className={`cadence-display ${playback.playing ? "running" : ""}`}
            >
              <label htmlFor="cadence-input" className="sr-only">
                每分钟步频
              </label>
              <input
                id="cadence-input"
                aria-label="每分钟步频"
                className="cadence-number"
                type="number"
                min="60"
                max="240"
                value={cadenceDraft}
                onChange={(event) => setCadenceDraft(event.target.value)}
                onBlur={commitCadence}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitCadence();
                    event.currentTarget.blur();
                  }
                }}
              />
              <div className="cadence-unit">步 / 分钟</div>
              <div className="pulse-row" aria-hidden="true">
                {[0, 1, 2, 3].map((index) => (
                  <i
                    className={
                      playback.playing && playback.pulse % 4 === index
                        ? "lit"
                        : ""
                    }
                    key={index}
                  />
                ))}
              </div>
            </div>
            <div className="cadence-adjust">
              <button
                className="icon-button"
                onClick={() =>
                  changeSetting("cadence", Math.max(60, settings.cadence - 1))
                }
                disabled={settings.cadence <= 60}
                aria-label="步频减少 1"
              >
                <Minus size={16} />
              </button>
              <input
                type="range"
                min="60"
                max="240"
                step="1"
                aria-label="步频滑块"
                value={settings.cadence}
                onChange={(event) =>
                  changeSetting("cadence", Number(event.target.value))
                }
                style={
                  {
                    "--fill": `${(settings.cadence - 60) / 1.8}%`,
                  } as CSSProperties
                }
              />
              <button
                className="icon-button"
                onClick={() =>
                  changeSetting("cadence", Math.min(240, settings.cadence + 1))
                }
                disabled={settings.cadence >= 240}
                aria-label="步频增加 1"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="cadence-presets">
              {[150, 165, 180].map((cadence) => (
                <button
                  className={settings.cadence === cadence ? "selected" : ""}
                  key={cadence}
                  onClick={() => changeSetting("cadence", cadence)}
                >
                  {cadence}
                </button>
              ))}
            </div>
            <div className="panel-divider" />
            <div className="subheading">
              <h3>节拍音色</h3>
              <span>点击试听</span>
            </div>
            <div className="tone-list">
              {tones.map((tone) => (
                <button
                  key={tone.id}
                  className={`tone-option ${settings.tone === tone.id ? "selected" : ""}`}
                  onClick={() => void audition(tone.id)}
                  disabled={!ready}
                  aria-label={`试听${tone.name}`}
                  aria-pressed={settings.tone === tone.id}
                >
                  <span className="tone-symbol">
                    <AudioLines size={17} />
                  </span>
                  <span className="tone-copy">
                    <strong>{tone.name}</strong>
                    <small>{tone.description}</small>
                  </span>
                  <span className="tone-radio">
                    {settings.tone === tone.id && (
                      <Check size={11} strokeWidth={3} />
                    )}
                  </span>
                </button>
              ))}
            </div>
            <div className="cadence-footnote">
              <Headphones size={15} />
              <span>一步一响，节拍贯穿整段配乐。</span>
            </div>
          </aside>

          <section className="playlist-panel panel">
            <div className="playlist-header">
              <div className="section-title">
                <span className="title-icon">
                  <Music2 size={18} />
                </span>
                <h2>配乐编排</h2>
                <span className="count-label">{tracks.length}</span>
              </div>
              <button
                className="text-button add-music"
                onClick={() => {
                  setMode("upload");
                  importRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  });
                  fileInput.current?.click();
                }}
                disabled={!ready || !!busy}
              >
                <Plus size={16} />
                添加配乐
              </button>
            </div>
            <div className="playlist-description">
              <span>音乐按顺序播放</span>
              <span>时长</span>
            </div>
            <div className="track-list">
              {!tracks.length && (
                <div className="empty-playlist">
                  <div className="empty-wave" aria-hidden="true">
                    {[
                      14, 24, 38, 54, 32, 66, 42, 24, 40, 56, 30, 18, 36, 26,
                      12,
                    ].map((height, index) => (
                      <i style={{ height }} key={index} />
                    ))}
                  </div>
                  <h3>你的跑步歌单，从这里开始</h3>
                  <p>添加音乐后，试听完整的配乐与步频。</p>
                </div>
              )}
              {entries.map(({ entryId, track }, index) => {
                const start = trackStart;
                trackStart += track.duration;
                return (
                  <article
                    className={`track-row ${playback.playing && playback.activeIndex === index ? "is-playing" : ""}`}
                    key={entryId}
                    data-entry-id={entryId}
                  >
                    <button
                      className="track-number"
                      onClick={() => {
                        void engine.current
                          ?.seek(start)
                          .catch((reason: Error) => setError(reason.message));
                      }}
                      aria-label={`跳转到${track.title}`}
                    >
                      {playback.playing && playback.activeIndex === index ? (
                        <AudioLines size={18} />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </button>
                    <div className="track-details">
                      <div className="track-title-row">
                        <h3 title={track.title}>{track.title}</h3>
                        <span>{formatTime(track.duration)}</span>
                      </div>
                      <div className="track-meta">
                        <span>{track.source || "本地音频"}</span>
                        <span>{formatTime(start)} 开始</span>
                      </div>
                      <Waveform
                        values={track.waveform}
                        active={
                          playback.activeIndex === index && playback.playing
                        }
                      />
                      <TrackTempo
                        track={track}
                        entryId={entryId}
                        cadence={settings.cadence}
                        onTrackUpdate={handleTrackUpdate}
                        onReplace={(updated) =>
                          setEntries((current) =>
                            replaceEntryTrack(
                              current,
                              entryId,
                              track.id,
                              updated,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="track-actions">
                      <button
                        className="icon-button"
                        disabled={index === 0}
                        onClick={() => moveTrack(index, -1)}
                        aria-label={`上移${track.title}`}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={index === tracks.length - 1}
                        onClick={() => moveTrack(index, 1)}
                        aria-label={`下移${track.title}`}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        className="icon-button remove-track"
                        onClick={() =>
                          setEntries((current) =>
                            current.filter(
                              (entry) => entry.entryId !== entryId,
                            ),
                          )
                        }
                        aria-label={`移除${track.title}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <section className="import-section" ref={importRef}>
              <div className="import-tabs" role="tablist" aria-label="配乐来源">
                {(
                  [
                    { id: "upload", label: "本地文件", icon: FolderOpen },
                    { id: "url", label: "视频链接", icon: Link },
                    { id: "search", label: "搜索歌曲", icon: Search },
                    { id: "ai", label: "AI 配乐", icon: Sparkles },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === id}
                    aria-controls="import-content"
                    id={`tab-${id}`}
                    className={mode === id ? "active" : ""}
                    key={id}
                    onClick={() => setMode(id)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                aria-label="选择音频或视频文件"
                multiple
                accept="audio/*,video/*,.m4a,.flac,.ogg,.opus,.aiff,.wma,.mkv"
                disabled={!ready || !!busy}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  if (event.target.files) void uploadFiles(event.target.files);
                }}
              />
              <div
                className="import-content"
                id="import-content"
                role="tabpanel"
                aria-labelledby={`tab-${mode}`}
              >
                {mode === "upload" && (
                  <button
                    className={`dropzone ${dragOver ? "drag-over" : ""}`}
                    disabled={!ready || !!busy}
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                  >
                    <span className="upload-icon">
                      <Upload size={21} />
                    </span>
                    <strong>
                      拖入文件，或<span>点击选择</span>
                    </strong>
                    <small>支持 MP3、WAV、FLAC、M4A 及视频文件</small>
                  </button>
                )}
                {mode === "url" && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (url.trim()) void importUrl(url.trim());
                    }}
                    className="source-form"
                  >
                    <label htmlFor="video-url">粘贴视频或音频链接</label>
                    <div className="input-action">
                      <input
                        id="video-url"
                        type="url"
                        required
                        placeholder="https://www.youtube.com/watch?v=…"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                      <button
                        className="small-primary"
                        disabled={!ready || !!busy || !url.trim()}
                      >
                        <ArrowRight size={18} />
                        <span className="sr-only">导入链接</span>
                      </button>
                    </div>
                    <p>
                      提取链接中的音轨，站点可用性取决于 yt-dlp 支持与网络环境。
                    </p>
                  </form>
                )}
                {mode === "search" && (
                  <div>
                    <form
                      onSubmit={(event) => void search(event)}
                      className="source-form"
                    >
                      <label htmlFor="song-query">输入歌名、歌手或关键词</label>
                      <div className="input-action">
                        <input
                          id="song-query"
                          placeholder="例如：夜空中最亮的星 逃跑计划"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                        <button
                          className="small-primary"
                          disabled={!ready || !!busy || !query.trim()}
                        >
                          <Search size={18} />
                          <span className="sr-only">搜索歌曲</span>
                        </button>
                      </div>
                      <p>通过 YouTube 搜索候选版本，确认后添加至编排。</p>
                    </form>
                    {results !== null && (
                      <div className="search-results">
                        {results.length === 0 && (
                          <p className="no-results">
                            没有找到结果，试试歌手名或更完整的歌名。
                          </p>
                        )}
                        {results.map((result, index) => (
                          <div
                            className="search-result"
                            key={`${result.url}-${index}`}
                          >
                            <span className="result-icon">
                              <Music2 size={16} />
                            </span>
                            <div>
                              <strong>{result.title}</strong>
                              <small>
                                {result.channel}{" "}
                                {result.duration
                                  ? `· ${formatTime(result.duration)}`
                                  : ""}
                              </small>
                            </div>
                            <button
                              className="icon-button"
                              disabled={!!busy}
                              onClick={() => void importUrl(result.url)}
                              aria-label={`添加${result.title}`}
                            >
                              <Plus size={18} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {mode === "ai" && (
                  <form
                    onSubmit={(event) => void generate(event)}
                    className="source-form ai-form"
                  >
                    <label htmlFor="ai-prompt">描述你想要的跑步配乐</label>
                    <textarea
                      id="ai-prompt"
                      placeholder="例如：轻快的电子器乐，温暖合成器，适合傍晚慢跑，无人声。"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      maxLength={4100}
                      rows={3}
                    />
                    <div className="ai-actions">
                      <label htmlFor="ai-duration">
                        时长{" "}
                        <input
                          id="ai-duration"
                          aria-label="AI 配乐时长（秒）"
                          type="number"
                          min="3"
                          max="600"
                          required
                          value={aiDuration}
                          onChange={(event) =>
                            setAiDuration(Number(event.target.value))
                          }
                        />{" "}
                        秒
                      </label>
                      <button
                        className="small-primary with-text"
                        disabled={
                          !ready ||
                          !!busy ||
                          !health?.ai_configured ||
                          !prompt.trim()
                        }
                      >
                        <Sparkles size={15} />
                        生成配乐
                      </button>
                    </div>
                    {!health?.ai_configured ? (
                      <p className="ai-setup">
                        在项目根目录的 .env 中设置
                        ELEVENLABS_API_KEY，重启服务后即可使用。生成会消耗服务商额度。
                      </p>
                    ) : (
                      <p>
                        使用 ElevenLabs 生成纯器乐配乐，会消耗你账户中的额度。
                      </p>
                    )}
                  </form>
                )}
              </div>
            </section>
            {!!busy && (
              <div className="import-status" role="status">
                <LoaderCircle size={16} className="spin" />
                <span>{busy}</span>
              </div>
            )}
            {tracks.length > 0 && (
              <div className="playlist-total">
                <span>{tracks.length} 条配乐 · 顺序拼接</span>
                <strong>{formatTime(totalDuration)}</strong>
              </div>
            )}
          </section>

          <aside className="mix-column">
            <section className="mixer-panel panel">
              <div className="section-title">
                <span className="title-icon">
                  <Settings2 size={18} />
                </span>
                <h2>混音控制</h2>
              </div>
              <VolumeControl
                label="背景音乐"
                kind="bgm"
                value={settings.bgmVolume}
                onChange={(value) => changeSetting("bgmVolume", value)}
              />
              <VolumeControl
                label="步频节拍"
                kind="beat"
                value={settings.beatVolume}
                onChange={(value) => changeSetting("beatVolume", value)}
              />
              <div className="mix-note">
                <Headphones size={15} />
                <span>试听时可实时调整音量。</span>
              </div>
            </section>
            <section className="export-panel">
              <div className="export-heading">
                <ArrowDownToLine size={19} />
                <h2>准备出发</h2>
              </div>
              <div className="export-stats">
                <span>
                  总时长<strong>{formatTime(totalDuration)}</strong>
                </span>
                <span>
                  步频
                  <strong>
                    {settings.cadence}
                    <small> SPM</small>
                  </strong>
                </span>
              </div>
              <div className="export-details">
                <span>{selectedTone?.name ?? "经典点击"}</span>
                <span>{beatCount.toLocaleString()} 次节拍</span>
              </div>
              <label htmlFor="export-format" className="format-label">
                导出格式
              </label>
              <div className="format-selector">
                <select
                  id="export-format"
                  aria-label="导出格式"
                  value={format}
                  onChange={(event) =>
                    setFormat(event.target.value as "mp3" | "wav")
                  }
                  disabled={exportActive}
                >
                  <option value="mp3">MP3 · 轻巧随身听</option>
                  <option value="wav">WAV · 无损音质</option>
                </select>
                <ChevronDown size={15} />
              </div>
              <button
                className="export-button"
                onClick={() => void startExport()}
                disabled={
                  !ready || !tracks.length || exportActive || exportStarting
                }
              >
                {exportActive || exportStarting ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowDownToLine size={17} />
                )}
                {exportActive
                  ? "正在合成配乐"
                  : exportStarting
                    ? "正在创建任务"
                    : "合成并导出"}
              </button>
              {!tracks.length && (
                <p className="export-hint">添加配乐后即可导出</p>
              )}
              {exportActive && job && (
                <div className="export-progress" role="status">
                  <div>
                    <span>合成进度</span>
                    <strong>{Math.round(job.progress)}%</strong>
                  </div>
                  <progress max="100" value={job.progress} />
                  <button onClick={() => void cancelExport()}>取消导出</button>
                  <p>导出使用开始时的编排与混音设置。</p>
                </div>
              )}
              {job?.status === "completed" && job.download_url && (
                <>
                  <a
                    className="download-button"
                    href={job.download_url}
                    download
                  >
                    <Check size={16} />
                    下载跑步配乐
                    <ArrowDownToLine size={15} />
                  </a>
                  {exportSnapshot && (
                    <p className="export-result-summary">
                      本次导出 · {exportSnapshot.cadence} SPM ·{" "}
                      {formatTime(exportSnapshot.duration)} ·{" "}
                      {exportSnapshot.format.toUpperCase()}
                      <br />
                      {exportSnapshot.toneName}
                    </p>
                  )}
                </>
              )}
              {job?.status === "cancelled" && (
                <p className="export-hint">导出已取消，可以调整后重新导出。</p>
              )}
              {job?.status === "failed" && (
                <p className="export-hint export-error">
                  {job.error || "导出失败，请重试。"}
                </p>
              )}
            </section>
            <p className="local-storage-note">
              <span className="local-dot" />
              素材与项目保存在这台电脑
            </p>
          </aside>
        </div>
        <div className="workspace-footer">
          <a
            href="https://github.com/Jocelyn-2005/stridemix"
            target="_blank"
            rel="noreferrer"
          >
            开源项目
            <ExternalLink size={12} />
          </a>
        </div>
      </main>

      <section className="transport" aria-label="配乐试听">
        <div className="transport-controls">
          <button
            className="icon-button reset-button"
            onClick={() => {
              void engine.current
                ?.seek(0)
                .catch((reason: Error) => setError(reason.message));
            }}
            disabled={!ready}
            aria-label="回到开头"
          >
            <SkipBack size={18} />
          </button>
          <button
            className={`play-button ${playback.playing ? "is-playing" : ""}`}
            disabled={!ready}
            onClick={() => void togglePlayback()}
            aria-label={
              playback.playing || playPending ? "暂停试听" : "播放试听"
            }
          >
            {playPending ? (
              <LoaderCircle size={21} className="spin" />
            ) : playback.playing ? (
              <Pause size={22} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" />
            )}
          </button>
        </div>
        <div className="transport-info">
          <strong>
            {playback.activeIndex >= 0
              ? tracks[playback.activeIndex]?.title
              : tracks.length
                ? "试听完整配乐"
                : "试听步频节拍"}
          </strong>
          <span>
            {settings.cadence} SPM <i />
            {selectedTone?.name ?? "经典点击"}
          </span>
        </div>
        <div className="seek-area">
          <span className="time-current">{formatTime(playback.position)}</span>
          <input
            type="range"
            aria-label="试听进度"
            min="0"
            max={totalDuration || 1}
            step="0.1"
            value={Math.min(playback.position, totalDuration || 0)}
            disabled={!tracks.length || !ready}
            onChange={(event) => {
              void engine.current
                ?.seek(Number(event.target.value))
                .catch((reason: Error) => setError(reason.message));
            }}
            style={
              {
                "--fill": `${totalDuration ? (playback.position / totalDuration) * 100 : 0}%`,
              } as CSSProperties
            }
          />
          <span className="time-total">{formatTime(totalDuration)}</span>
        </div>
        <div className="transport-mode">
          <span
            className={`playing-indicator ${playback.playing ? "active" : ""}`}
          >
            <i />
            <i />
            <i />
          </span>
          <span>{playback.playing ? "正在试听" : "待播放"}</span>
        </div>
      </section>

      {(error || notice) && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ? <CircleHelp size={18} /> : <Check size={18} />}
          <span>{error || notice}</span>
          <button
            className="icon-button"
            onClick={() => {
              setError("");
              setNotice("");
            }}
            aria-label="关闭提示"
          >
            <X size={17} />
          </button>
        </div>
      )}

      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button close-modal"
              onClick={() => setHelpOpen(false)}
              aria-label="关闭使用指南"
            >
              <X size={20} />
            </button>
            <span className="help-icon">
              <Headphones size={26} />
            </span>
            <h2 id="help-title">准备你的下一次跑步</h2>
            <ol>
              <li>
                <strong>添加配乐</strong>
                <p>
                  上传音频或视频、粘贴链接、搜索歌名，或使用 AI
                  生成配乐。支持连续添加多条。
                </p>
              </li>
              <li>
                <strong>设定你的步频</strong>
                <p>
                  165 表示每分钟 165
                  次提示，一步一响。点击音色可以试听，上下箭头可以调整曲目顺序。
                </p>
              </li>
              <li>
                <strong>调好音量，导出出发</strong>
                <p>
                  背景音乐和节拍独立调整。导出 MP3 或 WAV
                  后，可传到手机离线播放。
                </p>
              </li>
            </ol>
            <p className="help-footnote">
              编排自动保存在当前浏览器，音频素材保存在项目的 data
              目录。链接导入与歌曲搜索需要可访问对应站点的网络。AI 生成功能需要
              ElevenLabs API Key。
            </p>
            <button
              className="small-primary with-text"
              onClick={() => setHelpOpen(false)}
            >
              开始制作
              <ArrowRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
