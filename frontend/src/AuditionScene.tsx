import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Footprints, MoveRight, Sparkles } from "lucide-react";
import type { PlaybackState } from "./audio";
import { auditionFrame, kneePoint } from "./audition";
import "./audition.css";

export interface AuditionSceneProps {
  open: boolean;
  playback: PlaybackState;
  cadence: number;
  trackTitle: string;
  localPosition: number;
  anchorSeconds?: number | null;
  phaseOffsetMs?: number;
  hasTracks: boolean;
  background?: ReactNode;
  metrics?: ReactNode;
  motion?: boolean;
  onClose: () => void;
}

function Walker({ frame }: { frame: ReturnType<typeof auditionFrame> }) {
  const id = useId().replace(/:/g, "");
  const hipY = 206 - frame.bodyLift;
  function leg(which: "left" | "right", back = false) {
    const foot = frame[which];
    const x = 120 + foot.x;
    const y = 341 - foot.lift;
    const knee = kneePoint(120, hipY, x, y);
    return (
      <g className={back ? "walker-leg-back" : "walker-leg-front"}>
        <path d={`M 120 ${hipY} L ${knee.x} ${knee.y} L ${x} ${y - 5}`} fill="none" stroke={back ? "#243e50" : "#36566b"} strokeWidth="23" strokeLinecap="round" strokeLinejoin="round" />
        <path d={`M ${knee.x - 4} ${knee.y} L ${x - 4} ${y - 11}`} fill="none" stroke={back ? "#3b5666" : "#557283"} strokeWidth="3" strokeLinecap="round" />
        <g transform={`translate(${x}, ${y})`}>
          <path d="M-10-9 Q-2-13 7-7 L13-1 Q27 0 29 6 Q25 11 13 10 L-12 10 Q-17 7-12-1Z" fill={back ? "#b2c7c9" : "#e2eeeb"} />
          <path d="M-13 7 Q5 11 28 5" stroke={back ? "#63938e" : "#72ceba"} strokeWidth="5" fill="none" strokeLinecap="round" />
          <path d="M2-4 9-1M0 0 7 3" stroke="#50717a" strokeWidth="2" />
        </g>
      </g>
    );
  }
  return (
    <svg className="audition-walker" viewBox="0 0 260 360" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-jacket`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#a5e8c9" /><stop offset="1" stopColor="#4aa58f" />
        </linearGradient>
        <linearGradient id={`${id}-skin`}><stop stopColor="#b97a56" /><stop offset="1" stopColor="#e6ae83" /></linearGradient>
      </defs>
      <ellipse cx="129" cy="353" rx={55 - frame.bodyLift} ry="6" fill="#0a202b" opacity=".19" />
      <ellipse cx={120 + frame[frame.landingFoot].x} cy="353" rx={18 + 15 * (1 - frame.pulse)} ry="4" fill="none" stroke="#9bf3d4" opacity={frame.pulse * 0.75} strokeWidth="2" />
      {leg("left", true)}
      <g transform={`translate(0, ${-frame.bodyLift})`}>
        <g transform={`rotate(${-frame.armSwing}, 124, 131)`}>
          <path d="M122 133 Q113 159 104 177 L127 197" fill="none" stroke="#387f72" strokeWidth="19" strokeLinecap="round" />
          <path d="M125 196 134 203" stroke="#bc815f" strokeWidth="13" strokeLinecap="round" />
        </g>
        <path d="M108 193 141 191 144 214 Q126 222 104 213Z" fill="#294858" />
        <path d="M119 106 Q133 104 145 119 L151 162 145 204 Q127 213 103 204 L108 164 106 130 Q106 114 119 106Z" fill={`url(#${id}-jacket)`} />
        <path d="M141 121 143 196" fill="none" stroke="#c8f4dd" strokeWidth="2" opacity=".6" />
        <path d="M112 184 131 180 136 197 111 201" fill="none" stroke="#438f7d" strokeWidth="2" />
        <path d="M113 123 Q118 119 126 122" stroke="#c3f4dc" strokeWidth="4" strokeLinecap="round" />
        <path d="M126 91 126 112 Q136 119 143 110 L142 87" fill={`url(#${id}-skin)`} />
        <path d="M122 55 Q148 49 153 70 L154 83 161 90 153 94 Q154 108 140 108 L126 101 Q118 91 117 75Z" fill={`url(#${id}-skin)`} />
        <path d="M117 85 Q108 77 114 60 Q113 44 133 42 Q154 42 156 58 L150 68 Q139 63 127 70 L125 90Z" fill="#27373c" />
        <path d="M114 62 Q124 49 146 51" fill="none" stroke="#425456" strokeWidth="5" strokeLinecap="round" />
        <ellipse cx="126" cy="83" rx="6" ry="9" fill="#c98e67" />
        <path d="M127 78 Q121 80 125 86" fill="none" stroke="#a6684e" strokeWidth="2" strokeLinecap="round" />
        <path d="M149 80 152 80" stroke="#3b3d37" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M148 99 152 98" stroke="#9b5b43" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M117 75 Q113 51 135 48" fill="none" stroke="#d0e1de" strokeWidth="5" />
        <rect x="116" y="74" width="12" height="23" rx="6" fill="#19383d" />
        <rect x="117" y="78" width="7" height="14" rx="3.5" fill="#83d9bd" />
        <g transform={`rotate(${frame.armSwing}, 115, 133)`}>
          <path d="M116 134 Q114 157 108 177 L137 192" fill="none" stroke="#70c8ac" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M111 143 106 170" stroke="#a2e4ca" strokeWidth="3" strokeLinecap="round" />
          <path d="M136 191 146 196" stroke="#e1a57a" strokeWidth="13" strokeLinecap="round" />
          <path d="M132 185 128 195" stroke="#25484e" strokeWidth="5" />
          <path d="M131 187 130 192" stroke="#d1e7e0" strokeWidth="3" />
        </g>
      </g>
      {leg("right")}
    </svg>
  );
}

export default function AuditionScene({
  open, playback, cadence, trackTitle, localPosition, anchorSeconds,
  phaseOffsetMs = 0, hasTracks, background, metrics, motion = true, onClose,
}: AuditionSceneProps) {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [motionOverride, setMotionOverride] = useState<boolean | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const inGap = hasTracks && playback.activeIndex < 0;
  const moving = motionOverride ?? (motion && !reduced);
  const frame = auditionFrame(localPosition, cadence, anchorSeconds, phaseOffsetMs, !inGap && moving);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      // Parent removes inert from the studio in the same React update.
      requestAnimationFrame(() => previous?.isConnected && previous.focus({ preventScroll: true }));
    };
  }, [open]);

  return (
    <section
      className={`audition-scene ${open ? "is-open" : ""}`}
      aria-label="沉浸试听"
      aria-hidden={!open}
      inert={!open}
      data-position={localPosition.toFixed(3)}
      data-step={frame.beats.toFixed(3)}
      data-motion={moving ? "on" : "off"}
      data-playing={playback.playing}
      data-gap={inGap}
    >
      <div className="audition-wallpaper" aria-hidden="true">{background}</div>
      <div className="audition-atmosphere" aria-hidden="true" />
      <header className="audition-header">
        <button ref={closeButton} className="audition-back" onClick={onClose}>
          <ArrowLeft size={20} aria-hidden="true" /><span>返回工作室</span>
        </button>
        <span className="audition-label"><i />沉浸试听</span>
        <button
          className="audition-motion"
          onClick={() => setMotionOverride(!moving)}
          aria-pressed={moving}
          title={moving ? "关闭人物和地面动态" : "开启人物和地面动态"}
        ><Sparkles size={18} aria-hidden="true" /><span>{moving ? "动态已开" : "静态场景"}</span></button>
      </header>

      <div className="audition-title">
        <p>{inGap ? "留一点空隙，准备下一首" : playback.playing ? "跟着节奏，向前走" : "在这里，找到你的步调"}</p>
        <h2 title={trackTitle}>{trackTitle || "步频节拍"}</h2>
      </div>

      <div className="audition-world" aria-hidden="true">
        <div className="audition-horizon" />
        <div className="audition-ground">
          <svg viewBox="0 0 1600 400" preserveAspectRatio="none">
            <path d="M0 0H1600V400H0Z" className="audition-ground-fill" />
            {[20, 95, 220, 390].map(y => <path key={y} d={`M0 ${y}H1600`} className="audition-ground-line" />)}
            <g transform={`translate(${-frame.groundOffset * 2}, 0)`}>
              {Array.from({ length: 15 }, (_, index) => <path key={index} d={`M${index * 136 - 150} 0 L${index * 272 - 700} 400`} className="audition-ground-grid" />)}
            </g>
            <path d="M0 44H1600" className="audition-road-mark" strokeDasharray="64 72" strokeDashoffset={frame.groundOffset} />
          </svg>
        </div>
        <div className="audition-person"><Walker frame={frame} /></div>
        <div className="audition-footnote"><Footprints size={16} />一拍一步<MoveRight size={16} /></div>
      </div>

      <footer className="audition-details">
        <div className="audition-cadence"><span>目标步频</span><strong>{cadence}<small>步 / 分钟</small></strong></div>
        {metrics && <div className="audition-metrics">{metrics}</div>}
        <p className="audition-status"><span className={playback.playing && !inGap ? "active" : ""} />{inGap ? "曲间间隙 · 脚步休息" : playback.playing ? "正在播放 · 脚步跟随节拍器" : "已暂停 · 随时继续"}</p>
      </footer>
    </section>
  );
}
