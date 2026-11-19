import test from "node:test";
import assert from "node:assert/strict";
import { validateAppearance, DEFAULT_APPEARANCE, wallpaperFileError, WALLPAPER_MAX_BYTES } from "../src/appearanceSettings.ts";

test("older appearance settings acquire a font without losing selected themes", () => {
  assert.deepEqual(validateAppearance({ scene: "rain", colorMode: "light", motion: false, textSize: "large" }), {
    scene: "rain", colorMode: "light", motion: false, textSize: "large", font: "sans",
  });
});

test("saved preferences never retain expired object URLs or arbitrary font injection", () => {
  assert.deepEqual(validateAppearance({ font: "url(https://example.test)", wallpaperUrl: "blob:old", wallpaperName: "file.png" }), DEFAULT_APPEARANCE);
  assert.equal(validateAppearance({ font: "serif", scene: "custom" }).font, "serif");
  assert.equal(validateAppearance({ font: "serif", scene: "custom" }).scene, "custom");
});

test("wallpaper admission rejects unsupported, empty and oversized files", () => {
  assert.match(wallpaperFileError({ type: "image/svg+xml", size: 100 }), /JPG/);
  assert.match(wallpaperFileError({ type: "image/png", size: 0 }), /空文件/);
  assert.match(wallpaperFileError({ type: "image/png", size: WALLPAPER_MAX_BYTES + 1 }), /12 MB/);
  assert.equal(wallpaperFileError({ type: "image/webp", size: WALLPAPER_MAX_BYTES }), null);
});
