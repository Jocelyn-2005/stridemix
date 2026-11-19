import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ImagePlus, LoaderCircle, Moon, Sun, Trash2 } from "lucide-react";
import { DEFAULT_APPEARANCE, validateAppearance, WALLPAPER_ACCEPT, wallpaperFileError } from "./appearanceSettings";
import type { AppearanceSettings, FontChoice } from "./appearanceSettings";
import { deleteWallpaper, loadWallpaper, saveWallpaper } from "./wallpaperStore";
import "./appearance.css";

export type { AppearanceSettings } from "./appearanceSettings";

export type Appearance = AppearanceSettings;

const STORAGE_KEY = "stridemix.appearance.v1";

function readAppearance(): AppearanceSettings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? validateAppearance(JSON.parse(stored)) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<AppearanceSettings>(readAppearance);
  const [wallpaperBusy, setWallpaperBusy] = useState(true);
  const [wallpaperError, setWallpaperError] = useState("");
  const pending = useRef(true);

  useEffect(() => {
    let active = true;
    void loadWallpaper().then((saved) => {
      if (!active) return;
      if (saved) setAppearance(current => ({ ...current, wallpaperUrl: URL.createObjectURL(saved.image), wallpaperName: saved.name }));
      else setAppearance(current => current.scene === "custom" ? { ...current, scene: "forest" } : current);
    }).catch(() => {
      if (active) setWallpaperError("暂时无法读取已保存的壁纸，请检查浏览器存储权限后重试。");
    }).finally(() => {
      if (active) { pending.current = false; setWallpaperBusy(false); }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const url = appearance.wallpaperUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [appearance.wallpaperUrl]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validateAppearance(appearance)));
    } catch {
      // The current session remains usable when browser storage is unavailable.
    }
  }, [appearance]);

  const updateAppearance = useCallback((changes: Partial<AppearanceSettings>) => {
    setAppearance((current) => ({ ...current, ...validateAppearance({ ...current, ...changes }) }));
  }, []);

  const uploadWallpaper = useCallback(async (file: File) => {
    if (pending.current) return;
    const invalid = wallpaperFileError(file);
    if (invalid) { setWallpaperError(invalid); return; }
    pending.current = true;
    setWallpaperBusy(true);
    setWallpaperError("");
    let url: string | undefined;
    try {
      url = URL.createObjectURL(file);
      const image = new Image();
      image.src = url;
      try { await image.decode(); }
      catch { throw new Error("无法打开这张图片，请检查文件或换一张图片。"); }
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 30_000_000) {
        throw new Error("图片尺寸过大，请选择 3000 万像素以内的壁纸。");
      }
      try { await saveWallpaper(file, file.name); }
      catch { throw new Error("壁纸未能保存，浏览器存储可能已满或被禁用。请释放空间后重试。"); }
      const savedUrl = url;
      setAppearance(current => ({ ...current, scene: "custom", wallpaperUrl: savedUrl, wallpaperName: file.name }));
      url = undefined;
    } catch (error) {
      setWallpaperError(error instanceof Error ? error.message : "壁纸上传失败，请重试。");
    } finally {
      if (url) URL.revokeObjectURL(url);
      pending.current = false;
      setWallpaperBusy(false);
    }
  }, []);

  const removeWallpaper = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setWallpaperBusy(true);
    setWallpaperError("");
    try {
      await deleteWallpaper();
      setAppearance(current => ({ ...current, scene: current.scene === "custom" ? "forest" : current.scene, wallpaperUrl: undefined, wallpaperName: undefined }));
    } catch {
      setWallpaperError("壁纸未能移除，请检查浏览器存储权限后重试。");
    } finally { pending.current = false; setWallpaperBusy(false); }
  }, []);

  return { appearance, updateAppearance, uploadWallpaper, removeWallpaper, wallpaperBusy, wallpaperError };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function Wallpaper({ settings }: { settings: AppearanceSettings }) {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const moving = settings.motion && !reducedMotion && visible;
  return (
    <div
      className={`wallpaper ${moving ? "motion-enabled" : "motion-paused"}`}
      data-scene={settings.scene === "custom" && !settings.wallpaperUrl ? "forest" : settings.scene}
      aria-hidden="true"
    >
      <div className="wallpaper-image" style={settings.scene === "custom" && settings.wallpaperUrl ? { backgroundImage: `url("${settings.wallpaperUrl}")` } : undefined} />
      {settings.scene === "forest" && <div className="wallpaper-mist" />}
      {settings.scene === "aurora" && (
        <div className="wallpaper-aurora">
          <i /><i /><i />
        </div>
      )}
      {settings.scene === "rain" && <div className="wallpaper-rain" />}
      <div className="wallpaper-shade" />
    </div>
  );
}

const SCENES: { value: AppearanceSettings["scene"]; name: string; description: string }[] = [
  { value: "forest", name: "晨雾山林", description: "远山与薄雾缓缓移动" },
  { value: "aurora", name: "极光", description: "青绿光带流动于夜空" },
  { value: "rain", name: "雨夜城市", description: "城市灯光与轻落的雨线" },
  { value: "plain", name: "纯色", description: "简洁、安静的工作空间" },
];

const FONTS: { value: FontChoice; name: string; sample: string }[] = [
  { value: "sans", name: "清晰黑体", sample: "把每一步，交给节奏" },
  { value: "serif", name: "书卷宋体", sample: "把每一步，交给节奏" },
  { value: "rounded", name: "轻松圆体", sample: "把每一步，交给节奏" },
  { value: "mono", name: "等宽节奏", sample: "STEP 01 · 跟随节奏" },
];

export function AppearancePage({
  settings,
  onChange,
  onUploadWallpaper,
  onRemoveWallpaper,
  wallpaperBusy = false,
  wallpaperError = "",
}: {
  settings: AppearanceSettings;
  onChange: (changes: Partial<AppearanceSettings>) => void;
  onUploadWallpaper?: (file: File) => Promise<void>;
  onRemoveWallpaper?: () => Promise<void>;
  wallpaperBusy?: boolean;
  wallpaperError?: string;
}) {
  const reducedMotion = useReducedMotion();
  const uploadInput = useRef<HTMLInputElement>(null);

  return (
    <div className="appearance-page">
      <section className="appearance-controls glass-panel">
        <fieldset className="appearance-fieldset">
          <legend>界面颜色</legend>
          <div className="mode-options">
            {([
              { value: "dark", name: "深色", Icon: Moon },
              { value: "light", name: "浅色", Icon: Sun },
            ] as const).map(({ value, name, Icon }) => (
              <label className={`mode-option ${settings.colorMode === value ? "selected" : ""}`} key={value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="appearance-color"
                  value={value}
                  checked={settings.colorMode === value}
                  onChange={() => onChange({ colorMode: value })}
                />
                <Icon size={22} aria-hidden="true" />
                <span>{name}</span>
                <span className="selection-mark" aria-hidden="true">
                  {settings.colorMode === value && <Check size={15} />}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="appearance-fieldset">
          <legend>字号</legend>
          <div className="text-size-options">
            {([
              { value: "comfortable", name: "舒适", size: "17 px" },
              { value: "large", name: "大号", size: "19 px" },
            ] as const).map(({ value, name, size }) => (
              <label className={`text-size-option ${settings.textSize === value ? "selected" : ""}`} key={value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="appearance-text-size"
                  value={value}
                  checked={settings.textSize === value}
                  onChange={() => onChange({ textSize: value })}
                />
                <span>{name}</span>
                <small>{size}</small>
                <span className="selection-mark" aria-hidden="true">
                  {settings.textSize === value && <Check size={15} />}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="appearance-fonts glass-panel">
        <fieldset className="appearance-fieldset">
          <legend>界面字体</legend>
          <div className="font-options">
            {FONTS.map(({ value, name, sample }) => (
              <label className={`font-option ${settings.font === value ? "selected" : ""}`} key={value} data-font-preview={value}>
                <input className="sr-only" type="radio" name="appearance-font" value={value} checked={settings.font === value} onChange={() => onChange({ font: value })} />
                <span className="font-option-heading"><strong>{name}</strong><span className="selection-mark" aria-hidden="true">{settings.font === value && <Check size={15} />}</span></span>
                <span className="font-sample">{sample}</span>
                <span className="font-sample-numbers">165 · 01:24</span>
              </label>
            ))}
          </div>
          <p className="appearance-hint">优先使用设备上的对应字体；缺少时会使用同类字体。选择立即应用，也会保留到下次打开。</p>
        </fieldset>
      </section>

      <section className="appearance-scenes glass-panel">
        <fieldset className="appearance-fieldset">
          <legend>工作室背景</legend>
          <div className="scene-options">
            {SCENES.map(({ value, name, description }) => (
              <label className={`scene-option ${settings.scene === value ? "selected" : ""}`} key={value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="appearance-scene"
                  value={value}
                  checked={settings.scene === value}
                  onChange={() => onChange({ scene: value })}
                />
                <span className="scene-preview" data-scene={value} aria-hidden="true">
                  <span className="scene-preview-light" />
                  <span className="scene-selected"><Check size={18} /></span>
                </span>
                <span className="scene-copy"><strong>{name}</strong><small>{description}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="custom-wallpaper-setting">
          <div className="custom-wallpaper-heading">
            <div><h3>我的壁纸</h3><p>在工作室与试听场景中使用自己的风景。</p></div>
            <input ref={uploadInput} className="sr-only" type="file" accept={WALLPAPER_ACCEPT} aria-label="上传自定义壁纸" disabled={wallpaperBusy || !onUploadWallpaper} onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file && onUploadWallpaper) void onUploadWallpaper(file);
            }} />
            <button className="wallpaper-upload-button" disabled={wallpaperBusy || !onUploadWallpaper} onClick={() => uploadInput.current?.click()}>
              {wallpaperBusy ? <LoaderCircle size={19} className="spin" /> : <ImagePlus size={19} />}
              {wallpaperBusy ? "正在处理…" : settings.wallpaperUrl ? "更换壁纸" : "上传壁纸"}
            </button>
          </div>
          {settings.wallpaperUrl && (
            <div className="custom-wallpaper-card">
              <label className={`scene-option custom-scene-option ${settings.scene === "custom" ? "selected" : ""}`}>
                <input className="sr-only" type="radio" name="appearance-scene" value="custom" checked={settings.scene === "custom"} onChange={() => onChange({ scene: "custom" })} />
                <span className="scene-preview" data-scene="custom" style={{ backgroundImage: `url("${settings.wallpaperUrl}")` }} aria-hidden="true"><span className="scene-selected"><Check size={18} /></span></span>
                <span className="scene-copy"><strong>自定义壁纸</strong><small>{settings.scene === "custom" ? "正在使用" : "点击使用"}</small></span>
              </label>
              <div className="custom-wallpaper-details">
                <strong title={settings.wallpaperName}>{settings.wallpaperName}</strong>
                <p>背景会自动淡化，保持文字清晰。图片仅保存在当前浏览器中。</p>
                <button className="wallpaper-remove-button" disabled={wallpaperBusy || !onRemoveWallpaper} onClick={() => void onRemoveWallpaper?.()}><Trash2 size={17} />移除壁纸</button>
              </div>
            </div>
          )}
          <p className="appearance-hint">支持 JPG、PNG、WebP、AVIF，最大 12 MB。清除浏览器数据后需要重新上传。</p>
          {wallpaperError && <p className="wallpaper-error" role="alert">{wallpaperError}</p>}
        </div>
        <div className="motion-setting">
          <div>
            <label htmlFor="appearance-motion">背景动态</label>
            <p>
              {reducedMotion
                ? "系统已开启减少动态效果，背景保持静止。"
                : "开启后显示场景动态，页面隐藏时自动暂停。"}
            </p>
          </div>
          <label className="appearance-toggle" htmlFor="appearance-motion">
            <input
              id="appearance-motion"
              type="checkbox"
              checked={settings.motion}
              onChange={(event) => onChange({ motion: event.target.checked })}
            />
            <span className="toggle-track" aria-hidden="true"><i /></span>
            <span>{settings.motion ? "已开启" : "已关闭"}</span>
          </label>
        </div>
      </section>
    </div>
  );
}
