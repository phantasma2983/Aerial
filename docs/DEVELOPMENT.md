# Development Notes

## Prerequisites
- Node.js `>= 22.12.0` recommended.
  - The current toolchain (`@electron/rebuild` via `electron-builder@26.x`) warns on older patch versions.

## Common commands
- Install dependencies:
  - `npm ci`
- Syntax lint:
  - `npm run lint`
- List lint targets:
  - `npm run lint:targets`
- Build installer:
  - `npm run build`

## Lint configuration
- Lint targets are centralized in `scripts/lint-targets.json`.
- The runner script is `scripts/run-syntax-lint.js` and executes `node --check` for each target.
