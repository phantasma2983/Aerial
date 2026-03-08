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
    globalShortcut,
    clipboard
} = require('electron');
const {exec, execFile, execFileSync} = require('child_process');
const bundledVideos = require("./videos.json");
const packageMetadata = require("./package.json");
const https = require('https');
const fs = require('fs');
const path = require("path");
const AutoLaunch = require('auto-launch');
const {getVideoSource, sanitizeExtraVideo} = require('./shared/video-utils');
const APP_ICON_PATH = path.join(__dirname, 'icon.ico');
const APP_USER_MODEL_ID = "com.phantasma2983.aerial";
const LEGACY_UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\17c6ea6b-270a-5297-8e23-9bcda4a29a48";
const APPID_UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7d047ff4-f1b4-58c5-a9ab-6eaec19eeed0";

if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
}

function applyWindowsAppDetails(win) {
    if (process.platform !== "win32") {
        return;
    }
    if (typeof win.setAppDetails !== "function") {
        return;
    }
    win.setAppDetails({
        appId: APP_USER_MODEL_ID,
        appIconPath: APP_ICON_PATH,
        appIconIndex: 0,
        relaunchDisplayName: "Aerial"
    });
}

let autoLauncher = new AutoLaunch({
    name: 'Aerial',
});
const SunCalc = require('suncalc');

const UPSTREAM_REPO_URL = "https://github.com/OrangeJedi/Aerial";
let store;
let weatherDataRequest = null;

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
const DEBUG_LOG_FILE = "aerial-debug.log";
const MAX_LIFECYCLE_LOG_BYTES = 50 * 1024 * 1024;
const MAX_DEBUG_LOG_BYTES = 100 * 1024 * 1024;
const WEATHER_API_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const WEATHER_CACHE_TTL_MS = 20 * 60 * 1000;
const CONFIG_BACKUP_DIR_NAME = "config-backups";
const CONFIG_FILE_FILTERS = [{name: "Aerial Config", extensions: ["json"]}];
const EXPORTED_CONFIG_EXCLUDED_KEYS = new Set([
    "configured",
    "version",
    "numDisplays",
    "repositoryUrl",
    "releasesUrl",
    "wikiUrl",
    "licenseUrl",
    "upstreamRepositoryUrl",
    "updateAvailable",
    "latestReleaseVersion",
    "latestReleasePublishedAt",
    "latestReleaseNotes",
    "latestReleaseUrl",
    "latestReleaseName",
    "videoCacheSize",
    "downloadedVideos",
    "videoCatalog",
    "astronomy",
    "weatherData",
    "lastConfigBackupPath",
    "lastConfigBackupCreatedAt"
]);

function appendBoundedLogLine(fileName, line, maxBytes) {
    const logPath = path.join(app.getPath('userData'), fileName);
    const payload = `${line}\n`;
    try {
        const currentSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
        const payloadBytes = Buffer.byteLength(payload, "utf8");
        if (currentSize + payloadBytes > maxBytes) {
            const allowedBytes = Math.max(0, maxBytes - payloadBytes);
            if (allowedBytes === 0) {
                fs.writeFileSync(logPath, "");
            } else {
                const start = Math.max(0, currentSize - allowedBytes);
                const fd = fs.openSync(logPath, "r");
                try {
                    const buffer = Buffer.alloc(allowedBytes);
                    const bytesRead = fs.readSync(fd, buffer, 0, allowedBytes, start);
                    let tail = buffer.subarray(0, bytesRead).toString("utf8");
                    const firstNewline = tail.indexOf("\n");
                    if (start > 0 && firstNewline !== -1) {
                        tail = tail.slice(firstNewline + 1);
                    }
                    fs.writeFileSync(logPath, tail, "utf8");
                } finally {
                    fs.closeSync(fd);
                }
            }
        }
    } catch {
        // best-effort diagnostics only
    }
    fs.appendFileSync(logPath, payload);
}

function getWeatherUnavailableSnapshot(message, latitude = null, longitude = null) {
    return {
        available: false,
        stale: false,
        error: message,
        fetchedAt: "",
        latitude,
        longitude,
        source: "open-meteo",
        temperatureC: null,
        temperatureF: null,
        windSpeedKmh: null,
        weatherCode: null,
        isDay: true
    };
}

function buildWeatherUrl(latitude, longitude) {
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m,weather_code,is_day,wind_speed_10m",
        wind_speed_unit: "kmh",
        timezone: "auto"
    });
    return `${WEATHER_API_BASE_URL}?${params.toString()}`;
}

function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                "User-Agent": "Aerial",
                ...headers
            }
        }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Request failed with status ${response.statusCode}.`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on("error", reject);
    });
}

function normalizeWeatherSnapshot(payload, latitude, longitude) {
    const current = payload?.current;
    if (!current) {
        throw new Error("Weather response did not include current conditions.");
    }
    const temperatureC = Number(current.temperature_2m);
    const weatherCode = Number(current.weather_code);
    const isDay = Number(current.is_day) === 1;
    const windSpeedKmh = Number(current.wind_speed_10m);
    if (!Number.isFinite(temperatureC) || !Number.isFinite(weatherCode)) {
        throw new Error("Weather response was missing temperature or weather code.");
    }
    return {
        available: true,
        stale: false,
        error: "",
        fetchedAt: new Date().toISOString(),
        latitude,
        longitude,
        source: "open-meteo",
        temperatureC: Number(temperatureC.toFixed(1)),
        temperatureF: Number((((temperatureC * 9) / 5) + 32).toFixed(1)),
        windSpeedKmh: Number.isFinite(windSpeedKmh) ? Number(windSpeedKmh.toFixed(1)) : null,
        weatherCode,
        isDay
    };
}

function getStoredWeatherSnapshot() {
    const snapshot = store.get("weatherData");
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        return null;
    }
    return snapshot;
}

function shouldRefreshWeather(snapshot, latitude, longitude, force = false) {
    if (force || !snapshot || !snapshot.fetchedAt) {
        return true;
    }
    if (Number(snapshot.latitude) !== latitude || Number(snapshot.longitude) !== longitude) {
        return true;
    }
    const fetchedAt = Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(fetchedAt)) {
        return true;
    }
    return (Date.now() - fetchedAt) >= WEATHER_CACHE_TTL_MS;
}

async function getWeatherData(force = false) {
    const latitude = Number(store.get("latitude"));
    const longitude = Number(store.get("longitude"));
    const storedSnapshot = getStoredWeatherSnapshot();
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        const unavailable = storedSnapshot?.available
            ? {
                ...storedSnapshot,
                stale: true,
                error: "Set latitude and longitude in Settings > Time & Location to enable weather."
            }
            : getWeatherUnavailableSnapshot("Set latitude and longitude in Settings > Time & Location to enable weather.");
        store.set("weatherData", unavailable);
        return unavailable;
    }
    if (!shouldRefreshWeather(storedSnapshot, latitude, longitude, force)) {
        return storedSnapshot;
    }
    if (weatherDataRequest) {
        return weatherDataRequest;
    }
    weatherDataRequest = (async () => {
        try {
            const payload = await fetchJson(buildWeatherUrl(latitude, longitude));
            const snapshot = normalizeWeatherSnapshot(payload, latitude, longitude);
            store.set("weatherData", snapshot);
            return snapshot;
        } catch (error) {
            if (storedSnapshot?.available) {
                const staleSnapshot = {
                    ...storedSnapshot,
                    stale: true,
                    error: error?.message ?? String(error)
                };
                store.set("weatherData", staleSnapshot);
                return staleSnapshot;
            }
            const unavailable = getWeatherUnavailableSnapshot(error?.message ?? String(error), latitude, longitude);
            store.set("weatherData", unavailable);
            return unavailable;
        } finally {
            weatherDataRequest = null;
        }
    })();
    return weatherDataRequest;
}

function getLogFilePath(fileName) {
    return path.join(app.getPath('userData'), fileName);
}

function getLogSummary(fileName) {
    const logPath = getLogFilePath(fileName);
    if (!fs.existsSync(logPath)) {
        return {
            fileName,
            path: logPath,
            exists: false,
            size: 0,
            modifiedAt: ""
        };
    }
    const stats = fs.statSync(logPath);
    return {
        fileName,
        path: logPath,
        exists: true,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString()
    };
}

function getLogDiagnostics() {
    return {
        lifecycle: getLogSummary(LIFECYCLE_LOG_FILE),
        playback: getLogSummary(DEBUG_LOG_FILE)
    };
}

function openLogFile(fileName) {
    const logPath = getLogFilePath(fileName);
    if (fs.existsSync(logPath)) {
        shell.openPath(logPath);
        return;
    }
    shell.openExternal(app.getPath('userData'));
}

function deleteLogFile(fileName) {
    const logPath = getLogFilePath(fileName);
    if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
    }
}

function clearLogFile(fileName) {
    fs.writeFileSync(getLogFilePath(fileName), "", "utf8");
}

function runStartupMigrations(previousVersion) {
    if (!previousVersion) {
        return;
    }
    if (compareSemver(previousVersion, "1.3.8") < 0 && compareSemver(app.getVersion(), "1.3.8") >= 0) {
        try {
            deleteLogFile(LIFECYCLE_LOG_FILE);
            deleteLogFile(DEBUG_LOG_FILE);
        } catch {
            // best-effort cleanup only
        }
    }
}

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
        appendBoundedLogLine(LIFECYCLE_LOG_FILE, line, MAX_LIFECYCLE_LOG_BYTES);
    } catch {
        // best-effort diagnostics only
    }
}

function syncWindowsUninstallRegistration() {
    if (process.platform !== "win32" || !app.isPackaged) {
        return;
    }

    const regExe = path.join(process.env.windir || "C:\\Windows", "System32", "reg.exe");
    const uninstallerPath = path.join(path.dirname(process.execPath), "Uninstall Aerial.exe");
    if (!fs.existsSync(uninstallerPath)) {
        return;
    }

    const readRegValue = (key, name) => {
        try {
            const output = execFileSync(regExe, ["query", key, "/v", name], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const match = output.match(new RegExp(`\\s${name}\\s+REG_\\w+\\s+(.+)$`, "m"));
            return match ? match[1].trim() : "";
        } catch {
            return "";
        }
    };

    const writeRegValue = (key, name, type, value) => {
        execFileSync(regExe, ["add", key, "/v", name, "/t", type, "/d", String(value), "/f"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
    };

    try {
        const uninstallString = `"${uninstallerPath}" /currentuser`;
        const quietUninstallString = `"${uninstallerPath}" /currentuser /S`;
        const publisher = readRegValue(LEGACY_UNINSTALL_KEY, "Publisher")
            || readRegValue(APPID_UNINSTALL_KEY, "Publisher")
            || "phantasma2983";
        const staleExists = readRegValue(APPID_UNINSTALL_KEY, "UninstallString") !== "";

        writeRegValue(LEGACY_UNINSTALL_KEY, "DisplayName", "REG_SZ", `Aerial ${app.getVersion()}`);
        writeRegValue(LEGACY_UNINSTALL_KEY, "DisplayVersion", "REG_SZ", app.getVersion());
        writeRegValue(LEGACY_UNINSTALL_KEY, "UninstallString", "REG_SZ", uninstallString);
        writeRegValue(LEGACY_UNINSTALL_KEY, "QuietUninstallString", "REG_SZ", quietUninstallString);
        writeRegValue(LEGACY_UNINSTALL_KEY, "DisplayIcon", "REG_SZ", `${process.execPath},0`);
        writeRegValue(LEGACY_UNINSTALL_KEY, "Publisher", "REG_SZ", publisher);
        writeRegValue(LEGACY_UNINSTALL_KEY, "NoModify", "REG_DWORD", 1);
        writeRegValue(LEGACY_UNINSTALL_KEY, "NoRepair", "REG_DWORD", 1);

        if (staleExists) {
            execFileSync(regExe, ["delete", APPID_UNINSTALL_KEY, "/f"], {
                stdio: ["ignore", "ignore", "ignore"],
            });
        }
    } catch (error) {
        logLifecycle("windows-uninstall-sync-failed", {
            message: error?.message ?? String(error),
        });
    }
}

function broadcastRendererEvent(channel, ...args) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send(channel, ...args);
        }
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

function createRuntimeId(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getKnownCatalogVideoIds() {
    return new Set(getVideoCatalog().map((video) => video.id));
}

function sanitizeProfileVideoIds(videoIds) {
    const knownIds = getKnownCatalogVideoIds();
    if (!Array.isArray(videoIds)) {
        return [];
    }
    return Array.from(new Set(videoIds.filter((videoId) => (
        typeof videoId === "string" &&
        !videoId.startsWith("_") &&
        knownIds.has(videoId)
    ))));
}

function sanitizeFavoriteVideoIds(videoIds) {
    const knownIds = getKnownCatalogVideoIds();
    if (!Array.isArray(videoIds)) {
        return [];
    }
    return Array.from(new Set(videoIds.filter((videoId) => (
        typeof videoId === "string" &&
        knownIds.has(videoId)
    ))));
}

function normalizeVideoProfiles(profiles) {
    const source = Array.isArray(profiles) ? profiles : [];
    const usedIds = new Set();
    return source.map((profile, index) => {
        const normalized = profile && typeof profile === "object" ? profile : {};
        let id = typeof normalized.id === "string" ? normalized.id.trim() : "";
        if (!id || usedIds.has(id)) {
            id = createRuntimeId("profile");
        }
        usedIds.add(id);
        const name = String(normalized.name ?? "").trim() || `Profile ${index + 1}`;
        return {
            id,
            name,
            videos: sanitizeProfileVideoIds(normalized.videos)
        };
    });
}

function syncVideoProfiles() {
    const profiles = normalizeVideoProfiles(store.get("videoProfiles") ?? []);
    store.set("videoProfiles", profiles);
    let defaultId = String(store.get("videoProfileDefaultId") ?? "").trim();
    if (!profiles.some((profile) => profile.id === defaultId)) {
        defaultId = "";
    }
    store.set("videoProfileDefaultId", defaultId);
    store.set("videoProfileAutoApplyOnLaunch", store.get("videoProfileAutoApplyOnLaunch") ?? false);
    return profiles;
}

function getDefaultVideoProfile() {
    const profiles = syncVideoProfiles();
    const defaultId = String(store.get("videoProfileDefaultId") ?? "").trim();
    return profiles.find((profile) => profile.id === defaultId) ?? null;
}

function applyDefaultVideoProfileOnLaunch() {
    if (!store.get("videoProfileAutoApplyOnLaunch")) {
        return false;
    }
    const profile = getDefaultVideoProfile();
    if (!profile) {
        return false;
    }
    const customAllowed = (store.get("allowedVideos") ?? []).filter((videoId) => typeof videoId === "string" && videoId.startsWith("_"));
    const merged = Array.from(new Set([...profile.videos, ...customAllowed]));
    store.set("allowedVideos", merged);
    allowedVideos = merged;
    return true;
}

function getConfigExportData() {
    const snapshot = JSON.parse(JSON.stringify(store.store ?? {}));
    for (const key of EXPORTED_CONFIG_EXCLUDED_KEYS) {
        delete snapshot[key];
    }
    return snapshot;
}

function buildConfigPayload(reason) {
    return {
        app: "Aerial",
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        reason,
        version: app.getVersion(),
        config: getConfigExportData()
    };
}

function writeJsonFile(filePath, payload) {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getConfigBackupDirectory() {
    const backupDirectory = path.join(app.getPath("userData"), CONFIG_BACKUP_DIR_NAME);
    fs.mkdirSync(backupDirectory, {recursive: true});
    return backupDirectory;
}

function createConfigBackup(reason = "manual") {
    const backupDirectory = getConfigBackupDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(backupDirectory, `aerial-config-backup-${timestamp}.json`);
    const payload = buildConfigPayload(reason);
    writeJsonFile(filePath, payload);
    store.set("lastConfigBackupPath", filePath);
    store.set("lastConfigBackupCreatedAt", payload.exportedAt);
    return {
        filePath,
        createdAt: payload.exportedAt,
        reason
    };
}

function getBackupSummary() {
    const backupDirectory = getConfigBackupDirectory();
    const files = fs.readdirSync(backupDirectory)
        .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
        .map((fileName) => {
            const filePath = path.join(backupDirectory, fileName);
            const stats = fs.statSync(filePath);
            return {
                fileName,
                filePath,
                createdAt: stats.mtime.toISOString(),
                size: stats.size
            };
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
        directory: backupDirectory,
        totalBackups: files.length,
        latestBackup: files[0] ?? null
    };
}

function loadConfigPayloadFromFile(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const config = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.config && typeof parsed.config === "object"
        ? parsed.config
        : parsed;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("The selected file does not contain a valid Aerial config export.");
    }
    return config;
}

function importConfigPayload(config) {
    store.clear();
    for (const [key, value] of Object.entries(config)) {
        store.set(key, value);
    }
    setUpConfigFile();
    calculateAstronomy();
    cachePath = store.get("cachePath") ?? path.join(app.getPath("userData"), "videos");
    allowedVideos = store.get("allowedVideos") ?? [];
}

function getDownloadableCatalog() {
    return getVideoCatalog().filter((video) => !!getVideoSource(video, store.get("videoFileType")));
}

function getCacheDiagnostics() {
    const downloadableCatalog = getDownloadableCatalog();
    const downloadableById = new Map(downloadableCatalog.map((video) => [video.id, video]));
    const targetIds = Array.from(new Set(getVideosToDownload().filter((videoId) => downloadableById.has(videoId))));
    const targetSet = new Set(targetIds);
    const cacheFiles = getAllFilesInCache()
        .filter((fileName) => fileName.toLowerCase().endsWith(".mov"))
        .map((fileName) => ({
            fileName,
            id: fileName.slice(0, -4)
        }));
    const downloadedIds = cacheFiles.map((entry) => entry.id).filter((videoId) => downloadableById.has(videoId));
    const downloadedSet = new Set(downloadedIds);
    const missingIds = targetIds.filter((videoId) => !downloadedSet.has(videoId));
    const staleIds = downloadedIds.filter((videoId) => !targetSet.has(videoId));
    const orphanedIds = cacheFiles.map((entry) => entry.id).filter((videoId) => !downloadableById.has(videoId));
    const categoryMap = new Map();

    for (const video of downloadableCatalog) {
        const key = video.type || "other";
        if (!categoryMap.has(key)) {
            categoryMap.set(key, {
                key,
                label: key.charAt(0).toUpperCase() + key.slice(1),
                total: 0,
                downloaded: 0,
                missing: 0
            });
        }
    }

    for (const targetId of targetIds) {
        const video = downloadableById.get(targetId);
        if (!video) {
            continue;
        }
        const entry = categoryMap.get(video.type || "other");
        entry.total += 1;
        if (downloadedSet.has(targetId)) {
            entry.downloaded += 1;
        } else {
            entry.missing += 1;
        }
    }

    return {
        cachePath,
        cacheSize: getCacheSize(),
        cachedCount: downloadedIds.length,
        targetCount: targetIds.length,
        missingCount: missingIds.length,
        staleCount: staleIds.length,
        orphanedCount: orphanedIds.length,
        downloadedIds,
        missingIds,
        staleIds,
        orphanedIds,
        categoryStats: Array.from(categoryMap.values()).filter((entry) => entry.total > 0)
    };
}

function removeOrphanedVideosInCache() {
    const orphanedIds = getCacheDiagnostics().orphanedIds;
    for (const videoId of orphanedIds) {
        const filePath = path.join(cachePath, `${videoId}.mov`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
    updateVideoCache();
}

function buildDiagnosticsText() {
    const diagnostics = getCacheDiagnostics();
    const latestReleaseVersion = store.get("latestReleaseVersion") || "Unknown";
    return [
        `Aerial diagnostics`,
        `Generated: ${new Date().toISOString()}`,
        `Installed version: ${app.getVersion()}`,
        `Latest release: ${latestReleaseVersion}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Electron: ${process.versions.electron}`,
        `Chrome: ${process.versions.chrome}`,
        `Node: ${process.versions.node}`,
        `User data: ${app.getPath("userData")}`,
        `Cache path: ${diagnostics.cachePath}`,
        `Cache size bytes: ${diagnostics.cacheSize}`,
        `Cached videos: ${diagnostics.cachedCount}`,
        `Expected cached videos: ${diagnostics.targetCount}`,
        `Missing cached videos: ${diagnostics.missingCount}`,
        `Stale cached videos: ${diagnostics.staleCount}`,
        `Orphaned cached files: ${diagnostics.orphanedCount}`,
        `Config backups: ${getBackupSummary().totalBackups}`,
        `Default profile id: ${store.get("videoProfileDefaultId") || "(none)"}`,
        `Auto-apply default profile: ${store.get("videoProfileAutoApplyOnLaunch") ? "yes" : "no"}`
    ].join("\n");
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
function parseLaunchFlags(argv) {
    const flags = {
        config: false,
        preview: false,
        screensaver: false,
        testPreview: false,
        noQuit: false,
        screensaverSession: false
    };
    for (const arg of argv ?? []) {
        const normalized = String(arg || "").trim().toLowerCase();
        if (!normalized) {
            continue;
        }
        const slashArg = normalized.startsWith("-") ? `/${normalized.slice(1)}` : normalized;
        const token = slashArg.split(":")[0];
        if (token === "/c") {
            flags.config = true;
        } else if (token === "/p") {
            flags.preview = true;
        } else if (token === "/s") {
            flags.screensaver = true;
        } else if (token === "/t") {
            flags.testPreview = true;
        } else if (token === "/nq") {
            flags.noQuit = true;
        }
    }
    flags.screensaverSession = flags.config || flags.preview || flags.screensaver || flags.testPreview;
    return flags;
}
const launchFlags = parseLaunchFlags(process.argv);
const launchedAsScreensaverSession = launchFlags.screensaverSession;
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
        icon: APP_ICON_PATH
    });
    applyWindowsAppDetails(win);
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
            icon: APP_ICON_PATH,
            show: false
        })
        applyWindowsAppDetails(win);
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
        icon: APP_ICON_PATH,
        show: false
    });
    applyWindowsAppDetails(win);
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
        icon: APP_ICON_PATH
    });
    applyWindowsAppDetails(win);
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
        icon: APP_ICON_PATH
    });
    applyWindowsAppDetails(trayWindow);
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

    trayIcon = new Tray(APP_ICON_PATH);
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
    const previousVersion = String(store.get("version") ?? "").trim();
    runStartupMigrations(previousVersion);
    cachePath = store.get('cachePath') ?? path.join(app.getPath('userData'), "videos");
    allowedVideos = store.get("allowedVideos") ?? [];

    logLifecycle("startUp", {
        argv: process.argv,
        isPackaged: app.isPackaged,
        launchedAsScreensaverSession
    });
    Menu.setApplicationMenu(null);
    syncWindowsUninstallRegistration();
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
    applyDefaultVideoProfileOnLaunch();
    calculateAstronomy();
    getWeatherData(false);
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
    if (launchFlags.noQuit) {
        nq = true;
    }
    clearCacheTemp();
    if (store.get('videoCacheRemoveUnallowed')) {
        removeAllUnallowedVideosInCache();
    }
    removeAllNeverAllowedVideosInCache();
    if (launchFlags.config) {
        createConfigWindow(process.argv);
    } else if (launchFlags.preview) {
        // Windows passes /p for tiny Screen Saver Settings thumbnail preview.
        // Embedded preview hosting is not supported in this Electron path yet,
        // so avoid opening a standalone window and exit cleanly.
        app.quit();
    } else if (launchFlags.screensaver) {
        createSSWindow(process.argv);
    } else if (launchFlags.testPreview) {
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
    store.set('favoriteVideos', sanitizeFavoriteVideoIds(store.get('favoriteVideos') ?? []));
    store.set('downloadedVideos', store.get('downloadedVideos') ?? []);
    store.set('customVideos', store.get('customVideos') ?? []);
    syncVideoProfiles();

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
    store.set('latestReleaseVersion', store.get('latestReleaseVersion') ?? app.getVersion());
    store.set('latestReleasePublishedAt', store.get('latestReleasePublishedAt') ?? "");
    store.set('latestReleaseNotes', store.get('latestReleaseNotes') ?? "");
    store.set('latestReleaseUrl', store.get('latestReleaseUrl') ?? appReleasesUrl);
    store.set('latestReleaseName', store.get('latestReleaseName') ?? "");
    store.set('lastConfigBackupPath', store.get('lastConfigBackupPath') ?? "");
    store.set('lastConfigBackupCreatedAt', store.get('lastConfigBackupCreatedAt') ?? "");
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
    store.set('weatherData', getStoredWeatherSnapshot() ?? getWeatherUnavailableSnapshot(""));
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
    const releaseUrl = `https://api.github.com/repos/${appRepo}/releases/latest`;
    const request = https.get(releaseUrl, {
        headers: {
            "User-Agent": "Aerial",
            "Accept": "application/vnd.github+json"
        }
    }, (response) => {
        if (response.statusCode !== 200) {
            response.resume();
            console.log(`Error checking for updates: GitHub releases API returned ${response.statusCode}.`);
            return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
            body += chunk;
        });
        response.on("end", () => {
            try {
                const release = JSON.parse(body);
                const latestVersion = String(release.tag_name ?? release.name ?? "").replace(/^v/i, "").trim();
                store.set("latestReleaseVersion", latestVersion || app.getVersion());
                store.set("latestReleasePublishedAt", release.published_at ?? "");
                store.set("latestReleaseNotes", String(release.body ?? "").trim());
                store.set("latestReleaseUrl", release.html_url ?? appReleasesUrl);
                store.set("latestReleaseName", release.name ?? release.tag_name ?? "");
                if (latestVersion && compareSemver(latestVersion, app.getVersion()) > 0) {
                    store.set('updateAvailable', latestVersion);
                    if (app.isPackaged) {
                        new Notification({
                            title: "An update for Aerial is available",
                            body: `Version ${latestVersion} is available for download. Visit ${appReleasesUrl} to update Aerial.`
                        }).show();
                    }
                }
                broadcastRendererEvent("displaySettings");
            } catch (error) {
                console.log("Error parsing update response:", error);
            }
        });
    });

    request.on("error", (error) => {
        console.log("Error checking for updates:", error?.message ?? error);
    });
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
    openLogFile(DEBUG_LOG_FILE);
});

ipcMain.on('openLifecycleLog', () => {
    openLogFile(LIFECYCLE_LOG_FILE);
});

ipcMain.handle('getCacheDiagnostics', () => {
    return {
        ...getCacheDiagnostics(),
        backups: getBackupSummary()
    };
});

ipcMain.handle('getLogDiagnostics', () => {
    return getLogDiagnostics();
});

ipcMain.handle('clearLogs', (_event, target = "all") => {
    switch (target) {
        case "lifecycle":
            clearLogFile(LIFECYCLE_LOG_FILE);
            break;
        case "playback":
            clearLogFile(DEBUG_LOG_FILE);
            break;
        case "all":
            clearLogFile(LIFECYCLE_LOG_FILE);
            clearLogFile(DEBUG_LOG_FILE);
            break;
        default:
            throw new Error(`Unsupported log action: ${target}`);
    }
    return getLogDiagnostics();
});

ipcMain.handle('manageCache', async (event, action) => {
    switch (action) {
        case "downloadSelectedNow":
            if (!downloading) {
                downloadVideos();
            }
            break;
        case "removeUncheckedNow":
            removeAllUnallowedVideosInCache();
            removeAllNeverAllowedVideosInCache();
            break;
        case "removeOrphanedNow":
            removeOrphanedVideosInCache();
            break;
        default:
            throw new Error(`Unsupported cache action: ${action}`);
    }
    return getCacheDiagnostics();
});

ipcMain.handle('exportConfig', async (event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showSaveDialog(ownerWindow, {
        title: "Export Aerial Settings",
        defaultPath: path.join(app.getPath("documents"), `aerial-config-${app.getVersion()}.json`),
        filters: CONFIG_FILE_FILTERS
    });
    if (result.canceled || !result.filePath) {
        return {canceled: true};
    }
    writeJsonFile(result.filePath, buildConfigPayload("export"));
    return {
        canceled: false,
        filePath: result.filePath
    };
});

ipcMain.handle('createConfigBackup', () => {
    const backup = createConfigBackup("manual");
    return {
        canceled: false,
        backup,
        backups: getBackupSummary()
    };
});

ipcMain.handle('importConfig', async (event, mode = "import") => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const defaultDirectory = mode === "restoreBackup"
        ? getConfigBackupDirectory()
        : app.getPath("documents");
    const result = await dialog.showOpenDialog(ownerWindow, {
        title: mode === "restoreBackup" ? "Restore Aerial Backup" : "Import Aerial Settings",
        defaultPath: defaultDirectory,
        properties: ["openFile"],
        filters: CONFIG_FILE_FILTERS
    });
    if (result.canceled || !result.filePaths[0]) {
        return {canceled: true};
    }

    const backup = createConfigBackup(mode === "restoreBackup" ? "before-restore" : "before-import");
    const config = loadConfigPayloadFromFile(result.filePaths[0]);
    importConfigPayload(config);
    return {
        canceled: false,
        filePath: result.filePaths[0],
        backup,
        backups: getBackupSummary()
    };
});

ipcMain.handle('copyDiagnostics', () => {
    const text = buildDiagnosticsText();
    clipboard.writeText(text);
    return {
        copied: true,
        text
    };
});

ipcMain.handle('getWeatherData', (_event, force = false) => {
    return getWeatherData(Boolean(force));
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
    createSSWindow(process.argv);
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
    createConfigBackup("before-reset");
    store.clear();
    setUpConfigFile();
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.close();
    }
    createConfigWindow();
    //app.quit();
});

ipcMain.on('updateLocation', async (event) => {
    calculateAstronomy();
    if (astronomy.calculated) {
        store.set('sunrise', (astronomy.sunrise.getHours() < 10 ? '0' : "") + astronomy.sunrise.getHours() + ':' + (astronomy.sunrise.getMinutes() < 10 ? '0' : "") + astronomy.sunrise.getMinutes());
        store.set('sunset', (astronomy.sunset.getHours() < 10 ? '0' : "") + astronomy.sunset.getHours() + ':' + (astronomy.sunset.getMinutes() < 10 ? '0' : "") + astronomy.sunset.getMinutes());
    }
    await getWeatherData(true);
    event.reply('displaySettings');
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
        try {
            appendBoundedLogLine(DEBUG_LOG_FILE, line, MAX_DEBUG_LOG_BYTES);
        } catch {
            // best-effort diagnostics only
        }
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
