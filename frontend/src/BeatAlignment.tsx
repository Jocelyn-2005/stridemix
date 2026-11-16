import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { request } from "./api";
import type { RhythmWindow, Track } from "./api";
import type { PlaybackState } from "./audio";
import { formatTime } from "./timeline";
import { matchRhythm, metronomeTimes } from "./rhythm";
import "./alignment.css";

interface BeatAlignmentProps {
  track: Track;
  entryId: string;
  cadence: number;
  offsetMs: number;
  playback: PlaybackState;
  trackStart: number;
  onSeek: (localSeconds: number) => void;
  onTogglePlayback: () => void;
  onPreviewOffset: (offset: number | null) => void;
  onConfirm: (offset: number) => void;
  onCancel: () => void;
}

function Ripple({ age, active, label }: {
  age: number;
  active: boolean;
  label: string;
}) {
  const progress = active ? Math.min(1, Math.max(0, age) / 0.45) : 1;
  return (
    <div
      className={`calibration-ripple ${active && age < 0.13 ? "is-hit" : ""}`}
      aria-hidden="true"
    >
      <i
        style={{
          transform: `scale(${0.8 + progress * 0.8})`,
          opacity: 1 - progress,
        }}
      />
      <i
        style={{
          transform: `scale(${0.7 + progress * 0.5})`,
          opacity: (1 - progress) * 0.5,
        }}
      />
      <span>{label}</span>
    </div>
  );
}

function RhythmPlot({ data, ticks, position, music }: {
  data: RhythmWindow;
  ticks: number[];
  position: number;
  music: boolean;
}) {
  const width = 600;
  const height = 145;
  const x = (time: number) =>
    (time - data.start_seconds) / data.duration_seconds * width;
  const playhead = x(position);

  return (
    <div className="calibration-plot">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={music
          ? "当前片段的实际音频波形、鼓点和强拍"
          : "当前步频与偏移对应的节拍器落点"}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={ratio * width}
            x2={ratio * width}
            y1="0"
            y2={height}
            className="calibration-grid-line"
          />
        ))}
        <line
          x1="0"
          x2={width}
          y1="72"
          y2="72"
          className="calibration-zero-line"
        />
        {music && data.envelope.map((amplitude, index) => {
          const horizontal = index / Math.max(1, data.envelope.length - 1) * width;
          const size = Math.max(0, Math.min(1, amplitude)) * 44;
          return (
            <line
              key={index}
              x1={horizontal}
              x2={horizontal}
              y1={72 - size}
              y2={72 + size}
              className="calibration-envelope"
            />
          );
        })}
        {music ? (
          data.onsets.map((onset, index) => (
            <g
              key={index}
              className={onset.strong
                ? "calibration-onset strong"
                : "calibration-onset"}
            >
              <line
                x1={x(onset.time)}
                x2={x(onset.time)}
                y1={onset.strong ? 15 : 36}
                y2="116"
                opacity={0.4 + onset.strength * 0.6}
              />
              <circle
                cx={x(onset.time)}
                cy="127"
                r={onset.strong ? 5 : 3}
              />
            </g>
          ))
        ) : (
          ticks.map((time) => (
            <g key={time} className="calibration-tick">
              <line x1={x(time)} x2={x(time)} y1="28" y2="116" />
              <circle cx={x(time)} cy="127" r="4" />
            </g>
          ))
        )}
        {playhead >= 0 && playhead <= width && (
          <line
            x1={playhead}
            x2={playhead}
            y1="0"
            y2={height}
            className="calibration-playhead"
          />
        )}
      </svg>
      <div className="calibration-axis" aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <span key={ratio}>
            {formatTime(data.start_seconds + ratio * data.duration_seconds)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function BeatAlignment({
  track,
  entryId,
  cadence,
  offsetMs,
  playback,
  trackStart,
  onSeek,
  onTogglePlayback,
  onPreviewOffset,
  onConfirm,
  onCancel,
}: BeatAlignmentProps) {
  const initialPosition = playback.position - trackStart;
  const [start, setStart] = useState(() =>
    initialPosition >= 0 && initialPosition < track.duration
      ? Math.floor(initialPosition / 12) * 12
      : 0,
  );
  const [data, setData] = useState<RhythmWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(offsetMs);
  const [offsetDraft, setOffsetDraft] = useState(String(offsetMs));
  const localPosition = playback.position - trackStart;
  const insideTrack = localPosition >= 0 && localPosition < track.duration;
  const playingHere = playback.playing && insideTrack;
  const anchor = track.alignment?.anchor_seconds;
  const visibleStart = data?.start_seconds ?? start;
  const visibleDuration = data?.duration_seconds
    ?? Math.min(12, Math.max(0.01, track.duration - start));
  const visibleEnd = visibleStart + visibleDuration;

  useEffect(() => {
    setStart((current) => current < track.duration ? current : 0);
  }, [track.id, track.duration]);

  useEffect(() => {
    setOffset(offsetMs);
    setOffsetDraft(String(offsetMs));
  }, [entryId, track.id, offsetMs]);

  useEffect(() => {
    onPreviewOffset(offset);
  }, [offset, onPreviewOffset]);

  useEffect(() => {
    return () => onPreviewOffset(null);
  }, [onPreviewOffset]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setData(null);
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      start_seconds: String(start),
      duration_seconds: "12",
    });
    const timer = setTimeout(() => {
      request<RhythmWindow>(
        `/api/tracks/${encodeURIComponent(track.id)}/rhythm?${query}`,
        { signal: controller.signal },
      ).then((result) => {
        if (active) {
          setData(result);
        }
      }).catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "读取鼓点失败，请重试。");
        }
      }).finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    }, 180);

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [track.id, track.tempo?.bpm, start, retry]);

  useEffect(() => {
    if (
      playingHere &&
      !loading &&
      localPosition >= visibleEnd &&
      localPosition < track.duration
    ) {
      setStart(Math.floor(localPosition / 12) * 12);
    }
  }, [playingHere, loading, localPosition, visibleEnd, track.duration]);

  const ticks = useMemo(
    () => metronomeTimes(visibleStart, visibleDuration, cadence, anchor, offset),
    [visibleStart, visibleDuration, cadence, anchor, offset],
  );
  const match = useMemo(
    () => data ? matchRhythm(data, cadence, anchor, offset) : null,
    [data, cadence, anchor, offset],
  );
  const previousTick = ticks.filter((time) => time <= localPosition).at(-1);
  const previousOnset = data?.onsets
    .filter((onset) => onset.time <= localPosition)
    .at(-1);
  const tickAge = previousTick === undefined ? 1 : localPosition - previousTick;
  const onsetAge = previousOnset === undefined ? 1 : localPosition - previousOnset.time;
  const inWindow = insideTrack
    && localPosition >= visibleStart
    && localPosition <= visibleEnd;
  const evidence = data ? Math.round(data.reliability * 100) : null;

  function changeOffset(value: number) {
    const bounded = Math.min(1000, Math.max(-1000, value));
    setOffset(bounded);
    setOffsetDraft(String(Number(bounded.toFixed(2))));
  }

  function commitOffset() {
    const value = Number(offsetDraft);
    if (!offsetDraft.trim() || !Number.isFinite(value)) {
      setOffsetDraft(String(offset));
      return offset;
    }
    const bounded = Math.min(1000, Math.max(-1000, value));
    changeOffset(bounded);
    return bounded;
  }

  function playSegment() {
    onSeek(visibleStart);
    if (!playback.playing) {
      onTogglePlayback();
    }
  }

  return (
    <div className="beat-alignment-page">
      <section className="calibration-intro glass-panel">
        <div>
          <h2>{track.title}</h2>
        </div>
        <span className="calibration-cadence">
          {cadence}
          <small>步／分钟 · 一响一步</small>
        </span>
      </section>

      <section
        className="calibration-workbench glass-panel"
        aria-label="节拍器与音乐鼓点对照"
      >
        <div className="calibration-segment-toolbar">
          <div className="calibration-segment-controls">
            <button
              className="icon-button"
              disabled={start <= 0 || loading}
              onClick={() => setStart(Math.max(0, start - 12))}
              aria-label="上一个分析片段"
            >
              <ChevronLeft size={21} />
            </button>
            <span>{formatTime(visibleStart)} — {formatTime(visibleEnd)}</span>
            <button
              className="icon-button"
              disabled={visibleEnd >= track.duration - 0.01 || loading}
              onClick={() => setStart(Math.min(track.duration - 0.01, start + 12))}
              aria-label="下一个分析片段"
            >
              <ChevronRight size={21} />
            </button>
          </div>
          <div className="calibration-preview-controls">
            <button
              className="secondary-button"
              onClick={playSegment}
              disabled={loading}
            >
              <Play size={17} />
              从此片段试听
            </button>
            <button
              className="icon-button"
              onClick={onTogglePlayback}
              aria-label={playback.playing ? "暂停校准试听" : "继续校准试听"}
            >
              {playback.playing ? <Pause size={20} /> : <Play size={20} />}
            </button>
          </div>
        </div>
        <label
          className="calibration-segment-range"
          htmlFor={`segment-${entryId}`}
        >
          <span>选择音频片段</span>
          <input
            id={`segment-${entryId}`}
            type="range"
            min="0"
            max={Math.max(0, track.duration - 0.05)}
            step="0.1"
            value={Math.min(start, Math.max(0, track.duration - 0.05))}
            onChange={(event) => setStart(Number(event.target.value))}
            aria-label="校准音频片段位置"
            style={{
              "--fill": `${track.duration ? start / track.duration * 100 : 0}%`,
            } as CSSProperties}
          />
          <span>{formatTime(track.duration)}</span>
        </label>

        <div className="calibration-comparison">
          <section
            className="calibration-lane metronome-lane"
            aria-label="左侧节拍器"
          >
            <div className="calibration-lane-heading">
              <h3>节拍器</h3>
              <span>每个落点对应一步</span>
            </div>
            <Ripple
              age={tickAge}
              active={playingHere && inWindow && previousTick !== undefined}
              label="一步"
            />
            {data ? (
              <RhythmPlot
                data={data}
                ticks={ticks}
                position={localPosition}
                music={false}
              />
            ) : (
              <div className="calibration-plot-placeholder">
                {loading ? "正在读取时间线" : "时间线暂不可用"}
              </div>
            )}
          </section>
          <section
            className="calibration-lane music-lane"
            aria-label="右侧音乐鼓点"
          >
            <div className="calibration-lane-heading">
              <h3>BGM 鼓点</h3>
              <span>
                <i className="strong-node-key" />
                强拍候选
                <i className="drum-node-key" />
                鼓点
              </span>
            </div>
            <Ripple
              age={onsetAge}
              active={playingHere && inWindow && previousOnset !== undefined}
              label={previousOnset?.strong ? "强拍" : "鼓点"}
            />
            {data ? (
              <RhythmPlot
                data={data}
                ticks={ticks}
                position={localPosition}
                music
              />
            ) : (
              <div className="calibration-plot-placeholder">
                {loading ? (
                  <>
                    <LoaderCircle size={22} className="spin" />
                    提取实际音频节点
                  </>
                ) : "鼓点暂不可用"}
              </div>
            )}
          </section>
        </div>
        <div className="calibration-live-status">
          <span className={playingHere && inWindow ? "active" : ""}>
            <i />
            {playingHere && inWindow ? "同步试听中" : "等待试听"}
          </span>
          <span>
            曲内位置 {Math.max(0, Math.min(track.duration, localPosition)).toFixed(2)} 秒
          </span>
        </div>
        {error && (
          <div className="calibration-load-error" role="alert">
            <p>{error}</p>
            <button
              className="secondary-button"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新读取鼓点
            </button>
          </div>
        )}
      </section>

      <div className="calibration-bottom-grid">
        <section className="calibration-adjustment glass-panel">
          <h2>起拍微调</h2>
          <p>负值提前节拍，正值延后。当前调整即时用于试听。</p>
          <div className="calibration-offset-controls">
            <button
              className="secondary-button"
              onClick={() => changeOffset(offset - 10)}
              disabled={offset <= -1000}
              aria-label="校准节拍提前10毫秒"
            >
              −10
            </button>
            <label
              className="calibration-offset-input"
              htmlFor={`calibration-offset-${entryId}`}
            >
              <input
                id={`calibration-offset-${entryId}`}
                type="number"
                min="-1000"
                max="1000"
                step="any"
                value={offsetDraft}
                onChange={(event) => setOffsetDraft(event.target.value)}
                onBlur={commitOffset}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitOffset();
                    event.currentTarget.blur();
                  }
                }}
                aria-label="校准起拍偏移毫秒"
              />
              <span>ms</span>
            </label>
            <button
              className="secondary-button"
              onClick={() => changeOffset(offset + 10)}
              disabled={offset >= 1000}
              aria-label="校准节拍延后10毫秒"
            >
              +10
            </button>
          </div>
          <input
            className="calibration-offset-range"
            type="range"
            min="-1000"
            max="1000"
            step="1"
            value={offset}
            onChange={(event) => changeOffset(Number(event.target.value))}
            aria-label="起拍偏移滑块"
            style={{ "--fill": `${(offset + 1000) / 20}%` } as CSSProperties}
          />
          <button className="text-button" onClick={() => changeOffset(0)}>
            <RotateCcw size={17} />
            使用自动参考位置
          </button>
        </section>
        <section
          className="calibration-match glass-panel"
          aria-label="当前片段的参考匹配度"
        >
          <div className="calibration-match-heading">
            <h2>参考匹配度</h2>
            <span>当前片段</span>
          </div>
          <div className="calibration-match-number">
            {loading ? "…" : match?.score ?? "—"}
            {match && !loading && <small>%</small>}
          </div>
          <dl>
            <div>
              <dt>加权时间误差</dt>
              <dd>{match ? `${match.errorMs.toFixed(1)} ms` : "证据不足"}</dd>
            </div>
            <div>
              <dt>节点识别参考</dt>
              <dd>{evidence === null ? "—" : `${evidence}%`}</dd>
            </div>
            <div>
              <dt>接近节拍的参考节点</dt>
              <dd>{match ? `${match.matched} / ${match.total}` : "—"}</dd>
            </div>
          </dl>
          <p>
            {match
              ? "优先参考主节奏的落位，保留切分与装饰鼓点的自然位置。"
              : "当前片段的鼓点证据不足，结合试听判断对齐位置。"}
            {" "}最终以你的试听确认结果为准。
          </p>
        </section>
      </div>
      <div className="calibration-save-actions">
        <button className="secondary-button" onClick={onCancel}>
          <ArrowLeft size={18} />
          取消调整
        </button>
        <button
          className="primary-button"
          disabled={loading || !data}
          onClick={() => onConfirm(commitOffset())}
        >
          <Check size={19} />
          确认此对齐
        </button>
      </div>
    </div>
  );
}
