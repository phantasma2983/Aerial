# Aerial Optimization + Cleanup Audit (Full Codebase Review)

## Scope reviewed
- Main process/runtime: `app.js`, `preload.js`, `package.json`, `package-lock.json`.
- Renderer/UI: `web/config.html|css|js`, `web/screensaver.html|css|js`, `web/video-info.html|css|js`.
- Tooling/editor helpers: `json-editor/*`.
- Repository assets/docs for stale-file risk: `assets/images/*`, `documentation/*`, root metadata.

---

## Executive summary

This codebase is functional and actively maintained, but it now has **cleanup debt from two release generations** in three areas:

1. **Dependency/runtime drift** (lockfile + runtime code mismatch).
2. **Code duplication in shared video selection/sanitization logic**.
3. **Repo hygiene debt** (large non-runtime assets and legacy helper tooling kept in production tree).

The highest-priority fixes are small and low-risk: normalize dependencies, remove dead/legacy paths, and centralize duplicated helpers.

---

## Key findings

### 1) Runtime dependency mismatch and deprecated download path (high priority)
- `app.js` still calls `request(...)` in `downloadFile`, but no `request` import exists in the file. This path can fail at runtime when downloads are triggered. The implementation should be replaced with `https`/`fetch` stream logic. 
- `package-lock.json` still records `request` as a top-level dependency and includes deprecated `request` modules, while `package.json` no longer declares it.

**Impact:** runtime risk + confusing installs + harder reproducibility.

### 2) Wildcard dependency ranges reduce release reproducibility (high priority)
- `package.json` uses `"*"` for runtime dependencies (`auto-launch`, `electron-store`, `font-list-universal`, `json-beautify`, `suncalc`).

**Impact:** same git commit may resolve to different dependency trees over time.

### 3) Repeated helper logic across processes/renderers (medium priority)
- `getVideoSource` logic is duplicated in at least three files with slight alias/fallback differences.
- `sanitizeExtraVideo` behavior exists in both main and renderer with similar but not identical normalization.

**Impact:** inconsistent behavior and bug-fix duplication.

### 4) Legacy rendering mode remains as complexity hotspot (medium priority)
- `alternateRenderMethod` and canvas-heavy transition paths continue to exist in settings and screensaver runtime, with many timing paths and state flags.

**Impact:** maintenance complexity and performance troubleshooting overhead.

### 5) Stale/non-runtime assets are mixed into main repo tree (medium priority)
- Build excludes `documentation/*` and `assets/images/*`, yet the repo includes large documentation binaries and design-source artifacts (`.ai`, `.psd`) in `assets/images/icon` and `assets/images/icons`.

**Impact:** repo bloat and slower clone/review cycles; unclear what is canonical runtime asset vs source artwork.

### 6) Auxiliary JSON editor appears as maintenance-only tooling (low/medium priority)
- `json-editor/*` is wired from `app.js` but behaves as a niche data-maintenance tool. It is useful, but should be explicitly scoped as "developer tool" and possibly moved behind a dev flag or separate folder/package.

**Impact:** unclear product surface area, extra code to keep secure/modernized.

---

## Suspected stale/outdated file candidates

These are candidates for archival, relocation, or clear labeling:

1. `documentation/Aerial for Windows - User Manual.docx` (source document) + PDF copy in same folder.
2. Design source files under `assets/images/icon` and `assets/images/icons` (`.ai`, `.psd`) that are not runtime assets.
3. Historical preview GIF variants (`assets/images/surface_preview.gif`, `assets/images/surface_preview_wiki.gif`) if both are no longer needed.
4. Vendored web libraries under `web/libraries/*` should be version-inventoried and minimized (especially if some are only used in one screen).

Recommendation: keep if needed, but move to `assets/source/` or `docs/source/` and document ownership.

---

## Unused / cleanup candidates in code

> Note: Browser-side scripts use inline HTML handlers, so some functions appear single-use from static grep and are not necessarily dead code.

1. Audit and remove obsolete compatibility aliases once format migration completes:
   - H.265 aliases (`H265*` vs `HEVC*`) are handled in multiple places; establish one canonical format and auto-migrate stored prefs.
2. Consolidate one-off UI handlers into modules (config/video-info) and drop duplicate utility functions.
3. Re-check legacy settings toggles that materially overlap (`videoQuality`, `alternateRenderMethod`, transition options).

---

## Optimization + cleanup implementation plan

## Phase 0 (1 PR): "Stability and reproducibility baseline"
1. Replace `request(...)` download code in `app.js` with native `https` streaming and robust error handling.
2. Pin runtime dependencies in `package.json` (exact or `~`) and regenerate lockfile.
3. Run `npm ci` and smoke-test startup/config/download.
4. Add a CI check to fail on wildcard dependency ranges.

**Deliverable:** deterministic install + no deprecated direct network client.

## Phase 1 (1–2 PRs): "Shared logic extraction"
1. Create shared utility module(s) for:
   - `getVideoSource`
   - extra-video sanitization/validation
2. Consume shared module in main process + renderers.
3. Add lightweight unit tests for source selection and sanitization edge cases.

**Deliverable:** one behavior definition for video selection + less duplicate code.

## Phase 2 (1 PR): "Repository hygiene"
1. Move design/source artifacts to a clearly documented non-runtime path.
2. Add `docs/ASSET_INVENTORY.md` describing which files are runtime-critical.
3. Optionally migrate large binaries to Git LFS if history growth is an issue.

**Deliverable:** smaller cognitive footprint, easier onboarding.

## Phase 3 (1–2 PRs): "Rendering complexity reduction"
1. Re-evaluate `alternateRenderMethod` necessity by GPU profile.
2. Keep default transition path GPU-friendly; retain legacy path as fallback feature flag.
3. Add telemetry/debug counters for transition latency and frame drops.

**Deliverable:** better maintainability and clearer performance diagnosis.

---

## Suggested acceptance criteria for the cleanup effort

- No wildcard runtime deps in `package.json`.
- No deprecated direct dependency (`request`) in lockfile.
- Shared video source + extra-video sanitization logic has a single canonical implementation.
- Asset inventory exists and stale/design artifacts are either relocated or documented.
- Download flow and screensaver startup pass smoke tests on a clean install.

---

## Quick wins (can be done immediately)

1. Add a small CI lint/check script that fails if `"*"` appears in runtime deps.
2. Add a `docs/MAINTENANCE.md` entry describing `json-editor` as developer tooling.
3. Add comments where inline HTML handlers intentionally call globally-scoped functions, so static analysis results are less ambiguous.
