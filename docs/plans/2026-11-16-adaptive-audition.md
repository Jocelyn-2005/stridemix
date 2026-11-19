# Adaptive music and immersive audition

**Goal:** Keep variable-tempo music aligned throughout a running mix, explain current processing, and provide a personalized walking audition scene.

**Architecture:** Render adaptive music into internal arrangement caches from the original source. Keep one audio clock and the independent one-step metronome. Extend appearance settings with a locally stored wallpaper and font selection. The audition overlay consumes the existing player state and never creates a second audio engine.

**Tech stack:** FastAPI, NumPy, FFmpeg, React, TypeScript, SVG, IndexedDB.

## Implementation

1. Analyze the full song in bounded windows, retain the chosen musical tempo relationship, and build a monotonic local timing map from reliable beat evidence. Use pitch-preserving tempo changes with small phase corrections. Preserve weak sections conservatively.
2. Persist source/output segment times, speed multiplier, signed local timing correction, confidence and measured residual error. Keep original-only library behavior and original-source rerendering.
3. Show live multiplier and correction from actual playback position, plus a segment overview and measured alignment reference. Never label a planned alignment as measured accuracy.
4. Store uploaded raster wallpaper in IndexedDB, validate/decode files, provide replace/remove and honest persistence errors. Add local font choices with dark/light/mobile styles.
5. Open an immersive walking scene from bottom play. Center the character, derive footfalls and moving ground from the existing audio clock, handle pause/seek/gaps and reduced motion, and preserve accessible player controls and a return action.
6. Verify variable-tempo synthetic audio, late-song alignment, pitch and transitions; run backend/frontend suites and build. Exercise wallpaper persistence, font choices, playback scene, seek/pause/return, narrow layouts and both themes in an isolated browser.
7. Update user documentation, deploy the build to the local app, and publish verified source changes to the existing GitHub repository.

## User-visible semantics

- The metronome always clicks once per step. Music uses the suitable half/original/double tempo relation.
- The displayed multiplier is the active rendered segment's source-to-output speed.
- Timing correction is a signed local correction relative to the segment's tempo-only prediction, not a hardware playback latency estimate.
- Accuracy is estimated from the processed waveform. Insufficient rhythmic evidence remains explicitly uncertain.
- Uploaded wallpapers stay in the current browser; music and user media are never committed.
