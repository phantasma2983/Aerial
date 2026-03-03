//load libraries
const {
    app,
    BrowserWindow,
    ipcMain,
    screen,
    shell,
    dialog,
    Tray,
    Menu,
    powerMonitor,
    Notification,
    globalShortcut
} = require('electron');
const {exec, execFile} = require('child_process');
const bundledVideos = require("./videos.json");
const packageMetadata = require("./package.json");
const https = require('https');
const fs = require('fs');
const path = require("path");
const AutoLaunch = require('auto-launch');
const {getVideoSource, sanitizeExtraVideo} = require('./shared/video-utils');
let autoLauncher = new AutoLaunch({
    name: 'Aerial',
});
const SunCalc = require('suncalc');

const UPSTREAM_REPO_URL = "https://github.com/OrangeJedi/Aerial";
let store;

async function initializeStore() {
    const {default: Store} = await import('electron-store');
    store = new Store();
}

function getGitHubRepoFromUrl(repositoryUrl) {
    if (!repositoryUrl || typeof repositoryUrl !== "string") {
        return null;
    }
    const normalized = repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, "");
    const match = normalized.match(/github\.com[:/]+([^/]+\/[^/]+)/i);
    return match ? match[1] : null;
}

function compareSemver(left, right) {
    const l = String(left).split(".").map((v) => Number(v) || 0);
    const r = String(right).split(".").map((v) => Number(v) || 0);
    const len = Math.max(l.length, r.length);
    for (let i = 0; i < len; i++) {
        const li = l[i] ?? 0;
        const ri = r[i] ?? 0;
        if (li > ri) {
            return 1;
        }
        if (li < ri) {
            return -1;
        }
    }
    return 0;
}

const appRepo = getGitHubRepoFromUrl(packageMetadata.repository?.url) ?? "OrangeJedi/Aerial";
const appRepoUrl = `https://github.com/${appRepo}`;
const appReleasesUrl = `${appRepoUrl}/releases`;
const appWikiUrl = `${appRepoUrl}/wiki`;
const appLicenseUrl = `${appRepoUrl}/blob/HEAD/LICENSE`;
const MAX_VIDEO_HISTORY = 150;
const LIFECYCLE_LOG_FILE = "aerial-lifecycle.log";

function logLifecycle(eventName, details) {
    let detailText = "";
    if (details !== undefined) {
        try {
            detailText = ` ${JSON.stringify(details)}`;
        } catch {
            detailText = ` ${String(details)}`;
        }
    }
    const line = `${new Date().toISOString()} [lifecycle] ${eventName}${detailText}`;
    console.log(line);
    try {
        const userData = app.getPath('userData');
        fs.appendFileSync(path.join(userData, LIFECYCLE_LOG_FILE), `${line}\n`);
    } catch {
        // best-effort diagnostics only
    }
}

function setRepositoryMetadata() {
    store.set('repositoryUrl', appRepoUrl);
    store.set('releasesUrl', appReleasesUrl);
    store.set('wikiUrl', appWikiUrl);
    store.set('licenseUrl', appLicenseUrl);
    store.set('upstreamRepositoryUrl', UPSTREAM_REPO_URL);
}

function getExtraVideos() {
    const extras = store.get("extraVideos") ?? [];
    if (!Array.isArray(extras)) {
        return [];
    }
    const seen = new Set();
    const sanitized = [];
    for (const extra of extras) {
        const valid = sanitizeExtraVideo(extra);
        if (!valid || seen.has(valid.id)) {
            continue;
        }
        seen.add(valid.id);
        sanitized.push(valid);
    }
    return sanitized;
}

function getVideoCatalog() {
    const catalog = [...bundledVideos];
    const seen = new Set(catalog.map((video) => video.id));
    for (const extra of getExtraVideos()) {
        if (!seen.has(extra.id)) {
            catalog.push(extra);
            seen.add(extra.id);
        }
    }
    return catalog;
}

function syncVideoCatalog() {
    const extras = getExtraVideos();
    const catalog = getVideoCatalog();
    store.set("extraVideos", extras);
    store.set("videoCatalog", catalog);
    return catalog;
}

//initialize variables
let screens = [];
let screenIds = [];
let nq = false;
let cachePath = path.join(app.getPath('userData'), "videos");
let downloading = false;
let allowedVideos = [];
let previouslyPlayed = [];
let currentlyPlaying = '';
let playedVideoHistory = [];
let playedVideoHistoryIndex = -1;
let preview = false;
let suspend = false;
let suspendCountdown;
let isComputerSleeping = false;
let isComputerSuspendedOrLocked = false;
let isAppQuitting = false;
const launchedAsScreensaverSession = process.argv.some((arg) => {
    const normalized = String(arg || "").toLowerCase();
    return normalized === "/s" || normalized === "/p" || normalized === "/t";
});
let exitingScreensaverWindows = false;
let launchScreensaverBusy = false;
let fullscreenCheckInProgress = false;
let foregroundFullscreenCache = {value: false, checkedAt: 0};
let trayWindow = null;
let trayIcon = null;
let startTime = new Date();
let tod = {"day": [], "night": [], "none": []};
let astronomy = {
    "sunrise": undefined,
    "sunset": undefined,
    "moonrise": undefined,
    "moonset": undefined,
    "calculated": false
};
let admin = false;
exec('NET SESSION', function (err, so, se) {
    if (se.length === 0) {
        admin = true;
    }
    //console.log(se.length === 0 ? "admin" : "not admin");
});

function resetPlaybackHistory() {
    playedVideoHistory = [];
    playedVideoHistoryIndex = -1;
}

function pushVideoToHistory(videoId) {
    if (!videoId) {
        return;
    }
    if (playedVideoHistoryIndex < playedVideoHistory.length - 1) {
        playedVideoHistory = playedVideoHistory.slice(0, playedVideoHistoryIndex + 1);
    }
    playedVideoHistory.push(videoId);
    if (playedVideoHistory.length > MAX_VIDEO_HISTORY) {
        playedVideoHistory.shift();
    }
    playedVideoHistoryIndex = playedVideoHistory.length - 1;
}

function getPreviousVideoFromHistory() {
    if (playedVideoHistoryIndex > 0) {
        playedVideoHistoryIndex--;
        return playedVideoHistory[playedVideoHistoryIndex];
    }
    if (playedVideoHistoryIndex === 0 && playedVideoHistory.length > 0) {
        return playedVideoHistory[0];
    }
    return null;
}

function getForegroundWindowRect() {
    return new Promise((resolve) => {
        const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class AerialWinApi {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$hwnd = [AerialWinApi]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { return }
$rect = New-Object AerialWinApi+RECT
[AerialWinApi]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$pid = 0
[AerialWinApi]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$processName = ""
try {
  $processName = (Get-Process -Id $pid -ErrorAction Stop).ProcessName
} catch {}
$result = @{
  left = $rect.Left
  top = $rect.Top
  right = $rect.Right
  bottom = $rect.Bottom
  processName = $processName
}
$result | ConvertTo-Json -Compress
`.trim();

        execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
            timeout: 1500,
            windowsHide: true
        }, (error, stdout) => {
            if (error || !stdout) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()));
            } catch {
                resolve(null);
            }
        });
    });
}

function isRectFullscreenOnAnyDisplay(rect) {
    if (!rect) {
        return false;
    }
    const tolerance = 4;
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) {
        return false;
    }
    const displays = screen.getAllDisplays();
    for (const display of displays) {
        const bounds = display.bounds;
        const matchesX = Math.abs(rect.left - bounds.x) <= tolerance;
        const matchesY = Math.abs(rect.top - bounds.y) <= tolerance;
        const matchesWidth = Math.abs(width - bounds.width) <= tolerance;
        const matchesHeight = Math.abs(height - bounds.height) <= tolerance;
        if (matchesX && matchesY && matchesWidth && matchesHeight) {
            return true;
        }
    }
    return false;
}

async function isFullscreenAppActive() {
    const now = Date.now();
    if (now - foregroundFullscreenCache.checkedAt < 3000 || fullscreenCheckInProgress) {
        return foregroundFullscreenCache.value;
    }

    fullscreenCheckInProgress = true;
    try {
        const rect = await getForegroundWindowRect();
        const processName = rect?.processName?.toLowerCase?.() ?? "";
        const ignoredProcesses = new Set(["explorer", "shellexperiencehost", "searchhost", "startmenuexperiencehost", "aerial"]);
        if (ignoredProcesses.has(processName)) {
            foregroundFullscreenCache = {value: false, checkedAt: now};
            return false;
        }
        const isFullscreen = isRectFullscreenOnAnyDisplay(rect);
        foregroundFullscreenCache = {value: isFullscreen, checkedAt: now};
        return isFullscreen;
    } catch {
        foregroundFullscreenCache = {value: false, checkedAt: now};
        return false;
    } finally {
        fullscreenCheckInProgress = false;
    }
}

//window creation code
function createConfigWindow(argv) {
    let win = new BrowserWindow({
        width: 1080,
        height: 810,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            sandbox: false,
            preload: path.join(__dirname, "preload.js")
        },
        resizable: true,
        minimizable: true,
        maximizable: true,
        autoHideMenuBar: true,
        minWidth: 1024,
        minHeight: 768,
        icon: path.join(__dirname, 'icon.ico')
    });
    if (typeof win.removeMenu === "function") {
        win.removeMenu();
    } else {
        win.setMenu(null);
    }
    win.setMenuBarVisibility(false);
    win.loadFile('web/config.html');
    win.webContents.on('before-input-event', (event, input) => {
        const key = String(input.key || "").toUpperCase();
        const isDevToolsKey = input.type === 'keyDown' && (
            key === 'F12' ||
            (key === 'I' && input.control && input.shift)
        );
        if (isDevToolsKey) {
            if (win.webContents.isDevToolsOpened()) {
                win.webContents.closeDevTools();
            } else {
                win.webContents.openDevTools({mode: 'detach'});
            }
            event.preventDefault();
        }
    });
    win.on('closed', function () {
        win = null;
    });
    if (argv) {
        if (argv.includes("/dt")) {
            win.webContents.openDevTools();
        }
    }
    if (argv) {
        if (argv.includes("/w")) {
            setTimeout(() => {
                win.webContents.send('showWelcome')
            }, 1500);
        }
    }
    win.webContents.setWindowOpenHandler(({url}) => {
        shell.openExternal(url);
        return {action: 'deny'};
    });
}

function createSSWindow(argv) {
    logLifecycle("createSSWindow:start", {
        argv,
        nq,
        useTray: store.get('useTray'),
        screensCount: screens.length
    });
    switch (argv) {
        case undefined:
            break
        default: {
            if (!argv.includes("/nq")) {
                nq = false;
            }
        }
    }
    allowedVideos = store.get("allowedVideos");
    calculateAstronomy();
    previouslyPlayed = [];
    resetPlaybackHistory();
    let displays = screen.getAllDisplays();
    store.set('numDisplays', displays.length);
    for (let i = 0; i < displays.length; i++) {
        const displayId = displays[i].id;
        const renderScreensaver = !(store.get("onlyShowVideoOnPrimaryMonitor") && displayId !== screen.getPrimaryDisplay().id);
        let win = new BrowserWindow({
            width: displays[i].size.width,
            height: displays[i].size.height,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
                sandbox: false,
                preload: path.join(__dirname, "preload.js")
            },
            x: displays[i].bounds.x,
            y: displays[i].bounds.y,
            //sets the screensaver to run as windows if the 'no-quit' mode had been set
            fullscreen: !nq,
            transparent: true,
            frame: nq,
            icon: path.join(__dirname, 'icon.ico'),
            show: false
        })
        if (!renderScreensaver) {
            win.loadFile('web/black.html');
        } else {
            win.loadFile('web/screensaver.html');
            win.webContents.once('did-finish-load', () => {
                win.webContents.send('screenNumber', i);
            });
        }
        win.on('closed', function () {
            const closedIndex = screens.indexOf(win);
            if (closedIndex !== -1) {
                screens.splice(closedIndex, 1);
            }
            const screenIdIndex = screenIds.indexOf(displayId);
            if (screenIdIndex !== -1) {
                screenIds.splice(screenIdIndex, 1);
            }
            logLifecycle("createSSWindow:window-closed", {
                displayId,
                remainingTrackedScreens: screens.length
            });
            win = null;
        });
        win.once('ready-to-show', () => {
            win.show();
            if (renderScreensaver) {
                win.webContents.send('screensaverVisible');
            }
        })
        if (!nq) {
            win.setMenu(null);
            win.setAlwaysOnTop(true, "screen-saver");
        } else {
            win.frame = true;
        }
        screens.push(win);
        screenIds.push(displayId);
    }
    //find the screen the cursor is on and focus it so the cursor will hide
    let mainScreen = screens[screenIds.indexOf(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id)];
    startTime = new Date();
    if (mainScreen) {
        if (!mainScreen.isDestroyed()) {
            mainScreen.focus();
        }
    }
}

function createSSPWindow(argv) {
    nq = true;
    allowedVideos = store.get("allowedVideos");
    previouslyPlayed = [];
    resetPlaybackHistory();
    let displays = screen.getAllDisplays();
    let win = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            sandbox: false,
            preload: path.join(__dirname, "preload.js"),
        },
        frame: true,
        transparent: true,
        icon: path.join(__dirname, 'icon.ico'),
        show: false
    });
    win.loadFile('web/screensaver.html');
    win.webContents.once('did-finish-load', () => {
        win.webContents.send('screenNumber', 0);
    });
    win.on('closed', function () {
        screens.pop(screens.indexOf(win));
        nq = false;
        win = null;
        preview = false;
    });
    win.once('ready-to-show', () => {
        win.show();
        win.webContents.send('screensaverVisible');
    })
    if (argv) {
        if (argv.includes("/dt")) {
            win.webContents.openDevTools();

        }
    }
    screens.push(win);
    preview = true;
}

function createEditWindow(argv) {
    let win = new BrowserWindow({
        width: 1080,
        height: 810,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            sandbox: false,
            preload: path.join(__dirname, "preload.js")
        },
        icon: path.join(__dirname, 'icon.ico')
    });
    win.loadFile('web/video-info.html');
    win.on('closed', function () {
        win = null;
    });
    if (argv) {
        if (argv.includes("/dt")) {
            win.webContents.openDevTools();
        }
    }
    win.webContents.setWindowOpenHandler(({url}) => {
        shell.openExternal(url);
        return {action: 'deny'};
    });
    screens.push(win);
}

function createTrayWindow() {
    if (trayWindow && !trayWindow.isDestroyed() && trayIcon) {
        logLifecycle("createTrayWindow:reuse-existing");
        return;
    }
    logLifecycle("createTrayWindow:create");

    trayWindow = new BrowserWindow({
        width: 800, height: 600, center: true, minimizable: false, show: false,
        webPreferences: {
            nodeIntegration: false,
            webSecurity: true,
            sandbox: true,
        },
        icon: path.join(__dirname, 'icon.ico')
    });
    //trayWindow.loadURL("https://google.com/");
    trayWindow.on("close", (event) => {
        // Keep tray window hidden instead of destroyed when users close it.
        logLifecycle("trayWindow:close", {isAppQuitting});
        if (isAppQuitting) {
            return;
        }
        event.preventDefault();
        if (!trayWindow.isDestroyed()) {
            trayWindow.hide();
        }
    });
    trayWindow.on("closed", () => {
        logLifecycle("trayWindow:closed");
        trayWindow = null;
        if (!isAppQuitting && store.get('useTray')) {
            setTimeout(() => {
                createTrayWindow();
            }, 0);
        }
    });

    function refreshTrayMenu() {
        if (!trayIcon) {
            return;
        }
        trayIcon.setContextMenu(newMenu());
    }

    function newMenu() {
        return Menu.buildFromTemplate([
            {
                label: "Open Config", click: (item, window, event) => {
                    createConfigWindow();
                }
            },
            {type: "separator"},
            {
                label: "Start Aerial", click: (item, window, event) => {
                    createSSWindow();
                }
            },
            {
                label: suspend ? "Suspend Aerial (ON)" : "Suspend Aerial (OFF)",
                click: () => {
                    suspend = !suspend;
                    clearTimeout(suspendCountdown);
                    refreshTrayMenu();
                }
            },
            {
                label: 'Suspend for 1 hour',
                click: (e) => {
                    suspend = true;
                    clearTimeout(suspendCountdown);
                    refreshTrayMenu();
                    suspendCountdown = setTimeout(() => {
                        suspend = false;
                        refreshTrayMenu();
                    }, (1000 * 60) + (store.get('startAfter') * 60));
                }
            },
            {
                label: 'Suspend for 3 hours',
                click: (e) => {
                    suspend = true;
                    clearTimeout(suspendCountdown);
                    refreshTrayMenu();
                    suspendCountdown = setTimeout(() => {
                        suspend = false;
                        refreshTrayMenu();
                    }, (1000 * 60 * 3) + (store.get('startAfter') * 60));
                }
            },
            {type: "separator"},
            {
                label: "Exit Aerial", click: (item, window, event) => {
                    logLifecycle("trayMenu:exit-click");
                    isAppQuitting = true;
                    app.quit();
                }
            },
        ]);
    }

    trayIcon = new Tray(path.join(__dirname, 'icon.ico'));
    refreshTrayMenu();
    trayIcon.setToolTip("Aerial");
    logLifecycle("createTrayWindow:ready");
}

//start up code
app.allowRendererProcessReuse = true
app.on('before-quit', () => {
    logLifecycle("app:before-quit");
    isAppQuitting = true;
});
app.on('will-quit', () => {
    logLifecycle("app:will-quit");
});
app.on('quit', (_event, exitCode) => {
    logLifecycle("app:quit", {exitCode});
});
app.on('window-all-closed', (event) => {
    logLifecycle("app:window-all-closed", {
        isAppQuitting,
        launchedAsScreensaverSession,
        exitingScreensaverWindows,
        useTray: store.get('useTray'),
        trayWindowExists: Boolean(trayWindow && !trayWindow.isDestroyed()),
        trayIconExists: Boolean(trayIcon),
        screensCount: screens.length
    });
    if (isAppQuitting || launchedAsScreensaverSession) {
        return;
    }
    event.preventDefault();
    if (exitingScreensaverWindows) {
        if (store.get('useTray')) {
            createTrayWindow();
        } else {
            createConfigWindow();
        }
        return;
    }
    if (store.get('useTray')) {
        createTrayWindow();
    }
});
app.on('render-process-gone', (_event, webContents, details) => {
    logLifecycle("app:render-process-gone", {
        id: webContents?.id,
        reason: details?.reason,
        exitCode: details?.exitCode
    });
});
app.on('child-process-gone', (_event, details) => {
    logLifecycle("app:child-process-gone", {
        type: details?.type,
        reason: details?.reason,
        exitCode: details?.exitCode,
        serviceName: details?.serviceName,
        name: details?.name
    });
});
process.on('beforeExit', (code) => {
    logLifecycle("process:beforeExit", {code});
});
process.on('exit', (code) => {
    logLifecycle("process:exit", {code});
});
process.on('uncaughtException', (error) => {
    logLifecycle("process:uncaughtException", {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
    });
});
process.on('unhandledRejection', (reason) => {
    logLifecycle("process:unhandledRejection", {reason: String(reason)});
});

ipcMain.on('store-get-sync', (event, key) => {
    event.returnValue = store.get(key);
});

ipcMain.on('store-set-sync', (event, payload) => {
    if (!payload || typeof payload.key !== "string") {
        event.returnValue = false;
        return;
    }
    store.set(payload.key, payload.value);
    event.returnValue = true;
});

async function bootstrap() {
    await initializeStore();
    app.whenReady().then(startUp);
}

bootstrap().catch((error) => {
    console.error('Failed to initialize electron-store', error);
    app.exit(1);
});

function startUp() {
    cachePath = store.get('cachePath') ?? path.join(app.getPath('userData'), "videos");
    allowedVideos = store.get("allowedVideos") ?? [];

    logLifecycle("startUp", {
        argv: process.argv,
        isPackaged: app.isPackaged,
        launchedAsScreensaverSession
    });
    Menu.setApplicationMenu(null);
    setRepositoryMetadata();
    //Uncomment the line below when compiling the .scr file
    //store.set('useTray', false);
    let firstTime = false;
    if (!store.get("configured") || store.get("version") !== app.getVersion()) {
        firstTime = true;
        //make video cache directory
        if (!fs.existsSync(path.join(app.getPath('userData'), "videos"))) {
            fs.mkdirSync(path.join(app.getPath('userData'), "videos"));
        }
        if (!fs.existsSync(path.join(app.getPath('userData'), "videos", "temp"))) {
            fs.mkdirSync(path.join(app.getPath('userData'), "videos", "temp"));
        }
        setUpConfigFile();
    } else {
        // Keep runtime metadata and merged catalog current even between releases.
        setUpConfigFile();
    }
    calculateAstronomy();
    checkForUpdate();
    setupGlobalShortcut();
    store.set('numDisplays', screen.getAllDisplays().length);
    //configures Aerial to launch on startup
    if (store.get('useTray') && app.isPackaged) {
        autoLauncher.enable();
    } else {
        autoLauncher.disable();
    }
    //prevents quiting the app if wanted
    if (process.argv.includes("/nq")) {
        nq = true;
    }
    clearCacheTemp();
    if (store.get('videoCacheRemoveUnallowed')) {
        removeAllUnallowedVideosInCache();
    }
    removeAllNeverAllowedVideosInCache();
    if (process.argv.includes("/c")) {
        createConfigWindow(process.argv);
    } else if (process.argv.includes("/p")) {
        //createSSPWindow();
        app.quit();
    } else if (process.argv.includes("/s")) {
        createSSWindow(process.argv);
    } else if (process.argv.includes("/t")) {
        createSSPWindow(process.argv);
    } else {
        if (store.get('useTray')) {
            createTrayWindow();
            if (firstTime) {
                createConfigWindow(["/w"]);
            }
        } else {
            createConfigWindow();
        }
    }
    setTimeout(downloadVideos, 1500);
}

//loads the config file with the default setting if not set up already
function setUpConfigFile() {
    const catalog = syncVideoCatalog();
    //update video info
    if (!store.get('allowedVideos')) {
        let allowedVideos = [];
        for (let i = 0; i < catalog.length; i++) {
            allowedVideos.push(catalog[i].id);
        }
        store.set('allowedVideos', allowedVideos);
    }
    const knownVideoIds = new Set(catalog.map((video) => video.id));
    store.set('allowedVideos', (store.get('allowedVideos') ?? []).filter((videoId) => typeof videoId === "string" && (videoId.startsWith("_") || knownVideoIds.has(videoId))));
    store.set('alwaysDownloadVideos', (store.get('alwaysDownloadVideos') ?? []).filter((videoId) => knownVideoIds.has(videoId)));
    store.set('neverDownloadVideos', (store.get('neverDownloadVideos') ?? []).filter((videoId) => knownVideoIds.has(videoId)));
    store.set('downloadedVideos', store.get('downloadedVideos') ?? []);
    store.set('videoProfiles', store.get('videoProfiles') ?? []);
    store.set('customVideos', store.get('customVideos') ?? []);

    //start up settings
    store.set('useTray', store.get('useTray') ?? true);
    store.set('startAfter', store.get('startAfter') ?? 10);
    store.set('blankScreen', store.get('blankScreen') ?? true);
    store.set('blankAfter', store.get('blankAfter') ?? 30);
    store.set('sleepAfterBlank', store.get('sleepAfterBlank') ?? true);
    store.set('lockAfterRun', store.get('lockAfterRun') ?? false);
    store.set('lockAfterRunAfter', store.get('lockAfterRunAfter') ?? 15);
    store.set('runOnBattery', store.get('runOnBattery') ?? true);
    store.set('disableWhenFullscreenAppActive', store.get('disableWhenFullscreenAppActive') ?? true);
    store.set('updateAvailable', false);
    setRepositoryMetadata();
    store.set('debugPlayback', store.get('debugPlayback') ?? false);
    store.set('configTheme', store.get('configTheme') ?? "dark");
    store.set('enableGlobalShortcut', store.get('enableGlobalShortcut') ?? true);
    store.set('globalShortcutModifier1', store.get('globalShortcutModifier1') ?? "Super");
    store.set('globalShortcutModifier2', store.get('globalShortcutModifier2') ?? "+Control");
    store.set('globalShortcutKey', store.get('globalShortcutKey') ?? "A");
    //playback settings
    store.set('playbackSpeed', store.get('playbackSpeed') ?? 1);
    store.set('skipVideosWithKey', store.get('skipVideosWithKey') ?? true);
    store.set('skipKey', store.get('skipKey') ?? "ArrowRight");
    store.set('previousSkipKey', store.get('previousSkipKey') ?? "ArrowLeft");
    store.set('avoidDuplicateVideos', store.get('avoidDuplicateVideos') ?? true);
    store.set('videoFilters', store.get('videoFilters') ?? [{
        name: 'blur',
        value: 0,
        min: 0,
        max: 100,
        suffix: "px",
        defaultValue: 0
    }, {name: 'brightness', value: 100, min: 0, max: 100, suffix: "%", defaultValue: 100}, {
        name: 'grayscale',
        value: 0,
        min: 0,
        max: 100,
        suffix: "%",
        defaultValue: 0
    }, {name: 'hue-rotate', value: 0, min: 0, max: 360, suffix: "deg", defaultValue: 0}, {
        name: 'invert',
        value: 0,
        min: 0,
        max: 100,
        suffix: "%",
        defaultValue: 0
    }, {name: 'saturate', value: 100, min: 0, max: 256, suffix: "%", defaultValue: 100}, {
        name: 'sepia',
        value: 0,
        min: 0,
        max: 100,
        suffix: "%",
        defaultValue: 0
    },]);
    store.set('alternateRenderMethod', store.get("alternateRenderMethod") ?? false);
    store.set('alternateRenderAuto', store.get("alternateRenderAuto") ?? true);
    store.set('transitionType', store.get("transitionType") ?? "dissolve");
    store.set('transitionDirection', store.get("transitionDirection") ?? "");
    store.set('videoTransitionLength', store.get('videoTransitionLength') ?? 2000);
    store.set('fillMode', store.get('fillMode') ?? "stretch");
    store.set('videoFileType', store.get('videoFileType') ?? "H2641080p");
    if (store.get('videoFileType') === "H2651080p") {
        store.set('videoFileType', "HEVC1080p");
    } else if (store.get('videoFileType') === "H2654k") {
        store.set('videoFileType', "HEVC2160p");
    }
    //1.2.0 changes the default transition length because of internal changes
    if (store.get('videoTransitionLength') === 1000) {
        store.set('videoTransitionLength', 2000);
    }
    //time & location settings
    store.set('timeOfDay', store.get('timeOfDay') ?? false);
    store.set('sunrise', store.get('sunrise') ?? "06:00");
    store.set('sunset', store.get('sunset') ?? "18:00");
    store.set('useLocationForSunrise', store.get('useLocationForSunrise') ?? false);
    store.set('latitude', store.get('latitude') ?? "");
    store.set('longitude', store.get('longitude') ?? "");
    store.set('astronomy', store.get('astronomy') ?? astronomy)
    //multiscreen settings
    store.set('sameVideoOnScreens', store.get('sameVideoOnScreens') ?? false);
    store.set('onlyShowVideoOnPrimaryMonitor', store.get('onlyShowVideoOnPrimaryMonitor') ?? false);
    //cache settings
    store.set('videoCache', store.get('videoCache') ?? false);
    store.set('videoCacheProfiles', store.get('videoCacheProfiles') ?? false);
    store.set('videoCacheSize', getCacheSize());
    store.set('videoCacheRemoveUnallowed', store.get('videoCacheRemoveUnallowed') ?? false);
    store.set('cachePath', store.get('cachePath') ?? cachePath);
    store.set('immediatelyUpdateVideoCache', store.get('immediatelyUpdateVideoCache') ?? true);
    //check for downloaded videos
    updateVideoCache();
    //text settings
    store.set('textFont', store.get('textFont') ?? "Segoe UI");
    store.set('textSize', store.get('textSize') ?? "2");
    store.set('textSizeUnit', store.get('textSizeUnit') ?? "vw");
    store.set('textColor', store.get('textColor') ?? "#FFFFFF");
    store.set('textOpacity', store.get('textOpacity') ?? "1");
    store.set('textLineHeight', store.get('textLineHeight') ?? "1.2");
    store.set('textFontWeight', store.get('textFontWeight') ?? "400");
    store.set('textFadeInDuration', store.get('textFadeInDuration') ?? 650);
    store.set('textFadeOutDuration', store.get('textFadeOutDuration') ?? 260);
    let displayText = store.get('displayText');
    if (displayText) {
        if (!displayText.topleft[0]) {
            displayText = undefined;
        }
    }
    if (!displayText) {
        displayText = {
            'positionList': ["topleft", "topright", "bottomleft", "bottomright", "left", "right", "middle", "topmiddle", "bottommiddle", "random"]
        };
        let temp = [];
        for (let i = 0; i < 4; i++) {
            temp.push({'type': "none", "defaultFont": true});
        }
        displayText.positionList.forEach((v) => {
            displayText[v] = temp;
        });
    }
    if (!displayText.maxWidth || typeof displayText.maxWidth !== "object" || Array.isArray(displayText.maxWidth)) {
        displayText.maxWidth = {};
    }
    for (const position of displayText.positionList) {
        if (!displayText.maxWidth[position]) {
            const legacyArrayWidth = displayText[position]?.maxWidth;
            let legacyLineWidth = undefined;
            if (Array.isArray(displayText[position])) {
                for (const line of displayText[position]) {
                    if (line && line.maxWidth) {
                        legacyLineWidth = line.maxWidth;
                        break;
                    }
                }
            }
            displayText.maxWidth[position] = legacyArrayWidth || legacyLineWidth || "50%";
        }
    }
    store.set('displayText', displayText);
    store.set('randomSpeed', store.get('randomSpeed') ?? 30);
    store.set('videoQuality', store.get('videoQuality') ?? false);
    store.set('modernTransitions', store.get('modernTransitions') ?? true);
    store.set('fps', store.get('fps') ?? 60);

    //config
    store.set('version', app.getVersion());
    store.set("configured", true);
}

//setUpConfigFile();

//check for update on GitHub
function checkForUpdate() {
    store.set('updateAvailable', false);
    if (!app.isPackaged) {
        return;
    }

    const branches = ["main", "master"];
    const fetchBranchPackage = (index) => {
        if (index >= branches.length) {
            console.log(`Error checking for updates: unable to read package.json from ${appRepoUrl} (main/master).`);
            return;
        }

        const branch = branches[index];
        const packageUrl = `https://raw.githubusercontent.com/${appRepo}/${branch}/package.json`;
        https.get(packageUrl, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                fetchBranchPackage(index + 1);
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });

            response.on('end', () => {
                try {
                    const onlinePackage = JSON.parse(body);
                    if (!onlinePackage.version) {
                        return;
                    }
                    if (compareSemver(onlinePackage.version, app.getVersion()) > 0) {
                        store.set('updateAvailable', onlinePackage.version);
                        new Notification({
                            title: "An update for Aerial is available",
                            body: `Version ${onlinePackage.version} is available for download. Visit ${appReleasesUrl} to update Aerial.`
                        }).show();
                    }
                } catch (error) {
                    console.log("Error parsing update response:", error);
                }
            });
        }).on('error', () => {
            fetchBranchPackage(index + 1);
        });
    };

    fetchBranchPackage(0);
}

//events from browser windows
ipcMain.on('quitApp', (event, arg) => {
    quitApp();
});

ipcMain.on('keyPress', (event, key) => {
    if (store.get('skipVideosWithKey')) {
        if (key === store.get('skipKey')) {
            for (let i = 0; i < screens.length; i++) {
                screens[i].webContents.send('newVideo', 'next');
            }
            return;
        }
        if (key === store.get('previousSkipKey')) {
            for (let i = 0; i < screens.length; i++) {
                screens[i].webContents.send('newVideo', 'previous');
            }
            return;
        }
    }
    quitApp();
});

ipcMain.on('updateCache', (event) => {
    const path = cachePath;
    let videoList = [];
    fs.readdir(path, (err, files) => {
        files.forEach(file => {
            if (file.includes('.mov')) {
                videoList.push(file.slice(0, file.length - 4));
            }
        });
        if (!downloading) {
            store.set('downloadedVideos', videoList);
        }
        store.set('videoCacheSize', getCacheSize());
        event.reply('displaySettings');
    });
    updateCustomVideos();
});

ipcMain.on('deleteCache', (event) => {
    removeAllVideosInCache();
    event.reply('displaySettings');
});

ipcMain.on('openCache', (event) => {
    shell.openExternal(cachePath);
});

ipcMain.on('openConfigFolder', (event) => {
    shell.openExternal(app.getPath('userData'));
});

ipcMain.on('openPlaybackLog', () => {
    const logPath = path.join(app.getPath('userData'), "aerial-debug.log");
    if (fs.existsSync(logPath)) {
        shell.openPath(logPath);
        return;
    }
    shell.openExternal(app.getPath('userData'));
});

ipcMain.on('selectCustomLocation', async (event, arg) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showOpenDialog(ownerWindow, {
        properties: ['openDirectory']
    });
    const path = result.filePaths[0];
    let videoList = [];
    videoList.path = path;
    fs.readdir(path, (err, files) => {
        files.forEach(file => {
            if (file.includes('.mp4') || file.includes('.webm') || file.includes('.ogv')) {
                videoList.push(file);
            }
        });
        event.reply('newCustomVideos', videoList, path);
    });
    //event.reply('filePath', result.filePaths);
});

ipcMain.on('selectCacheLocation', async (event, arg) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showOpenDialog(ownerWindow, {
        properties: ['openDirectory']
    });
    const newPath = result.filePaths[0];
    //removeAllVideosInCache();
    if (newPath != undefined) {
        cachePath = newPath;
        store.set('cachePath', newPath);
        fs.mkdirSync(path.join(store.get('cachePath'), "temp"));
        updateVideoCache(() => {
            event.reply('displaySettings');
        });
    }
});

ipcMain.on('refreshCache', (event) => {
    if (store.get('immediatelyUpdateVideoCache')) {
        if (!downloading) {
            downloadVideos();
        }
        if (store.get('videoCacheRemoveUnallowed')) {
            removeAllUnallowedVideosInCache();
            removeAllNeverAllowedVideosInCache();
        }
    }
});

ipcMain.on('selectFile', async (event, args) => {
    let type = args[0];
    let position = args[1];
    let line = args[2];
    const filters = {
        'image': {name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'gif']}
    };
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    dialog.showOpenDialog(ownerWindow, {
        properties: ['openFile'],
        filters: [filters[type]]
    }).then(result => {
        if (!result.canceled) {
            let displayText = store.get('displayText');
            displayText[position][line].imagePath = result.filePaths[0];
            store.set('displayText', displayText);
            event.reply('updateAttribute', ['imageFileName', result.filePaths[0]]);
        }
    });
});

ipcMain.on('openPreview', (event) => {
    createSSPWindow(process.argv);
});

ipcMain.on('openInfoEditor', (event) => {
    createEditWindow(process.argv);
});

ipcMain.on('refreshConfig', (event) => {
    setUpConfigFile();
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.close();
    }
    createConfigWindow();
});

ipcMain.on('resetConfig', (event) => {
    fs.unlink(`${app.getPath('userData')}/config.json`, err => {
    });
    setUpConfigFile();
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.close();
    }
    createConfigWindow();
    //app.quit();
});

ipcMain.on('updateLocation', (event) => {
    calculateAstronomy();
    if (astronomy.calculated) {
        store.set('sunrise', (astronomy.sunrise.getHours() < 10 ? '0' : "") + astronomy.sunrise.getHours() + ':' + (astronomy.sunrise.getMinutes() < 10 ? '0' : "") + astronomy.sunrise.getMinutes());
        store.set('sunset', (astronomy.sunset.getHours() < 10 ? '0' : "") + astronomy.sunset.getHours() + ':' + (astronomy.sunset.getMinutes() < 10 ? '0' : "") + astronomy.sunset.getMinutes());
        event.reply('displaySettings');
    }
});

ipcMain.handle('newVideoId', (event, payload) => {
    const request = typeof payload === "string" ? {lastPlayed: payload, direction: "next"} : (payload ?? {});
    const lastPlayed = request.lastPlayed ?? "";
    const direction = request.direction ?? "next";

    if (currentlyPlaying === '') {
        onFirstVideoPlayed();
    }

    if (direction === "previous") {
        if (currentlyPlaying && lastPlayed !== currentlyPlaying) {
            return currentlyPlaying;
        }
        const previous = getPreviousVideoFromHistory();
        if (previous) {
            currentlyPlaying = previous;
            return currentlyPlaying;
        }
        return currentlyPlaying || lastPlayed;
    }

    function newId() {
        let id = "";
        if (store.get('timeOfDay')) {
            let time = getTimeOfDay();
            if (tod[time].length > 0) {
                id = tod[time][randomInt(0, tod[time].length - 1)];
            }
        } else {
            if (allowedVideos.length > 0) {
                id = allowedVideos[randomInt(0, allowedVideos.length - 1)];
            }
        }
        if (!id) {
            return currentlyPlaying || "";
        }
        if (store.get('avoidDuplicateVideos') && allowedVideos.length > 6) {
            if (previouslyPlayed.includes(id)) {
                return newId();
            } else {
                previouslyPlayed.push(id);
                if (previouslyPlayed.length > (allowedVideos.length * .3)) {
                    previouslyPlayed.shift();
                }
            }
        }
        return id;
    }

    if (store.get('sameVideoOnScreens')) {
        if (currentlyPlaying !== lastPlayed) {
            return currentlyPlaying
        }
    }
    currentlyPlaying = newId();
    pushVideoToHistory(currentlyPlaying);
    return currentlyPlaying;
})

ipcMain.on('newGlobalShortcut', (event) => {
    setupGlobalShortcut();
});

ipcMain.on('consoleLog', (event, msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    if (store.get('debugPlayback')) {
        fs.appendFile(path.join(app.getPath('userData'), "aerial-debug.log"), `${line}\n`, () => {
        });
    }
});

//events from the system
powerMonitor.on('resume', () => {
    //let Aerial know that the system has been woken up so it can run again
    isComputerSleeping = false;
    isComputerSuspendedOrLocked = false;
    closeAllWindows();
});

powerMonitor.on('suspend', () => {
    isComputerSuspendedOrLocked = true;
    closeAllWindows();
});

powerMonitor.on('lock-screen', () => {
    isComputerSuspendedOrLocked = true;
    closeAllWindows();
});

powerMonitor.on('unlock-screen', () => {
    isComputerSuspendedOrLocked = false;
    closeAllWindows();
});

//let Aerial load the video with Apple's self-signed cert
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (url.match(/^https:\/\/sylvan.apple.com/) !== null) {
        event.preventDefault();
        callback(true)
    } else {
        callback(false)
    }
});

function setupGlobalShortcut() {
    globalShortcut.unregisterAll();
    if (store.get("enableGlobalShortcut")) {
        globalShortcut.register(`${store.get("globalShortcutModifier1") + store.get("globalShortcutModifier2")}+${store.get("globalShortcutKey")}`, () => {
            createSSWindow();
        })
    }
}

//video functions
function updateCustomVideos() {
    let allowedVideos = store.get('allowedVideos');
    let customVideos = store.get('customVideos');
    const knownIds = new Set(getVideoCatalog().map((video) => video.id));
    for (let i = 0; i < allowedVideos.length; i++) {
        if (allowedVideos[i][0] === "_") {
            let index = customVideos.findIndex((e) => {
                if (allowedVideos[i] === e.id) {
                    return true;
                }
            });
            if (index === -1) {
                allowedVideos.splice(i, 1);
                i--;
            }
        } else if (!knownIds.has(allowedVideos[i])) {
            allowedVideos.splice(i, 1);
            i--;
        }
    }
    store.set('allowedVideos', allowedVideos);
}

function downloadFile(file_url, targetPath, callback) {
    let receivedBytes = 0;
    let totalBytes = 0;

    const url = new URL(file_url);
    const agent = new https.Agent({
        host: url.hostname,
        rejectUnauthorized: false
    });

    const request = https.get(url, {agent}, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            downloadFile(response.headers.location, targetPath, callback);
            return;
        }

        if (response.statusCode !== 200) {
            response.resume();
            callback(false);
            return;
        }

        totalBytes = Number(response.headers['content-length']) || 0;
        const output = fs.createWriteStream(targetPath);

        response.on('data', (chunk) => {
            receivedBytes += chunk.length;
            showProgress(receivedBytes, totalBytes);
        });

        output.on('finish', () => {
            output.close(() => callback(true));
        });

        output.on('error', () => {
            output.destroy();
            callback(false);
        });

        response.on('error', () => {
            output.destroy();
            callback(false);
        });

        response.pipe(output);
    });

    request.on('error', () => callback(false));

    function showProgress(received, total) {
        const percentage = total > 0 ? (received * 100) / total : 0;
        return percentage;
    }
}

function downloadVideos() {
    const videos = getVideoCatalog();
    let allowedVideos = getVideosToDownload();
    let downloadedVideos = store.get('downloadedVideos') ?? [];
    let flag = false;
    for (let i = 0; i < allowedVideos.length; i++) {
        if (!downloadedVideos.includes(allowedVideos[i]) && allowedVideos[i][0] !== "_") {
            flag = true;
            let index = videos.findIndex((v) => {
                if (allowedVideos[i] === v.id) {
                    return true;
                }
            });
            if (index === -1) {
                continue;
            }
            const videoSource = getVideoSource(videos[index], store.get('videoFileType'));
            if (!videoSource) {
                continue;
            }
            //console.log(allowedVideos[i]);
            //console.log(`Downloading ${videos[index].name}`);
            downloadFile(videoSource, `${cachePath}/temp/${allowedVideos[i]}.mov`, (downloadSuccessful) => {
                if (!downloadSuccessful) {
                    downloadVideos();
                    return;
                }
                fs.copyFileSync(`${cachePath}/temp/${allowedVideos[i]}.mov`, `${cachePath}/${allowedVideos[i]}.mov`);
                fs.unlink(`${cachePath}/temp/${allowedVideos[i]}.mov`, (err) => {
                });
                downloadedVideos.push(allowedVideos[i]);
                store.set('downloadedVideos', downloadedVideos);
                store.set('videoCacheSize', getCacheSize());
                downloadVideos();
            });
            break;
        }
    }
    downloading = flag;
}

function getVideosToDownload() {
    let allowedVideos = store.get('videoCache') ? store.get('allowedVideos') : [];
    store.get('alwaysDownloadVideos').forEach(e => {
        allowedVideos.push(e);
    });
    if (store.get("videoCacheProfiles") && store.get('videoCache')) {
        store.get('videoProfiles').forEach(e => {
            allowedVideos.push(...e.videos);
        });
    }
    allowedVideos = allowedVideos.filter(function (item, pos, self) {
        return self.indexOf(item) === pos;
    });
    store.get('neverDownloadVideos').forEach(e => {
        if (allowedVideos.includes(e)) {
            allowedVideos.splice(allowedVideos.indexOf(e), 1);
        }
    });
    return allowedVideos;
}

//cache functions
function getAllFilesInCache() {
    if (!fs.existsSync(cachePath)) {
        return [];
    }
    return fs.readdirSync(cachePath);
}

function getCacheSize() {
    let totalSize = 0;
    getAllFilesInCache().forEach(function (filePath) {
        if (fs.existsSync(`${cachePath}/${filePath}`)) {
            totalSize += fs.statSync(`${cachePath}/${filePath}`).size;
        }
    });
    return totalSize;
}

function removeAllVideosInCache() {
    getAllFilesInCache().forEach(file => {
        if (fs.existsSync(`${cachePath}/${file}`)) {
            fs.unlink(`${cachePath}/${file}`, (err) => {
            });
        }
    });
    store.set('videoCacheSize', getCacheSize());
}

function removeAllUnallowedVideosInCache() {
    let allowedVideos = getVideosToDownload();
    let downloadedVideos = store.get('downloadedVideos') ?? [];
    for (let i = 0; i < downloadedVideos.length; i++) {
        if (!allowedVideos.includes(downloadedVideos[i])) {
            fs.unlink(`${cachePath}/${downloadedVideos[i]}.mov`, (err) => {
            });
        }
    }
    updateVideoCache();
}

function removeAllNeverAllowedVideosInCache() {
    let neverAllowedVideos = store.get('neverDownloadVideos');
    let downloadedVideos = store.get('downloadedVideos') ?? [];
    for (let i = 0; i < downloadedVideos.length; i++) {
        if (neverAllowedVideos.includes(downloadedVideos[i])) {
            fs.unlink(`${cachePath}/${downloadedVideos[i]}.mov`, (err) => {
            });
            downloadedVideos.splice(i, 1);
            i--;
        }
    }
    store.set('videoCacheSize', getCacheSize());
}

function updateVideoCache(callback) {
    let videoList = [];
    fs.readdir(cachePath, (err, files) => {
        if (err || !files) {
            if (callback) {
                callback();
            }
            return;
        }
        files.forEach(file => {
            if (file.includes('.mov')) {
                videoList.push(file.slice(0, file.length - 4));
            }
        });
        if (!downloading) {
            store.set('downloadedVideos', videoList);
        }
        store.set('videoCacheSize', getCacheSize());
        if (callback) {
            callback();
        }
    });
}

function clearCacheTemp() {
    if (!fs.existsSync(`${app.getPath('userData')}/videos/`)) {
        fs.mkdirSync(`${app.getPath('userData')}/videos/`);
    }
    if (!fs.existsSync(`${app.getPath('userData')}/videos/temp`)) {
        fs.mkdirSync(`${app.getPath('userData')}/videos/temp`);
    }
    if(!fs.existsSync(cachePath + "\\temp")){
        fs.mkdirSync(cachePath + "\\temp");
    }
    let dir = fs.readdirSync(cachePath + "\\temp").forEach(file => {
        if (fs.existsSync(`${cachePath}/temp/${file}`)) {
            fs.unlink(`${cachePath}/temp/${file}`, (err) => {
            });
        }
    });
}

//open & close functions
function quitApp() {
    if (exitingScreensaverWindows) {
        logLifecycle("quitApp:ignored-reentry");
        return;
    }
    logLifecycle("quitApp:requested", {
        nq,
        useTray: store.get('useTray'),
        screensCount: screens.length,
        trayWindowExists: Boolean(trayWindow && !trayWindow.isDestroyed()),
        trayIconExists: Boolean(trayIcon)
    });
    if (!nq) {
        //app.quit();
        if (store.get("lockAfterRun") && (new Date() - startTime) / 1000 > store.get("lockAfterRunAfter")) {
            lockComputer();
        }
        exitingScreensaverWindows = true;
        logLifecycle("quitApp:closeAllWindows");
        closeAllWindows();
        if (store.get('useTray') && !launchedAsScreensaverSession) {
            createTrayWindow();
            setTimeout(() => {
                createTrayWindow();
            }, 200);
        }
        setTimeout(() => {
            exitingScreensaverWindows = false;
            logLifecycle("quitApp:exitingScreensaverWindows-reset");
        }, 1000);
        currentlyPlaying = '';
        resetPlaybackHistory();
    }
}

function closeAllWindows() {
    logLifecycle("closeAllWindows:start", {trackedScreens: screens.length});
    const windowsToClose = [...screens];
    for (let i = 0; i < windowsToClose.length; i++) {
        if (!windowsToClose[i].isDestroyed()) {
            windowsToClose[i].destroy();
        }
    }
    screens = [];
    screenIds = [];
    logLifecycle("closeAllWindows:done");
}

function sleepComputer() {
    if (preview) {
        return
    }
    closeAllWindows();
    exec("rundll32.exe powrprof.dll, SetSuspendState Sleep");
    isComputerSleeping = true;
}

function lockComputer() {
    if (preview) {
        return
    }
    exec("Rundll32.exe user32.dll,LockWorkStation");
}

//idle startup timer
async function launchScreensaver() {
    if (launchScreensaverBusy) {
        return;
    }
    launchScreensaverBusy = true;
    let startAfter = store.get('startAfter');
    try {
        //console.log(screens.length,powerMonitor.getSystemIdleTime(),store.get('startAfter') * 60)
        if (screens.length === 0 && !suspend && !isComputerSleeping && !isComputerSuspendedOrLocked && startAfter > 0) {
            //let idleTime = powerMonitor.getSystemIdleTime();
            if (powerMonitor.getSystemIdleState(startAfter * 60) === "idle" && getWakeLock()) {
                if (!store.get("runOnBattery")) {
                    if (powerMonitor.isOnBatteryPower()) {
                        return;
                    }
                }
                if (store.get("disableWhenFullscreenAppActive") && await isFullscreenAppActive()) {
                    return;
                }
                createSSWindow();
            }
        }
    } finally {
        launchScreensaverBusy = false;
    }
}

setInterval(() => {
    launchScreensaver().catch((error) => {
        console.log("launchScreensaver error", error);
    });
}, 5000);

function onFirstVideoPlayed() {
    let startTime = new Date();
    setTimeOfDayList();
    if (store.get('blankScreen')) {
        let interval = setInterval(() => {
            if (screens.length === 0) {
                clearTimeout(interval);
                return;
            }
            if (new Date() - startTime >= store.get('blankAfter') * 60 * 1000) {
                blankScreensaver();
            }
        }, 30000);
    }
}

function blankScreensaver() {
    for (let i = 0; i < screens.length; i++) {
        screens[i].webContents.send('blankTheScreen');
        if (store.get('sleepAfterBlank')) {
            //sleep the computer after a few seconds of blank screen
            setTimeout(() => {
                sleepComputer()
            }, store.get('videoTransitionLength') * 3)
        }
    }
}

//Time of day code functions
function setTimeOfDayList() {
    tod = {"day": [], "night": [], "none": []};
    if (store.get('timeOfDay')) {
        const videos = getVideoCatalog();
        for (let i = 0; i < allowedVideos.length; i++) {
            let index = videos.findIndex((e) => {
                if (allowedVideos[i] === e.id) {
                    return true;
                }
            });
            //some people seem to be getting errors where video[index] doesn't exit, this line will fix it.
            if (videos[index]) {
                switch (videos[index].timeOfDay) {
                    case "day":
                        tod.day.push(allowedVideos[i]);
                        break;
                    case "night":
                        tod.night.push(allowedVideos[i]);
                        break;
                    default:
                        tod.none.push(allowedVideos[i]);
                }
            }
            if (tod.day.length <= 3) {
                tod.day.push(...tod.none);
            }
            if (tod.night.length <= 3) {
                tod.night.push(...tod.none);
            }
        }
    }
}

setTimeOfDayList();

function getTimeOfDay() {
    let cHour = new Date().getHours();
    let cMin = new Date().getMinutes();
    let sunriseHour = store.get('sunrise').substring(0, 2);
    let sunriseMinute = store.get('sunrise').substring(3, 5);
    let sunsetHour = store.get('sunset').substring(0, 2);
    let sunsetMinute = store.get('sunset').substring(3, 5);
    let time = "night";
    if ((cHour === sunriseHour && cMin >= sunriseMinute) || (cHour > sunriseHour && cHour < sunsetHour) || (cHour === sunsetHour && cMin < sunsetMinute)) {
        time = "day";
    }
    return time;
}

//astronomy code
function calculateAstronomy() {
    if (store.get('latitude') !== "" && store.get('longitude') !== "") {
        let sunTimes = SunCalc.getTimes(new Date(), store.get('latitude'), store.get('longitude'));
        let moonTimes = SunCalc.getMoonTimes(new Date(), store.get('latitude'), store.get('longitude'))
        astronomy.sunrise = sunTimes.sunrise;
        astronomy.sunset = sunTimes.sunset;
        astronomy.moonrise = moonTimes.rise;
        astronomy.moonset = moonTimes.set;
        astronomy.calculated = true;
        store.set('astronomy', astronomy);
    }
}

//check the system to see if any app is requesting the system to not sleep
//Requires admin privileges to run
function getWakeLock() {
    if (admin) {
        exec('powercfg /requests', function (error, stdout, stderr) {
                if (error) {
                    console.log(error);
                    return true;
                }
                return stdout.match(/None./g).length !== 6;
            }
        );
    } else {
        return true;
    }
}

//helper functions
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
