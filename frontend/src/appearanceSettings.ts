export type FontChoice = "sans" | "serif" | "rounded" | "mono";

export interface AppearanceSettings {
  colorMode: "dark" | "light";
  scene: "forest" | "aurora" | "rain" | "plain" | "custom";
  motion: boolean;
  textSize: "comfortable" | "large";
  font: FontChoice;
  // Object URLs only live in memory. Image bytes are saved separately in IndexedDB.
  wallpaperUrl?: string;
  wallpaperName?: string;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorMode: "dark", scene: "forest", motion: true,
  textSize: "comfortable", font: "sans",
};

export function validateAppearance(value: unknown): AppearanceSettings {
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    colorMode: stored.colorMode === "light" ? "light" : "dark",
    scene: typeof stored.scene === "string" && ["aurora", "rain", "plain", "custom"].includes(stored.scene)
      ? stored.scene as AppearanceSettings["scene"] : "forest",
    motion: typeof stored.motion === "boolean" ? stored.motion : true,
    textSize: stored.textSize === "large" ? "large" : "comfortable",
    font: typeof stored.font === "string" && ["serif", "rounded", "mono"].includes(stored.font)
      ? stored.font as FontChoice : "sans",
  };
}

export const WALLPAPER_MAX_BYTES = 12 * 1024 * 1024;
export const WALLPAPER_ACCEPT = "image/jpeg,image/png,image/webp,image/avif";

export function wallpaperFileError(file: Pick<File, "size" | "type">): string | null {
  if (!WALLPAPER_ACCEPT.split(",").includes(file.type)) return "请选择 JPG、PNG、WebP 或 AVIF 图片。";
  if (file.size === 0) return "这张图片是空文件，请重新选择。";
  if (file.size > WALLPAPER_MAX_BYTES) return "图片超过 12 MB，请选择较小的图片。";
  return null;
}
