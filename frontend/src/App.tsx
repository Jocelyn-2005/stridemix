import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, DragEvent, FormEvent } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
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
  Library,
  ListMusic,
  Link,
  LoaderCircle,
  Menu,
  Minus,
  Music2,
  Pause,
  Palette,
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
import { analyzeTrack, request } from "./api";
import type { DeletionPreview, ExportJob, Health, SearchResult, Tone, Track } from "./api";
import { PreviewEngine } from "./audio";
import type { MixSettings, PlaybackState } from "./audio";
import {
  buildTimeline,
  countTrackBeats,
  formatTime,
  SAMPLE_RATE,
} from "./timeline";
import TrackTempo from "./TrackTempo";
import BeatAlignment from "./BeatAlignment";
import DeleteTrackDialog from "./DeleteTrackDialog";
import {
  createEntry,
  DEFAULT_SETTINGS,
  parseProject,
  replaceEntryTrack,
  restoreEntries,
  updateSharedTrack,
} from "./project";
import type { PlaylistEntry } from "./project";
import { AppearancePage, useAppearance, Wallpaper } from "./Appearance";
import { PAGE_TITLES, parseRoute, routeHash } from "./routing";
import type { AppRoute } from "./routing";

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
  trackCount: number;
  bgmVolume: number;
  beatVolume: number;
  gapSeconds: number;
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
  const [route, setRoute] = useState(() =>
    parseRoute(window.location.hash, !!saved?.trackIds.length),
  );
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { appearance, updateAppearance } = useAppearance();
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [deletionTarget, setDeletionTarget] = useState<{ track: Track; preview: DeletionPreview } | null>(null);
  const [deletionLoading, setDeletionLoading] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState("");
  const deletedTrackIds = useRef(new Set<string>());
  const [settings, setSettings] = useState<MixSettings>(
    saved?.settings ?? DEFAULT_SETTINGS,
  );
  const [cadenceDraft, setCadenceDraft] = useState(
    String(saved?.settings.cadence ?? 165),
  );
  const [gapDraft, setGapDraft] = useState(
    String(saved?.settings.gapSeconds ?? DEFAULT_SETTINGS.gapSeconds),
  );
  const [entries, setEntries] = useState<PlaylistEntry[]>([]);
  const [alignmentPreview, setAlignmentPreview] = useState<{
    entryId: string;
    trackId: string;
    offsetMs: number;
  } | null>(null);
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
  const previousGap = useRef(settings.gapSeconds);
  const latestEntries = useRef(entries);
  const latestAlignmentPreview = useRef(alignmentPreview);
  const timeline = useMemo(
    () => buildTimeline(tracks, settings.gapSeconds),
    [tracks, settings.gapSeconds],
  );
  const totalDuration = timeline.durationFrames / SAMPLE_RATE;
  const exportActive = job?.status === "processing" || job?.status === "queued";
  const selectedTone = tones.find((tone) => tone.id === settings.tone);

  useEffect(() => {
    function syncRoute() {
      setRoute(parseRoute(window.location.hash, !!saved?.trackIds.length));
      setNavigationOpen(false);
    }
    const initial = parseRoute(window.location.hash, !!saved?.trackIds.length);
    window.history.replaceState(null, "", routeHash(initial));
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, [saved]);

  useEffect(() => {
    document.title = `${PAGE_TITLES[route.page]} · StrideMix`;
    window.scrollTo(0, 0);
  }, [route]);

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
        setLibraryTracks(library.filter((track) => !track.adaptation));
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
    latestEntries.current = entries;
    latestAlignmentPreview.current = alignmentPreview;
    const arrangementChanged = engine.current?.setTracks(
      tracks,
      entries.map((entry) =>
        alignmentPreview?.entryId === entry.entryId && alignmentPreview.trackId === entry.track.id
          ? alignmentPreview.offsetMs
          : entry.phaseOffsetMs,
      ),
    );
    if (arrangementChanged) {
      playOperation.current += 1;
      setPlayPending(false);
    }
  }, [tracks, entries, alignmentPreview]);
  useEffect(() => {
    if (previousGap.current !== settings.gapSeconds) {
      previousGap.current = settings.gapSeconds;
      playOperation.current += 1;
      setPlayPending(false);
    }
    engine.current?.update(settings);
  }, [settings]);
  useEffect(() => {
    setCadenceDraft(String(settings.cadence));
  }, [settings.cadence]);
  useEffect(() => {
    setGapDraft(String(settings.gapSeconds));
  }, [settings.gapSeconds]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          trackIds: tracks.map((track) => track.id),
          entryIds: entries.map((entry) => entry.entryId),
          phaseOffsetsMs: entries.map((entry) => entry.phaseOffsetMs),
          settings,
          format,
        }),
      );
    } catch {
      /* Editing remains available if browser storage is full or disabled. */
    }
  }, [ready, tracks, entries, settings, format]);

  const handleTrackUpdate = useCallback((updated: Track) => {
    if (deletedTrackIds.current.has(updated.id)) return;
    setEntries((current) => updateSharedTrack(current, updated));
    if (updated.adaptation) return;
    setLibraryTracks((current) => {
      const exists = current.some((track) => track.id === updated.id);
      return exists
        ? current.map((track) => track.id === updated.id ? updated : track)
        : [updated, ...current];
    });
  }, []);

  async function prepareDeletion(track: Track) {
    if (deletionLoading || deletionBusy) return;
    setDeletionLoading(track.id);
    setDeletionError("");
    try {
      const preview = await request<DeletionPreview>(`/api/tracks/${track.id}/deletion`);
      setDeletionTarget({ track, preview });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取删除范围失败，请重试。");
    } finally {
      setDeletionLoading("");
    }
  }

  async function confirmDeletion() {
    if (!deletionTarget || deletionBusy) return;
    setDeletionBusy(true);
    setDeletionError("");
    const affected = new Set(deletionTarget.preview.track_ids);
    if (latestEntries.current.some((entry) => affected.has(entry.track.id))) {
      playOperation.current += 1;
      setPlayPending(false);
      engine.current?.pause();
    }
    try {
      const result = await request<{ deleted_ids: string[] }>(`/api/tracks/${deletionTarget.track.id}`, {
        method: "DELETE",
        body: JSON.stringify({ expected_ids: deletionTarget.preview.track_ids }),
      });
      const removed = new Set(result.deleted_ids.length ? result.deleted_ids : deletionTarget.preview.track_ids);
      for (const id of removed) deletedTrackIds.current.add(id);
      setEntries((current) => current.filter((entry) => !removed.has(entry.track.id)));
      setLibraryTracks((current) => current.filter((track) => !removed.has(track.id)));
      setDeletionTarget(null);
      setNotice(`已删除 ${removed.size} 条素材`);
    } catch (reason) {
      setDeletionError(reason instanceof Error ? reason.message : "删除失败，请重试。");
      const preview = await request<DeletionPreview>(`/api/tracks/${deletionTarget.track.id}/deletion`).catch(() => null);
      if (preview) setDeletionTarget({ ...deletionTarget, preview });
    } finally {
      setDeletionBusy(false);
    }
  }

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

  function commitGap() {
    const value = Number(gapDraft);
    if (!gapDraft.trim() || !Number.isFinite(value)) {
      setGapDraft(String(settings.gapSeconds));
      return;
    }
    const gapSeconds = Math.max(0, Math.min(30, value));
    changeSetting("gapSeconds", gapSeconds);
    setGapDraft(String(gapSeconds));
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
        handleTrackUpdate(track);
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
      handleTrackUpdate(track);
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
      handleTrackUpdate(track);
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
      const missingAlignment = tracks.filter(
        (track) => !track.alignment || track.alignment.status === "pending" || track.tempo?.source === "manual",
      );
      const pending = [
        ...new Map(missingAlignment.map((track) => [track.id, track])).values(),
      ];
      const results = await Promise.all(
        pending.map((track) => analyzeTrack(track.id, track.tempo?.source === "manual").catch(() => null)),
      );
      if (operation !== playOperation.current) return;
      const analyzed = results.filter((track) => track !== null);
      if (analyzed.length) {
        const byId = new Map(analyzed.map((track) => [track.id, track]));
        analyzed.forEach(handleTrackUpdate);
        const currentEntries = latestEntries.current;
        engine.current?.setTracks(
          currentEntries.map((entry) => byId.get(entry.track.id) ?? entry.track),
          currentEntries.map((entry) => {
            const preview = latestAlignmentPreview.current;
            return preview?.entryId === entry.entryId && preview.trackId === entry.track.id
              ? preview.offsetMs
              : entry.phaseOffsetMs;
          }),
        );
      }
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

  function seekPlayback(position: number) {
    playOperation.current += 1;
    setPlayPending(false);
    void engine.current
      ?.seek(position)
      .catch((reason: Error) => setError(reason.message));
  }

  function moveTrack(index: number, direction: number) {
    playOperation.current += 1;
    setPlayPending(false);
    setEntries((current) => {
      const next = [...current];
      const destination = index + direction;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  function removeTrack(entryId: string) {
    playOperation.current += 1;
    setPlayPending(false);
    setEntries((current) => current.filter((entry) => entry.entryId !== entryId));
  }

  async function startExport() {
    if (!tracks.length || exportActive || exportStarting) return;
    setError("");
    setExportStarting(true);
    const parameters = {
      tracks: entries.map((entry) => ({
        id: entry.track.id,
        phase_offset_ms: entry.phaseOffsetMs,
      })),
      cadence: settings.cadence,
      tone: settings.tone,
      bgm_volume: settings.bgmVolume,
      beat_volume: settings.beatVolume,
      gap_seconds: settings.gapSeconds,
      format,
    };
    const snapshot: ExportSnapshot = {
      cadence: parameters.cadence,
      toneName:
        tones.find((tone) => tone.id === parameters.tone)?.name ??
        parameters.tone,
      duration: totalDuration,
      format: parameters.format,
      trackCount: parameters.tracks.length,
      bgmVolume: parameters.bgm_volume,
      beatVolume: parameters.beat_volume,
      gapSeconds: parameters.gap_seconds,
    };
    try {
      const legacyTracks = [...new Map(tracks
        .filter((track) => track.tempo?.source === "manual")
        .map((track) => [track.id, track])).values()];
      const analyzed = await Promise.all(legacyTracks.map((track) => analyzeTrack(track.id, true)));
      analyzed.forEach(handleTrackUpdate);
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

  const beatCount = timeline.tracks.reduce(
    (total, section) => total + countTrackBeats(
      section.durationFrames,
      settings.cadence,
      tracks[section.index].alignment?.anchor_seconds,
      entries[section.index].phaseOffsetMs,
    ),
    0,
  );

  const filteredLibrary = libraryTracks.filter((track) =>
    `${track.title} ${track.source}`.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()),
  );
  const selectedEntry = route.page === "track" || route.page === "alignment"
    ? entries.find((entry) => entry.entryId === route.entryId)
    : undefined;
  const selectedIndex = selectedEntry
    ? entries.findIndex((entry) => entry.entryId === selectedEntry.entryId)
    : -1;
  const calibrationEntryId = route.page === "alignment" ? route.entryId : null;
  const previewAlignment = useCallback((offset: number | null) => {
    const entry = latestEntries.current.find((candidate) => candidate.entryId === calibrationEntryId);
    setAlignmentPreview(offset === null || !entry ? null : {
      entryId: entry.entryId,
      trackId: entry.track.id,
      offsetMs: offset,
    });
  }, [calibrationEntryId]);

  function finishAlignment(offset?: number) {
    if (!selectedEntry) return;
    const entry = latestEntries.current.find((candidate) => candidate.entryId === selectedEntry.entryId);
    if (!entry || entry.track.id !== selectedEntry.track.id) return;
    if (offset !== undefined) {
      setEntries((current) => current.map((candidate) =>
        candidate.entryId === entry.entryId && candidate.track.id === entry.track.id
          ? { ...candidate, phaseOffsetMs: offset }
          : candidate,
      ));
      setNotice("已确认并保存这条配乐的起拍对齐");
    }
    setAlignmentPreview(null);
    window.location.hash = routeHash({ page: "track", entryId: entry.entryId });
  }

  const activeNavigation = route.page === "track" || route.page === "alignment" ? "mix" : route.page;
  const navigation = [
    { page: "library", icon: Library },
    { page: "import", icon: Plus },
    { page: "mix", icon: ListMusic },
    { page: "rhythm", icon: AudioLines },
    { page: "export", icon: ArrowDownToLine },
    { page: "appearance", icon: Palette },
  ] as const;
  const descriptions: Record<AppRoute["page"], string> = {
    library: "从添加音乐导入的原曲，随时加入新的编排。",
    import: "从文件、链接、歌曲搜索或 AI 配乐开始。导入后自动加入曲库与编排。",
    mix: "调整播放顺序，进入单曲调试，让每一段音乐衔接你的步伐。",
    rhythm: "设定每分钟步数，试听音色，分别调整音乐与节拍音量。",
    track: "程序自动提取音乐节奏和起拍，按目标步频制作适配版。",
    alignment: "对照节拍器与音乐鼓点试听，确认适合这条配乐的对齐位置。",
    export: "核对编排与混音设置，合成为可以离线播放的跑步配乐。",
    appearance: "选择适合你的背景、明暗和字号。",
  };

  return (
    <div
      className="studio-shell"
      data-theme={appearance.colorMode}
      data-text-size={appearance.textSize}
    >
      <Wallpaper settings={appearance} />
      {navigationOpen && (
        <button
          className="sidebar-backdrop"
          onClick={() => setNavigationOpen(false)}
          aria-label="关闭导航"
        />
      )}
      <aside
        className={`sidebar ${navigationOpen ? "is-open" : ""}`}
        aria-label="主导航"
      >
        <a
          className="brand"
          href="#/library"
          aria-label="StrideMix 曲库"
        >
          <span
            className="brand-mark"
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            STRIDE
            <span className="brand-light">
              MIX
            </span>
            <small>
              跑步配乐工作台
            </small>
          </span>
        </a>
        <nav
          className="sidebar-nav"
          aria-label="工作台页面"
        >
          {navigation.map(({ page, icon: Icon }) => (
            <a
              key={page}
              href={`#/${page}`}
              className={`nav-link ${activeNavigation === page ? "active" : ""}`}
              aria-current={activeNavigation === page ? "page" : undefined}
              onClick={() => setNavigationOpen(false)}
            >
              <Icon size={22} />
              <span>
                {PAGE_TITLES[page]}
              </span>
              {page === "mix" && entries.length > 0 &&
                <span className="nav-count">
                  {entries.length}
                </span>
              }
              {page === "export" && exportActive &&
                <LoaderCircle
                  size={17}
                  className="spin"
                />
              }
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection ${health ? "online" : ""}`}>
            <i />
            {health ? "本地服务已连接" : "正在连接本地服务"}
          </span>
          <p className="local-storage-note">
            素材保存在这台电脑，编排自动保存。
          </p>
          <button
            className="text-button help-button"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={19} />
            使用指南
          </button>
          <a
            className="text-button"
            href="https://github.com/Jocelyn-2005/stridemix"
            target="_blank"
            rel="noreferrer"
          >
            <Github size={19} />
            开源项目
            <ExternalLink size={15} />
          </a>
        </div>
      </aside>
      <main
        className="workspace-main"
        id="main-content"
      >
        <header className="workspace-header">
          <div className="header-leading">
            <button
              className="icon-button mobile-menu-button"
              onClick={() => setNavigationOpen((open) => !open)}
              aria-label="打开导航"
              aria-expanded={navigationOpen}
            >
              <Menu size={23} />
            </button>
            <nav
              className={`breadcrumb ${route.page === "alignment" ? "calibration-breadcrumb" : ""}`}
              aria-label="当前位置"
            >
              <a href="#/library">
                工作台
              </a>
              <span aria-hidden="true">
                /
              </span>
              {(route.page === "track" || route.page === "alignment") &&
                <>
                  <a href="#/mix">
                    配乐编排
                  </a>
                  <span aria-hidden="true">
                    /
                  </span>
                </>
              }
              {route.page === "alignment" && selectedEntry && (
                <>
                  <a href={routeHash({ page: "track", entryId: selectedEntry.entryId })}>单曲调试</a>
                  <span aria-hidden="true">/</span>
                </>
              )}
              <span aria-current="page">
                {PAGE_TITLES[route.page]}
              </span>
            </nav>
          </div>
          <div className="header-actions">
            <span className="header-project-meta">
              {tracks.length} 条配乐 · {formatTime(totalDuration)}
            </span>
            <a
              className="secondary-button"
              href="#/import"
            >
              <Plus size={18} />
              添加音乐
            </a>
          </div>
        </header>
        <div className="page-content">
          <section className="page-heading">
            <div>
              <h1>
                {PAGE_TITLES[route.page]}
              </h1>
              <p className="page-description">
                {descriptions[route.page]}
              </p>
            </div>
            <div className="page-actions">
              {route.page === "library" &&
                <a
                  className="primary-button"
                  href="#/mix"
                >
                  <ListMusic size={19} />
                  查看编排{entries.length > 0 && ` · ${entries.length}`}
                </a>
              }
              {(route.page === "rhythm" || route.page === "track" || route.page === "export") &&
                <a
                  className="secondary-button"
                  href="#/mix"
                >
                  <ArrowLeft size={18} />
                  返回编排
                </a>
              }
              {route.page === "mix" &&
                <a
                  className="primary-button"
                  href="#/export"
                >
                  <ArrowDownToLine size={19} />
                  前往导出
                </a>
              }
            </div>
          </section>
          {route.page === "library" && (
            <section
              className="library-page"
              aria-label="本地音乐曲库"
            >
              <div className="library-toolbar toolbar">
                <label
                  className="search-field"
                  htmlFor="library-search"
                >
                  <Search size={21} />
                  <input
                    id="library-search"
                    type="search"
                    placeholder="搜索名称或来源"
                    value={libraryQuery}
                    onChange={(event) => setLibraryQuery(event.target.value)}
                  />
                </label>
                <span className="library-count">
                  {filteredLibrary.length} 条素材
                </span>
              </div>
              {!ready ?
                <div
                  className="empty-state glass-panel"
                  role="status"
                >
                  <LoaderCircle
                    size={32}
                    className="spin"
                  />
                  <h2>
                    正在读取曲库
                  </h2>
                  <p>
                    连接本地服务并恢复编排。
                  </p>
                </div>
                : libraryTracks.length === 0 ? (
                  <div className="empty-state glass-panel">
                    <Library size={42} />
                    <h2>
                      把第一首音乐加入曲库
                    </h2>
                    <p>
                      上传音频或视频文件，也可以从链接、歌名搜索和 AI 配乐导入。
                    </p>
                    <a
                      className="primary-button"
                      href="#/import"
                    >
                      <Plus size={20} />
                      添加音乐
                    </a>
                  </div>
                ) : filteredLibrary.length === 0 ? (
                  <div className="empty-state glass-panel">
                    <Search size={34} />
                    <h2>
                      没有找到匹配的音乐
                    </h2>
                    <p>
                      试试其他名称或来源。
                    </p>
                    <button
                      className="secondary-button"
                      onClick={() => setLibraryQuery("")}
                    >
                      清空搜索
                    </button>
                  </div>
                ) : (
                  <div className="library-grid">
                    {filteredLibrary.map((track) => (
                      <article
                        className="library-card glass-panel"
                        key={track.id}
                        data-track-id={track.id}
                      >
                        <div className="library-art">
                          <Music2 size={28} />
                          <Waveform values={track.waveform} />
                        </div>
                        <div className="library-card-copy">
                          <h2 title={track.title}>
                            {track.title}
                          </h2>
                          <p>
                            {track.source || "本地音频"}
                          </p>
                          <div className="library-card-meta">
                            <span>
                              {formatTime(track.duration)}
                            </span>
                            <span>
                              {track.tempo?.bpm ? `${Number(track.tempo.bpm.toFixed(1))} BPM` : "BPM 待分析"}
                            </span>
                          </div>
                        </div>
                        <div className="library-card-actions">
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setEntries((current) => [...current, createEntry(track)]);
                            setNotice(`已将「${track.title}」加入编排`);
                          }}
                          aria-label={`将${track.title}加入编排`}
                        >
                          <Plus size={18} />
                          加入编排
                        </button>
                        <button
                          className="icon-button library-delete-button"
                          disabled={!!deletionLoading || deletionBusy}
                          onClick={() => void prepareDeletion(track)}
                          aria-label={`删除素材${track.title}`}
                        >
                          {deletionLoading === track.id ? <LoaderCircle size={18} className="spin" /> : <Trash2 size={18} />}
                        </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
            </section>
          )}
          {route.page === "import" && (
            <div className="import-page">
              <section className="import-section glass-panel">
                <div
                  className="import-tabs"
                  role="tablist"
                  aria-label="配乐来源"
                >
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
                      <span>
                        {label}
                      </span>
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
                        拖入文件，或
                        <span>
                          点击选择
                        </span>
                      </strong>
                      <small>
                        支持 MP3、WAV、FLAC、M4A 及视频文件
                      </small>
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
                      <label htmlFor="video-url">
                        粘贴视频或音频链接
                      </label>
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
                          <span className="sr-only">
                            导入链接
                          </span>
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
                        <label htmlFor="song-query">
                          输入歌名、歌手或关键词
                        </label>
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
                            <span className="sr-only">
                              搜索歌曲
                            </span>
                          </button>
                        </div>
                        <p>
                          通过 YouTube 搜索候选版本，确认后添加至编排。
                        </p>
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
                                <strong>
                                  {result.title}
                                </strong>
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
                      <label htmlFor="ai-prompt">
                        描述你想要的跑步配乐
                      </label>
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
                          />
                          {" "}
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
                <div
                  className="import-status"
                  role="status"
                >
                  <LoaderCircle
                    size={16}
                    className="spin"
                  />
                  <span>
                    {busy}
                  </span>
                </div>
              )}
              <div className="page-bottom-actions">
                <a
                  className="secondary-button"
                  href="#/library"
                >
                  <Library size={19} />
                  查看曲库
                </a>
                <a
                  className="primary-button"
                  href="#/mix"
                >
                  <ListMusic size={19} />
                  查看编排 · {entries.length}
                </a>
              </div>
            </div>
          )}
          {route.page === "mix" && (
            <div className="mix-layout">
              <section className="playlist-panel glass-panel">
                <div className="section-heading">
                  <div>
                    <h2>
                      播放顺序
                    </h2>
                    <p>
                      {entries.length} 条配乐 · {formatTime(totalDuration)}
                    </p>
                  </div>
                  <a
                    className="secondary-button"
                    href="#/library"
                  >
                    <Plus size={19} />
                    从曲库添加
                  </a>
                </div>
                <div className="track-list">
                  {entries.length === 0 &&
                    <div className="empty-state">
                      <ListMusic size={38} />
                      <h3>
                        编排里还没有音乐
                      </h3>
                      <p>
                        从曲库选择素材，或导入新的音乐。
                      </p>
                      <a
                        className="primary-button"
                        href="#/import"
                      >
                        <Plus size={19} />
                        添加音乐
                      </a>
                    </div>
                  }
                  {entries.map(({ entryId, track, phaseOffsetMs }, index) => {
                    const start = timeline.tracks[index].startFrame / SAMPLE_RATE;
                    return (
                      <article
                        className={`track-row ${playback.playing && playback.activeIndex === index ? "is-playing" : ""}`}
                        key={entryId}
                        data-entry-id={entryId}
                      >
                        <button
                          className="track-number"
                          onClick={() => seekPlayback(start)}
                          aria-label={`跳转到${track.title}`}
                        >
                          {playback.playing && playback.activeIndex === index ?
                            <AudioLines size={21} />
                            : String(index + 1).padStart(2, "0")}
                        </button>
                        <div className="track-details">
                          <div className="track-title-row">
                            <h3 title={track.title}>
                              {track.title}
                            </h3>
                            <span>
                              {formatTime(track.duration)}
                            </span>
                          </div>
                          <div className="track-meta">
                            <span>
                              {track.source || "本地音频"}
                            </span>
                            <span>
                              {formatTime(start)} 开始
                            </span>
                          </div>
                          <div className="track-summary">
                            <span>
                              {track.tempo?.bpm ? `${Number(track.tempo.bpm.toFixed(1))} BPM` : "BPM 待分析"}
                            </span>
                            <span>
                              {track.alignment?.anchor_seconds != null ? `起拍 ${track.alignment.anchor_seconds.toFixed(2)} 秒` : "起拍待确认"}
                            </span>
                            <span>
                              微调 {Number(phaseOffsetMs.toFixed(2))} ms
                            </span>
                            {track.adaptation &&
                              <span>
                                适配版
                              </span>
                            }
                          </div>
                        </div>
                        <div className="track-actions">
                          <a
                            className="secondary-button track-debug"
                            href={routeHash({ page: "track", entryId })}
                            aria-label={`调试${track.title}`}
                          >
                            <Settings2 size={17} />
                            调试
                          </a>
                          <button
                            className="icon-button"
                            disabled={index === 0}
                            onClick={() => moveTrack(index, -1)}
                            aria-label={`上移${track.title}`}
                          >
                            <ArrowUp size={18} />
                          </button>
                          <button
                            className="icon-button"
                            disabled={index === tracks.length - 1}
                            onClick={() => moveTrack(index, 1)}
                            aria-label={`下移${track.title}`}
                          >
                            <ArrowDown size={18} />
                          </button>
                          <button
                            className="icon-button remove-track"
                            onClick={() => removeTrack(entryId)}
                            aria-label={`移除${track.title}`}
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <label
                  className="gap-control"
                  htmlFor="track-gap"
                >
                  <span>
                    曲间间隙
                    <small>
                      间隙内音乐与节拍静音
                    </small>
                  </span>
                  <input
                    id="track-gap"
                    type="number"
                    min="0"
                    max="30"
                    step="any"
                    value={gapDraft}
                    onChange={(event) => setGapDraft(event.target.value)}
                    onBlur={commitGap}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitGap();
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <span>
                    秒
                  </span>
                </label>
              </section>
              <aside className="mix-overview glass-panel">
                <div className="section-heading">
                  <h2>
                    当前配乐
                  </h2>
                </div>
                <dl className="project-facts">
                  <div>
                    <dt>
                      总时长
                    </dt>
                    <dd>
                      {formatTime(totalDuration)}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      目标步频
                    </dt>
                    <dd>
                      {settings.cadence}
                      <small>
                        SPM
                      </small>
                    </dd>
                  </div>
                  <div>
                    <dt>
                      节拍音色
                    </dt>
                    <dd>
                      {selectedTone?.name ?? "经典点击"}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      节拍数量
                    </dt>
                    <dd>
                      {beatCount.toLocaleString()} 次
                    </dd>
                  </div>
                </dl>
                <a
                  className="secondary-button"
                  href="#/rhythm"
                >
                  <AudioLines size={20} />
                  节奏与混音
                  <ArrowRight size={18} />
                </a>
                <a
                  className="primary-button"
                  href="#/export"
                >
                  <ArrowDownToLine size={20} />
                  前往导出
                </a>
              </aside>
            </div>
          )}
          <div className="rhythm-layout" hidden={route.page !== "rhythm"}>
            <section className="cadence-panel glass-panel">
              <div className="section-title">
                <span className="title-icon">
                  <AudioLines size={18} />
                </span>
                <h2>
                  设定步频
                </h2>
              </div>
              <div
                className={`cadence-display ${playback.playing ? "running" : ""}`}
              >
                <label
                  htmlFor="cadence-input"
                  className="sr-only"
                >
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
                <div className="cadence-unit">
                  步 / 分钟
                </div>
                <div
                  className="pulse-row"
                  aria-hidden="true"
                >
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
                <h3>
                  节拍音色
                </h3>
                <span>
                  点击试听
                </span>
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
                      <strong>
                        {tone.name}
                      </strong>
                      <small>
                        {tone.description}
                      </small>
                    </span>
                    <span className="tone-radio">
                      {settings.tone === tone.id && (
                        <Check
                          size={11}
                          strokeWidth={3}
                        />
                      )}
                    </span>
                  </button>
                ))}
              </div>
              <div className="cadence-footnote">
                <Headphones size={15} />
                <span>
                  一步一响，每曲按起拍独立对齐。
                </span>
              </div>
            </section>
            <section className="mixer-panel glass-panel">
              <div className="section-title">
                <span className="title-icon">
                  <Settings2 size={18} />
                </span>
                <h2>
                  混音控制
                </h2>
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
                <span>
                  试听时可实时调整音量。
                </span>
              </div>
            </section>
          </div>
          {(route.page === "track" || route.page === "alignment") && !ready && (
            <div
              className="empty-state glass-panel"
              role="status"
            >
              <LoaderCircle
                size={30}
                className="spin"
              />
              <p>
                正在恢复编排…
              </p>
            </div>
          )}
          {entries.map((entry, index) => (
            <section
              className="track-detail glass-panel"
              key={entry.entryId}
              hidden={route.page !== "track" || selectedEntry?.entryId !== entry.entryId}
            >
              <div className="track-detail-heading">
                <div>
                  <span className="detail-eyebrow">
                    编排第 {index + 1} 条
                  </span>
                  <h2>
                    {entry.track.title}
                  </h2>
                  <p>
                    {entry.track.source || "本地音频"} · {formatTime(entry.track.duration)} · 从 {formatTime(timeline.tracks[index].startFrame / SAMPLE_RATE)} 开始
                  </p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => seekPlayback(timeline.tracks[index].startFrame / SAMPLE_RATE)}
                >
                  <SkipBack size={18} />
                  定位到这首
                </button>
              </div>
              <div className="track-detail-waveform">
                <Waveform
                  values={entry.track.waveform}
                  active={playback.playing && playback.activeIndex === index}
                />
              </div>
              <div className="detail-section">
                <div className="section-heading">
                  <h3>
                    音乐节奏
                  </h3>
                  <a
                    className="text-button"
                    href="#/rhythm"
                  >
                    目标 {settings.cadence} SPM
                    <ArrowRight size={17} />
                  </a>
                </div>
                <TrackTempo
                  track={entry.track}
                  entryId={entry.entryId}
                  cadence={settings.cadence}
                  onTrackUpdate={handleTrackUpdate}
                  onReplace={(updated) => {
                    handleTrackUpdate(updated);
                    setEntries((current) =>
                      replaceEntryTrack(current, entry.entryId, entry.track.id, updated),
                    );
                  }}
                />
              </div>
              <p className="saved-alignment">
                {entry.phaseOffsetMs === 0
                  ? entry.track.alignment?.anchor_seconds == null
                    ? "起拍待确认，可进入可视化校准试听"
                    : "起拍使用程序自动提取的参考位置"
                  : `已保存的起拍微调 ${Number(entry.phaseOffsetMs.toFixed(2))} ms`}
              </p>
            </section>
          ))}
          {route.page === "alignment" && selectedEntry && (
            <BeatAlignment
              key={selectedEntry.entryId}
              track={selectedEntry.track}
              entryId={selectedEntry.entryId}
              cadence={settings.cadence}
              offsetMs={selectedEntry.phaseOffsetMs}
              playback={playback}
              trackStart={timeline.tracks[selectedIndex].startFrame / SAMPLE_RATE}
              onSeek={(seconds) => seekPlayback(timeline.tracks[selectedIndex].startFrame / SAMPLE_RATE + seconds)}
              onTogglePlayback={() => void togglePlayback()}
              onPreviewOffset={previewAlignment}
              onConfirm={(offset) => finishAlignment(offset)}
              onCancel={() => finishAlignment()}
            />
          )}
          {(route.page === "track" || route.page === "alignment") && ready && !selectedEntry && (
            <div className="empty-state glass-panel">
              <Music2 size={38} />
              <h2>
                这条配乐已从编排中移除
              </h2>
              <p>
                返回编排，选择需要调试的曲目。
              </p>
              <a
                className="primary-button"
                href="#/mix"
              >
                <ArrowLeft size={19} />
                返回编排
              </a>
            </div>
          )}
          {route.page === "export" &&
            <div className="export-layout">
              <section className="export-panel glass-panel">
                <div className="export-heading">
                  <ArrowDownToLine size={19} />
                  <h2>
                    合成与导出
                  </h2>
                </div>
                <div className="export-stats">
                  <span>
                    总时长
                    <strong>
                      {formatTime(totalDuration)}
                    </strong>
                  </span>
                  <span>
                    步频
                    <strong>
                      {settings.cadence}
                      <small>
                        SPM
                      </small>
                    </strong>
                  </span>
                </div>
                <div className="export-details">
                  <span>
                    {selectedTone?.name ?? "经典点击"}
                  </span>
                  <span>
                    {beatCount.toLocaleString()} 次节拍
                  </span>
                </div>
                <label
                  htmlFor="export-format"
                  className="format-label"
                >
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
                    <option value="mp3">
                      MP3 · 压缩音频
                    </option>
                    <option value="wav">
                      WAV · 无压缩音频
                    </option>
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
                    <LoaderCircle
                      size={17}
                      className="spin"
                    />
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
                  <p className="export-hint">
                    添加配乐后即可导出
                  </p>
                )}
                {exportActive && job && (
                  <div
                    className="export-progress"
                    role="status"
                  >
                    <div>
                      <span>
                        合成进度
                      </span>
                      <strong>
                        {Math.round(job.progress)}%
                      </strong>
                    </div>
                    <progress
                      max="100"
                      value={job.progress}
                    />
                    <button onClick={() => void cancelExport()}>
                      取消导出
                    </button>
                    <p>
                      导出使用开始时的编排与混音设置。
                    </p>
                  </div>
                )}
                {job && exportSnapshot && (
                  <section
                    className="export-job-summary"
                    aria-label="本次导出任务参数"
                  >
                    <h3>
                      本次任务使用的参数
                    </h3>
                    <p>
                      {exportSnapshot.trackCount} 条配乐 · {formatTime(exportSnapshot.duration)} ·{" "}
                      {exportSnapshot.cadence} SPM · {exportSnapshot.format.toUpperCase()}
                    </p>
                    <p>
                      {exportSnapshot.toneName} · 音乐 {Math.round(exportSnapshot.bgmVolume * 100)}% ·{" "}
                      节拍 {Math.round(exportSnapshot.beatVolume * 100)}% · 间隙 {exportSnapshot.gapSeconds} 秒
                    </p>
                  </section>
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
                  </>
                )}
                {job?.status === "cancelled" && (
                  <p className="export-hint">
                    导出已取消，可以调整后重新导出。
                  </p>
                )}
                {job?.status === "failed" && (
                  <p className="export-hint export-error">
                    {job.error || "导出失败，请重试。"}
                  </p>
                )}
              </section>
              <section className="export-checklist glass-panel">
                <div className="section-heading">
                  <h2>
                    当前编排参数
                  </h2>
                  <a
                    className="text-button"
                    href="#/mix"
                  >
                    编辑
                    <ArrowRight size={17} />
                  </a>
                </div>
                <dl className="project-facts">
                  <div>
                    <dt>
                      配乐数量
                    </dt>
                    <dd>
                      {entries.length} 条
                    </dd>
                  </div>
                  <div>
                    <dt>
                      音乐音量
                    </dt>
                    <dd>
                      {Math.round(settings.bgmVolume * 100)}%
                    </dd>
                  </div>
                  <div>
                    <dt>
                      节拍音量
                    </dt>
                    <dd>
                      {Math.round(settings.beatVolume * 100)}%
                    </dd>
                  </div>
                  <div>
                    <dt>
                      曲间间隙
                    </dt>
                    <dd>
                      {settings.gapSeconds} 秒
                    </dd>
                  </div>
                </dl>
                <ol className="export-track-list">
                  {entries.map((entry) =>
                    <li key={entry.entryId}>
                      <span>
                        {entry.track.title}
                      </span>
                      <span>
                        {formatTime(entry.track.duration)}
                      </span>
                    </li>
                  )}
                </ol>
                {!entries.length &&
                  <p>
                    从曲库加入音乐后即可导出。
                  </p>
                }
              </section>
            </div>
          }
          {route.page === "appearance" &&
            <AppearancePage
              settings={appearance}
              onChange={updateAppearance}
            />
          }
        </div>
      </main>
      <section
        className="transport"
        aria-label="配乐试听"
      >
        <div className="transport-controls">
          <button
            className="icon-button reset-button"
            onClick={() => seekPlayback(0)}
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
              <LoaderCircle
                size={21}
                className="spin"
              />
            ) : playback.playing ? (
              <Pause
                size={22}
                fill="currentColor"
              />
            ) : (
              <Play
                size={21}
                fill="currentColor"
              />
            )}
          </button>
        </div>
        <div className="transport-info">
          <strong>
            {playback.activeIndex >= 0
              ? tracks[playback.activeIndex]?.title
              : tracks.length
                ? playback.playing
                  ? "曲间间隙"
                  : "试听完整配乐"
                : "试听步频节拍"}
          </strong>
          <span>
            {settings.cadence} SPM
            <i />
            {selectedTone?.name ?? "经典点击"}
          </span>
        </div>
        <div className="seek-area">
          <span className="time-current">
            {formatTime(playback.position)}
          </span>
          <input
            type="range"
            aria-label="试听进度"
            min="0"
            max={totalDuration || 1}
            step="0.1"
            value={Math.min(playback.position, totalDuration || 0)}
            disabled={!tracks.length || !ready}
            onChange={(event) => {
              seekPlayback(Number(event.target.value));
            }}
            style={
              {
                "--fill": `${totalDuration ? (playback.position / totalDuration) * 100 : 0}%`,
              } as CSSProperties
            }
          />
          <span className="time-total">
            {formatTime(totalDuration)}
          </span>
        </div>
        <div className="transport-mode">
          <span
            className={`playing-indicator ${playback.playing ? "active" : ""}`}
          >
            <i />
            <i />
            <i />
          </span>
          <span>
            {playback.playing ? "正在试听" : "待播放"}
          </span>
        </div>
      </section>
      {deletionTarget && (
        <DeleteTrackDialog
          titles={deletionTarget.preview.titles}
          projectCount={entries.filter((entry) => deletionTarget.preview.track_ids.includes(entry.track.id)).length}
          busy={deletionBusy}
          error={deletionError}
          onConfirm={() => void confirmDeletion()}
          onClose={() => {
            if (!deletionBusy) setDeletionTarget(null);
          }}
        />
      )}
      {(error || notice) && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ?
            <CircleHelp size={18} />
            :
            <Check size={18} />
          }
          <span>
            {error || notice}
          </span>
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
        <div
          className="modal-backdrop"
          onClick={() => setHelpOpen(false)}
        >
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
            <h2 id="help-title">
              使用指南
            </h2>
            <ol>
              <li>
                <strong>
                  添加配乐
                </strong>
                <p>
                  上传音频或视频、粘贴链接、搜索歌名，或使用 AI
                  生成配乐。支持连续添加多条。
                </p>
              </li>
              <li>
                <strong>
                  设定你的步频
                </strong>
                <p>
                  165 表示每分钟 165
                  次提示，一步一响。点击音色可以试听，上下箭头可以调整曲目顺序。
                </p>
              </li>
              <li>
                <strong>
                  调好音量，导出出发
                </strong>
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
