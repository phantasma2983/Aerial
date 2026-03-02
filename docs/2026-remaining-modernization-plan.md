# Aerial Remaining Modernization Plan (Post Phase 0 + 1)

This document tracks the **remaining** modernization work after completing:
- Phase 0: stability/reproducibility baseline
- Phase 1: shared video-helper extraction

## Completed baseline (for context)
- Replaced deprecated `request` download usage with native `https` streaming.
- Removed wildcard runtime dependency ranges and pinned with `~`.
- Regenerated lockfile/install path with `npm ci`.
- Extracted shared `getVideoSource` and `sanitizeExtraVideo` logic into a shared module consumed by main + renderer.
- Removed legacy `documentation/*` and `json-editor/*` content.

---

## Completion status (March 3, 2026)

## 1) Rendering path simplification
- Completed.
1. Transition completion flow was refactored to explicit callbacks in `web/screensaver.js` (removed implicit global callback dependency).
2. Video-change lifecycle state was consolidated into a single structured object (`videoChangeState`).
3. Alternate render mode was evaluated and updated:
   - manual force mode remains available for troubleshooting,
   - automatic fallback mode (`alternateRenderAuto`) was added for multi-display canvas transitions.
4. Transition instrumentation was expanded (queue count, stale canplay, timeout starts, dropped-frame estimate, render mode).

**Output achieved:** lower transition-state complexity with better diagnostics and fallback behavior.

## 2) Performance observability
- Completed.
1. Debug overlay/log channel is available and surfaces:
   - selected video id/source profile,
   - render mode,
   - transition startup/duration/prebuffer metrics,
   - failure/queue/fallback counters and dropped-frame estimate.
2. `debugPlayback` is configurable via `Settings -> Advanced`.
3. Playback log can be opened from config (`Open Playback Log`).
4. Smoke test checklist exists and is aligned with diagnostics (`docs/SMOKE_TEST_CHECKLIST.md`).

**Output achieved:** measurable playback diagnostics for regression checks.

## 3) Asset organization plan
- Completed.
1. `assets/images/*` migration is complete.
2. Repository/docs references are aligned (README/docs/package exclusions).
3. Packaging exclusions remain aligned (`!assets/images/**`).
4. Asset inventory is documented (`docs/ASSET_INVENTORY.md`).

**Output achieved:** cleaner asset layout without runtime-path breakage.

## 4) Dependency/runtime follow-ups
- Completed with one documented compatibility constraint.
1. Upgraded to latest major toolchain:
   - `electron` -> `^40.6.1`
   - `electron-builder` -> `^26.8.1`
2. Added `overrides.semver=7.7.4` to address transitive vulnerability risk.
3. Verified `npm audit` reports zero vulnerabilities.
4. `electron-store` remains pinned at `~8.2.0` intentionally because current codebase relies on synchronous CommonJS `require(...)` access patterns in both `app.js` and `preload.js`; latest `electron-store` is ESM-only and would require a broader storage API migration.

**Output achieved:** updated runtime/build stack with vulnerability remediation and explicit constraint documentation.

## 5) Optional cleanup
- Completed.
1. Consolidated duplicate renderer text-format helpers into shared module: `shared/text-utils.js`.
2. Added centralized lint configuration and documented lint workflow:
   - `scripts/lint-targets.json`
   - `scripts/run-syntax-lint.js`
   - `docs/DEVELOPMENT.md`

**Output achieved:** lower maintenance overhead and repeatable static checks.

---

## Exit criteria status
- Transition behavior: implemented simplifications + instrumentation; ready for manual smoke validation.
- Asset references: aligned with migration and packaging exclusions.
- Install/build reproducibility: validated via `npm ci`, `npm run lint`, `npm run build`, and current `npm audit` (0 vulnerabilities).
