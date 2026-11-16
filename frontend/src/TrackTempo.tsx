import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Check,
  Gauge,
  LoaderCircle,
  Pencil,
  RotateCcw,
  WandSparkles,
  X,
} from "lucide-react";
import { analyzeTrack, request } from "./api";
import type { Track } from "./api";
import {
  cadenceReferences,
  chooseCadenceReference,
  formatTempo,
} from "./tempo";
import { formatTime } from "./timeline";

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
    "analyzing" | "saving" | "adapting" | "restoring" | null
  >(null);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [selectedMultiplier, setSelectedMultiplier] = useState<number | null>(
    null,
  );
  const tempo = track.tempo;
  const status = tempo?.status ?? "pending";
  const alignmentStatus = track.alignment?.status ?? "pending";
  const bpm = tempo?.bpm ?? null;
  const references = cadenceReferences(bpm);
  const reference =
    references.find(
      (candidate) => candidate.multiplier === selectedMultiplier,
    ) ?? chooseCadenceReference(bpm, cadence);
  const speed = reference ? cadence / reference.cadence : null;
  const busy = operation !== null;

  useEffect(() => {
    setSelectedMultiplier(null);
    setManualOpen(false);
    setError("");
  }, [track.id, bpm]);

  useEffect(() => {
    if (status !== "pending" && alignmentStatus !== "pending") return;
    let active = true;
    setOperation("analyzing");
    analyzeTrack(track.id)
      .then((updated) => {
        if (!active) return;
        setOperation(null);
        onTrackUpdate(updated);
      })
      .catch((reason) => {
        if (!active) return;
        setOperation(null);
        setError(
          reason instanceof Error ? reason.message : "节奏分析失败，请重试。",
        );
      });
    return () => {
      active = false;
    };
  }, [track.id, status, alignmentStatus, onTrackUpdate]);

  async function retryAnalysis() {
    setError("");
    setOperation("analyzing");
    try {
      const updated = await analyzeTrack(track.id);
      setOperation(null);
      onTrackUpdate(updated);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "节奏分析失败，请重试。",
      );
      setOperation(null);
    }
  }

  async function saveTempo(event: FormEvent) {
    event.preventDefault();
    const value = Number(draft);
    if (!draft.trim() || !Number.isFinite(value) || value < 30 || value > 480) {
      setError("请输入 30–480 之间的 BPM。");
      return;
    }
    setError("");
    setOperation("saving");
    try {
      const updated = await request<Track>(
        `/api/tracks/${encodeURIComponent(track.id)}/tempo`,
        {
          method: "PATCH",
          body: JSON.stringify({ bpm: value }),
        },
      );
      onTrackUpdate(updated);
      setManualOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "保存 BPM 失败，请重试。",
      );
    } finally {
      setOperation(null);
    }
  }

  async function adapt() {
    if (!reference || busy) return;
    setError("");
    setOperation("adapting");
    try {
      const updated = await request<Track>(
        `/api/tracks/${encodeURIComponent(track.id)}/adapt`,
        {
          method: "POST",
          body: JSON.stringify({
            cadence,
            reference_cadence: reference.cadence,
          }),
        },
      );
      onReplace(updated);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "生成变速版失败，请重试。",
      );
    } finally {
      setOperation(null);
    }
  }

  async function restore() {
    if (!track.adaptation || busy) return;
    setError("");
    setOperation("restoring");
    try {
      const original = await request<Track>(
        `/api/tracks/${encodeURIComponent(track.adaptation.original_id)}`,
      );
      onReplace(original);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "恢复原版失败，请重试。",
      );
    } finally {
      setOperation(null);
    }
  }

  const bpmLabel =
    tempo?.source === "manual"
      ? "手动 BPM"
      : tempo?.source === "adapted"
        ? "变速 BPM"
        : "估算 BPM";
  const lowConfidence =
    status === "uncertain" ||
    (tempo?.source === "analysis" && tempo.confidence < 0.45);

  return (
    <div className="track-tempo">
      <div className="tempo-heading">
        <span className="tempo-value">
          <Gauge size={13} />
          {bpm === null ? (
            "BPM 待填写"
          ) : (
            <>
              {bpmLabel}
              <strong>{formatTempo(bpm)}</strong>
            </>
          )}
        </span>
        <button
          className="tempo-edit"
          type="button"
          disabled={busy}
          onClick={() => {
            setDraft(bpm === null ? "" : String(bpm));
            setManualOpen(!manualOpen);
          }}
          aria-label={`校正${track.title}的BPM`}
        >
          <Pencil size={11} />
          {bpm === null ? "填写 BPM" : "手动校正"}
        </button>
      </div>
      {operation === "analyzing" ? (
        <p className="tempo-status" role="status">
          <LoaderCircle size={12} className="spin" />
          正在分析曲目节奏…
        </p>
      ) : status === "pending" ? (
        <button
          className="tempo-retry"
          onClick={() => void retryAnalysis()}
          disabled={busy}
        >
          重新分析节奏
        </button>
      ) : bpm === null ? (
        <p className="tempo-status">无法可靠判断节奏，可手动填写 BPM。</p>
      ) : (
        <p className={`tempo-confidence ${lowConfidence ? "uncertain" : ""}`}>
          {tempo?.source === "manual" ? (
            "已手动校正"
          ) : (
            <>
              参考分数 {Math.round((tempo?.confidence ?? 0) * 100)}%
              {lowConfidence ? " · 弱节奏，仅供参考" : " · 可按听感校正"}
            </>
          )}
        </p>
      )}

      {manualOpen && (
        <form
          className="manual-tempo-form"
          onSubmit={(event) => void saveTempo(event)}
        >
          <label htmlFor={`bpm-${entryId}`}>BPM</label>
          <input
            id={`bpm-${entryId}`}
            type="number"
            min="30"
            max="480"
            step="any"
            required
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="30–480"
            disabled={busy}
          />
          <button
            className="tempo-save"
            type="submit"
            disabled={busy}
            aria-label={`保存${track.title}的BPM`}
          >
            {operation === "saving" ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Check size={13} />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={busy}
            onClick={() => setManualOpen(false)}
            aria-label="取消 BPM 校正"
          >
            <X size={13} />
          </button>
        </form>
      )}

      {references.length > 0 && (
        <>
          <div className="reference-heading">
            步频参考<span>步 / 分钟</span>
          </div>
          <div
            className="cadence-references"
            role="radiogroup"
            aria-label={`${track.title}的步频参考`}
          >
            {references.map((candidate) => (
              <label
                className={
                  candidate.multiplier === reference?.multiplier
                    ? "selected"
                    : ""
                }
                key={candidate.multiplier}
                title={candidate.description}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name={`reference-${entryId}`}
                  aria-label={`${candidate.label} ${formatTempo(candidate.cadence)} 步/分`}
                  checked={candidate.multiplier === reference?.multiplier}
                  onChange={() => setSelectedMultiplier(candidate.multiplier)}
                  disabled={busy}
                />
                <span>{candidate.label}</span>
                <strong>{formatTempo(candidate.cadence)}</strong>
              </label>
            ))}
          </div>
          <div className="adapt-controls">
            <span>
              {reference?.description}
              <small>目标 {cadence} 步/分 · 保持音高</small>
            </span>
            <button
              className="adapt-button"
              onClick={() => void adapt()}
              disabled={busy}
              aria-label={`制作${track.title}的适配版`}
            >
              {operation === "adapting" ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <WandSparkles size={13} />
              )}
              <span>
                {operation === "adapting" ? "制作中…" : "制作适配版"}
                <small>{speed?.toFixed(2)}×</small>
              </span>
            </button>
          </div>
        </>
      )}

      {track.adaptation && (
        <div className="adaptation-result">
          <span>
            变速版 · 总倍率 {track.adaptation.speed.toFixed(2)}× ·{" "}
            {formatTime(track.duration)}
          </span>
          <button
            onClick={() => void restore()}
            disabled={busy}
            aria-label={`恢复${track.title}的原版`}
          >
            {operation === "restoring" ? (
              <LoaderCircle size={11} className="spin" />
            ) : (
              <RotateCcw size={11} />
            )}
            恢复原版
          </button>
        </div>
      )}
      {error && (
        <p className="tempo-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
