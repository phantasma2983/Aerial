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

## Remaining work

## 1) Rendering path simplification (highest remaining impact)
1. Keep current default playback path, but reduce transition-state complexity in `web/screensaver.js`.
2. Evaluate whether `alternateRenderMethod` should remain user-facing or become an automatic fallback.
3. Add transition timing instrumentation (start latency, failures, retries, and dropped frame indicators).

**Output:** simpler transition code paths with better diagnostics.

## 2) Performance observability
1. Add a debug overlay/log channel for:
   - selected video id/source profile,
   - transition duration and startup time,
   - prebuffer wait duration.
2. Add a basic smoke-test checklist for multi-monitor playback and transition reliability.

**Output:** measurable data for regression checks before releases.

## 3) Asset organization plan (images are still required)
`images/*` remains needed for project/docs purposes and should not be deleted.

Proposed migration (future PR):
1. Move image assets to `assets/images/*`.
2. Update all repository references (e.g., README paths and any HTML/docs references).
3. Keep Electron packaging exclusions aligned so non-runtime assets stay out of installers.
4. Add `docs/ASSET_INVENTORY.md` mapping each asset to its purpose (runtime UI, docs, design source, etc.).

**Output:** cleaner repository layout without breaking references.

## 4) Dependency/runtime follow-ups
1. Address high-risk vulnerabilities where upgrades are compatible with Electron 22 runtime constraints.
2. Plan a controlled Electron/electron-builder major upgrade branch with compatibility testing.

**Output:** reduced security/maintenance risk and clearer upgrade path.

## 5) Optional cleanup
1. Consolidate minor duplicated formatting logic in renderer scripts.
2. Add lint configuration/documented lint command for repeatable static checks.

**Output:** lower maintenance overhead.

---

## Suggested execution order
1. Rendering path simplification and instrumentation.
2. Asset move to `assets/images/*` + path updates.
3. Dependency vulnerability remediation.
4. Tooling/lint polish.

## Exit criteria for the remaining plan
- Transition behavior stable across single/multi-monitor setups.
- Asset references continue to resolve after path migration.
- CI/install checks are green with reproducible dependency resolution.
