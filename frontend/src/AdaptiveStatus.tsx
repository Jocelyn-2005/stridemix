import type { Track } from "./api";
import { processingAt, signedMilliseconds } from "./adaptive";
import { formatTime } from "./timeline";
import "./adaptive.css";

export function LiveProcessing({ track, position, cadence, gap = false, compact = false }: {
  track?: Track;
  position: number;
  cadence: number;
  gap?: boolean;
  compact?: boolean;
}) {
  const current = processingAt(track, position);
  const stale = track?.adaptation && Math.abs(track.adaptation.target_cadence - cadence) > .01;
  return <div className={`live-processing ${compact ? "compact" : ""}`} aria-label="当前音乐处理">
    <span><small>当前倍速</small><strong>{gap ? "—" : `${current.speed.toFixed(3)}×`}</strong></span>
    <span title="当前段相对仅变速方案的局部时序修正，正值延后，负值提前。已包含在音乐中。"><small>时序微调</small><strong>{gap ? "—" : signedMilliseconds(current.correctionMs)}</strong></span>
    {!compact && <span><small>鼓点残差参考</small><strong>{gap ? "间隙重置" : current.driftMs !== null ? `${Math.round(current.driftMs)} ms` : "待确认"}</strong></span>}
    {!compact && <p>{gap ? "下一首开始时重置步伐。" : stale ? "步频已改变，请重新适配当前歌曲。" : !track?.adaptation ? "原曲播放 · 可在单曲调试中制作分段适配版。" : current.confidence !== null && current.confidence < .35 ? "这段鼓点证据较弱，建议结合试听判断。" : track.adaptation.mode === "adaptive" ? "按音乐段落调整，保留旋律音高与节奏层次。" : "当前使用固定倍速。"}</p>}
  </div>;
}

export function AdaptationOverview({ track, position, onSeek }: {
  track: Track;
  position?: number;
  onSeek?: (position: number) => void;
}) {
  const adaptation = track.adaptation;
  const segments = adaptation?.segments ?? [];
  if (!adaptation || !segments.length) return null;
  const current = position === undefined ? null : processingAt(track, position).segment;
  const speeds = segments.map((segment) => segment.speed);
  return <section className="adaptation-overview" aria-label="整曲分段适配记录">
    <div className="adaptation-overview-heading"><strong>整曲分段适配</strong><span>{segments.length} 段 · {Math.min(...speeds).toFixed(2)}–{Math.max(...speeds).toFixed(2)}×</span></div>
    <div className="adaptation-map" aria-label="点击段落跳转试听">
      {segments.map((segment, index) => <button key={index}
        type="button" disabled={!onSeek} onClick={() => onSeek?.(segment.output_start)}
        className={`${segment === current ? "current" : ""} ${segment.confidence < .35 ? "uncertain" : ""}`}
        style={{ flexGrow: Math.max(.001, segment.output_end - segment.output_start) }}
        aria-label={`第 ${index + 1} 段，${formatTime(segment.output_start)}，${segment.speed.toFixed(3)} 倍速`}
        aria-current={segment === current ? "true" : undefined}
        title={`${formatTime(segment.output_start)}–${formatTime(segment.output_end)} · ${segment.speed.toFixed(3)}× · ${signedMilliseconds(segment.correction_ms)}${segment.drift_ms === null ? " · 鼓点证据不足" : ` · 残差 ${Math.round(segment.drift_ms)} ms`}`}
      ><i style={{ height: `${Math.min(90, Math.max(15, 45 + Math.log2(segment.speed / adaptation.speed) * 90))}%` }} /></button>)}
    </div>
    <div className="adaptation-axis"><span>00:00</span><span>{formatTime(track.duration)}</span></div>
    <p>点击段落试听。倍速相对原曲；时序微调已写入音乐，正值延后、负值提前。浅色斜纹表示鼓点证据较弱。</p>
    <div className="adaptation-measurements">
      <span>可核对时长 <strong>{Math.round((adaptation.coverage ?? 0) * 100)}%</strong></span>
      <span>处理后残差参考 <strong>{adaptation.drift_ms == null ? "证据不足" : `${Math.round(adaptation.drift_ms)} ms`}</strong></span>
    </div>
    <p>误差来自处理后的音频鼓点检测，越小越接近节拍网格。切分节奏、弱鼓点可能影响估计，最终以试听为准。</p>
    <details><summary>查看每段的倍速与微调</summary><div className="adaptation-table-wrap"><table>
      <thead><tr><th>播放区间</th><th>倍速</th><th>时序微调</th><th>残差参考</th></tr></thead>
      <tbody>{segments.map((segment, index) => <tr key={index} className={segment === current ? "current" : ""}>
        <td><button type="button" disabled={!onSeek} onClick={() => onSeek?.(segment.output_start)}>{formatTime(segment.output_start)}–{formatTime(segment.output_end)}</button></td>
        <td>{segment.speed.toFixed(3)}×</td><td>{signedMilliseconds(segment.correction_ms)}</td><td>{segment.drift_ms == null ? "待确认" : `${Math.round(segment.drift_ms)} ms`}</td>
      </tr>)}</tbody>
    </table></div></details>
  </section>;
}
