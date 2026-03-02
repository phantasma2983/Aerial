# Asset Inventory

## Runtime-critical assets
- `icon.ico` - application/installer icon.
- `web/images/*` - assets used directly by renderer HTML/CSS.
- `web/libraries/*` - bundled third-party frontend dependencies.

## Repository/documentation assets
- `assets/images/surface_preview.gif` - README preview image.
- `assets/images/surface_preview_wiki.gif` - wiki/demo variant.
- `assets/images/task_scheduler/*` - task scheduler guide screenshots.
- `assets/images/icon/*` - icon exports and source design files.
- `assets/images/icons/*` - sunrise/sunset icon assets and design sources.

## Packaging behavior
- Installer/package build excludes `assets/images/*` because these are repo/docs assets, not runtime files.
