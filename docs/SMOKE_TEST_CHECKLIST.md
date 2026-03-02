# Aerial Smoke Test Checklist

## Playback and transitions
- Launch configuration window (`/c`) and verify settings render.
- Launch preview (`/t`) and verify first video starts.
- Verify transition executes between 2+ clips without black-frame stalls.
- With `debugPlayback=true`, verify metrics overlay updates transition and frame stats.

## Multi-monitor
- Connect 2 displays and launch screensaver (`/s`).
- Verify configured monitor behavior (`sameVideoOnScreens`, primary-only mode).
- Verify transition timing stays stable on both monitors.

## Power/visibility lifecycle
- Minimize/restore preview window and confirm transition scheduler pauses/resumes cleanly.
- Lock/unlock workstation and verify screensaver resumes normally.

## Video cache
- Enable cache and trigger refresh.
- Verify download temp file is copied to final cache path and listed in downloaded videos.
- Simulate failed URL and verify app continues to next candidate without crash.

## Tray + shortcuts
- Start tray mode and verify menu actions (configure, start, suspend, exit).
- Verify global shortcut starts screensaver when enabled.
