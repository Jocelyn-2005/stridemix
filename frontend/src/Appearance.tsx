import { useCallback, useEffect, useState } from "react";
import { Check, Moon, Sun } from "lucide-react";

export interface AppearanceSettings {
  colorMode: "dark" | "light";
  scene: "forest" | "aurora" | "rain" | "plain";
  motion: boolean;
  textSize: "comfortable" | "large";
}

export type Appearance = AppearanceSettings;

const STORAGE_KEY = "stridemix.appearance.v1";
const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorMode: "dark",
  scene: "forest",
  motion: true,
  textSize: "comfortable",
};

function validateAppearance(value: unknown): AppearanceSettings {
  const stored = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    colorMode: stored.colorMode === "light" ? "light" : "dark",
    scene: stored.scene === "aurora" || stored.scene === "rain" || stored.scene === "plain"
      ? stored.scene
      : "forest",
    motion: typeof stored.motion === "boolean" ? stored.motion : true,
    textSize: stored.textSize === "large" ? "large" : "comfortable",
  };
}

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

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // The current session remains usable when browser storage is unavailable.
    }
  }, [appearance]);

  const updateAppearance = useCallback((changes: Partial<AppearanceSettings>) => {
    setAppearance((current) => validateAppearance({ ...current, ...changes }));
  }, []);

  return { appearance, updateAppearance };
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
      data-scene={settings.scene}
      aria-hidden="true"
    >
      <div className="wallpaper-image" />
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

export function AppearancePage({
  settings,
  onChange,
}: {
  settings: AppearanceSettings;
  onChange: (changes: Partial<AppearanceSettings>) => void;
}) {
  const reducedMotion = useReducedMotion();

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
