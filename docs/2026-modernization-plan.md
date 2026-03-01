# Aerial (Windows) 2026 Modernization Plan

## Why playback stutters unless "Disable all video processing" is enabled

The current renderer has two very different pipelines:

1. **Processed mode (stutters):** videos are continuously copied into a `<canvas>` and redrawn every frame (`drawVideo()` + `drawImage()`), with blend/composite operations for transitions and optional CSS-like filters. This keeps the transition effects, but adds heavy per-frame work and can push decoding + compositing out of the smooth hardware path on many systems.
2. **No-processing mode (smooth):** the app shows a raw `<video>` element (`videoQuality` mode), bypassing most canvas work and transitions.

The code currently drives the processed mode with an always-running loop via `requestAnimationFrame(drawVideo)` and a custom `setTimeout` frame scheduler option (`alternateRenderMethod`), both of which can increase jitter under modern GPU scheduling and power management.

## Current technical baseline (from repo)

- Runtime/deployment stack:
  - `electron` is pinned to `^22.2.0` (2023 era).
  - `electron-builder` is pinned to `^24.0.0`.
- Several runtime dependencies are specified as `"*"`, making builds non-reproducible and risk-prone over time.
- Update checking still uses deprecated `request`.
- Video rendering/transitions are implemented in software-style canvas compositing (multiple `globalCompositeOperation` modes and gradients) rather than GPU-native dual-video crossfade via CSS/Web Animations.

## 2026 upgrade goals

1. **Primary goal:** eliminate stutter with transitions enabled.
2. **Secondary goal:** keep visual quality while reducing CPU/GPU spikes and frame-time variance.
3. **Maintenance goal:** migrate off deprecated or floating dependencies and make releases reproducible.

## Dependency modernization plan

### Phase 1 — safe baseline upgrades

1. Upgrade Electron in supported hops (to avoid breaking jump):
   - 22 → 28 (stability checkpoint)
   - 28 → latest stable available in 2026 (target current Chromium/Node LTS alignment)
2. Upgrade `electron-builder` to current compatible major after Electron bump.
3. Replace `request` with native `fetch`/`https` wrapper.
4. Replace `"*"` dependency ranges with pinned semver ranges (`~` or exact versions).
5. Add a lockfile refresh and CI install mode (`npm ci`) for reproducible builds.

### Phase 2 — rendering path modernization (highest impact for your issue)

1. Keep two `<video>` elements always hardware accelerated and visible in a shared stacking context.
2. Replace canvas-based transition effects with GPU-friendly operations:
   - Default: opacity crossfade (cheap and smooth).
   - Optional directional wipes using CSS `clip-path` / mask where supported.
   - Keep complex effects (radial fades, dip-to-black) as optional "high quality effects" with automatic fallback.
3. Remove the perpetual canvas repaint loop for the default path.
4. Synchronize transition timing to actual media readiness:
   - use `canplay`/`canplaythrough` + `requestVideoFrameCallback` (when available),
   - avoid fixed sleeps (`500ms`, `1000ms`) before assuming decode readiness.
5. Add frame pacing controls:
   - pause all transition timers when window is hidden,
   - avoid custom RAF polyfill unless needed for a specific GPU driver bug.

### Phase 3 — media pipeline improvements

1. Prefer modern codecs where hardware decode is strongest on Windows in 2026 (HEVC/AV1 availability check + fallback to H.264).
2. Add startup capability probe and choose the best profile per machine.
3. Add optional pre-decoding warmup for next clip (muted hidden pre-roll) before transition start.
4. Ensure all cached paths and metadata updates are asynchronous and non-blocking around playback boundaries.

### Phase 4 — observability and regression prevention

1. Add a lightweight performance overlay/logging mode:
   - dropped frames,
   - transition start latency,
   - decode-to-display delay,
   - average/95th percentile frame time.
2. Add automated smoke test for transition smoothness budget (best-effort in CI).
3. Track per-GPU-vendor defaults (Intel/AMD/NVIDIA) for transition complexity.

## Concrete code hotspots to refactor first

1. `web/screensaver.js`
   - `drawVideo()` loop with full-canvas compositing every frame.
   - `fadeVideoIn`/`fadeVideoOut` timer recursion at 16ms granularity.
   - fixed delays around playback preparation (`setTimeout(..., 500)` and later waits).
2. `app.js`
   - migration away from `request` in update check.
   - modern Electron lifecycle and config hardening.
3. `package.json`
   - dependency pinning and Electron/Builder modernization.

## Recommended execution order (practical)

1. **Branch A: dependency/runtime update only** (no rendering changes).
   - Validate startup/config/cache/download behavior.
2. **Branch B: new default transition engine** (dual-video + CSS/Web Animations).
   - Keep current canvas engine behind a legacy toggle for fallback.
3. **Branch C: instrumentation + auto profile selection**.
4. Roll out with A/B config switch:
   - "Modern transitions (recommended)"
   - "Legacy canvas transitions"

## Success criteria

- With transitions enabled, playback remains smooth on typical modern hardware at native monitor refresh.
- Frame-time spikes during transition are significantly reduced vs legacy canvas mode.
- No increase in crash rate or playback error retries.
- Builds are reproducible and do not drift due to wildcard dependency ranges.

## Notes about this analysis

- This plan is based on the current repository code paths and package metadata.
- Package-registry-based "latest version" probing may be blocked in restricted environments; exact target versions should be finalized during implementation on a network-enabled CI or development machine.
