//Global variables
//This list of allowed or 'checked' videos
const bundledVideos = electron.bundledVideos ?? electron.videos;
const {getVideoSource, sanitizeExtraVideo} = electron.videoUtils;
const {FONT_SIZE_UNITS, normalizeOpacity, normalizeFontSizeUnit} = electron.textUtils;
let videos = electron.store.get("videoCatalog") ?? electron.videos;
let allowedVideos = electron.store.get("allowedVideos");
let downloadedVideos = electron.store.get("downloadedVideos");
let alwaysDownloadVideos = electron.store.get("alwaysDownloadVideos");
let neverDownloadVideos = electron.store.get("neverDownloadVideos");
let favoriteVideos = electron.store.get("favoriteVideos") ?? [];
let customVideos = electron.store.get("customVideos");
let extraVideos = electron.store.get("extraVideos") ?? [];
let fontList = [];
let selectedVideoIndex = -1;
let videoSearchQuery = "";
let videoQuickFilters = {
    checkedOnly: false,
    downloadedOnly: false,
    favoritesOnly: false,
    userAddedOnly: false,
    type: "all"
};
let latestCacheDiagnostics = null;
let cacheDiagnosticsRefreshToken = 0;
let latestLogDiagnostics = null;
let pendingProfileSelectionId = "";
refreshVideoCatalog();

function refreshVideoCatalog() {
    const validExtraVideos = [];
    const seenExtraIds = new Set();
    for (const candidate of extraVideos) {
        const sanitized = sanitizeExtraVideo(candidate);
        if (!sanitized || seenExtraIds.has(sanitized.id)) {
            continue;
        }
        seenExtraIds.add(sanitized.id);
        validExtraVideos.push(sanitized);
    }
    extraVideos = validExtraVideos;
    electron.store.set("extraVideos", extraVideos);

    const merged = [...bundledVideos];
    const seenIds = new Set(merged.map((video) => video.id));
    for (const extra of extraVideos) {
        if (!seenIds.has(extra.id)) {
            merged.push(extra);
            seenIds.add(extra.id);
        }
    }
    electron.store.set("videoCatalog", merged);
    videos = merged;
}

function syncRendererState() {
    videos = electron.store.get("videoCatalog") ?? electron.videos;
    allowedVideos = electron.store.get("allowedVideos") ?? [];
    downloadedVideos = electron.store.get("downloadedVideos") ?? [];
    alwaysDownloadVideos = electron.store.get("alwaysDownloadVideos") ?? [];
    neverDownloadVideos = electron.store.get("neverDownloadVideos") ?? [];
    favoriteVideos = electron.store.get("favoriteVideos") ?? [];
    customVideos = electron.store.get("customVideos") ?? [];
    extraVideos = electron.store.get("extraVideos") ?? [];
    refreshVideoCatalog();
    favoriteVideos = favoriteVideos.filter((videoId) => videos.some((video) => video.id === videoId));
    electron.store.set("favoriteVideos", favoriteVideos);
}

//Updates all the <input> tags with their proper values. Called on page load
function displaySettings() {
    syncRendererState();
    let checked = ["timeOfDay", "skipVideosWithKey", "sameVideoOnScreens", "videoCache", "videoCacheProfiles", "videoCacheRemoveUnallowed", "avoidDuplicateVideos", "onlyShowVideoOnPrimaryMonitor", "videoQuality", "debugPlayback", "immediatelyUpdateVideoCache", "useTray", "blankScreen", "sleepAfterBlank", "lockAfterRun", "alternateRenderMethod", "alternateRenderAuto", "useLocationForSunrise", "runOnBattery", "disableWhenFullscreenAppActive", "enableGlobalShortcut"];
    for (let i = 0; i < checked.length; i++) {
        $(`#${checked[i]}`).prop('checked', electron.store.get(checked[i]));
    }
    let numTxt = ["sunrise", "sunset", "textFont", "textSize", "textSizeUnit", "textColor", "textLineHeight", "textFontWeight", "textFadeInDuration", "textFadeOutDuration", "startAfter", "blankAfter", "fps", "latitude", "longitude", "randomSpeed", "skipKey", "previousSkipKey", "transitionType", "fillMode", "globalShortcutModifier1", "globalShortcutModifier2", "globalShortcutKey", "lockAfterRunAfter", "videoFileType"];
    for (let i = 0; i < numTxt.length; i++) {
        $(`#${numTxt[i]}`).val(electron.store.get(numTxt[i]));
    }
    let slider = ["playbackSpeed", "videoTransitionLength", "textOpacity"];
    for (let i = 0; i < slider.length; i++) {
        $(`#${slider[i]}`).val(electron.store.get(slider[i]));
        if (slider[i] === "textOpacity") {
            $(`#${slider[i]}Text`).text(normalizeOpacity(electron.store.get(slider[i]), 1).toFixed(2));
        } else {
            $(`#${slider[i]}Text`).text(electron.store.get(slider[i]));
        }
    }
    let numeralText = [{'id': "videoCacheSize", 'format': "0.00 ib"}];
    for (let i = 0; i < numeralText.length; i++) {
        $(`#${numeralText[i].id}`).text(numeral(electron.store.get(numeralText[i].id)).format(numeralText[i].format));
    }
    let staticText = ["version", "updateAvailable"];
    for (let i = 0; i < staticText.length; i++) {
        $(`#${staticText[i]}`).text(electron.store.get(staticText[i]));
    }
    applyTheme(electron.store.get("configTheme") ?? "dark");
    bindAboutLinks();
    displayExtraVideos();
    displayPlaybackSettings();
    displayCustomVideos();
    populateGlobalFontSelect();
    colorTextPositionRadio();
    syncSelectedTextPositionOptions();
    updateSettingVisibility();
    renderAboutPanel();
    refreshCacheDiagnostics();
    refreshLogDiagnostics();
    makeList();
    selectVideo(selectedVideoIndex >= 0 ? selectedVideoIndex : -1);

    //display update, if there is one
    //console.log(electron.store.get('updateAvailable'));
    if (electron.store.get('updateAvailable') !== false) {
        document.getElementById(`aboutUpdate`).style.display = "";
        document.getElementById(`updateBadge`).style.display = "";
    }
}

displaySettings();

function applyTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    document.body.setAttribute("data-theme", normalized);
    electron.store.set("configTheme", normalized);
    const themeToggle = document.getElementById("themeToggle");
    if (themeToggle) {
        themeToggle.innerHTML = normalized === "dark"
            ? `<i class="fa fa-sun"></i> Light`
            : `<i class="fa fa-moon"></i> Dark`;
    }
}

function toggleTheme() {
    const currentTheme = document.body.getAttribute("data-theme") ?? "dark";
    applyTheme(currentTheme === "dark" ? "light" : "dark");
}

function bindAboutLinks() {
    const repositoryUrl = electron.store.get("repositoryUrl");
    const releasesUrl = electron.store.get("releasesUrl");
    const wikiUrl = electron.store.get("wikiUrl");
    const licenseUrl = electron.store.get("licenseUrl");
    const upstreamRepositoryUrl = electron.store.get("upstreamRepositoryUrl");

    const links = [
        {id: "repoLink", href: repositoryUrl},
        {id: "welcomeRepoLink", href: repositoryUrl},
        {id: "releaseLink", href: releasesUrl},
        {id: "openReleasePageButton", href: releasesUrl},
        {id: "wikiLink", href: wikiUrl},
        {id: "licenseLink", href: licenseUrl},
        {id: "upstreamRepoLink", href: upstreamRepositoryUrl}
    ];

    for (const link of links) {
        if (link.href) {
            const element = document.getElementById(link.id);
            if (element) {
                element.href = link.href;
            }
        }
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatDisplayDate(value) {
    if (!value) {
        return "Unavailable";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Unavailable";
    }
    return date.toLocaleString();
}

function summarizeReleaseNotes(notes) {
    const lines = String(notes ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) {
        return "No release notes were published for the latest release.";
    }
    return lines.slice(0, 8).join("\n");
}

function renderAboutPanel() {
    const installedVersion = electron.store.get("version") ?? "Unknown";
    const latestVersion = electron.store.get("latestReleaseVersion") ?? installedVersion;
    const publishedAt = electron.store.get("latestReleasePublishedAt");
    const releaseNotes = summarizeReleaseNotes(electron.store.get("latestReleaseNotes"));
    const releaseNotesElement = document.getElementById("latestReleaseNotes");
    const latestVersionElement = document.getElementById("latestReleaseVersion");
    const latestPublishedElement = document.getElementById("latestReleasePublishedAt");
    const diagnosticsStatus = document.getElementById("diagnosticsCopyStatus");
    if (latestVersionElement) {
        latestVersionElement.textContent = latestVersion;
    }
    if (latestPublishedElement) {
        latestPublishedElement.textContent = formatDisplayDate(publishedAt);
    }
    if (releaseNotesElement) {
        releaseNotesElement.textContent = releaseNotes;
    }
    const installedElement = document.getElementById("installedVersion");
    if (installedElement) {
        installedElement.textContent = installedVersion;
    }
    if (diagnosticsStatus) {
        diagnosticsStatus.textContent = "";
    }
}

function renderBackupSummary(backups) {
    const backupInfo = document.getElementById("configBackupSummary");
    if (!backupInfo) {
        return;
    }
    if (!backups) {
        backupInfo.innerHTML = `<p class="w3-small">Backup information is unavailable.</p>`;
        return;
    }
    if (!backups.latestBackup) {
        backupInfo.innerHTML = `<p class="w3-small">No backups created yet. Manual backups are stored in <code>${escapeHtml(backups.directory)}</code>.</p>`;
        return;
    }
    backupInfo.innerHTML = `<div class="infoGrid">
            <div><span class="infoLabel">Backup folder</span><span class="infoValue">${escapeHtml(backups.directory)}</span></div>
            <div><span class="infoLabel">Saved backups</span><span class="infoValue">${backups.totalBackups}</span></div>
            <div><span class="infoLabel">Latest backup</span><span class="infoValue">${escapeHtml(backups.latestBackup.fileName)}</span></div>
            <div><span class="infoLabel">Created</span><span class="infoValue">${escapeHtml(formatDisplayDate(backups.latestBackup.createdAt))}</span></div>
        </div>`;
}


function formatLogSummary(log) {
    if (!log?.exists) {
        return "Not created yet";
    }
    return `${numeral(log.size).format("0.00 ib")} | ${formatDisplayDate(log.modifiedAt)}`;
}

function renderLogDiagnostics(diagnostics) {
    latestLogDiagnostics = diagnostics;
    const summary = document.getElementById("logManagerSummary");
    if (!summary) {
        return;
    }
    if (!diagnostics) {
        summary.innerHTML = `<p class="w3-small">Log diagnostics are unavailable.</p>`;
        return;
    }
    summary.innerHTML = `<div class="infoGrid logManagerGrid">
            <div>
                <span class="infoLabel">Lifecycle Log</span>
                <span class="infoValue">${escapeHtml(formatLogSummary(diagnostics.lifecycle))}</span>
                <span class="infoSubvalue">${escapeHtml(diagnostics.lifecycle?.path ?? "")}</span>
            </div>
            <div>
                <span class="infoLabel">Playback Log</span>
                <span class="infoValue">${escapeHtml(formatLogSummary(diagnostics.playback))}</span>
                <span class="infoSubvalue">${escapeHtml(diagnostics.playback?.path ?? "")}</span>
            </div>
        </div>`;
}

async function refreshLogDiagnostics() {
    try {
        const diagnostics = await electron.ipcRenderer.invoke("getLogDiagnostics");
        renderLogDiagnostics(diagnostics);
    } catch (error) {
        const summary = document.getElementById("logManagerSummary");
        if (summary) {
            summary.innerHTML = `<p class="w3-small">Unable to load log diagnostics: ${escapeHtml(error.message)}</p>`;
        }
    }
}

async function clearLogs(target) {
    const labelMap = {
        lifecycle: "Clear the lifecycle log?",
        playback: "Clear the playback log?",
        all: "Clear both log files?"
    };
    if (labelMap[target] && !confirm(labelMap[target])) {
        return;
    }
    const diagnostics = await electron.ipcRenderer.invoke("clearLogs", target);
    renderLogDiagnostics(diagnostics);
}

function formatVideoIdList(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return "None";
    }
    const shown = ids.slice(0, 6).map((id) => escapeHtml(id)).join(", ");
    return ids.length > 6 ? `${shown}, +${ids.length - 6} more` : shown;
}

function renderCacheDiagnostics(diagnostics) {
    latestCacheDiagnostics = diagnostics;
    const summary = document.getElementById("cacheManagerSummary");
    const categoryTable = document.getElementById("cacheCategoryStats");
    const fileState = document.getElementById("cacheFileStates");
    if (!summary || !categoryTable || !fileState) {
        return;
    }
    summary.innerHTML = `<div class="statsCardGrid">
            <div class="statsCard"><span class="statsLabel">Cached</span><span class="statsValue">${diagnostics.cachedCount}</span></div>
            <div class="statsCard"><span class="statsLabel">Expected</span><span class="statsValue">${diagnostics.targetCount}</span></div>
            <div class="statsCard"><span class="statsLabel">Missing</span><span class="statsValue">${diagnostics.missingCount}</span></div>
            <div class="statsCard"><span class="statsLabel">Orphaned</span><span class="statsValue">${diagnostics.orphanedCount}</span></div>
        </div>
        <div class="infoGrid compactInfoGrid">
            <div><span class="infoLabel">Cache size</span><span class="infoValue">${numeral(diagnostics.cacheSize).format("0.00 ib")}</span></div>
            <div><span class="infoLabel">Cache path</span><span class="infoValue">${escapeHtml(diagnostics.cachePath)}</span></div>
        </div>`;

    if ((diagnostics.categoryStats ?? []).length === 0) {
        categoryTable.innerHTML = `<p class="w3-small">No downloadable videos are currently selected for cache tracking.</p>`;
    } else {
        categoryTable.innerHTML = `<table class="w3-table-all">
                <tr><th>Category</th><th>Tracked</th><th>Downloaded</th><th>Missing</th></tr>
                ${diagnostics.categoryStats.map((entry) => `<tr>
                    <td>${escapeHtml(entry.label)}</td>
                    <td>${entry.total}</td>
                    <td>${entry.downloaded}</td>
                    <td>${entry.missing}</td>
                </tr>`).join("")}
            </table>`;
    }

    fileState.innerHTML = `<div class="infoGrid">
            <div><span class="infoLabel">Missing IDs</span><span class="infoValue">${formatVideoIdList(diagnostics.missingIds)}</span></div>
            <div><span class="infoLabel">Stale IDs</span><span class="infoValue">${formatVideoIdList(diagnostics.staleIds)}</span></div>
            <div><span class="infoLabel">Orphaned IDs</span><span class="infoValue">${formatVideoIdList(diagnostics.orphanedIds)}</span></div>
        </div>`;
}

async function refreshCacheDiagnostics() {
    const refreshToken = ++cacheDiagnosticsRefreshToken;
    try {
        const diagnostics = await electron.ipcRenderer.invoke("getCacheDiagnostics");
        if (refreshToken !== cacheDiagnosticsRefreshToken) {
            return;
        }
        renderCacheDiagnostics(diagnostics);
        renderBackupSummary(diagnostics.backups);
    } catch (error) {
        const summary = document.getElementById("cacheManagerSummary");
        if (summary) {
            summary.innerHTML = `<p class="w3-small">Unable to load cache diagnostics: ${escapeHtml(error.message)}</p>`;
        }
    }
}

async function runCacheAction(action, confirmationMessage) {
    if (confirmationMessage && !confirm(confirmationMessage)) {
        return;
    }
    const diagnostics = await electron.ipcRenderer.invoke("manageCache", action);
    renderCacheDiagnostics(diagnostics);
    updateCache();
}

async function exportSettings() {
    const result = await electron.ipcRenderer.invoke("exportConfig");
    if (!result || result.canceled) {
        return;
    }
    alert(`Settings exported to:\n${result.filePath}`);
}

async function createSettingsBackup() {
    const result = await electron.ipcRenderer.invoke("createConfigBackup");
    if (!result || result.canceled) {
        return;
    }
    renderBackupSummary(result.backups);
    alert(`Backup created:\n${result.backup.filePath}`);
}

async function importSettings() {
    const result = await electron.ipcRenderer.invoke("importConfig", "import");
    if (!result || result.canceled) {
        return;
    }
    alert(`Settings imported from:\n${result.filePath}\n\nA backup of the previous config was saved to:\n${result.backup.filePath}`);
    window.location.reload();
}

async function restoreSettingsBackup() {
    const result = await electron.ipcRenderer.invoke("importConfig", "restoreBackup");
    if (!result || result.canceled) {
        return;
    }
    alert(`Backup restored from:\n${result.filePath}\n\nA backup of the previous config was saved to:\n${result.backup.filePath}`);
    window.location.reload();
}

async function copyDiagnostics() {
    const result = await electron.ipcRenderer.invoke("copyDiagnostics");
    const status = document.getElementById("diagnosticsCopyStatus");
    if (status) {
        status.textContent = result?.copied ? "Diagnostics copied." : "Diagnostics copy failed.";
    }
}

function getUserAddedVideoIdSet() {
    return new Set((extraVideos ?? []).map((video) => video.id));
}

function getFavoriteVideoIdSet() {
    return new Set(favoriteVideos ?? []);
}

function saveFavoriteVideos(nextFavorites) {
    favoriteVideos = Array.from(new Set((nextFavorites ?? []).filter((videoId) => videos.some((video) => video.id === videoId))));
    electron.store.set("favoriteVideos", favoriteVideos);
}

function toggleFavoriteVideo(videoId) {
    const favorites = getFavoriteVideoIdSet();
    if (favorites.has(videoId)) {
        saveFavoriteVideos(favoriteVideos.filter((id) => id !== videoId));
    } else {
        saveFavoriteVideos([...favoriteVideos, videoId]);
    }
    makeList();
    if (selectedVideoIndex >= 0 && getVisibleVideoIndices().includes(selectedVideoIndex)) {
        selectVideo(selectedVideoIndex);
    } else {
        selectedVideoIndex = -1;
        selectVideo(-1);
    }
}

function showJsonVideoEditor() {
    const template = {
        id: "example-video-id",
        name: "Example Video",
        accessibilityLabel: "User Added",
        type: "landscape",
        timeOfDay: "none",
        src: {
            H2641080p: "https://example.com/video.mov"
        }
    };
    $('#jsonVideoInput').val(JSON.stringify(template, null, 2));
    document.getElementById('addJsonVideo').style.display = 'block';
}

function saveJsonVideoFromModal() {
    let parsed;
    const raw = $('#jsonVideoInput').val().trim();
    if (!raw) {
        alert("Paste a JSON object or array first.");
        return;
    }
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        alert(`Invalid JSON: ${error.message}`);
        return;
    }
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    const existingIds = new Set(videos.map((video) => video.id));
    const newVideos = [];
    for (const item of incoming) {
        const sanitized = sanitizeExtraVideo(item);
        if (!sanitized) {
            continue;
        }
        if (existingIds.has(sanitized.id)) {
            continue;
        }
        existingIds.add(sanitized.id);
        newVideos.push(sanitized);
    }
    if (newVideos.length === 0) {
        alert("No valid new videos were found. Ensure each item has a unique `id` and a non-empty `src` map.");
        return;
    }
    extraVideos = [...extraVideos, ...newVideos];
    electron.store.set("extraVideos", extraVideos);

    if ($('#jsonVideoAutoSelect').is(':checked')) {
        for (const video of newVideos) {
            if (!allowedVideos.includes(video.id)) {
                allowedVideos.push(video.id);
            }
        }
        electron.store.set("allowedVideos", allowedVideos);
    }

    refreshVideoCatalog();
    makeList();
    displayExtraVideos();
    refreshCache();
    document.getElementById('addJsonVideo').style.display = 'none';
}

function removeExtraVideo(videoId) {
    extraVideos = extraVideos.filter((video) => video.id !== videoId);
    allowedVideos = allowedVideos.filter((id) => id !== videoId);
    alwaysDownloadVideos = alwaysDownloadVideos.filter((id) => id !== videoId);
    neverDownloadVideos = neverDownloadVideos.filter((id) => id !== videoId);
    electron.store.set("extraVideos", extraVideos);
    electron.store.set("allowedVideos", allowedVideos);
    electron.store.set("alwaysDownloadVideos", alwaysDownloadVideos);
    electron.store.set("neverDownloadVideos", neverDownloadVideos);
    refreshVideoCatalog();
    makeList();
    selectVideo(-1);
    displayExtraVideos();
    refreshCache();
}

function displayExtraVideos() {
    extraVideos = electron.store.get("extraVideos") ?? [];
    let html = "<table class='w3-table-all'>";
    if (extraVideos.length === 0) {
        html += "<tr><td class='w3-small'>No user JSON videos added yet.</td></tr>";
    } else {
        for (const video of extraVideos) {
            const safeId = String(video.id).replace(/'/g, "\\'");
            html += `<tr>
                    <td>
                        <div class="videoInfoLabelCell">
                            ${video.name ?? video.id}
                            <span class="videoInfoVideoId">${video.id}</span>
                        </div>
                    </td>
                    <td style="width: 40px"><i class='fa fa-times w3-large' style='color: #f44336' onclick="removeExtraVideo('${safeId}')"></i></td>
                </tr>`;
        }
    }
    html += "</table>";
    $('#jsonVideoList').html(html);
}

function displayPlaybackSettings() {
    let settings = electron.store.get('videoFilters');
    let html = "";
    for (let i = 0; i < settings.length; i++) {
        html += `<div class="filterSettingRow">
                    <div class="settingSplitRow">
                        <label>${settings[i].name}: <span id="${settings[i].name}Text">${settings[i].value}</span></label>
                        <span onclick="resetSetting('${settings[i].name}', 'filterSlider', ${settings[i].defaultValue})"><i class="fa fa-undo"></i></span>
                    </div>
                    <input type="range" min="${settings[i].min}" max="${settings[i].max}" value="${settings[i].value}" step="1" id="${settings[i].name}" class="slider" onchange="updateSetting('${settings[i].name}','filterSlider')">
                 </div>`;
    }
    $('#videoFilterSettings').html(html);
}

//Updates settings of all shapes and sizes
function updateSetting(setting, type) {
    switch (type) {
        case "check":
            electron.store.set(setting, document.getElementById(setting).checked);
            break;
        case "slider":
            if (setting === "textOpacity") {
                const normalizedOpacity = normalizeOpacity(document.getElementById(setting).value, 1);
                document.getElementById(setting).value = normalizedOpacity;
                $(`#${setting}Text`).text(normalizedOpacity.toFixed(2));
                electron.store.set(setting, normalizedOpacity);
                break;
            }
            $(`#${setting}Text`).text(document.getElementById(setting).value);
        case "number":
        case "text":
        case "select":
        case "time":
            if (setting === "textSizeUnit") {
                electron.store.set(setting, normalizeTextSizeUnit(document.getElementById(setting).value));
            } else {
                electron.store.set(setting, document.getElementById(setting).value);
            }
            break;
        case "filterSlider":
            $(`#${setting}Text`).text(document.getElementById(setting).value);
            let s = electron.store.get('videoFilters');
            let index = s.findIndex((e) => {
                if (setting === e.name) {
                    return true;
                }
            });
            s[index].value = document.getElementById(setting).value;
            electron.store.set('videoFilters', s);
            break;
        case "autocomplete":
            let v = document.getElementById(setting).value;
            if (fontList.includes(v)) {
                electron.store.set(setting, v);
                $('#textFontError').css('display', "none");
            } else {
                $('#textFontError').css('display', "");
            }
            break;

    }
    updateSettingVisibility();
}

//Sets a setting to its default value, if it exists
function resetSetting(setting, type, value) {
    switch (type) {
        case "slider":
            $(`#${setting}Text`).text(value);
            $(`#${setting}`).val(value);
        case "number":
            $(`#${setting}`).val(value);
        case "text":
        case "time":
            electron.store.set(setting, value);
            break;
        case "filterSlider":
            let s = electron.store.get('videoFilters');
            let index = s.findIndex((e) => {
                if (setting === e.name) {
                    return true;
                }
            });
            s[index].value = s[index].defaultValue;
            electron.store.set('videoFilters', s);
            $(`#${setting}Text`).text(s[index].defaultValue);
            $(`#${setting}`).val(s[index].defaultValue);
            break;
    }
}

//Mass resets all the filter settings
function resetFilterSettings() {
    let videoFilters = electron.store.get('videoFilters');
    for (let i = 0; i < videoFilters.length; i++) {
        videoFilters[i].value = videoFilters[i].defaultValue;
    }
    electron.store.set('videoFilters', videoFilters);
    displayPlaybackSettings();
}

//Updated input fields that may be effected by another input
function updateSettingVisibility() {
    // Shows or hides the FPS settings for the alternate render method
    if (electron.store.get("alternateRenderMethod") || electron.store.get("alternateRenderAuto")) {
        $("#alternateRenderMethodFPS").show(300);
    } else {
        $("#alternateRenderMethodFPS").hide(200);

    }
    //disabled sunrise & sunset fields if they are calculated automatically
    if (electron.store.get("useLocationForSunrise")) {
        if (document.getElementById('latitude').value !== "" && document.getElementById('longitude').value !== "") {
            document.getElementById('sunrise').disabled = true;
            document.getElementById('sunset').disabled = true;
        } else {
            document.getElementById('needsLocation').style.display = 'block';
            electron.store.set('useLocationForSunrise', false);
            displaySettings();
        }
    } else {
        document.getElementById('sunrise').disabled = false;
        document.getElementById('sunset').disabled = false;
    }

    //show directions for transitions
    let directions, html = '';
    switch (electron.store.get("transitionType")) {
        case 'random':
        case 'dissolve':
        case 'dipToBlack':
            document.getElementById('transitionDirectionSpan').style.display = 'none';
            break;
        case 'fade':
            directions = [{name: "Left", value: "left"}, {name: "Right", value: "right"},
                {name: "Top", value: "top"}, {name: "Bottom", value: "bottom"},
                {name: "Top Left", value: "top-left"}, {name: "Top Right", value: "top-right"},
                {name: "Bottom Left", value: "bottom-left"}, {name: "Bottom Right", value: "bottom-right"}];
            break;
        case 'wipe':
            directions = [{name: "Left", value: "left"}, {name: "Right", value: "right"},
                {name: "Top", value: "top"}, {name: "Bottom", value: "bottom"}];
            break;
        case 'fadeCircle':
        case 'circle':
            directions = [{name: "Normal", value: "normal"}, {name: "Reverse", value: "reverse"}];
            break;
    }
    if (directions) {
        let currentDirection = electron.store.get('transitionDirection');
        directions.forEach((direction) => {
            html += `<option value="${direction.value}" ${currentDirection === direction.value ? "selected" : ""}>${direction.name}</option>`;
        });
        html += `<option value="random" ${currentDirection === "random" ? "selected" : ""}>Random</option>`;
        document.getElementById('transitionDirectionSpan').style.display = '';
        document.getElementById('transitionDirection').innerHTML = html;
        if (currentDirection === "") {
            electron.store.set('transitionDirection', directions[0].value);
        }
    }
}

//config functions
function refreshAerial() {
    alert("You will need to run Aerial again to finish the refresh");
    electron.ipcRenderer.send('refreshConfig');
}

function resetAerial() {
    if (confirm("This will reset all of Aerial's settings; this cannot be undone.\nAre you sure you want to do this?")) {
        alert("You will need to run Aerial again to finish resetting");
        electron.ipcRenderer.send('resetConfig');
    }
}

//Menu functions that interacted with app.js
function updateLocation() {
    if (electron.store.get('useLocationForSunrise')) {
        setTimeout(() => {
            electron.ipcRenderer.send('updateLocation');
        }, 200);
    }
}

//Cache functions
function updateCache() {
    electron.ipcRenderer.send('updateCache');
}

function refreshCache() {
    electron.ipcRenderer.send('refreshCache');
}

function deleteCache() {
    if (confirm('Are sure you want to delete all the videos in the cache?'))
        electron.ipcRenderer.send('deleteCache');
}

function selectCacheLocation() {
    if (confirm("This will delete all videos in the current cache and move the cache location to the chosen folder.\nIf you want to keep your downloaded videos copy them to the new location before clicking ok.")) {
        console.log('hey');
        electron.ipcRenderer.send('selectCacheLocation');
    }
}

let skipKeyInput = document.getElementById('skipKey');
skipKeyInput.addEventListener('keyup', (e) => {
    skipKeyInput.value = e.code;
    updateSetting('skipKey', 'text');
});

let previousSkipKeyInput = document.getElementById('previousSkipKey');
previousSkipKeyInput.addEventListener('keyup', (e) => {
    previousSkipKeyInput.value = e.code;
    updateSetting('previousSkipKey', 'text');
});

let globalShortcutKeyInput = document.getElementById('globalShortcutKey');
globalShortcutKeyInput.addEventListener('keyup', (e) => {
    let key = e.key;
    if (key.length === 1) {
        key = key.toUpperCase();
    }
    globalShortcutKeyInput.value = key;
    updateSetting('globalShortcutKey', 'text');
    newGlobalShortcut();
});
electron.ipcRenderer.on('displaySettings', () => {
    displaySettings();
});

electron.ipcRenderer.on('showWelcome', () => {
    document.getElementById('welcomeMessage').style.display = 'block';
});

electron.ipcRenderer.on('updateAttribute', (args) => {
    let id = args[0];
    let value = args[1]
    document.getElementById(id).innerText = value;
});

//Custom videos
electron.ipcRenderer.on('newCustomVideos', (videoList, path) => {
    customVideos = electron.store.get('customVideos');
    for (let i = 0; i < videoList.length; i++) {
        let index = customVideos.findIndex((e) => {
            if (`${path}\\${videoList[i]}` === e.path) {
                return true;
            }
        });
        if (index === -1) {
            customVideos.push({
                "path": `${path}\\${videoList[i]}`,
                "name": videoList[i],
                "id": newId(),
                "accessibilityLabel": "Custom Video"
            });
        }
        allowedVideos.push(customVideos[customVideos.length - 1].id);
    }
    electron.store.set('customVideos', customVideos);
    electron.store.set("allowedVideos", allowedVideos);
    displayCustomVideos();
});

function newId() {
    return '_' + Math.random().toString(36).substr(2, 9);
}

function displayCustomVideos() {
    let html = "";
    customVideos = electron.store.get('customVideos');
    html += "<table class='w3-table-all'>";
    for (let i = 0; i < customVideos.length; i++) {
        html += `<tr>
                <td><input type="checkbox" class="w3-check" ${allowedVideos.includes(customVideos[i].id) ? "checked" : ""} onclick="checkCustomVideo(this,'${customVideos[i].id}')"></td>
                <td>${customVideos[i].name}</td>
                <td><i class="fa fa-cog w3-large" onclick="editCustomVideo('${customVideos[i].id}')"></i></td>
                <td><i class='fa fa-times w3-large' style='color: #f44336' onclick="removeCustomVideo('${customVideos[i].id}')"></i></td>
                </tr>`;
    }
    html += "</table>";
    $('#customVideoList').html(html);
}

function checkCustomVideo(e, id) {
    if (e.checked) {
        allowedVideos.push(id);
    } else {
        allowedVideos.splice(allowedVideos.indexOf(id), 1);
    }
    electron.store.set("allowedVideos", allowedVideos);
}

function removeCustomVideo(id) {
    if (allowedVideos.includes(id)) {
        allowedVideos.splice(allowedVideos.indexOf(id), 1);
    }
    let index = customVideos.findIndex((e) => {
        if (id === e.id) {
            return true;
        }
    });
    customVideos.splice(index, 1);
    electron.store.set("customVideos", customVideos);
    displayCustomVideos();
}

function editCustomVideo(id) {
    let index = customVideos.findIndex((e) => {
        if (id === e.id) {
            return true;
        }
    });
    document.getElementById('editCustomVideo').style.display = 'block';
    document.getElementById('customVideoName').onchange = () => {
        customVideos[index].name = $('#customVideoName').val();
        electron.store.set('customVideos', customVideos);
        displayCustomVideos()
    };
    document.getElementById('customVideoName').value = customVideos[index].name;
    electron.store.set('customVideos', customVideos);
    displayCustomVideos();
}

//Text tab

function colorTextPositionRadio() {
    let displayTextSettings = electron.store.get('displayText');
    $('.imagePosition').each(function () {
        let color = false;
        for (let i = 0; i < displayTextSettings[this.value].length; i++) {
            if (displayTextSettings[this.value][i].type !== "none") {
                color = true;
            }
        }
        if (color) {
            $(this).addClass('imagePositionWithValue');
        } else {
            $(this).removeClass('imagePositionWithValue')
        }
    });
}

function syncSelectedTextPositionOptions() {
    let selectedPosition = document.querySelector('input.imagePosition[name="imagePosition"]:checked');
    if (!selectedPosition) {
        selectedPosition = document.querySelector('input.imagePosition[name="imagePosition"][value="random"]')
            || document.querySelector('input.imagePosition[name="imagePosition"]');
        if (!selectedPosition) {
            return;
        }
        selectedPosition.checked = true;
    }
    positionSelect(selectedPosition);
}

function loadScreenSelect() {
    let html = '<option value="">All Screens</option>'
    for (let i = 0; i < electron.store.get('numDisplays'); i++) {
        html += `<option value="${i}">Screen ${i + 1}</option>`
    }
    $('#screenSelectorSelect').html(html);
}

function escapeHtmlAttribute(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;");
}

function escapeHtmlText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;");
}

const TEXT_SIZE_UNITS = [...FONT_SIZE_UNITS];

function normalizeTextSizeUnit(unit) {
    return normalizeFontSizeUnit(unit, "vw");
}

function getTextSizeUnitOptionsHtml(selectedUnit) {
    const selected = normalizeTextSizeUnit(selectedUnit);
    let html = "";
    for (const unit of TEXT_SIZE_UNITS) {
        html += `<option value="${unit}" ${unit === selected ? "selected" : ""}>${unit}</option>`;
    }
    return html;
}

function getFontOptionsHtml(selectedFont) {
    const selected = String(selectedFont ?? "");
    const optionFonts = [...fontList];
    if (selected && !optionFonts.includes(selected)) {
        optionFonts.unshift(selected);
    }
    if (optionFonts.length === 0) {
        optionFonts.push(selected || "Segoe UI");
    }
    let html = "";
    for (const font of optionFonts) {
        const escapedValue = escapeHtmlAttribute(font);
        const escapedLabel = escapeHtmlText(font);
        html += `<option value="${escapedValue}" ${font === selected ? "selected" : ""}>${escapedLabel}</option>`;
    }
    return html;
}

function populateGlobalFontSelect() {
    const fontSelect = document.getElementById("textFont");
    if (!fontSelect) {
        return;
    }
    const selectedFont = electron.store.get("textFont") ?? "";
    fontSelect.innerHTML = getFontOptionsHtml(selectedFont);
}

loadScreenSelect();

//handles selecting a radio button from the position image
function positionSelect(position) {
    position = position.value;
    let displayTextSettings = electron.store.get('displayText')[position];

    document.getElementById("positionTypeSelect0").setAttribute('onchange', `updatePositionType('${position}',0)`);
    document.getElementById("positionRow0").setAttribute('onclick', `lineSelect('${position}',0)`);
    $('#positionTypeSelect0').val(displayTextSettings[0].type);
    document.getElementById("positionTypeSelect1").setAttribute('onchange', `updatePositionType('${position}',1)`);
    document.getElementById("positionRow1").setAttribute('onclick', `lineSelect('${position}',1)`);
    $('#positionTypeSelect1').val(displayTextSettings[1].type);
    document.getElementById("positionTypeSelect2").setAttribute('onchange', `updatePositionType('${position}',2)`);
    document.getElementById("positionRow2").setAttribute('onclick', `lineSelect('${position}',2)`);
    $('#positionTypeSelect2').val(displayTextSettings[2].type);
    document.getElementById("positionTypeSelect3").setAttribute('onchange', `updatePositionType('${position}',3)`);
    document.getElementById("positionRow3").setAttribute('onclick', `lineSelect('${position}',3)`);
    $('#positionTypeSelect3').val(displayTextSettings[3].type);

    $('#positionType').css('display', "");
    lineSelect(position, 0);
}

function getPositionMaxWidth(textSettings, position) {
    const maxWidthMap = textSettings.maxWidth;
    if (maxWidthMap && typeof maxWidthMap === "object" && maxWidthMap[position]) {
        return maxWidthMap[position];
    }
    const positionSettings = textSettings[position];
    if (positionSettings && positionSettings.maxWidth) {
        return positionSettings.maxWidth;
    }
    if (Array.isArray(positionSettings)) {
        for (let i = 0; i < positionSettings.length; i++) {
            if (positionSettings[i] && positionSettings[i].maxWidth) {
                return positionSettings[i].maxWidth;
            }
        }
    }
    return "50%";
}

function updatePositionMaxWidth(position) {
    let text = electron.store.get('displayText');
    if (!text.maxWidth || typeof text.maxWidth !== "object" || Array.isArray(text.maxWidth)) {
        text.maxWidth = {};
    }
    text.maxWidth[position] = $('#textWidthSelect').val();
    electron.store.set('displayText', text);
}

function ensurePositionMaxWidth(position, maxWidth) {
    let text = electron.store.get('displayText');
    if (!text.maxWidth || typeof text.maxWidth !== "object" || Array.isArray(text.maxWidth)) {
        text.maxWidth = {};
    }
    if (!text.maxWidth[position]) {
        text.maxWidth[position] = maxWidth;
        electron.store.set('displayText', text);
    }
}

function lineSelect(position, line) {
    let textSettings = electron.store.get('displayText');
    let positionSettings = textSettings[position];
    let displayTextSettings = positionSettings[line];
    const maxWidth = getPositionMaxWidth(textSettings, position);
    ensurePositionMaxWidth(position, maxWidth);
    document.getElementById("textWidthSelect").setAttribute('onchange', `updatePositionMaxWidth('${position}')`);
    $('#textWidthSelect').val(maxWidth);
    $('#textWidthContainer').css('display', "inline-flex");

    for (let i = 0; i < 4; i++) {
        $(`#positionRow${i}`).removeClass("positionLineRowActive");
        $(`#positionLineNum${i}`).removeClass("positionLineLabelActive");
    }
    $(`#positionRow${line}`).addClass("positionLineRowActive");
    $(`#positionLineNum${line}`).addClass("positionLineLabelActive");

    if (electron.store.get('numDisplays') > 0) {
        $('#screenSelectorDiv').css('display', "");
        $('#screenSelectorSelect').val(displayTextSettings.onlyShowOnScreen);
        document.getElementById("screenSelectorSelect").setAttribute('onchange', `updateScreenSelect('${position}',${line})`);
    }

    updatePositionType(position, line);
}

function updatePositionType(position, line) {
    let displayTextSettings = electron.store.get('displayText');
    const attrEscape = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;");
    const textEscape = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;");
    const formRow = (label, controlHtml, inputId = "") => `
        <div class="formRow">
            <label class="formLabel"${inputId ? ` for="${inputId}"` : ""}>${label}</label>
            <div class="formControl">${controlHtml}</div>
        </div>`;
    const formDivider = () => `<div class="formRow formRowFull"><hr class="positionDetailsDivider"></div>`;
    const helpButtonHtml = `<button onclick="document.getElementById('timeFormatExplain').style.display='block'" class="w3-button w3-white w3-border w3-border-blue w3-round-large positionHelpAction">Show Formatting Details</button>`;
    displayTextSettings[position][line].type = $('#positionTypeSelect' + line).val();
    const activeLine = displayTextSettings[position][line];
    let formRows = "";
    switch (activeLine.type) {
        case "none":
            break;
        case "text":
            formRows += formRow(
                "Text",
                `<input id="positionTextValue" class="w3-input positionInputMedium" value="${attrEscape(activeLine.text)}" oninput="updateTextSetting(this, '${position}','${line}', 'text')" onchange="updateTextSetting(this, '${position}','${line}', 'text')">`,
                "positionTextValue"
            );
            break;
        case "html":
            formRows += formRow(
                "HTML",
                `<textarea id="positionHtmlValue" class="w3-input positionTextarea" oninput="updateTextSetting(this, '${position}','${line}', 'html')" onchange="updateTextSetting(this, '${position}','${line}', 'html')" rows="7">${textEscape(activeLine.html)}</textarea>`,
                "positionHtmlValue"
            );
            break;
        case "image":
            formRows += formRow(
                "Image File",
                `<button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="electron.ipcRenderer.send('selectFile',['image','${position}','${line}'])">Select Image</button>
                 <span class="w3-small positionMetaText">File: <span id="imageFileName">${textEscape(activeLine.imagePath)}</span></span>`
            );
            formRows += formRow(
                "Image Width",
                `<input id="positionImageWidth" class="w3-input positionInputTiny" value="${attrEscape(activeLine.imageWidth)}" oninput="updateTextSetting(this, '${position}','${line}', 'imageWidth')" onchange="updateTextSetting(this, '${position}','${line}', 'imageWidth')">`,
                "positionImageWidth"
            );
            break;
        case "time":
            activeLine.timeString = activeLine.timeString || "hh:mm:ss";
            formRows += formRow(
                "Time Format",
                `<input id="positionTimeFormat" class="w3-input positionInputMedium" value="${attrEscape(activeLine.timeString)}" oninput="showMomentDisplay('positionTimeDisplay', this); updateTextSetting(this, '${position}','${line}', 'timeString')" onchange="showMomentDisplay('positionTimeDisplay', this); updateTextSetting(this, '${position}','${line}', 'timeString')">
                 <span id="positionTimeDisplay" class="positionPreviewValue">${moment().format(activeLine.timeString)}</span>`,
                "positionTimeFormat"
            );
            formRows += formRow("Format Help", helpButtonHtml);
            break;
        case "information":
            activeLine.infoType = activeLine.infoType || "accessibilityLabel";
            formRows += formRow(
                "Type",
                `<select id="positionInfoType" class="positionInputMedium" onchange="updateTextSetting(this, '${position}', '${line}','infoType')">
                                <option value="accessibilityLabel" ${activeLine.infoType === "accessibilityLabel" ? "selected" : ""}>Label</option>
                                <option value="name" ${activeLine.infoType === "name" ? "selected" : ""}>Video Name</option>
                                ${position !== "random" ? `<option value="poi" ${activeLine.infoType === "poi" ? "selected" : ""}>Location Information</option>` : ""}
                            </select>`,
                "positionInfoType"
            );
            break;
        case "astronomy":
            if (document.getElementById('latitude').value === "" || document.getElementById('longitude').value === "") {
                document.getElementById('needsLocation').style.display = 'block';
                displayTextSettings[position][line].type = "none";
                $('#positionTypeSelect' + line).val("none");
                break;
            }
            activeLine.astronomy = activeLine.astronomy || "sunrise/set";
            activeLine.astroTimeString = activeLine.astroTimeString || "hh:mm";
            formRows += formRow(
                "Type",
                `<select id="positionAstronomyType" class="positionInputMedium" onchange="updateTextSetting(this, '${position}','${line}', 'astronomy')">
                                <option value="sunrise/set" ${activeLine.astronomy === "sunrise/set" ? "selected" : ""}>Sunrise/Sunset</option>
                                <option value="moonrise/set" ${activeLine.astronomy === "moonrise/set" ? "selected" : ""}>Moonrise/Moonset</option>
                                <option value="sunrise" ${activeLine.astronomy === "sunrise" ? "selected" : ""}>Sunrise</option>
                                <option value="sunset" ${activeLine.astronomy === "sunset" ? "selected" : ""}>Sunset</option>
                                <option value="moonrise" ${activeLine.astronomy === "moonrise" ? "selected" : ""}>Moonrise</option>
                                <option value="moonset" ${activeLine.astronomy === "moonset" ? "selected" : ""}>Moonset</option>
                            </select>`,
                "positionAstronomyType"
            );
            formRows += formRow(
                "Time Format",
                `<input id="positionAstroFormat" class="w3-input positionInputTiny" value="${attrEscape(activeLine.astroTimeString)}" oninput="showMomentDisplay('positionTimeDisplay', this); updateTextSetting(this, '${position}', '${line}','astroTimeString')" onchange="showMomentDisplay('positionTimeDisplay', this); updateTextSetting(this, '${position}', '${line}','astroTimeString')">
                 <span id="positionTimeDisplay" class="positionPreviewValue">${moment().format(activeLine.astroTimeString)}</span>`,
                "positionAstroFormat"
            );
            formRows += formRow("Format Help", helpButtonHtml);
            break;
    }
    if (activeLine.type !== "none") {
        formRows += formDivider();
        formRows += formRow(
            "Use Default Font",
            `<div class="positionCheckboxRow">
                <input type="checkbox" class="w3-check" id="useDefaultFont" onchange="updateTextSettingCheck(this, '${position}','${line}', 'defaultFont'); updatePositionType('${position}','${line}');" ${activeLine.defaultFont ? 'checked' : ''}>
                <label for="useDefaultFont">Enabled</label>
            </div>`,
            "useDefaultFont"
        );
        formRows += formRow(
            "Custom CSS",
            `<input id="customCSS" class="w3-input positionInputMedium" oninput="updateTextSetting(this, '${position}','${line}', 'customCSS')" onchange="updateTextSetting(this, '${position}','${line}', 'customCSS')" value="${attrEscape(activeLine.customCSS)}"/>`,
            "customCSS"
        );
        if (!activeLine.defaultFont) {
            activeLine.font = activeLine.font || electron.store.get('textFont');
            activeLine.fontSize = activeLine.fontSize || electron.store.get('textSize');
            activeLine.fontSizeUnit = normalizeTextSizeUnit(activeLine.fontSizeUnit || electron.store.get('textSizeUnit'));
            activeLine.fontColor = activeLine.fontColor || electron.store.get('textColor');
            activeLine.opacity = normalizeOpacity(activeLine.opacity, normalizeOpacity(electron.store.get('textOpacity'), 1));
            activeLine.fontWeight = activeLine.fontWeight || electron.store.get('textFontWeight');
            formRows += formRow(
                "Font",
                `<select id="positionFont" class="w3-input positionInputMedium" onchange="updateTextSetting(this, '${position}','${line}', 'font')">
                    ${getFontOptionsHtml(activeLine.font)}
                </select>`,
                "positionFont"
            );
            formRows += formRow(
                "Font Size",
                `<input class="w3-input positionInputTiny" id="positionTextSize" type="number" step=".1" oninput="updateTextSetting(this, '${position}','${line}', 'fontSize')" onchange="updateTextSetting(this, '${position}','${line}', 'fontSize')" value="${attrEscape(activeLine.fontSize)}">
                 <label for="positionTextSizeUnit">Unit</label>
                 <select id="positionTextSizeUnit" class="positionInputTiny" onchange="updateTextSetting(this, '${position}','${line}', 'fontSizeUnit')">
                    ${getTextSizeUnitOptionsHtml(activeLine.fontSizeUnit)}
                 </select>`,
                "positionTextSize"
            );
            formRows += formRow(
                "Color",
                `<input id="positionTextColor" class="w3-input positionColorInput" type="color" oninput="updateTextSetting(this, '${position}','${line}', 'fontColor')" onchange="updateTextSetting(this, '${position}','${line}', 'fontColor')" value="${attrEscape(activeLine.fontColor)}">`,
                "positionTextColor"
            );
            formRows += formRow(
                "Opacity",
                `<input class="slider textOpacitySlider" id="positionTextOpacity" type="range" min="0" max="1" step=".01" oninput="document.getElementById('positionTextOpacityValue').textContent = Number(this.value).toFixed(2); updateTextSetting(this, '${position}','${line}', 'opacity')" onchange="updateTextSetting(this, '${position}','${line}', 'opacity')" value="${attrEscape(activeLine.opacity)}">
                 <span id="positionTextOpacityValue">${normalizeOpacity(activeLine.opacity, 1).toFixed(2)}</span>`,
                "positionTextOpacity"
            );
            formRows += formRow(
                "Font Weight",
                `<input class="w3-input positionInputTiny" id="positionTextWeight" type="number" min="100" max="900" step="100" oninput="updateTextSetting(this, '${position}','${line}', 'fontWeight')" onchange="updateTextSetting(this, '${position}','${line}', 'fontWeight')" value="${attrEscape(activeLine.fontWeight)}">`,
                "positionTextWeight"
            );
        }
        const html = `<div class="positionDetailsPanel"><div class="formGrid">${formRows}</div></div>`;

        $('#positionDetails').html(html);

        if (activeLine.type === "astronomy") {
            const astroInput = document.getElementById("positionAstroFormat");
            if (astroInput) {
                showMomentDisplay('positionTimeDisplay', astroInput);
            }
        }
    } else {
        $('#positionDetails').html("");
    }
    electron.store.set('displayText', displayTextSettings);
    colorTextPositionRadio();
}

//Text settings are stored separate from other settings, so they require their own functions
function updateTextSetting(input, position, line, setting) {
    let text = electron.store.get('displayText');
    if (setting === "fontSizeUnit") {
        text[position][line][setting] = normalizeTextSizeUnit(input.value);
    } else if (setting === "opacity") {
        text[position][line][setting] = normalizeOpacity(input.value, 1);
    } else {
        text[position][line][setting] = input.value;
    }
    electron.store.set('displayText', text);
}

//This one handles checkboxes because they are a special case
function updateTextSettingCheck(input, position, line, setting) {
    let text = electron.store.get('displayText');
    text[position][line][setting] = input.checked;
    electron.store.set('displayText', text);
}

function updateScreenSelect(position, line) {
    let text = electron.store.get('displayText');
    text[position][line].onlyShowOnScreen = $('#screenSelectorSelect').val();
    electron.store.set('displayText', text);
}

//Handles changing menu tabs
function changeTab(evt, tab) {
    let i, x, tablinks;
    x = document.getElementsByClassName("tab");
    for (i = 0; i < x.length; i++) {
        x[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tablink");
    for (i = 0; i < x.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" w3-blue", "");
    }
    document.getElementById(tab).style.display = "block";
    evt.currentTarget.className += " w3-blue";
}

//Functions to run the side menus
function selectSetting(item) {
    const settingsTab = document.getElementById("settingsTab");
    let list = settingsTab.getElementsByClassName("settingsListItem");
    for (let i = 0; i < list.length; i++) {
        list[i].className = list[i].className.replace("w3-deep-orange", "");
    }
    document.getElementById(`settingsList-${item}`).className += " w3-deep-orange";
    let cards = settingsTab.getElementsByClassName("settingsCard");
    for (let i = 0; i < cards.length; i++) {
        cards[i].style.display = "none";
    }
    document.getElementById(`${item}Settings`).style.display = "";
}

function selectTextSetting(item) {
    const textTab = document.getElementById("textTab");
    let list = textTab.getElementsByClassName("textSettingsListItem");
    for (let i = 0; i < list.length; i++) {
        list[i].className = list[i].className.replace("w3-deep-orange", "");
    }
    if (item !== "general") {
        document.getElementById(`textSettingsList-${item}`).className += " w3-deep-orange";
    }
    let cards = textTab.getElementsByClassName("textSettingsCard");
    for (let i = 0; i < cards.length; i++) {
        cards[i].style.display = "none";
    }
    document.getElementById(`${item}TextSettings`).style.display = "";
    if (item === "position") {
        syncSelectedTextPositionOptions();
    }
}

//Video tab

function createRuntimeId(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeVideoProfilesData(profiles) {
    const source = Array.isArray(profiles) ? profiles : [];
    const seenIds = new Set();
    const validVideoIds = new Set(videos.map((video) => video.id));
    return source.map((profile, index) => {
        const normalized = profile && typeof profile === "object" ? profile : {};
        let id = typeof normalized.id === "string" ? normalized.id.trim() : "";
        if (!id || seenIds.has(id)) {
            id = createRuntimeId("profile");
        }
        seenIds.add(id);
        const name = String(normalized.name ?? "").trim() || `Profile ${index + 1}`;
        const profileVideos = Array.isArray(normalized.videos)
            ? normalized.videos.filter((videoId, position, list) => typeof videoId === "string" && validVideoIds.has(videoId) && !videoId.startsWith("_") && list.indexOf(videoId) === position)
            : [];
        return {id, name, videos: profileVideos};
    });
}

function getVideoProfiles() {
    const profiles = normalizeVideoProfilesData(electron.store.get("videoProfiles") ?? []);
    electron.store.set("videoProfiles", profiles);
    const defaultId = electron.store.get("videoProfileDefaultId") ?? "";
    if (defaultId && !profiles.some((profile) => profile.id === defaultId)) {
        electron.store.set("videoProfileDefaultId", "");
    }
    return profiles;
}

function saveVideoProfiles(profiles) {
    electron.store.set("videoProfiles", normalizeVideoProfilesData(profiles));
}

function getSelectedProfileId() {
    return $("#videoProfiles").val();
}

function getSelectedProfile() {
    const selectedId = getSelectedProfileId();
    return getVideoProfiles().find((profile) => profile.id === selectedId) ?? null;
}

function renderProfileOptions() {
    const profiles = getVideoProfiles();
    const defaultId = electron.store.get("videoProfileDefaultId") ?? "";
    const currentSelection = getSelectedProfileId();
    const select = document.getElementById("videoProfiles");
    if (!select) {
        return;
    }
    const options = profiles.map((profile) => {
        const suffixParts = [`${profile.videos.length} videos`];
        if (profile.id === defaultId) {
            suffixParts.push("default");
        }
        return `<option value="${profile.id}">${escapeHtml(profile.name)} (${suffixParts.join(", ")})</option>`;
    });
    select.innerHTML = options.length > 0 ? options.join("") : `<option value="">No saved profiles</option>`;
    if (profiles.some((profile) => profile.id === pendingProfileSelectionId)) {
        select.value = pendingProfileSelectionId;
    } else if (profiles.some((profile) => profile.id === currentSelection)) {
        select.value = currentSelection;
    } else if (profiles[0]) {
        select.value = profiles[0].id;
    }
    pendingProfileSelectionId = "";
    renderSelectedProfileSummary();
}

function renderSelectedProfileSummary() {
    const summary = document.getElementById("videoProfileSummary");
    if (!summary) {
        return;
    }
    const profile = getSelectedProfile();
    if (!profile) {
        summary.innerHTML = `<p class="w3-small">Create a profile to save and reuse checked videos.</p>`;
        return;
    }
    const isDefault = profile.id === (electron.store.get("videoProfileDefaultId") ?? "");
    summary.innerHTML = `<div class="infoGrid compactInfoGrid">
            <div><span class="infoLabel">Profile</span><span class="infoValue">${escapeHtml(profile.name)}</span></div>
            <div><span class="infoLabel">Videos</span><span class="infoValue">${profile.videos.length}</span></div>
            <div><span class="infoLabel">Default</span><span class="infoValue">${isDefault ? "Yes" : "No"}</span></div>
            <div><span class="infoLabel">Launch behavior</span><span class="infoValue">${electron.store.get("videoProfileAutoApplyOnLaunch") ? "Auto-apply default" : "Manual only"}</span></div>
        </div>`;
}

function openVideoProfileDialog(mode) {
    const dialog = document.getElementById("videoProfileDialog");
    const input = document.getElementById("videoProfileNameInput");
    const modeInput = document.getElementById("videoProfileDialogMode");
    const sourceInput = document.getElementById("videoProfileDialogSourceId");
    const title = document.getElementById("videoProfileDialogTitle");
    const button = document.getElementById("videoProfileDialogSubmit");
    const selectedProfile = getSelectedProfile();
    modeInput.value = mode;
    sourceInput.value = selectedProfile?.id ?? "";
    switch (mode) {
        case "rename":
            if (!selectedProfile) {
                alert("Select a profile to rename.");
                return;
            }
            title.textContent = "Rename Profile";
            button.textContent = "Rename";
            input.value = selectedProfile.name;
            break;
        case "duplicate":
            if (!selectedProfile) {
                alert("Select a profile to duplicate.");
                return;
            }
            title.textContent = "Duplicate Profile";
            button.textContent = "Duplicate";
            input.value = `${selectedProfile.name} Copy`;
            break;
        default:
            title.textContent = "Create Profile";
            button.textContent = "Create";
            input.value = "";
            break;
    }
    dialog.style.display = "block";
    input.focus();
    input.select();
}

function closeVideoProfileDialog() {
    document.getElementById("videoProfileDialog").style.display = "none";
}

function submitVideoProfileDialog() {
    const mode = document.getElementById("videoProfileDialogMode").value;
    const sourceId = document.getElementById("videoProfileDialogSourceId").value;
    const name = document.getElementById("videoProfileNameInput").value.trim();
    if (!name) {
        alert("Profile name is required.");
        return;
    }
    const profiles = getVideoProfiles();
    const conflictingProfile = profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase() && profile.id !== sourceId);
    if (conflictingProfile) {
        alert("A profile with that name already exists.");
        return;
    }
    if (mode === "rename") {
        const profile = profiles.find((entry) => entry.id === sourceId);
        if (!profile) {
            alert("Select a profile to rename.");
            return;
        }
        profile.name = name;
        saveVideoProfiles(profiles);
        pendingProfileSelectionId = profile.id;
    } else if (mode === "duplicate") {
        const sourceProfile = profiles.find((entry) => entry.id === sourceId);
        if (!sourceProfile) {
            alert("Select a profile to duplicate.");
            return;
        }
        const duplicate = {
            id: createRuntimeId("profile"),
            name,
            videos: [...sourceProfile.videos]
        };
        profiles.push(duplicate);
        saveVideoProfiles(profiles);
        pendingProfileSelectionId = duplicate.id;
    } else {
        const created = {
            id: createRuntimeId("profile"),
            name,
            videos: allowedVideos.filter((videoId) => !videoId.startsWith("_"))
        };
        profiles.push(created);
        saveVideoProfiles(profiles);
        pendingProfileSelectionId = created.id;
    }
    closeVideoProfileDialog();
    renderVideoSettingsPanel();
    refreshCache();
}

function applySelectedProfile() {
    const profile = getSelectedProfile();
    if (!profile) {
        alert("Select a profile to load.");
        return;
    }
    const customAllowed = allowedVideos.filter((videoId) => videoId.startsWith("_"));
    allowedVideos = Array.from(new Set([...profile.videos, ...customAllowed]));
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
    refreshCache();
}

function saveCurrentSelectionToSelectedProfile() {
    const profile = getSelectedProfile();
    if (!profile) {
        alert("Select a profile to update.");
        return;
    }
    const profiles = getVideoProfiles();
    const target = profiles.find((entry) => entry.id === profile.id);
    target.videos = allowedVideos.filter((videoId) => !videoId.startsWith("_"));
    saveVideoProfiles(profiles);
    renderVideoSettingsPanel();
    refreshCache();
}

function deleteSelectedProfile() {
    const profile = getSelectedProfile();
    if (!profile) {
        alert("Select a profile to delete.");
        return;
    }
    if (!confirm(`Delete profile "${profile.name}"?`)) {
        return;
    }
    const profiles = getVideoProfiles().filter((entry) => entry.id !== profile.id);
    saveVideoProfiles(profiles);
    if ((electron.store.get("videoProfileDefaultId") ?? "") === profile.id) {
        electron.store.set("videoProfileDefaultId", "");
    }
    renderVideoSettingsPanel();
    refreshCache();
}

function duplicateSelectedProfile() {
    openVideoProfileDialog("duplicate");
}

function renameSelectedProfile() {
    openVideoProfileDialog("rename");
}

function setSelectedProfileAsDefault() {
    const profile = getSelectedProfile();
    if (!profile) {
        alert("Select a profile to mark as default.");
        return;
    }
    electron.store.set("videoProfileDefaultId", profile.id);
    renderVideoSettingsPanel();
}

function toggleVideoProfileAutoApply() {
    const input = document.getElementById("videoProfileAutoApplyOnLaunch");
    electron.store.set("videoProfileAutoApplyOnLaunch", !!input?.checked);
    renderSelectedProfileSummary();
}

function applyFavoriteSelection(mode) {
    const favoriteIds = videos
        .filter((video) => getFavoriteVideoIdSet().has(video.id))
        .map((video) => video.id);
    if (favoriteIds.length === 0) {
        alert("No favorite videos are available.");
        return;
    }
    if (mode === "only") {
        const customAllowed = allowedVideos.filter((videoId) => videoId.startsWith("_"));
        allowedVideos = Array.from(new Set([...favoriteIds, ...customAllowed]));
    } else if (mode === "select") {
        allowedVideos = Array.from(new Set([...allowedVideos, ...favoriteIds]));
    } else {
        allowedVideos = allowedVideos.filter((videoId) => videoId.startsWith("_") || !favoriteIds.includes(videoId));
    }
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
    refreshCache();
}

function renderVideoSettingsPanel() {
    const favoriteCount = favoriteVideos.length;
    $('#videoSettings').html(`<div class="w3-container videoSettingsContent">
            <div class="settingActionRow videoSettingsButtonRow">
                <button class="w3-button w3-white w3-border w3-border-green w3-round-large" onclick="selectAll()">Select All</button>
                <button class="w3-button w3-white w3-border w3-border-red w3-round-large" onclick="deselectAll()">Deselect All</button>
            </div>
            <div class="videoSettingsSelectRow videoSettingsControlRow">
                <select class="w3-select w3-border" style="width: 25%" id="videoType">
                    <option value="cityscape">Cityscape</option>
                    <option value="landscape">Landscape</option>
                    <option value="space">Space</option>
                    <option value="underwater">Underwater</option>
                </select>
                <button class="w3-button w3-white w3-border w3-border-green w3-round-large" onclick="selectType()">Select Type</button>
                <button class="w3-button w3-white w3-border w3-border-red w3-round-large" onclick="deselectType()">Deselect Type</button>
            </div>
            <div class="videoSettingsSection">
                <div class="settingSplitRow videoSettingsSectionHeader">
                    <h3>Favorites</h3>
                    <span class="w3-small">${favoriteCount} pinned video${favoriteCount === 1 ? "" : "s"}</span>
                </div>
                <div class="videoSettingsSectionBody">
                    <div class="infoPanel">
                        <div class="infoGrid compactInfoGrid">
                            <div><span class="infoLabel">Pinned at top</span><span class="infoValue">${favoriteCount}</span></div>
                            <div><span class="infoLabel">Quick filter</span><span class="infoValue">Use the Favorites chip in the video sidebar.</span></div>
                        </div>
                    </div>
                </div>
                <div class="settingActionRow videoSettingsButtonRow">
                    <button class="w3-button w3-white w3-border w3-border-green w3-round-large" onclick="applyFavoriteSelection('select')">Select Favorites</button>
                    <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="applyFavoriteSelection('only')">Only Favorites</button>
                    <button class="w3-button w3-white w3-border w3-border-red w3-round-large" onclick="applyFavoriteSelection('clear')">Clear Favorites</button>
                </div>
            </div>
            <div class="videoSettingsSection">
                <div class="settingSplitRow videoSettingsSectionHeader">
                    <h3>Profiles</h3>
                    <span class="w3-small">Save reusable video selections</span>
                </div>
                <div class="videoSettingsSectionBody">
                    <select class="w3-select w3-border" id="videoProfiles" onchange="renderSelectedProfileSummary()"></select>
                    <div id="videoProfileSummary" class="infoPanel"></div>
                    <label class="videoSettingsToggleRow" for="videoProfileAutoApplyOnLaunch">
                        <input type="checkbox" id="videoProfileAutoApplyOnLaunch" class="w3-check" onclick="toggleVideoProfileAutoApply()">
                        <span>Auto-apply the default profile on launch</span>
                    </label>
                </div>
                <div class="settingActionRow videoSettingsButtonRow">
                    <button class="w3-button w3-white w3-border w3-border-green w3-round-large" onclick="applySelectedProfile()">Load Profile</button>
                    <button class="w3-button w3-white w3-border w3-border-green w3-round-large" onclick="saveCurrentSelectionToSelectedProfile()">Update Profile</button>
                    <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="openVideoProfileDialog('create')">Create</button>
                    <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="duplicateSelectedProfile()">Duplicate</button>
                    <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="renameSelectedProfile()">Rename</button>
                    <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="setSelectedProfileAsDefault()">Set Default</button>
                    <button class="w3-button w3-white w3-border w3-border-red w3-round-large" onclick="deleteSelectedProfile()">Delete</button>
                </div>
            </div>
            <div class="videoSettingsSection">
                <h3>Downloads</h3>
                <div class="videoSettingsSelectRow videoSettingsControlRow">
                    <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="changeAllVideoDownloadState('allVideoDownloadState')">Set all videos to</button>
                    <select id="allVideoDownloadState" class="w3-select w3-border" style="width: 35%">
                        <option value="whenChecked">download when checked</option>
                        <option value="always">always download</option>
                        <option value="never">never download</option>
                    </select>
                </div>
            </div>
        </div>`).css('display', '');
    renderProfileOptions();
    $("#videoProfileAutoApplyOnLaunch").prop("checked", !!electron.store.get("videoProfileAutoApplyOnLaunch"));
}

function setVideoSearch(value) {
    videoSearchQuery = value;
    makeList();
}

function toggleVideoQuickFilter(filterKey) {
    videoQuickFilters[filterKey] = !videoQuickFilters[filterKey];
    makeList();
}

function setVideoTypeQuickFilter(value) {
    videoQuickFilters.type = value;
    makeList();
}

function clearVideoFilters() {
    videoSearchQuery = "";
    videoQuickFilters = {
        checkedOnly: false,
        downloadedOnly: false,
        favoritesOnly: false,
        userAddedOnly: false,
        type: "all"
    };
    makeList();
}

function getVisibleVideoIndices() {
    const userAddedIds = getUserAddedVideoIdSet();
    const query = videoSearchQuery.trim().toLowerCase();
    return videos.reduce((matches, video, index) => {
        const haystack = [video.name, video.id, video.accessibilityLabel, video.type].filter(Boolean).join(" ").toLowerCase();
        if (query && !haystack.includes(query)) {
            return matches;
        }
        if (videoQuickFilters.checkedOnly && !allowedVideos.includes(video.id)) {
            return matches;
        }
        if (videoQuickFilters.downloadedOnly && !downloadedVideos.includes(video.id)) {
            return matches;
        }
        if (videoQuickFilters.favoritesOnly && !favoriteVideos.includes(video.id)) {
            return matches;
        }
        if (videoQuickFilters.userAddedOnly && !userAddedIds.has(video.id)) {
            return matches;
        }
        if (videoQuickFilters.type !== "all" && video.type !== videoQuickFilters.type) {
            return matches;
        }
        matches.push(index);
        return matches;
    }, []);
}

function renderVideoListRow(index) {
    const video = videos[index];
    const favoriteSet = getFavoriteVideoIdSet();
    return `<div class="videoListRow">
                <input type="checkbox" ${allowedVideos.includes(video.id) ? "checked" : ""} class="w3-check videoListCheck" onclick="checkVideo(event,${index})">
                <a href="#" id="videoList-${index}" onclick="selectVideo(${index}); return false;" class="videoListEntry">
                    <span class="videoListEntryName">${escapeHtml(video.name ? video.name : video.accessibilityLabel)}</span>
                    <span class="videoListEntryMeta">
                        ${favoriteSet.has(video.id) ? "<span class='videoListBadge videoListBadgeFavorite'>Favorite</span>" : ""}
                        ${downloadedVideos.includes(video.id) ? "<span class='videoListBadge'>Cached</span>" : ""}
                        ${getUserAddedVideoIdSet().has(video.id) ? "<span class='videoListBadge videoListBadgeMuted'>User added</span>" : ""}
                    </span>
                </a>
            </div>`;
}

function setVideoGroupSelection(groupLabel, mode) {
    const matchingIds = videos
        .filter((video) => video.accessibilityLabel === groupLabel)
        .map((video) => video.id);
    if (mode === "only") {
        const customAllowed = allowedVideos.filter((videoId) => videoId.startsWith("_"));
        allowedVideos = Array.from(new Set([...matchingIds, ...customAllowed]));
    } else if (mode === "select") {
        for (const videoId of matchingIds) {
            if (!allowedVideos.includes(videoId)) {
                allowedVideos.push(videoId);
            }
        }
    } else {
        allowedVideos = allowedVideos.filter((videoId) => videoId.startsWith("_") || !matchingIds.includes(videoId));
    }
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
    refreshCache();
}

//Makes and then displays the videos on the sidebar
function makeList() {
    const previousSearchInput = document.getElementById("videoSidebarSearch");
    const shouldRestoreSearchFocus = document.activeElement === previousSearchInput;
    const previousSelectionStart = shouldRestoreSearchFocus ? previousSearchInput.selectionStart : null;
    const previousSelectionEnd = shouldRestoreSearchFocus ? previousSearchInput.selectionEnd : null;
    const visibleIndices = getVisibleVideoIndices();
    const favoriteSet = getFavoriteVideoIdSet();
    const pinnedFavoriteIndices = visibleIndices.filter((index) => favoriteSet.has(videos[index].id));
    const regularIndices = visibleIndices.filter((index) => !favoriteSet.has(videos[index].id));
    const types = Array.from(new Set(videos.map((video) => video.type).filter(Boolean)));
    let videoList = `<div class='videoListTitleLink sidebarHeader'>
            <div class="videoSidebarHeader">
                <h3 class="w3-bar-item videoListTitle"><i class="fa fa-film"></i> Videos</h3>
                <div class="videoSidebarControls">
                    <input id="videoSidebarSearch" class="w3-input videoSidebarSearch" type="text" placeholder="Search videos" value="${escapeHtml(videoSearchQuery)}" oninput="setVideoSearch(this.value)">
                    <div class="videoQuickFilterRow">
                        <button class="videoQuickFilter ${videoQuickFilters.checkedOnly ? "active" : ""}" onclick="toggleVideoQuickFilter('checkedOnly')">Checked</button>
                        <button class="videoQuickFilter ${videoQuickFilters.downloadedOnly ? "active" : ""}" onclick="toggleVideoQuickFilter('downloadedOnly')">Downloaded</button>
                        <button class="videoQuickFilter ${videoQuickFilters.favoritesOnly ? "active" : ""}" onclick="toggleVideoQuickFilter('favoritesOnly')">Favorites</button>
                        <button class="videoQuickFilter ${videoQuickFilters.userAddedOnly ? "active" : ""}" onclick="toggleVideoQuickFilter('userAddedOnly')">User Added</button>
                    </div>
                    <div class="videoQuickFilterFooter">
                        <select class="w3-select videoTypeQuickFilter" onchange="setVideoTypeQuickFilter(this.value)">
                            <option value="all">All types</option>
                            ${types.map((type) => `<option value="${type}" ${videoQuickFilters.type === type ? "selected" : ""}>${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))}</option>`).join("")}
                        </select>
                <button class="w3-button w3-white w3-border w3-round-large" onclick="clearVideoFilters()">Clear</button>
                    </div>
                    <p class="w3-small videoSidebarMeta">Showing ${visibleIndices.length} of ${videos.length} videos</p>
                </div>
            </div>
        </div>`;
    if (pinnedFavoriteIndices.length > 0) {
        videoList += `<div class="videoListSectionHeader">
                    <h5 class="videoListSectionTitle">Favorites</h5>
                    <div class="videoListSectionActions" role="group" aria-label="Selection actions for favorites">
                        <button class="videoSectionAction" onclick="applyFavoriteSelection('select')">All</button>
                        <button class="videoSectionAction" onclick="applyFavoriteSelection('only')">Only</button>
                        <button class="videoSectionAction" onclick="applyFavoriteSelection('clear')">None</button>
                    </div>
                </div>`;
        for (const index of pinnedFavoriteIndices) {
            videoList += renderVideoListRow(index);
        }
    }
    let headertxt = "";
    for (const index of regularIndices) {
        const video = videos[index];
        const safeLabel = String(video.accessibilityLabel ?? "").replace(/'/g, "\\'");
        if (headertxt !== video.accessibilityLabel) {
            videoList += `<div class="videoListSectionHeader">
                    <h5 class="videoListSectionTitle" title="${escapeHtml(video.accessibilityLabel)}">${escapeHtml(video.accessibilityLabel)}</h5>
                    <div class="videoListSectionActions" role="group" aria-label="Selection actions for ${escapeHtml(video.accessibilityLabel)}">
                        <button class="videoSectionAction" onclick="setVideoGroupSelection('${safeLabel}','select')">All</button>
                        <button class="videoSectionAction" onclick="setVideoGroupSelection('${safeLabel}','only')">Only</button>
                        <button class="videoSectionAction" onclick="setVideoGroupSelection('${safeLabel}','clear')">None</button>
                    </div>
                </div>`;
            headertxt = video.accessibilityLabel;
        }
        videoList += renderVideoListRow(index);
    }
    if (visibleIndices.length === 0) {
        videoList += `<div class="videoListEmptyState">
                <p>No videos match the current filters.</p>
                <button class="w3-button w3-white w3-border w3-round-large" onclick="clearVideoFilters()">Clear filters</button>
            </div>`;
    }
    $('#videoList').html(videoList);
    if (shouldRestoreSearchFocus) {
        const nextSearchInput = document.getElementById("videoSidebarSearch");
        if (nextSearchInput) {
            nextSearchInput.focus();
            if (typeof previousSelectionStart === "number" && typeof previousSelectionEnd === "number") {
                nextSearchInput.setSelectionRange(previousSelectionStart, previousSelectionEnd);
            }
        }
    }
}

$(document).ready(() => {
    makeList();
    selectVideo(-1);
});

//Shows further info when you click on a video
function selectVideo(index) {
    selectedVideoIndex = index;
    let x = document.getElementsByClassName("videoListEntry");
    for (i = 0; i < x.length; i++) {
        x[i].className = x[i].className.replace(" videoListEntryActive", "");
    }
    if (index > -1) {
        downloadedVideos = electron.store.get("downloadedVideos") ?? [];
        favoriteVideos = electron.store.get("favoriteVideos") ?? [];
        const selectedEntry = document.getElementById("videoList-" + index);
        if (selectedEntry) {
            selectedEntry.className += " videoListEntryActive";
        }
        const hasDownloadedCopy = downloadedVideos.includes(videos[index].id);
        const isFavorite = favoriteVideos.includes(videos[index].id);
        let videoSRC = getVideoSource(videos[index]);
        if (hasDownloadedCopy) {
            videoSRC = `${electron.store.get('cachePath')}/${videos[index].id}.mov`;
        }
        const hasVideoSource = typeof videoSRC === "string" && videoSRC.length > 0;
        const player = document.getElementById("videoPlayer");
        if (hasVideoSource) {
            player.src = videoSRC;
            $('#videoPlayer').show();
        } else {
            player.pause();
            player.removeAttribute("src");
            player.load();
            $('#videoPlayer').hide();
        }
        $('#videoName').text(videos[index].accessibilityLabel);
        let videoDownloadState = "whenChecked";
        if (alwaysDownloadVideos.includes(videos[index].id)) {
            videoDownloadState = "always";
        } else if (neverDownloadVideos.includes(videos[index].id)) {
            videoDownloadState = "never";
        }
        $('#videoInfo').html(`<div class="videoInfoContent">
                              <div class="settingActionRow videoInfoTopActions">
                                  <button class="w3-button w3-white w3-border w3-border-blue w3-round-large" onclick="selectVideo(-1)">
                                    <i class="fa fa-arrow-left"></i> Back to Video Settings
                                  </button>
                                  <button class="w3-button w3-white w3-border ${isFavorite ? "w3-border-yellow" : "w3-border-blue"} w3-round-large" onclick="toggleFavoriteVideo('${videos[index].id}')">
                                    <i class="fa ${isFavorite ? "fa-star" : "fa-star-o"}"></i> ${isFavorite ? "Unfavorite" : "Favorite"}
                                  </button>
                              </div>
                              ${hasVideoSource ? "" : "<p class='w3-small'>Preview is unavailable for this video source.</p>"}
                              ${isFavorite ? "<p class='w3-large'><i class='fa fa-star' style='color: #d4a017'></i> Favorite</p>" : ""}
                              ${hasDownloadedCopy ? "<p class='w3-large'><i class='far fa-check-circle' style='color: #4CAF50'></i> Downloaded</p>" : "<p class='w3-large'><i class='far fa-times-circle' style='color: #f44336'></i> Downloaded</p>"}
                              <div class="w3-small videoInfoDownloadOptions">
                                  <label class="videoInfoDownloadOption">
                                      <input class="w3-radio" type="radio" name="downloadVideo" onclick="changeVideoDownloadState(this, '${videos[index].id}')" value="whenChecked" ${videoDownloadState === "whenChecked" ? "checked" : ""}>
                                      <span>Download when checked and cache is enabled</span>
                                  </label>
                                  <label class="videoInfoDownloadOption">
                                      <input class="w3-radio" type="radio" name="downloadVideo" onclick="changeVideoDownloadState(this, '${videos[index].id}')" value="always" ${videoDownloadState === "always" ? "checked" : ""}>
                                      <span>Always download</span>
                                  </label>
                                  <label class="videoInfoDownloadOption">
                                      <input class="w3-radio" type="radio" name="downloadVideo" onclick="changeVideoDownloadState(this, '${videos[index].id}')" value="never" ${videoDownloadState === "never" ? "checked" : ""}>
                                      <span>Never download</span>
                                  </label>
                              </div></div>`).css('display', '');
        $('#videoSettings').css('display', 'none');
    } else {
        const player = document.getElementById("videoPlayer");
        player.pause();
        player.removeAttribute("src");
        player.load();
        $('#videoPlayer').hide();
        $('#videoName').text("Video Settings");
        $('#videoInfo').css('display', 'none');
        renderVideoSettingsPanel();
    }
}

function changeVideoDownloadState(element, videoId) {
    alwaysDownloadVideos = alwaysDownloadVideos.filter(function (item, pos, self) {
        return item !== videoId;
    });
    neverDownloadVideos = neverDownloadVideos.filter(function (item, pos, self) {
        return item !== videoId;
    });
    switch (element.value) {
        case "whenChecked":
            break;
        case "always":
            alwaysDownloadVideos.push(videoId);
            break;
        case "never":
            neverDownloadVideos.push(videoId);
            break;
    }
    electron.store.set("alwaysDownloadVideos", alwaysDownloadVideos);
    electron.store.set("neverDownloadVideos", neverDownloadVideos);
    refreshCache();
}

function changeAllVideoDownloadState(elementId) {
    alwaysDownloadVideos = [];
    neverDownloadVideos = [];
    switch ($(`#${elementId}`).val()) {
        case "whenChecked":
            break;
        case "always":
            for (let i = 0; i < videos.length; i++) {
                alwaysDownloadVideos.push(videos[i].id);
            }
            break;
        case "never":
            for (let i = 0; i < videos.length; i++) {
                neverDownloadVideos.push(videos[i].id);
            }
            break;
    }
    electron.store.set("alwaysDownloadVideos", alwaysDownloadVideos);
    electron.store.set("neverDownloadVideos", neverDownloadVideos);
    renderVideoSettingsPanel();
    refreshCache();
}

//Updates the video list when a video is checked
function checkVideo(e, index) {
    if (e.currentTarget.checked) {
        allowedVideos.push(videos[index].id);
    } else {
        allowedVideos.splice(allowedVideos.indexOf(videos[index].id), 1);
    }
    electron.store.set("allowedVideos", allowedVideos);
    if (selectedVideoIndex === -1) {
        renderVideoSettingsPanel();
    }
    setTimeout(refreshCache, 50);
}

//automated video selection buttons
function deselectAll() {
    allowedVideos = allowedVideos.filter(id => id[0] === "_");
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
}

function selectAll() {
    allowedVideos = [];
    for (let i = 0; i < videos.length; i++) {
        allowedVideos.push(videos[i].id);
    }
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
}

function selectType() {
    let type = $('#videoType').val();
    for (let i = 0; i < videos.length; i++) {
        if (videos[i].type === type) {
            if (!allowedVideos.includes(videos[i].id)) {
                allowedVideos.push(videos[i].id);
            }
        }
    }
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
}

function deselectType() {
    let type = $('#videoType').val();
    for (let i = 0; i < videos.length; i++) {
        if (videos[i].type === type) {
            if (allowedVideos.includes(videos[i].id)) {
                allowedVideos.splice(allowedVideos.indexOf(videos[i].id), 1);
            }
        }
    }
    electron.store.set("allowedVideos", allowedVideos);
    makeList();
    renderVideoSettingsPanel();
}

//Video Profiles
function createProfile(id) {
    const input = document.getElementById(id);
    document.getElementById("videoProfileNameInput").value = input?.value ?? "";
    document.getElementById("videoProfileDialogMode").value = "create";
    document.getElementById("videoProfileDialogSourceId").value = "";
    submitVideoProfileDialog();
}

function updateProfile(id) {
    saveCurrentSelectionToSelectedProfile();
}

function removeProfile(id) {
    deleteSelectedProfile();
}

function displayProfile(id) {
    applySelectedProfile();
}

//For formatting time and dates. Used throughout the config menu
function showMomentDisplay(id, stringID) {
    $(`#${id}`).text(moment().format(stringID.value));
}

//Autocomplete stuff
function autocomplete(inp, arr, func) {
    /*the autocomplete function takes two arguments,
    the text field element and an array of possible autocompleted values:*/
    var currentFocus;
    /*execute a function when someone writes in the text field:*/
    inp.addEventListener("input", function (e) {
        var a, b, i, val = this.value;
        /*close any already open lists of autocompleted values*/
        closeAllLists();
        /*if (!val) {
            return false;
        }*/
        currentFocus = -1;
        /*create a DIV element that will contain the items (values):*/
        a = document.createElement("DIV");
        a.setAttribute("id", this.id + "autocomplete-list");
        a.setAttribute("class", "autocomplete-items");
        /*append the DIV element as a child of the autocomplete container:*/
        this.parentNode.appendChild(a);
        /*for each item in the array...*/
        for (i = 0; i < arr.length; i++) {
            /*check if the item starts with the same letters as the text field value:*/
            if (arr[i].substr(0, val.length).toUpperCase() == val.toUpperCase() || !val) {
                /*create a DIV element for each matching element:*/
                b = document.createElement("DIV");
                /*make the matching letters bold:*/
                b.innerHTML = "<strong>" + arr[i].substr(0, val.length) + "</strong>";
                b.innerHTML += arr[i].substr(val.length);
                /*insert a input field that will hold the current array item's value:*/
                b.innerHTML += "<input type='hidden' value='" + arr[i] + "'>";
                /*execute a function when someone clicks on the item value (DIV element):*/
                b.addEventListener("click", function (e) {
                    /*insert the value for the autocomplete text field:*/
                    inp.value = this.getElementsByTagName("input")[0].value;
                    /*close the list of autocompleted values,
                    (or any other open lists of autocompleted values:*/
                    closeAllLists();
                    func(inp);
                });
                a.appendChild(b);
            }
        }
    });
    /*execute a function presses a key on the keyboard:*/
    inp.addEventListener("keydown", function (e) {
        var x = document.getElementById(this.id + "autocomplete-list");
        if (x) x = x.getElementsByTagName("div");
        if (e.keyCode == 40) {
            /*If the arrow DOWN key is pressed,
            increase the currentFocus variable:*/
            currentFocus++;
            /*and and make the current item more visible:*/
            addActive(x);
        } else if (e.keyCode == 38) { //up
            /*If the arrow UP key is pressed,
            decrease the currentFocus variable:*/
            currentFocus--;
            /*and and make the current item more visible:*/
            addActive(x);
        } else if (e.keyCode == 13) {
            /*If the ENTER key is pressed, prevent the form from being submitted,*/
            e.preventDefault();
            if (currentFocus > -1) {
                /*and simulate a click on the "active" item:*/
                if (x) x[currentFocus].click();
            }
        }
    });

    function addActive(x) {
        /*a function to classify an item as "active":*/
        if (!x) return false;
        /*start by removing the "active" class on all items:*/
        removeActive(x);
        if (currentFocus >= x.length) currentFocus = 0;
        if (currentFocus < 0) currentFocus = (x.length - 1);
        /*add class "autocomplete-active":*/
        x[currentFocus].classList.add("autocomplete-active");
    }

    function removeActive(x) {
        /*a function to remove the "active" class from all autocomplete items:*/
        for (var i = 0; i < x.length; i++) {
            x[i].classList.remove("autocomplete-active");
        }
    }

    function closeAllLists(elmnt) {
        /*close all autocomplete lists in the document,
        except the one passed as an argument:*/
        var x = document.getElementsByClassName("autocomplete-items");
        for (var i = 0; i < x.length; i++) {
            if (elmnt != x[i] && elmnt != inp) {
                x[i].parentNode.removeChild(x[i]);
            }
        }
    }

    /*execute a function when someone clicks in the document:*/
    /*document.addEventListener("click", function (e) {
        closeAllLists(e.target);
    });*/
}

function closeAllLists(elmnt) {
    /*close all autocomplete lists in the document,
    except the one passed as an argument:*/
    var x = document.getElementsByClassName("autocomplete-items");
    for (var i = 0; i < x.length; i++) {
        if (elmnt != x[i]) {
            x[i].parentNode.removeChild(x[i]);
        }
    }
}

document.addEventListener("click", function (e) {
    closeAllLists(e.target);
});

//Load available system fonts and populate the dropdowns
electron.fontListUniversal.getFonts().then(fonts => {
    fontList = Array.from(new Set(fonts)).sort((a, b) => a.localeCompare(b));
    populateGlobalFontSelect();
    syncSelectedTextPositionOptions();
}).catch(() => {
    populateGlobalFontSelect();
});

//Preview
function openPreview() {
    electron.ipcRenderer.send('openPreview');
}

function newGlobalShortcut() {
    electron.ipcRenderer.send('newGlobalShortcut');
}
