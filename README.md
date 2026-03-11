<p align="center">  
    <img alt="" src="/assets/images/surface_preview.gif" />
</p>
<p align="center">
    <img alt="" src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" />
    <img alt="" src="https://img.shields.io/github/last-commit/phantasma2983/Aerial?style=flat-square" />
    <img alt="" src="https://img.shields.io/github/v/release/phantasma2983/Aerial?style=flat-square" />
    <img alt="" src="https://img.shields.io/github/downloads/phantasma2983/Aerial/total?style=flat-square" />
</p>

# Aerial - Apple TV Screen Saver for Windows
 
Aerial is a Windows screen saver that mimics Apple's  Apple TV screen saver. It plays the various videos Apple shot of cities, landscapes, underwater scenes, and the earth from the ISS.

> Legacy alternatives: [JohnCoates/Aerial for macOS](https://github.com/JohnCoates/Aerial) and [graysky2/xscreensaver-aerial for Linux](https://github.com/graysky2/xscreensaver-aerial/).

## Installing
Download the latest release from [here](https://github.com/phantasma2983/Aerial/releases). Run the installer and configure your settings.

Be sure to configure your system's screen and sleep settings accordingly and to disable any other screensavers.

### Optional `.scr` install
Releases also include `Aerial.scr` for native Windows screensaver install flow.

1. Download `Aerial.scr`.
2. Right-click the file and choose `Install`.
3. In Windows Screen Saver Settings, select `Aerial` from the drop-down and use `Settings...` to open the config UI.
4. The tiny monitor-thumbnail preview (`/p`) is not embedded yet; use `Preview` or wait for idle to test fullscreen playback.

## Features
![image](https://user-images.githubusercontent.com/25063853/224231865-f8716c9a-ff9a-4c2b-bf18-21dc1bd4d504.png)
Aerial brings the Apple TV aerial experience to Windows with a full desktop configuration app and a native `.scr` install option.

### Playback

- Plays Apple-hosted aerial videos on Windows
- Supports H.264 1080p, HEVC 1080p, and HEVC 4K source selection
- Fill modes for stretch and crop
- Multiple transition styles and direction controls
- Adjustable playback speed
- Avoid duplicate-video playback
- Keyboard shortcuts for next and previous video
- Preview mode from the config UI

### Video Library

- Enable all videos, disable all videos, or filter by category
- Favorites support
- Saved video profiles, including default profile auto-apply on launch
- Quick filters in the Videos tab for checked, downloaded, favorites, user-added, and video type
- Add local custom videos
- Add extra videos through user-provided JSON metadata
- Video metadata editor/export tools for working with JSON entries

### Text, Overlays, and Minimal Mode

- Overlay text, date/time, images, HTML, points of interest, weather, and astronomy data
- Per-position text layout with random-position movement
- Per-line font, size, color, opacity, and weight overrides
- Adjustable overlay fade-in and fade-out timing
- Per-position max width control
- Per-screen text targeting on multi-display setups
- Minimal mode after a configurable amount of idle playback
- Minimal mode clock that moves every 15 seconds
- Custom minimal-mode time format

### Time, Location, Weather, and Astronomy

- Sunrise and sunset scheduling
- Optional automatic sunrise/sunset calculation from latitude and longitude
- Current weather line using Open-Meteo data
- Astronomy text options for sunrise, sunset, moonrise, and moonset

### Multi-Display and Performance

- Same video on every screen or independent playback
- Option to show video only on the primary monitor
- Alternate render fallback for multi-display setups
- Modern transition path plus diagnostics-oriented playback logging
- Debug playback overlay and log capture support

### Cache, Config, and Diagnostics

- Download videos to a local cache for smoother or offline playback
- Per-video download rules: checked-only, always download, never download
- Cache diagnostics for downloaded, missing, stale, and orphaned videos
- Cache cleanup actions, including orphan removal
- Settings export, import, and automatic backup support
- Diagnostics copy/export for support and troubleshooting
- Lifecycle and playback log management from the config UI

### System Integration

- Tray app integration
- Optional run on battery
- Optional block when another fullscreen app is active
- Global shortcut support
- Optional computer sleep after minimal mode starts
- Optional workstation lock after Aerial has been running
- Native `.scr` install flow for Windows Screen Saver Settings

### UI

- Dedicated Settings, Videos, and Text tabs
- Light and dark config themes
- About panel with release information and update details

See the [feature wiki](https://github.com/phantasma2983/Aerial/wiki/Features-&-To-Do-List) and the [version history](https://github.com/phantasma2983/Aerial/wiki/Version-History) for additional project notes.

>[Complete list of available videos.](https://docs.google.com/spreadsheets/d/1bboTohF06r-fafrImTExAPqM9m6h2m2lgJyAkQuYVJI/edit#gid=1684411812)

## Contributing

We are always looking for more help on this project! Some of our best features were suggested or added by the community. We appreciate new issues and pull requests.

Have an idea or want to help? Check out our [guide to contributing](https://github.com/phantasma2983/Aerial/wiki/Contributing-Guide). 
It includes information on submitting ideas, how to set up Aerial's dev environment, using launch flags, and other developer information

## About
Aerial is an Electron/Node.js Windows screensaver based on the Apple TV aerial experience.

This repo is a maintained fork of [OrangeJedi/Aerial](https://github.com/OrangeJedi/Aerial), with inspiration from [JohnCoates/Aerial](https://github.com/JohnCoates/Aerial) and [cDima/Aerial](https://github.com/cDima/Aerial).

Released under the [MIT License](https://github.com/phantasma2983/Aerial/blob/HEAD/LICENSE)
