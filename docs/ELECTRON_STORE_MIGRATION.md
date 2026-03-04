# Electron Store Migration Plan

This project uses [`electron-store`](https://github.com/sindresorhus/electron-store) as the persistent settings/configuration layer.

## Migration status (v1.3.5)

Implemented in code:
- Upgraded dependency target to `electron-store ~11.0.2`.
- Main process now initializes `electron-store` via ESM dynamic import before startup (`initializeStore` + `bootstrap`).
- Preload no longer imports `electron-store` directly; it proxies sync `get/set` through main-process IPC (`store-get-sync` / `store-set-sync`) while preserving the renderer contract `electron.store.get/set`.

Remaining recommended follow-up:
- Add an explicit key/schema layer in main-process storage access to reduce malformed write risk from renderer payloads.
- Optionally migrate renderer access to async `invoke` to avoid sync IPC on hot paths.

## Why this matters

- Dependency pin in this repository is now `electron-store ~11.0.2` (latest stable during this migration).
- `electron-store` is ESM-only, so the main process now loads it through dynamic import during bootstrap.
- The preload bridge remains sync for renderer compatibility and forwards `get/set` to main via synchronous IPC.

This keeps existing renderer behavior stable while moving runtime storage implementation to the modern ESM package.

## Current usage in this codebase

- Main process (`app.js`): creates a store instance and reads/writes app settings extensively (startup defaults, tray behavior, cache paths, playback toggles, video catalogs, etc.).
- Preload (`preload.js`): does not instantiate `electron-store` directly; it exposes `electron.store.get/set` by forwarding to main over IPC via `contextBridge`.
- Renderer scripts (`web/*.js`): call `electron.store.get/set` heavily, especially in `web/config.js`, plus playback/runtime reads in `web/screensaver.js` and `web/video-info.js`.

This means migration impact is broad: one storage contract is used across main, preload, and renderer-facing API.

## Migration goals

1. Upgrade to latest `electron-store` safely.
2. Keep current settings schema and existing user data intact.
3. Avoid breaking renderer scripts that depend on `electron.store.get/set`.
4. Isolate store implementation details behind a local adapter so future storage upgrades are low-risk.

## Recommended implementation approach

## Phase 1: Introduce a storage adapter (no dependency upgrade yet)

1. Add a `shared/settings-store` module that exports a stable API (for example: `get`, `set`, `has`, `delete`, `reset`, `getAll`).
2. Keep implementation backed by current `electron-store@8` initially.
3. Replace direct `new Store()` usage in `app.js` and `preload.js` with the adapter.
4. Keep the preload bridge API stable (`electron.store.get/set`) so renderer code remains unchanged.

**Outcome:** all usage goes through one local abstraction.

## Phase 2: Move project runtime to ESM-compatible store loading

1. Update adapter internals to load ESM `electron-store`.
2. Use one of these migration patterns:
   - convert app entry points to ESM, **or**
   - keep CJS entry points and use dynamic `import('electron-store')` within the adapter with async initialization.
3. If using async initialization, gate app startup until settings store is ready.

**Outcome:** project can consume modern `electron-store` without changing renderer call sites.

## Phase 3: Data compatibility + schema hardening

1. Verify old settings file is read correctly after upgrade.
2. Add explicit schema/defaults in adapter where practical to reduce invalid state issues.
3. Add versioned migrations for known key changes (if any are needed).

**Outcome:** upgrade is safe for existing users and future config evolution.

## Phase 4: Validation and rollout

1. Test matrix:
   - existing user profile upgraded in place,
   - clean install,
   - first launch, tray behavior, config save/apply, screensaver playback settings.
2. Validate settings written from renderer are visible in main process and vice versa.
3. Ship in one release with a clear rollback strategy (pin back to 8.x if regressions appear).

## Practical scope estimate

- **Code touch breadth:** moderate-to-high (main + preload + shared adapter + startup flow).
- **Renderer refactor needed:** low if preload API compatibility is preserved.
- **Risk level:** medium (startup/config critical path), manageable with staged adapter-first migration.

## Notes for maintainers

- Keep the renderer-facing contract stable during migration: `electron.store.get(key)` and `electron.store.set(key, value)`.
- Avoid spreading direct `electron-store` imports to new files; route all access through the adapter.
- Document final architecture in `docs/DEVELOPMENT.md` once migration is complete.
