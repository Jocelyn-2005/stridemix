import { useEffect, useState } from "react";
import {
  AudioLines,
  LoaderCircle,
  RotateCcw,
  ScanLine,
  WandSparkles,
} from "lucide-react";
import { analyzeTrack, reanalyzeTrack, request } from "./api";
import type { Track } from "./api";
import { chooseCadenceReference, formatTempo } from "./tempo";
import { formatTime } from "./timeline";
import "./alignment.css";

interface TrackTempoProps {
  track: Track;
  entryId: string;
  cadence: number;
  onTrackUpdate: (track: Track) => void;
  onReplace: (track: Track) => void;
}

export default function TrackTempo({
  track,
  entryId,
  cadence,
  onTrackUpdate,
  onReplace,
}: TrackTempoProps) {
  const [operation, setOperation] = useState<
    "analyzing" | "adapting" | "restoring" | null
  >(null);
  const [error, setError] = useState("");
  const tempo = track.tempo;
  const status = tempo?.status ?? "pending";
  const alignmentStatus = track.alignment?.status ?? "pending";
  const legacyManual = tempo?.source === "manual";
  const bpm = legacyManual ? null : tempo?.bpm ?? null;
  const reference = chooseCadenceReference(bpm, cadence);
  const speed = reference ? cadence / reference.cadence : null;
  const musicalTarget = bpm !== null && speed !== null ? bpm * speed : null;
  const busy = operation !== null;

  let rhythmLabel = operation === "analyzing" ? "正在识别" : "节奏未确定";
  if (bpm !== null) {
    rhythmLabel = `${formatTempo(bpm)} BPM`;
  }

  let rhythmStatus = "当前音频的节奏证据较弱，可进入可视化校准试听。";
  if (bpm !== null) {
    if (track.alignment?.anchor_seconds == null) {
      rhythmStatus = "音乐节奏已识别，起拍证据不足，可进入可视化校准核对。";
    } else if (alignmentStatus === "detected") {
      rhythmStatus = "已从音频提取鼓点并设置起拍，节拍器始终每响一步。";
    } else {
      rhythmStatus = "已找到起拍参考，鼓点判断较弱，可进入可视化校准核对。";
    }
  }

  useEffect(() => {
    setError("");
  }, [track.id]);

  useEffect(() => {
    if (!legacyManual && status !== "pending" && alignmentStatus !== "pending") {
      return;
    }
    let active = true;
    setOperation("analyzing");
    const analysis = legacyManual
      ? reanalyzeTrack(track.id)
      : analyzeTrack(track.id);

    analysis.then((updated) => {
      if (!active) {
        return;
      }
      setOperation(null);
      onTrackUpdate(updated);
    }).catch((reason) => {
      if (!active) {
        return;
      }
      setOperation(null);
      setError(reason instanceof Error ? reason.message : "自动识别失败，请重新识别。");
    });

    return () => {
      active = false;
    };
  }, [track.id, legacyManual, status, alignmentStatus, onTrackUpdate]);

  async function reanalyze() {
    if (busy) {
      return;
    }
    setOperation("analyzing");
    setError("");
    try {
      onTrackUpdate(await reanalyzeTrack(track.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "自动识别失败，请重试。");
    } finally {
      setOperation(null);
    }
  }

  async function adapt() {
    if (!reference || busy) {
      return;
    }
    setOperation("adapting");
    setError("");
    try {
      const updated = await request<Track>(
        `/api/tracks/${encodeURIComponent(track.id)}/adapt`,
        {
          method: "POST",
          body: JSON.stringify({ cadence, reference_cadence: reference.cadence }),
        },
      );
      onReplace(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "制作适配版失败，请重试。");
    } finally {
      setOperation(null);
    }
  }

  async function restore() {
    if (!track.adaptation || busy) {
      return;
    }
    setOperation("restoring");
    setError("");
    try {
      const original = await request<Track>(
        `/api/tracks/${encodeURIComponent(track.adaptation.original_id)}`,
      );
      onReplace(original);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复原版失败，请重试。");
    } finally {
      setOperation(null);
    }
  }

  return (
    <div className="track-tempo automatic-rhythm">
      <div className="auto-rhythm-heading">
        <div>
          <span className="auto-rhythm-label">
            <AudioLines size={19} />
            自动识别音乐节奏
          </span>
          <strong className="auto-rhythm-value">{rhythmLabel}</strong>
        </div>
        <button
          className="secondary-button"
          onClick={() => void reanalyze()}
          disabled={busy}
          aria-label={`重新识别${track.title}的鼓点`}
        >
          {operation === "analyzing" ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <ScanLine size={18} />
          )}
          {operation === "analyzing" ? "识别中…" : "重新自动识别"}
        </button>
      </div>
      {operation === "analyzing" ? (
        <p className="auto-rhythm-status" role="status">
          正在从音频中提取节奏与强拍起点…
        </p>
      ) : (
        <p className="auto-rhythm-status">{rhythmStatus}</p>
      )}
      <div className="auto-rhythm-actions">
        <div>
          <strong>节拍器 {cadence} 步／分钟</strong>
          <span>
            {musicalTarget !== null && speed !== null && bpm !== null
              ? `音乐 ${formatTempo(bpm)} → ${formatTempo(musicalTarget)} BPM · ${speed.toFixed(2)}× · 保持音高`
              : "自动选择合适的音乐拍速关系，保持音高"}
          </span>
        </div>
        <button
          className="adapt-button"
          onClick={() => void adapt()}
          disabled={!reference || busy}
          aria-label={`制作${track.title}的适配版`}
        >
          {operation === "adapting" ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <WandSparkles size={18} />
          )}
          {operation === "adapting" ? "制作中…" : "适配当前步频"}
        </button>
      </div>
      {track.adaptation && (
        <div className="adaptation-result">
          <span>
            音乐 {bpm === null ? "—" : formatTempo(bpm)} BPM · 节拍器 {track.adaptation.target_cadence} 步／分钟
            {" · "}{formatTime(track.duration)}
          </span>
          <button
            onClick={() => void restore()}
            disabled={busy}
            aria-label={`恢复${track.title}的原版`}
          >
            {operation === "restoring" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <RotateCcw size={16} />
            )}
            恢复原版
          </button>
        </div>
      )}
      <a
        className="secondary-button open-alignment"
        href={`#/track/${encodeURIComponent(entryId)}/align`}
      >
        <AudioLines size={19} />
        进入可视化校准
      </a>
      {error && <p className="tempo-error" role="alert">{error}</p>}
    </div>
  );
}
