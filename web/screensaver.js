const videos = electron.videos;
const urlSearchParams = new URLSearchParams(window.location.search);
const rendererMode = urlSearchParams.get("mode") ?? "screensaver";
const isWallpaperMode = rendererMode === "wallpaper";
const resumePlaybackState = {
    videoId: urlSearchParams.get("resumeVideoId") ?? "",
    currentTime: Math.max(0, Number(urlSearchParams.get("resumeTime")) || 0)
};
const MODE_SCOPED_SETTING_KEYS = new Set([
    "allowedVideos",
    "displayText",
    "playbackSpeed",
    "videoFilters",
    "textFont",
    "textSize",
    "textSizeUnit",
    "textColor",
    "textLineHeight",
    "textFontWeight",
    "textOpacity",
    "textFadeInDuration",
    "textFadeOutDuration",
    "randomSpeed"
]);

function modeScopedSettingKey(key) {
    if (!isWallpaperMode || !MODE_SCOPED_SETTING_KEYS.has(key)) {
        return key;
    }
    return `wallpaper${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function modeStoreGet(key) {
    return electron.store.get(modeScopedSettingKey(key));
}

const allowedVideos = modeStoreGet("allowedVideos");
let downloadedVideos = modeStoreGet("downloadedVideos");
let customVideos = modeStoreGet("customVideos");
const {getVideoSource} = electron.videoUtils;
const {
    normalizeOpacity,
    normalizeFontSizeUnit,
    normalizeFontSizeValue,
    getFontSizeCssValue
} = electron.textUtils;
let currentlyPlaying = '';
let transitionTimeout;
let poiTimeout = [];
let blackScreen = false;
let minimalModeActive = false;
let previousErrorId = "";
let numErrors = 1;
let screenNumber = null;
let randomType, randomDirection;
let nextVideoTimeout;
let randomInitialTimeout = null;
let randomInterval = null;
let minimalModeClockTimeout = null;
let minimalModeMoveInterval = null;
let minimalModeCurrentPosition = "";
const startInMinimalMode = urlSearchParams.get("startMode") === "minimal";
const videoChangeState = {
    inProgress: false,
    queuedDirection: null,
    waitingTimeout: null
};
let textTransitionTimeout = null;
let randomTextTransitionInProgress = false;
let textVisibilitySignaled = false;
let initialTextFadeStarted = false;
let initialTextFadeFallbackTimeout = null;
const opacityAnimationState = new WeakMap();
let wallpaperPlaybackStateInterval = null;
let wallpaperSpeedEaseInterval = null;
let wallpaperFullscreenActive = false;
let wallpaperCurrentPlaybackRate = Number(modeStoreGet('playbackSpeed')) || 1;
let wallpaperPauseTimeout = null;
let wallpaperPlaybackSmoothingActive = false;
const WALLPAPER_SLOWDOWN_TICK_MS = 100;
const WALLPAPER_PAUSE_AFTER_MS = 1000;
const WALLPAPER_PAUSE_RATE_FLOOR = 0.35;
const debugPlayback = modeStoreGet("debugPlayback") ?? false;
const playbackMetrics = {
    transitionRequests: 0,
    transitionQueued: 0,
    transitionStarts: 0,
    transitionCompletes: 0,
    transitionFailures: 0,
    staleCanPlayEvents: 0,
    prebufferTimeoutStarts: 0,
    transitionStartLatencyMs: 0,
    transitionDurationMs: 0,
    prebufferWaitMs: 0,
    droppedFrameEstimate: 0,
    frameTimes: [],
    selectedSource: "",
    selectedVideoId: "",
    renderMode: ""
};
let metricsOverlay = null;
let metricsOverlayInterval = null;
let activeTransitionStartedAt = 0;
let pendingTransitionRequestedAt = 0;

function once(callback) {
    let called = false;
    return () => {
        if (called || !callback) {
            return;
        }
        called = true;
        callback();
    };
}

function getConfiguredPlaybackSpeed() {
    return Math.max(0.05, Number(modeStoreGet('playbackSpeed')) || 1);
}

function applyPlaybackRate(rate) {
    const safeRate = Math.max(0.05, Number(rate) || 0.05);
    for (const container of containers) {
        container.playbackRate = safeRate;
    }
}

function setWallpaperPlaybackSmoothing(active) {
    if (!isWallpaperMode) {
        return;
    }
    if (wallpaperPlaybackSmoothingActive === active) {
        return;
    }
    wallpaperPlaybackSmoothingActive = active;
    for (const container of containers) {
        container.classList.toggle("wallpaperPlaybackSmoothing", active);
    }
}

function clearWallpaperPauseTimeout() {
    if (!wallpaperPauseTimeout) {
        return;
    }
    clearTimeout(wallpaperPauseTimeout);
    wallpaperPauseTimeout = null;
}

function pauseWallpaperAfterSlowdown() {
    if (wallpaperPauseTimeout) {
        return;
    }
    wallpaperPauseTimeout = setTimeout(() => {
        wallpaperPauseTimeout = null;
        if (!wallpaperFullscreenActive) {
            return;
        }
        wallpaperCurrentPlaybackRate = 0;
        for (const container of containers) {
            container.pause();
        }
    }, WALLPAPER_PAUSE_AFTER_MS);
}

function getTextTransitionDurationMs(setting, fallbackMs) {
    const parsed = Number(modeStoreGet(setting));
    if (!Number.isFinite(parsed)) {
        return fallbackMs;
    }
    return Math.max(0, Math.min(10000, parsed));
}

const textFadeInDuration = getTextTransitionDurationMs("textFadeInDuration", 650);
const textFadeOutDuration = getTextTransitionDurationMs("textFadeOutDuration", 260);
const globalDefaultTextOpacity = normalizeOpacity(modeStoreGet("textOpacity"), 1);
const WEATHER_RENDER_CHECK_MS = 5 * 60 * 1000;
const MINIMAL_MODE_MOVE_MS = 15 * 1000;
const WEATHER_ICON_BASE_PATH = "../assets/weather-icons/lucide";
const minimalModeTimeFormatter = new Intl.DateTimeFormat(undefined, {timeStyle: "short"});
let weatherDisplayTimeout = null;
let weatherDisplayRequest = null;
let latestWeatherData = modeStoreGet("weatherData") ?? null;
const minimalModeOverlay = document.getElementById("minimalModeOverlay");

function clearWeatherDisplayRefresh() {
    if (weatherDisplayTimeout) {
        clearTimeout(weatherDisplayTimeout);
        weatherDisplayTimeout = null;
    }
}

function normalizeWeatherUnit(unit) {
    return unit === "f" ? "f" : "c";
}

function getWeatherIconName(snapshot) {
    const weatherCode = Number(snapshot?.weatherCode);
    const windSpeedKmh = Number(snapshot?.windSpeedKmh);
    if ([95, 96, 99].includes(weatherCode)) {
        return "cloud-lightning.svg";
    }
    if ([56, 57, 66, 67, 71, 73, 75, 77, 85, 86].includes(weatherCode)) {
        return "cloud-snow.svg";
    }
    if ([45, 48].includes(weatherCode)) {
        return "cloud-fog.svg";
    }
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(weatherCode)) {
        return "cloud-rain.svg";
    }
    if (Number.isFinite(windSpeedKmh) && windSpeedKmh >= 35) {
        return "wind.svg";
    }
    if (weatherCode === 0) {
        return snapshot?.isDay ? "sun.svg" : "moon.svg";
    }
    if ([1, 2].includes(weatherCode)) {
        return snapshot?.isDay ? "cloud-sun.svg" : "cloud.svg";
    }
    return "cloud.svg";
}

function formatWeatherTemperature(snapshot, unit) {
    const normalizedUnit = normalizeWeatherUnit(unit);
    const temperature = normalizedUnit === "f" ? Number(snapshot?.temperatureF) : Number(snapshot?.temperatureC);
    if (!Number.isFinite(temperature)) {
        return "--";
    }
    return `${Math.round(temperature)}°${normalizedUnit.toUpperCase()}`;
}

function buildWeatherMarkup(snapshot, unit) {
    if (!snapshot?.available && !snapshot?.stale) {
        return `<span class="weatherInline weatherInlineUnavailable">Weather unavailable</span>`;
    }
    const iconName = getWeatherIconName(snapshot);
    return `<span class="weatherInline${snapshot?.stale ? " weatherInlineStale" : ""}">
            <img class="weatherIcon" src="${WEATHER_ICON_BASE_PATH}/${iconName}" alt="" aria-hidden="true">
            <span class="weatherTemperature">${formatWeatherTemperature(snapshot, unit)}</span>
        </span>`;
}

function renderWeatherHosts() {
    if (blackScreen) {
        return;
    }
    document.querySelectorAll(".weatherOverlayHost").forEach((element) => {
        element.innerHTML = buildWeatherMarkup(latestWeatherData, element.dataset.weatherUnit);
    });
}

function scheduleWeatherDisplayRefresh() {
    clearWeatherDisplayRefresh();
    if (blackScreen || !document.querySelector(".weatherOverlayHost")) {
        return;
    }
    weatherDisplayTimeout = setTimeout(() => {
        refreshWeatherDisplay(false);
    }, WEATHER_RENDER_CHECK_MS);
}

function refreshWeatherDisplay(force = false) {
    if (blackScreen || !document.querySelector(".weatherOverlayHost")) {
        return Promise.resolve(latestWeatherData);
    }
    if (weatherDisplayRequest) {
        return weatherDisplayRequest;
    }
    weatherDisplayRequest = electron.ipcRenderer.invoke("getWeatherData", force)
        .then((snapshot) => {
            latestWeatherData = snapshot;
            renderWeatherHosts();
            return snapshot;
        })
        .catch(() => {
            renderWeatherHosts();
            return latestWeatherData;
        })
        .finally(() => {
            weatherDisplayRequest = null;
            if (!blackScreen) {
                scheduleWeatherDisplayRefresh();
            }
        });
    return weatherDisplayRequest;
}

function logPlayback(message, details) {
    if (!debugPlayback) {
        return;
    }
    let suffix = "";
    if (details !== undefined) {
        suffix = typeof details === "string" ? ` ${details}` : ` ${JSON.stringify(details)}`;
    }
    electron.ipcRenderer.send('consoleLog', `[playback][screen ${screenNumber ?? "?"}] ${message}${suffix}`);
}

function ensureMetricsOverlay() {
    if (!debugPlayback || metricsOverlay) {
        return;
    }
    metricsOverlay = document.createElement("div");
    metricsOverlay.id = "playbackMetricsOverlay";
    metricsOverlay.style.cssText = "position:fixed;top:12px;left:12px;z-index:99999;background:rgba(0,0,0,.55);color:#d8f4d8;padding:8px 10px;font:12px/1.4 monospace;border-radius:6px;pointer-events:none;max-width:42vw;white-space:pre-wrap";
    document.body.appendChild(metricsOverlay);
    metricsOverlayInterval = setInterval(renderMetricsOverlay, 1000);
    renderMetricsOverlay();
}

function renderMetricsOverlay() {
    if (!debugPlayback || !metricsOverlay) {
        return;
    }
    const times = playbackMetrics.frameTimes;
    const avg = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : "0.00";
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(2) : "0.00";
    metricsOverlay.textContent = [
        `video: ${playbackMetrics.selectedVideoId || "-"}`,
        `source: ${playbackMetrics.selectedSource || "-"}`,
        `render: ${playbackMetrics.renderMode || "-"}`,
        `transition req/start/done/fail: ${playbackMetrics.transitionRequests}/${playbackMetrics.transitionStarts}/${playbackMetrics.transitionCompletes}/${playbackMetrics.transitionFailures}`,
        `queued: ${playbackMetrics.transitionQueued} | stale canplay: ${playbackMetrics.staleCanPlayEvents} | timeout starts: ${playbackMetrics.prebufferTimeoutStarts}`,
        `latency ms: ${Math.round(playbackMetrics.transitionStartLatencyMs)} | transition ms: ${Math.round(playbackMetrics.transitionDurationMs)} | prebuffer ms: ${Math.round(playbackMetrics.prebufferWaitMs)}`,
        `frame avg/p95 ms: ${avg}/${p95} | dropped(est): ${playbackMetrics.droppedFrameEstimate}`
    ].join("\n");
}

function detectSourceProfile(videoInfo, sourceUrl) {
    if (!videoInfo || !videoInfo.src || !sourceUrl) {
        return "";
    }
    for (const [profile, url] of Object.entries(videoInfo.src)) {
        if (url === sourceUrl) {
            return profile;
        }
    }
    return "custom";
}

function trackFrameDelta(deltaMs) {
    if (!Number.isFinite(deltaMs)) {
        return;
    }
    playbackMetrics.frameTimes.push(deltaMs);
    if (playbackMetrics.frameTimes.length > 180) {
        playbackMetrics.frameTimes.shift();
    }
    if (deltaMs > 40) {
        playbackMetrics.droppedFrameEstimate++;
    }
}

function quitApp() {
    if (isWallpaperMode) {
        return;
    }
    electron.ipcRenderer.send('quitApp');
}

//quit when a key is pressed
document.addEventListener('keydown', (e) => {
    if (isWallpaperMode) {
        return;
    }
    electron.ipcRenderer.send('keyPress', e.code);
});
if (!isWallpaperMode) {
    document.addEventListener('mousedown', quitApp);
    setTimeout(function () {
        var threshold = 5;
        document.addEventListener('mousemove', function (e) {
            if (threshold * threshold < e.movementX * e.movementX
                + e.movementY * e.movementY) {
                quitApp();
            }
        });
    }, 1500);
}

let containers = [document.getElementById("video"), document.getElementById("video2")]
let currentPlayer = 0;
let prePlayer = 1;

/*let video = document.getElementById("video");
let video2 = document.getElementById("video2");*/

containers.forEach((video) => {
    video.addEventListener('play', () => {
        video.style.backgroundColor = "black";
    });
    video.addEventListener("error", videoError);
    video.addEventListener("ended", () => {
        if (blackScreen || video !== containers[currentPlayer]) {
            return;
        }
        clearTimeout(nextVideoTimeout);
        newVideo();
    });
});

function videoError(event) {
    if (event.srcElement === containers[currentPlayer]) {
        setTimeout(() => {
            if (event.srcElement.currentTime === 0) {
                console.error('VIDEO PLAYBACK ERROR', event.target.error.message, event);
                if (previousErrorId !== currentlyPlaying) {
                    newVideo();
                }
                previousErrorId = currentlyPlaying;
                numErrors++;
            }
        }, 500 * numErrors);
    } else {
        console.warn("Error in Pre-Player");
    }
}

function prepVideo(videoContainer, direction, callback, options = {}) {
    if (blackScreen) {
        if (callback) {
            callback(false);
        }
        return
    }
    containers[videoContainer].src = "";
    const videoIdPromise = options.videoId
        ? Promise.resolve(options.videoId)
        : electron.ipcRenderer.invoke('newVideoId', {lastPlayed: currentlyPlaying, direction: direction ?? "next"});
    videoIdPromise.then((id) => {
        if (!id) {
            if (callback) {
                callback(false);
            }
            return;
        }
        let videoInfo, videoSRC;
        //grab video info and file location based on whether it is a custom video or not
        if (id[0] === "_") {
            videoInfo = customVideos[customVideos.findIndex((e) => {
                if (id === e.id) {
                    return true;
                }
            })];
            if (!videoInfo) {
                if (callback) {
                    callback(false);
                }
                return;
            }
            videoSRC = videoInfo.path;
        } else {
            let index = videos.findIndex((e) => {
                if (id === e.id) {
                    return true;
                }
            });
            if (index === -1) {
                if (callback) {
                    callback(false);
                }
                return;
            }
            videoInfo = videos[index];
            downloadedVideos = modeStoreGet("downloadedVideos");
            videoSRC = getVideoSource(videoInfo, modeStoreGet('videoFileType'));
            if (downloadedVideos.includes(videoInfo.id)) {
                videoSRC = `${modeStoreGet('cachePath')}/${videoInfo.id}.mov`;
            }
        }
        if (!videoSRC) {
            if (callback) {
                callback(false);
            }
            return;
        }
        //load video in video player
        containers[videoContainer].videoId = id;
        containers[videoContainer].src = videoSRC;
        playbackMetrics.selectedVideoId = id;
        playbackMetrics.selectedSource = detectSourceProfile(videoInfo, videoSRC);
        containers[videoContainer].playbackRate = isWallpaperMode ? Math.max(0.05, wallpaperCurrentPlaybackRate) : getConfiguredPlaybackSpeed();
        containers[videoContainer].pause();
        const resumeTime = Number(options.currentTime);
        if (Number.isFinite(resumeTime) && resumeTime > 0) {
            containers[videoContainer].addEventListener('loadedmetadata', () => {
                const duration = containers[videoContainer].duration;
                containers[videoContainer].currentTime = Number.isFinite(duration) && duration > 2
                    ? Math.min(resumeTime, Math.max(0, duration - 1))
                    : resumeTime;
            }, {once: true});
        }

        if (callback) {
            callback(true);
        }
    }).catch(() => {
        if (callback) {
            callback(false);
        }
    });
}

function playVideo(videoContainer, loadedCallback) {
    if (blackScreen) {
        return
    }

    currentlyPlaying = containers[videoContainer].videoId;
    containers[videoContainer].play().catch((error) => {
        console.warn("Video play was interrupted", error);
    });
    containers[videoContainer].playbackRate = isWallpaperMode ? Math.max(0.05, wallpaperCurrentPlaybackRate) : getConfiguredPlaybackSpeed();

    if (loadedCallback) {
        loadedCallback();
    }
}

function clearVideoWaitingTimeout() {
    if (videoChangeState.waitingTimeout) {
        clearTimeout(videoChangeState.waitingTimeout);
        videoChangeState.waitingTimeout = null;
    }
}

function completeVideoChange() {
    videoChangeState.inProgress = false;
    if (videoChangeState.queuedDirection) {
        const direction = videoChangeState.queuedDirection;
        videoChangeState.queuedDirection = null;
        newVideo(direction);
    }
}

function newVideo(direction = "next") {
    clearTimeout(nextVideoTimeout);
    playbackMetrics.transitionRequests++;
    pendingTransitionRequestedAt = performance.now();
    if (videoChangeState.inProgress) {
        playbackMetrics.transitionQueued++;
        videoChangeState.queuedDirection = direction;
        logPlayback("newVideo queued", {direction});
        return;
    }
    videoChangeState.inProgress = true;
    const targetPlayer = prePlayer;
    logPlayback("newVideo requested", {currentPlayer, prePlayer: targetPlayer});
    prepVideo(targetPlayer, direction, (prepared) => {
        if (!prepared) {
            playbackMetrics.transitionFailures++;
            logPlayback("newVideo prep failed", {targetPlayer});
            completeVideoChange();
            return;
        }
        clearVideoWaitingTimeout();
        let started = false;
        const onCanPlay = (source) => {
            if (started || blackScreen) {
                return;
            }
            started = true;
            clearVideoWaitingTimeout();
            if (source === "timeout") {
                playbackMetrics.prebufferTimeoutStarts++;
                logPlayback("canplay fallback timeout hit", {
                    targetPlayer,
                    readyState: containers[targetPlayer].readyState
                });
            }
            if (prePlayer !== targetPlayer) {
                playbackMetrics.staleCanPlayEvents++;
                logPlayback("stale onCanPlay ignored", {targetPlayer, currentPlayer, prePlayer});
                return;
            }
            playbackMetrics.transitionStarts++;
            playbackMetrics.prebufferWaitMs = performance.now() - pendingTransitionRequestedAt;
            playbackMetrics.transitionStartLatencyMs = playbackMetrics.prebufferWaitMs;
            activeTransitionStartedAt = performance.now();
            logPlayback("starting transition", {
                targetPlayer,
                currentPlayer,
                prePlayer,
                duration: containers[targetPlayer].duration,
                readyState: containers[targetPlayer].readyState
            });
            playVideo(targetPlayer, () => {
                runTransitionIn(transitionLength, completeVideoChange);
                scheduleNextVideo();
            });
        };

        if (containers[targetPlayer].readyState >= 3) {
            onCanPlay("readyState");
            return;
        }

        containers[targetPlayer].addEventListener('canplay', () => onCanPlay("canplay"), {once: true});
        //fail-safe in case a driver never reports canplay
        videoChangeState.waitingTimeout = setTimeout(() => {
            videoChangeState.waitingTimeout = null;
            onCanPlay("timeout");
        }, 1500);
    });
}

function scheduleNextVideo(videoContainer = prePlayer) {
    clearTimeout(nextVideoTimeout);
    const video = containers[videoContainer];
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime) || 0;
    const playbackRate = Math.max(0.05, Number(video.playbackRate) || getConfiguredPlaybackSpeed());
    if (!Number.isFinite(duration) || duration <= 0) {
        logPlayback("scheduleNextVideo skipped", {duration: video.duration, videoContainer});
        return;
    }
    const remainingMs = Math.max(0, (duration - currentTime) * 1000 / playbackRate);
    const nextInMs = Math.max(1000, remainingMs - transitionLength - 500);
    logPlayback("scheduleNextVideo", {inMs: nextInMs, durationMs: duration * 1000, currentTime, playbackRate, videoContainer});
    nextVideoTimeout = setTimeout(() => {
        newVideo();
        numErrors = 0;
    }, nextInMs);
}

function switchVideoContainers() {
    logPlayback("switchVideoContainers before", {currentPlayer, prePlayer});
    if (videoQuality) {
        containers[currentPlayer].style.display = 'none';
        containers[prePlayer].style.display = '';
    } else if (useModernTransitions) {
        containers[currentPlayer].style.opacity = '0';
        containers[currentPlayer].style.display = 'none';
        containers[prePlayer].style.display = '';
        containers[prePlayer].style.opacity = '1';
    }
    containers[currentPlayer].pause();
    let temp = currentPlayer;
    currentPlayer = prePlayer;
    transitionPercent = 1;
    prePlayer = temp;
    logPlayback("switchVideoContainers after", {currentPlayer, prePlayer});
    playbackMetrics.transitionCompletes++;
    if (activeTransitionStartedAt > 0) {
        playbackMetrics.transitionDurationMs = performance.now() - activeTransitionStartedAt;
        activeTransitionStartedAt = 0;
    }
}

function drawDynamicText() {
    if (blackScreen) {
        return;
    }
    let videoInfo;
    if (currentlyPlaying[0] === "_") {
        videoInfo = customVideos[customVideos.findIndex((e) => {
            if (currentlyPlaying === e.id) {
                return true;
            }
        })];
    } else {
        let index = videos.findIndex((e) => {
            if (currentlyPlaying === e.id) {
                return true;
            }
        });
        videoInfo = videos[index];
    }

    //exit the function if no video info is found
    if (!videoInfo) {
        return;
    }

    for (let position of displayText.positionList) {
        for (let i = 0; i < displayText[position].length; i++) {
            let line = displayText[position][i];
            let textArea;
            if (position !== "random") {
                textArea = $(`#${position}-${i}`);
            } else {
                textArea = $(`#${position}-${i}`);
            }
            if (line.type === "information") {
                if (line.infoType === "poi" && position !== "random") {
                    if (videoInfo["pointsOfInterest"] !== undefined) {
                        changePOI(position, i, -1, videoInfo["pointsOfInterest"]);
                    } else {
                        changePOI(position, i, -1, {"0": ""});
                    }
                } else {
                    textArea.text(videoInfo[line.infoType]);
                }
            }
        }
    }
}

let transitionLength = modeStoreGet('videoTransitionLength');
let transitionPercent = 1;
let transitionSource = "";
const useModernTransitions = !modeStoreGet("videoQuality") && (modeStoreGet("modernTransitions") ?? true);

function runTransitionIn(time, onComplete) {
    const complete = once(onComplete);
    if (useModernTransitions) {
        transitionVideosModern(time, complete);
        return;
    }
    clearTimeout(transitionTimeout);
    fadeVideoIn(time, complete);
}

function transitionVideosModern(time, onComplete) {
    drawDynamicText();
    const fromVideo = containers[currentPlayer];
    const toVideo = containers[prePlayer];

    fromVideo.style.transition = `opacity ${time}ms linear`;
    toVideo.style.transition = `opacity ${time}ms linear`;
    fromVideo.style.display = '';
    toVideo.style.display = '';
    toVideo.style.opacity = '0';

    requestAnimationFrame(() => {
        fromVideo.style.opacity = '0';
        toVideo.style.opacity = '1';
    });

    clearTimeout(transitionTimeout);
    transitionTimeout = setTimeout(() => {
        switchVideoContainers();
        fromVideo.style.transition = '';
        toVideo.style.transition = '';
        transitionTimeout = null;
        onComplete();
    }, time);
}

function fadeVideoOut(time) {
    transitionSource = "fadeout";
    if (time > 0) {
        transitionTimeout = setTimeout(fadeVideoOut, 16, time - 16);
    }
    transitionPercent = time / transitionLength;
    if (transitionPercent <= 0) {
        transitionPercent = 0;
        clearTimeout(transitionTimeout);
        setTimeout(() => {
            transitionSource = ""
        }, 1000);
    } else if (transitionPercent >= 1) {
        transitionPercent = 1;
    }
}

function fadeTextOut(time) {
    if (time > 0) {
        textTransitionTimeout = setTimeout(fadeTextOut, 16, time - 16);
    }
    $('#textDisplayArea').css('opacity', time / transitionLength);
}

function getElementOpacity(element, fallback = 1) {
    if (!element) {
        return fallback;
    }
    const inlineOpacity = Number(element.style.opacity);
    if (Number.isFinite(inlineOpacity)) {
        return inlineOpacity;
    }
    const computedOpacity = Number(window.getComputedStyle(element).opacity);
    if (Number.isFinite(computedOpacity)) {
        return computedOpacity;
    }
    return fallback;
}

function stopOpacityAnimation(element) {
    if (!element) {
        return;
    }
    const current = opacityAnimationState.get(element);
    if (current) {
        cancelAnimationFrame(current.rafId);
        opacityAnimationState.delete(element);
    }
}

function animateOpacity(element, from, to, duration, onComplete) {
    if (!element) {
        if (onComplete) {
            onComplete();
        }
        return;
    }
    const safeFrom = normalizeOpacity(from, 1);
    const safeTo = normalizeOpacity(to, 1);
    const safeDuration = Math.max(0, Number(duration) || 0);

    stopOpacityAnimation(element);
    element.style.opacity = String(safeFrom);
    if (safeDuration === 0 || safeFrom === safeTo) {
        element.style.opacity = String(safeTo);
        if (onComplete) {
            onComplete();
        }
        return;
    }

    const startTime = performance.now();
    const step = (now) => {
        const progress = Math.min(1, (now - startTime) / safeDuration);
        const value = safeFrom + ((safeTo - safeFrom) * progress);
        element.style.opacity = String(value);
        if (progress >= 1) {
            opacityAnimationState.delete(element);
            if (onComplete) {
                onComplete();
            }
            return;
        }
        const rafId = requestAnimationFrame(step);
        opacityAnimationState.set(element, {rafId});
    };

    const rafId = requestAnimationFrame(step);
    opacityAnimationState.set(element, {rafId});
}

function fadeInTextOverlay(duration = textFadeInDuration) {
    const overlay = document.getElementById("textDisplayArea");
    clearTimeout(textTransitionTimeout);
    animateOpacity(overlay, 0, 1, duration);
}

function fadeVideoIn(time, onComplete) {
    if (time === transitionLength) {
        if (transitionSettings.type === "random") {
            randomType = true;
            transitionSettings.type = transitionTypes[randomInt(0, transitionTypes.length - 1)];
            transitionSettings.direction = transitionDirections[transitionSettings.type][randomInt(0, transitionDirections[transitionSettings.type].length - 1)];
        }
        if (transitionSettings.direction === "random") {
            randomDirection = true;
            transitionSettings.direction = transitionDirections[transitionSettings.type][randomInt(0, transitionDirections[transitionSettings.type].length - 1)];
        }
    }
    if (time > 0) {
        transitionTimeout = setTimeout(() => fadeVideoIn(time - 16, onComplete), 16);
    }
    transitionPercent = 1 - (time / transitionLength);

    //update dynamic video text 1/3 of the way through the transition
    if (transitionPercent >= .33) {
        drawDynamicText();
    }
    if (transitionPercent <= 0) {
        transitionPercent = 0;
    } else if (transitionPercent >= 1) {
        transitionPercent = 1;
        clearTimeout(transitionTimeout);
        switchVideoContainers();
        if (randomType) {
            transitionSettings.type = "random";
        }
        if (randomDirection) {
            transitionSettings.direction = "random";
        }
        onComplete();
    }
}

function changePOI(position, line, currentPOI, poiList) {
    if (blackScreen) {
        return;
    }
    poiTimeout = clearTimeouts(poiTimeout);
    let poiS = Object.keys(poiList);
    for (let i = 0; i < poiS.length; i++) {
        if (Number(poiS[i]) > currentPOI) {
            $(`#${position}-${line}`).text(poiList[poiS[i]]);
            if (i < poiS.length - 1) {
                poiTimeout.push(setTimeout(changePOI, (Number(poiS[i + 1]) - Number(poiS[i])) * 1000 || 0, position, line, poiS[i], poiList));
            }
            break;
        }
    }
}

function clearTimeouts(arr) {
    for (let i = 0; i < arr.length; i++) {
        clearTimeout(arr[i]);
    }
    return [];
}

const transitionTypes = ["dissolve", "dipToBlack", "fade", "wipe", "circle", "fadeCircle"];
const transitionDirections = {
    "dissolve": [""],
    "dipToBlack": [""],
    "fade": ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"],
    "wipe": ["left", "right", "top", "bottom"],
    "circle": ["normal", "reverse"],
    "fadeCircle": ["normal", "reverse"]
};
let transitionSettings = {
    "type": modeStoreGet("transitionType"),
    "direction": modeStoreGet("transitionDirection")
};

//put the video on the canvas
function drawVideo(dt) {
    trackFrameDelta(Number(dt));
    ctx1.reset();
    ctx1.filter = filterString;
    ctx1.globalCompositeOperation = "source-over";
    ctx1.globalAlpha = 1;
    if (minimalModeActive) {
        ctx1.fillStyle = "#000000";
        ctx1.fillRect(0, 0, window.innerWidth, window.innerHeight);
        requestAnimationFrame(drawVideo);
        return;
    }
    if (transitionPercent < 1) {
        if (transitionSource === "fadeout") {
            drawImage(ctx1, containers[currentPlayer]);
            ctx1.fillStyle = `rgba(0,0,0,${1 - transitionPercent})`;
            ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
            ctx1.fill();
        } else {
            let gradient, maxBound, rad;
            switch (transitionSettings.type) {
                case "dissolve":
                    if (containers[currentPlayer].paused) {
                        ctx1.fillStyle = `rgb(0, 0, 0)`;
                        ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                        ctx1.fill();
                    } else {
                        drawImage(ctx1, containers[currentPlayer]);
                    }
                    ctx1.globalCompositeOperation = "destination-out";
                    ctx1.fillStyle = `rgba(0,0,0,${transitionPercent})`;
                    ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                    ctx1.fill();
                    ctx1.globalCompositeOperation = "destination-over";
                    drawImage(ctx1, containers[prePlayer]);
                    break;
                case "dipToBlack":
                    if (transitionPercent <= .5) {
                        drawImage(ctx1, containers[currentPlayer]);
                        ctx1.globalCompositeOperation = "destination-out";
                        ctx1.fillStyle = `rgba(0,0,0,${transitionPercent * 2})`;
                        ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                        ctx1.fill();
                        ctx1.globalCompositeOperation = "destination-over";
                        ctx1.fillStyle = `rgb(0, 0, 0)`;
                        ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                        ctx1.fill();
                    } else {
                        ctx1.fillStyle = `rgb(0, 0, 0)`;
                        ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                        ctx1.fill();
                        ctx1.globalCompositeOperation = "destination-out";
                        ctx1.fillStyle = `rgba(0,0,0,${(transitionPercent - .5) * 2})`;
                        ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                        ctx1.fill();
                        ctx1.globalCompositeOperation = "destination-over";
                        drawImage(ctx1, containers[prePlayer]);
                    }
                    break;
                case"fade":
                    drawImage(ctx1, containers[prePlayer]);
                    ctx1.globalCompositeOperation = "destination-out";
                    switch (transitionSettings.direction) {
                        case "left":
                            gradient = ctx1.createLinearGradient(0, window.innerHeight / 2, window.innerWidth, window.innerHeight / 2);
                            break;
                        case "right":
                            gradient = ctx1.createLinearGradient(window.innerWidth, window.innerHeight / 2, 0, window.innerHeight / 2);
                            break;
                        case "top":
                            gradient = ctx1.createLinearGradient(window.innerWidth / 2, 0, window.innerWidth / 2, window.innerHeight);
                            break;
                        case "bottom":
                            gradient = ctx1.createLinearGradient(window.innerWidth / 2, window.innerHeight, window.innerWidth / 2, 0);
                            break;
                        case "top-left":
                            gradient = ctx1.createLinearGradient(0, 0, window.innerWidth, window.innerHeight);
                            break;
                        case"top-right":
                            gradient = ctx1.createLinearGradient(window.innerWidth, 0, 0, window.innerHeight);
                            break;
                        case"bottom-left":
                            gradient = ctx1.createLinearGradient(0, window.innerHeight, window.innerWidth, 0);
                            break;
                        case"bottom-right":
                            gradient = ctx1.createLinearGradient(window.innerWidth, window.innerHeight, 0, 0,);
                            break;
                    }
                    gradient.addColorStop(transitionPercent, "rgba(0,0,0,0)");
                    gradient.addColorStop(transitionPercent + .15 > 1 ? 1 : transitionPercent + .15, `rgba(0, 0, 0, 1)`);
                    ctx1.fillStyle = gradient;
                    ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                    ctx1.fill();
                    ctx1.globalCompositeOperation = "destination-over";
                    drawImage(ctx1, containers[currentPlayer]);
                    break;
                case "wipe":
                    drawImage(ctx1, containers[prePlayer]);
                    ctx1.globalCompositeOperation = "destination-in";
                    ctx1.globalAlpha = 1;
                    ctx1.fillStyle = "#000000";
                    switch (transitionSettings.direction) {
                        case "left":
                            ctx1.rect(0, 0, window.innerWidth * transitionPercent, window.innerHeight);
                            break;
                        case "right":
                            ctx1.rect(window.innerWidth - (window.innerWidth * transitionPercent), 0, window.innerWidth, window.innerHeight);
                            break;
                        case "top":
                            ctx1.rect(0, 0, window.innerWidth, window.innerHeight * transitionPercent);
                            break;
                        case "bottom":
                            ctx1.rect(0, window.innerHeight - (window.innerHeight * transitionPercent), window.innerWidth, window.innerHeight);
                            break;
                    }

                    ctx1.fill();
                    ctx1.globalCompositeOperation = "destination-over";
                    drawImage(ctx1, containers[currentPlayer]);
                    break;
                case "circle":
                    if (transitionSettings.direction === 'normal') {
                        drawImage(ctx1, containers[prePlayer]);
                        maxBound = window.innerWidth > window.innerHeight ? window.innerWidth : window.innerHeight;
                        rad = maxBound * (transitionPercent > 1 ? 1 : transitionPercent < 0 ? 0 : transitionPercent);
                        ctx1.fillStyle = "#000000";
                        ctx1.globalCompositeOperation = "destination-in";
                        ctx1.arc(window.innerWidth / 2, window.innerHeight / 2, rad, 0, Math.PI * 2);
                        ctx1.fill();

                        ctx1.globalCompositeOperation = "destination-over";
                        drawImage(ctx1, containers[currentPlayer]);
                    } else {
                        drawImage(ctx1, containers[prePlayer]);
                        maxBound = window.innerWidth > window.innerHeight ? window.innerWidth : window.innerHeight;
                        rad = maxBound * (1 - (transitionPercent > 1 ? 1 : transitionPercent < 0 ? 0 : transitionPercent));
                        ctx1.fillStyle = "#000000";
                        ctx1.globalCompositeOperation = "destination-out";
                        ctx1.arc(window.innerWidth / 2, window.innerHeight / 2, rad, 0, Math.PI * 2);
                        ctx1.fill();
                        ctx1.globalCompositeOperation = "destination-over";
                        drawImage(ctx1, containers[currentPlayer]);
                    }
                    break;
                case "fadeCircle" :
                    drawImage(ctx1, containers[prePlayer]);
                    ctx1.globalCompositeOperation = "destination-out";
                    maxBound = window.innerWidth > window.innerHeight ? window.innerWidth : window.innerHeight;
                    switch (transitionSettings.direction) {
                        case "reverse":
                            gradient = ctx1.createRadialGradient(window.innerWidth / 2, window.innerHeight / 2, maxBound, window.innerWidth / 2, window.innerHeight / 2, 0);
                            break;
                        default:
                            gradient = ctx1.createRadialGradient(window.innerWidth / 2, window.innerHeight / 2, 0, window.innerWidth / 2, window.innerHeight / 2, maxBound);
                            break;
                    }
                    gradient.addColorStop(transitionPercent, "rgba(0,0,0,0)");
                    gradient.addColorStop(transitionPercent + .05 > 1 ? 1 : transitionPercent + .05, `rgba(0, 0, 0, 1)`);
                    ctx1.fillStyle = gradient;
                    ctx1.rect(0, 0, window.innerWidth, window.innerHeight);
                    ctx1.fill();
                    ctx1.globalCompositeOperation = "destination-over";
                    drawImage(ctx1, containers[currentPlayer]);
                    break;
            }
        }
    } else {
        drawImage(ctx1, containers[currentPlayer]);
        //ctx1.drawImage(containers[currentPlayer], 0, 0, window.innerWidth, window.innerHeight);
    }
    requestAnimationFrame(drawVideo);
}

//function to scale image properly when drawn
let aspectRatio = window.innerWidth / window.innerHeight;
let widthScale = window.innerWidth / ((16 / 9) * window.innerHeight);
let heightScale = window.innerHeight / (window.innerWidth / (16 / 9));

function drawImage(context, image) {
    if (modeStoreGet("fillMode") === "stretch" || aspectRatio === 16 / 9) {
        //stretch
        context.drawImage(image, 0, 0, window.innerWidth, window.innerHeight);
    } else if (modeStoreGet("fillMode") === "crop") {
        //crop
        if (widthScale > 1) {
            context.drawImage(image, 0, (image.videoHeight - image.videoHeight / widthScale) / 2, image.videoWidth, image.videoHeight / widthScale, 0, 0, window.innerWidth, window.innerHeight);
        } else {
            context.drawImage(image, (image.videoWidth - image.videoWidth / heightScale) / 2, 0, image.videoWidth / heightScale, image.videoHeight, 0, 0, window.innerWidth, window.innerHeight);
        }
    }
}

let c1 = document.getElementById('canvasVideo');
let ctx1 = c1.getContext('2d');
c1.width = window.innerWidth;
c1.height = window.innerHeight;
let videoFilters = modeStoreGet('videoFilters');
let filterString = "";
for (let i = 0; i < videoFilters.length; i++) {
    if (videoFilters[i].value !== videoFilters[i].defaultValue) {
        filterString += `${videoFilters[i].name}(${videoFilters[i].value}${videoFilters[i].suffix}) `;
    }
}
ctx1.filter = filterString;
containers.forEach((container, index) => {
    container.style.filter = filterString;
    container.style.display = index === currentPlayer ? '' : 'none';
    container.style.opacity = index === currentPlayer ? '1' : '0';
});

// Fix for issue #110
// Replace requestAnimationFrame with our own that never sleeps
const drawVideoRequests = [];
const animationFPS = Number(modeStoreGet("fps")) || 60;
const forceAlternateRenderMethod = modeStoreGet("alternateRenderMethod") ?? false;
const autoAlternateRenderMethod = (modeStoreGet("alternateRenderAuto") ?? true)
    && !forceAlternateRenderMethod
    && !modeStoreGet("videoQuality")
    && !useModernTransitions
    && Number(modeStoreGet("numDisplays") ?? 1) > 1;
const useAlternateRenderMethod = forceAlternateRenderMethod || autoAlternateRenderMethod;
let videoQuality = modeStoreGet("videoQuality");
const shouldRenderWithCanvas = !videoQuality && !useModernTransitions;

if (autoAlternateRenderMethod) {
    logPlayback("auto alternate render fallback enabled", {
        numDisplays: modeStoreGet("numDisplays") ?? 1
    });
}

function enableVideoElementRendering() {
    $('#video').css('display', '');
    $('#video2').css('display', '');
    $('#canvasVideo').hide();
}

if (!shouldRenderWithCanvas) {
    playbackMetrics.renderMode = "video-elements";
    enableVideoElementRendering();
} else if (useAlternateRenderMethod) {
    playbackMetrics.renderMode = forceAlternateRenderMethod ? "alternate-raf-forced" : "alternate-raf-auto";
    function getAnimationFrame(start) {
        let time = start;
        const fns = drawVideoRequests.slice();
        drawVideoRequests.length = 0;

        const t = performance.now();
        const dt = t - start;
        const t1 = 1e3 / animationFPS; //60 FPS;

        for (const f of fns) f(dt);

        while (time <= t + t1 / 4) time += t1;
        setTimeout(getAnimationFrame, time - t, performance.now());
    }

    function requestAnimationFrame(func) {
        drawVideoRequests.push(func);
        return drawVideoRequests.length - 1;
    }

    getAnimationFrame(performance.now());
    drawVideo(16);
} else {
    playbackMetrics.renderMode = "native-raf";
    drawVideo(16);
}

function runClock(position, line, timeString) {
    if (blackScreen) {
        return
    }
    $(`#${position}-${line}-clock`).text(moment().format(timeString));
    displayText[position][line].clockTimeout = setTimeout(runClock, 1000 - new Date().getMilliseconds(), position, line, timeString);
}

//set up css
const globalFontSize = getFontSizeCssValue(
    modeStoreGet('textSize'),
    modeStoreGet('textSizeUnit'),
    2,
    "vw"
);
$('.displayText')
    .css('font-family', `"${modeStoreGet('textFont')}"`)
    .css('font-size', globalFontSize)
    .css('color', `${modeStoreGet('textColor')}`)
    .css('line-height', `${modeStoreGet('textLineHeight')}`)
    .css('font-weight', `${modeStoreGet('textFontWeight')}`);
$('#textDisplayArea').css('opacity', 0);

//draw text
let displayText = modeStoreGet('displayText') ?? [];
let html = "";
let textOverlayInitialized = false;

function getPositionAlignmentClass(position) {
    if (position.includes("left")) {
        return "w3-left-align";
    }
    if (position.includes("middle")) {
        return "w3-center";
    }
    if (position.includes("right")) {
        return "w3-right-align";
    }
    return "";
}

function clearDisplayTextTimers() {
    if (!displayText?.positionList) {
        return;
    }
    for (const position of displayText.positionList) {
        if (displayText[position]?.clockTimeout) {
            clearTimeout(displayText[position].clockTimeout);
            displayText[position].clockTimeout = null;
        }
        const lines = Array.isArray(displayText[position]) ? displayText[position] : [];
        for (const line of lines) {
            if (line?.clockTimeout) {
                clearTimeout(line.clockTimeout);
                line.clockTimeout = null;
            }
        }
    }
}

function reportWallpaperPlaybackState() {
    if (!isWallpaperMode || blackScreen) {
        return;
    }
    const activeVideo = containers[currentPlayer];
    if (!activeVideo?.videoId) {
        return;
    }
    electron.ipcRenderer.send('wallpaperPlaybackState', {
        videoId: activeVideo.videoId,
        currentTime: activeVideo.currentTime,
        duration: activeVideo.duration,
        screenNumber
    });
}

function updateWallpaperSpeedEase() {
    if (!isWallpaperMode) {
        return;
    }
    const configuredRate = getConfiguredPlaybackSpeed();
    const pauseFloor = Math.min(configuredRate, WALLPAPER_PAUSE_RATE_FLOOR);
    const slowdownTicks = Math.max(1, WALLPAPER_PAUSE_AFTER_MS / WALLPAPER_SLOWDOWN_TICK_MS);
    const step = Math.max(0.04, (configuredRate - pauseFloor) / slowdownTicks);
    if (wallpaperFullscreenActive) {
        clearTimeout(nextVideoTimeout);
        setWallpaperPlaybackSmoothing(true);
        pauseWallpaperAfterSlowdown();
        if (wallpaperCurrentPlaybackRate === 0) {
            return;
        }
        wallpaperCurrentPlaybackRate = Math.max(pauseFloor, wallpaperCurrentPlaybackRate - step);
        applyPlaybackRate(wallpaperCurrentPlaybackRate);
        return;
    }

    clearWallpaperPauseTimeout();
    if (wallpaperCurrentPlaybackRate === 0) {
        wallpaperCurrentPlaybackRate = configuredRate;
        applyPlaybackRate(wallpaperCurrentPlaybackRate);
        for (const container of containers) {
            if (container.videoId) {
                container.play().catch(() => {});
            }
        }
        scheduleNextVideo(currentPlayer);
        setWallpaperPlaybackSmoothing(false);
        return;
    }

    wallpaperCurrentPlaybackRate = Math.min(configuredRate, wallpaperCurrentPlaybackRate + step);
    applyPlaybackRate(wallpaperCurrentPlaybackRate);
    if (wallpaperCurrentPlaybackRate >= configuredRate) {
        setWallpaperPlaybackSmoothing(false);
    }
}

function setWallpaperFullscreenActive(isActive) {
    if (!isWallpaperMode) {
        return;
    }
    const wasFullscreenActive = wallpaperFullscreenActive;
    wallpaperFullscreenActive = Boolean(isActive);
    if (!wallpaperFullscreenActive && wallpaperCurrentPlaybackRate === 0) {
        wallpaperCurrentPlaybackRate = getConfiguredPlaybackSpeed();
        applyPlaybackRate(wallpaperCurrentPlaybackRate);
        for (const container of containers) {
            if (container.videoId && container.paused) {
                container.play().catch(() => {});
            }
        }
        setWallpaperPlaybackSmoothing(false);
    } else if (!wallpaperFullscreenActive) {
        clearWallpaperPauseTimeout();
    }
    if (wasFullscreenActive && !wallpaperFullscreenActive) {
        scheduleNextVideo(currentPlayer);
    }
    if (!wallpaperSpeedEaseInterval) {
        wallpaperSpeedEaseInterval = setInterval(updateWallpaperSpeedEase, WALLPAPER_SLOWDOWN_TICK_MS);
    }
}

function stopStandardOverlayActivity() {
    clearTimeout(nextVideoTimeout);
    clearVideoWaitingTimeout();
    clearTimeout(transitionTimeout);
    clearTimeout(textTransitionTimeout);
    clearTimeout(initialTextFadeFallbackTimeout);
    clearTimeout(randomInitialTimeout);
    clearTimeout(minimalModeClockTimeout);
    clearInterval(randomInterval);
    clearInterval(minimalModeMoveInterval);
    initialTextFadeFallbackTimeout = null;
    randomInitialTimeout = null;
    randomInterval = null;
    minimalModeClockTimeout = null;
    minimalModeMoveInterval = null;
    videoChangeState.queuedDirection = null;
    videoChangeState.inProgress = false;
    poiTimeout = clearTimeouts(poiTimeout);
    clearDisplayTextTimers();
    clearWeatherDisplayRefresh();

    const overlay = document.getElementById("textDisplayArea");
    stopOpacityAnimation(overlay);
    if (overlay) {
        overlay.style.opacity = "0";
        overlay.style.display = "none";
        overlay.innerHTML = "";
    }
}

function getMinimalModePositions() {
    return (displayText?.positionList ?? []).filter((position) => position !== "random");
}

function chooseNextMinimalModePosition(currentPosition = "") {
    const positions = getMinimalModePositions();
    if (positions.length <= 1) {
        return positions[0] ?? "middle";
    }
    let nextPosition = currentPosition;
    while (nextPosition === currentPosition) {
        nextPosition = positions[randomInt(0, positions.length - 1)];
    }
    return nextPosition;
}

function formatMinimalModeTime(date = new Date()) {
    const customFormat = String(modeStoreGet("minimalTimeFormat") ?? "").trim();
    if (customFormat) {
        return moment(date).format(customFormat);
    }
    return minimalModeTimeFormatter.format(date);
}

function getMinimalModeClockStyles() {
    const useDefaultFont = modeStoreGet("minimalModeDefaultFont") ?? true;
    const baseFontSizeValue = normalizeFontSizeValue(modeStoreGet('textSize'), 2);
    const baseFontSizeUnit = normalizeFontSizeUnit(modeStoreGet('textSizeUnit'), "vw");
    return {
        fontFamily: useDefaultFont
            ? modeStoreGet('textFont')
            : (modeStoreGet('minimalModeFont') || modeStoreGet('textFont')),
        fontSize: getFontSizeCssValue(
            useDefaultFont ? modeStoreGet('textSize') : modeStoreGet('minimalModeFontSize'),
            useDefaultFont ? modeStoreGet('textSizeUnit') : modeStoreGet('minimalModeFontSizeUnit'),
            baseFontSizeValue,
            baseFontSizeUnit
        ),
        color: useDefaultFont
            ? modeStoreGet('textColor')
            : (modeStoreGet('minimalModeFontColor') || modeStoreGet('textColor')),
        fontWeight: useDefaultFont
            ? modeStoreGet('textFontWeight')
            : (modeStoreGet('minimalModeFontWeight') || modeStoreGet('textFontWeight')),
        opacity: useDefaultFont
            ? globalDefaultTextOpacity
            : normalizeOpacity(modeStoreGet('minimalModeOpacity'), globalDefaultTextOpacity)
    };
}

function applyMinimalModeClockStyles() {
    const clock = document.getElementById("minimalModeClock");
    if (!clock) {
        return;
    }
    const styles = getMinimalModeClockStyles();
    clock.style.fontFamily = `"${styles.fontFamily}"`;
    clock.style.fontSize = styles.fontSize;
    clock.style.color = `${styles.color}`;
    clock.style.fontWeight = `${styles.fontWeight}`;
    clock.style.opacity = `${styles.opacity}`;
}

function renderMinimalMode(position = chooseNextMinimalModePosition()) {
    if (!minimalModeOverlay) {
        return;
    }
    minimalModeCurrentPosition = position;
    const align = getPositionAlignmentClass(position);
    minimalModeOverlay.innerHTML = `<div class="w3-display-${position} ${align} w3-container minimalModeTimeWrap">
            <div id="minimalModeClock" class="minimalModeTime">${formatMinimalModeTime()}</div>
        </div>`;
    applyMinimalModeClockStyles();
    minimalModeOverlay.style.display = "block";
    minimalModeOverlay.style.opacity = "1";
    minimalModeOverlay.setAttribute("aria-hidden", "false");
}

function scheduleMinimalModeClockUpdate() {
    clearTimeout(minimalModeClockTimeout);
    if (!minimalModeActive) {
        minimalModeClockTimeout = null;
        return;
    }
    const now = new Date();
    const delay = Math.max(1000, ((59 - now.getSeconds()) * 1000) + (1000 - now.getMilliseconds()));
    minimalModeClockTimeout = setTimeout(updateMinimalModeClock, delay);
}

function updateMinimalModeClock() {
    if (!minimalModeActive) {
        return;
    }
    const clock = document.getElementById("minimalModeClock");
    if (clock) {
        clock.textContent = formatMinimalModeTime();
    }
    scheduleMinimalModeClockUpdate();
}

function showMinimalMode() {
    minimalModeActive = true;
    renderMinimalMode(chooseNextMinimalModePosition());
    updateMinimalModeClock();
    minimalModeMoveInterval = setInterval(() => {
        if (!minimalModeActive) {
            return;
        }
        const nextPosition = chooseNextMinimalModePosition(minimalModeCurrentPosition);
        renderMinimalMode(nextPosition);
    }, MINIMAL_MODE_MOVE_MS);
    if (metricsOverlay) {
        metricsOverlay.style.display = "none";
    }
}

function clearVideoContainersForMinimalMode() {
    containers.forEach((container) => {
        container.pause();
        container.removeAttribute("src");
        container.load();
        container.style.opacity = "0";
    });
}

function resumeVideoPlayback(state) {
    if (!state?.videoId) {
        newVideo();
        return;
    }
    clearTimeout(nextVideoTimeout);
    videoChangeState.inProgress = true;
    const targetPlayer = prePlayer;
    prepVideo(targetPlayer, "next", (prepared) => {
        if (!prepared) {
            videoChangeState.inProgress = false;
            newVideo();
            return;
        }
        clearVideoWaitingTimeout();
        const startResumedVideo = () => {
            if (prePlayer !== targetPlayer) {
                return;
            }
            playVideo(targetPlayer, () => {
                runTransitionIn(0, completeVideoChange);
                scheduleNextVideo();
            });
        };
        if (containers[targetPlayer].readyState >= 3) {
            startResumedVideo();
            return;
        }
        containers[targetPlayer].addEventListener('canplay', startResumedVideo, {once: true});
        videoChangeState.waitingTimeout = setTimeout(() => {
            videoChangeState.waitingTimeout = null;
            startResumedVideo();
        }, 1500);
    }, state);
}

function activateMinimalMode(options = {}) {
    const immediate = Boolean(options.immediate);
    if (blackScreen) {
        return;
    }
    blackScreen = true;
    stopStandardOverlayActivity();
    if (immediate) {
        clearVideoContainersForMinimalMode();
        showMinimalMode();
        return;
    }
    fadeVideoOut(transitionLength);
    fadeTextOut(transitionLength);
    setTimeout(() => {
        clearVideoContainersForMinimalMode();
        showMinimalMode();
    }, transitionLength + 750);
}

function renderText() {
//create content divs
    if (blackScreen) {
        return;
    }
    html = "";
    for (let position of displayText.positionList) {
        let align = getPositionAlignmentClass(position);
        html += `<div class="w3-display-${position} ${align} w3-container textDisplayArea" id="textDisplay-${position}" style="text-shadow:.05vw .05vw 0 #444"></div>`;
        $('#textDisplayArea').html(html);
    }
    $('#textDisplayArea').css('display', "");
//add text to the content
    for (let position of displayText.positionList) {
        if (position !== "random") {
            displayTextPosition(position);
        }
    }
}

function initializeTextOverlay() {
    if (textOverlayInitialized) {
        return;
    }
    renderText();
    const overlay = document.getElementById("textDisplayArea");
    if (overlay) {
        overlay.style.opacity = "0";
    }
    textOverlayInitialized = true;
    if (document.visibilityState === "visible") {
        textVisibilitySignaled = true;
    }
    startInitialTextFadeIfReady();
    scheduleInitialTextFadeFallback();
}

function startInitialTextFadeIfReady() {
    if (!textOverlayInitialized || !textVisibilitySignaled || initialTextFadeStarted) {
        return;
    }
    initialTextFadeStarted = true;
    if (initialTextFadeFallbackTimeout) {
        clearTimeout(initialTextFadeFallbackTimeout);
        initialTextFadeFallbackTimeout = null;
    }
    fadeInTextOverlay();
}

function scheduleInitialTextFadeFallback() {
    if (initialTextFadeFallbackTimeout) {
        clearTimeout(initialTextFadeFallbackTimeout);
    }
    // Safety net: in case visibility/ipc events are missed, still show text.
    initialTextFadeFallbackTimeout = setTimeout(() => {
        if (initialTextFadeStarted) {
            return;
        }
        textVisibilitySignaled = true;
        startInitialTextFadeIfReady();
    }, 1500);
}

function applyRandomTextAtPosition(targetPosition, onComplete) {
    const targetSelector = $(`#textDisplay-${targetPosition}`);
    const targetElement = targetSelector[0];
    if (!targetElement) {
        if (onComplete) {
            onComplete();
        }
        return;
    }
    stopOpacityAnimation(targetElement);
    targetElement.style.opacity = "0";
    displayTextPosition("random", targetPosition);
    displayText.random.currentLocation = targetPosition;
    animateOpacity(targetElement, 0, 1, textFadeInDuration, onComplete);
}

function fadeSwitchRandomText(nextPosition) {
    if (randomTextTransitionInProgress) {
        return;
    }
    randomTextTransitionInProgress = true;
    const currentPosition = displayText.random.currentLocation;
    if (!currentPosition || currentPosition === "none") {
        applyRandomTextAtPosition(nextPosition, () => {
            randomTextTransitionInProgress = false;
        });
        return;
    }

    const currentSelector = $(`#textDisplay-${currentPosition}`);
    const currentElement = currentSelector[0];
    const currentOpacity = getElementOpacity(currentElement, 1);
    animateOpacity(currentElement, currentOpacity, 0, textFadeOutDuration, () => {
        currentSelector.html("");
        applyRandomTextAtPosition(nextPosition, () => {
            randomTextTransitionInProgress = false;
        });
    });
}

function getPositionMaxWidth(position) {
    const maxWidthMap = displayText.maxWidth;
    if (maxWidthMap && typeof maxWidthMap === "object" && maxWidthMap[position]) {
        return maxWidthMap[position];
    }
    const positionSettings = displayText[position];
    if (!positionSettings) {
        return "50%";
    }
    if (positionSettings.maxWidth) {
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

function displayTextPosition(position, displayLocation) {
    if (blackScreen) {
        return;
    }
    let selector = displayLocation ? `#textDisplay-${displayLocation}` : `#textDisplay-${position}`;
    let html = "";
    $(selector).css('width', 'auto');
    $(selector).css('max-width', getPositionMaxWidth(position));
    for (let i = 0; i < displayText[position].length; i++) {
        if (displayText[position][i].onlyShowOnScreen === undefined || screenNumber === null || Number(displayText[position][i].onlyShowOnScreen) === Number(screenNumber)) {
            html += `<div id="${position}-${i}" style="${displayText[position][i].customCSS}">${createContentLine(displayText[position][i], position, i)}</div>`;
        }
    }
    $(selector).html(html);
    for (let i = 0; i < displayText[position].length; i++) {
        const lineSettings = displayText[position][i];
        const lineElement = $(`#${position}-${i}`);
        if (lineElement.length === 0) {
            continue;
        }
        const lineOpacity = lineSettings.defaultFont
            ? globalDefaultTextOpacity
            : normalizeOpacity(lineSettings.opacity, globalDefaultTextOpacity);
        lineElement.css('opacity', `${lineOpacity}`);
        if (!lineSettings.defaultFont) {
            const lineFontSize = getFontSizeCssValue(
                lineSettings.fontSize,
                lineSettings.fontSizeUnit,
                normalizeFontSizeValue(modeStoreGet('textSize'), 2),
                normalizeFontSizeUnit(modeStoreGet('textSizeUnit'), "vw")
            );
            const lineFontFamily = lineSettings.font || modeStoreGet('textFont');
            const lineFontColor = lineSettings.fontColor || modeStoreGet('textColor');
            const lineFontWeight = lineSettings.fontWeight || modeStoreGet('textFontWeight');
            lineElement
                .css('font-family', `"${lineFontFamily}"`)
                .css('font-size', lineFontSize)
                .css('color', `${lineFontColor}`)
                .css('font-weight', `${lineFontWeight}`);
        }
    }
    renderWeatherHosts();
    refreshWeatherDisplay(false);
}

function createContentLine(contentLine, position, line) {
    let html = "";
    switch (contentLine.type) {
        case "none":
            break;
        case "text":
            html += contentLine.text;
            break;
        case "html":
            html += contentLine.html;
            break;
        case "image":
            html += `<img src="${contentLine.imagePath}" alt="There was an error displaying this image"
                    ${contentLine.imageWidth == "" ? "" : `height=${contentLine.imageWidth}`} 
                    />`;
            break;
        case "time":
            html += `<div id=${position}-${line}-clock></div>`;
            runClock(position, line, contentLine.timeString);
            break;
        case "astronomy":
            const astronomy = modeStoreGet("astronomy");
            let type = contentLine.astronomy;
            if (contentLine.astronomy === "sunrise/set") {
                if (new Date() < new Date(astronomy.sunrise) || new Date() > new Date(astronomy.sunset)) {
                    type = "sunrise";
                } else {
                    type = "sunset";
                }
            }
            if (contentLine.astronomy === "moonrise/set") {
                if (new Date() < new Date(astronomy.moonrise) && new Date() > new Date(astronomy.moonset)) {
                    type = "moonrise";
                } else {
                    type = "moonset";
                }
            }
            switch (type) {
                case "sunrise":
                    html += "Sunrise @"
                    break
                case "sunset":
                    html += "Sunset @"
                    break
                case "moonrise":
                    html += "Moonrise @"
                    break
                case "moonset":
                    html += "Moonset @"
                    break
            }
            let eventTime = moment(astronomy[type]);
            html += eventTime.format(contentLine.astroTimeString);
            break;
        case "information":
            html += "<script>drawDynamicText()</script>";
            break;
        case "weather":
            html += `<span id="${position}-${line}-weather" class="weatherOverlayHost" data-weather-unit="${normalizeWeatherUnit(contentLine.weatherUnit)}"></span>`;
            break;
    }
    return html;
}

let random = false;
for (let i = 0; i < displayText.random.length; i++) {
    if (displayText.random[i].type !== "none") {
        random = true;
    }
}
if (random) {
    displayText.random.currentLocation = "none";
    randomInitialTimeout = setTimeout(switchRandomText, 750);
    randomInterval = setInterval(switchRandomText, modeStoreGet('randomSpeed') * 1000);
}

function switchRandomText() {
    if (blackScreen) {
        return;
    }
    if (randomTextTransitionInProgress) {
        return;
    }
    let newLoc = false;
    let c = 0;
    do {
        c++;
        if (c > 100) {
            console.error("random overload - nowhere to go");
            break;
        }
        newLoc = displayText.positionList[randomInt(0, displayText.positionList.length - 1)];
        let text = false;
        for (let i = 0; i < displayText[newLoc].length; i++) {
            if (displayText[newLoc][i].type !== "none") {
                text = true;
            }
        }
        if (text || displayText.random.currentLocation === newLoc) {
            newLoc = false;
            continue;
        }
        if (displayText.random[0].type === "time" && displayText.random.currentLocation !== "none") {
            clearTimeout(displayText[displayText.random.currentLocation].clockTimeout);
        }
        fadeSwitchRandomText(newLoc);
    } while (!newLoc);
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

initializeTextOverlay();
ensureMetricsOverlay();
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        clearTimeout(nextVideoTimeout);
        clearVideoWaitingTimeout();
        return;
    }
    if (!textVisibilitySignaled && document.visibilityState === "visible") {
        textVisibilitySignaled = true;
        startInitialTextFadeIfReady();
    }
    if (!videoChangeState.inProgress && !blackScreen) {
        scheduleNextVideo();
    }
});

//play a video unless the window was launched directly into minimal mode
if (startInMinimalMode) {
    activateMinimalMode({immediate: true});
} else if (resumePlaybackState.videoId) {
    resumeVideoPlayback(resumePlaybackState);
} else {
    newVideo();
}

if (isWallpaperMode) {
    wallpaperPlaybackStateInterval = setInterval(reportWallpaperPlaybackState, 1000);
    wallpaperSpeedEaseInterval = setInterval(updateWallpaperSpeedEase, WALLPAPER_SLOWDOWN_TICK_MS);
}

electron.ipcRenderer.on('newVideo', (_event, direction) => {
    newVideo(direction === "previous" ? "previous" : "next");
});

electron.ipcRenderer.on('enterMinimalMode', activateMinimalMode);
electron.ipcRenderer.on('enterMinimalModeImmediate', () => {
    activateMinimalMode({immediate: true});
});
electron.ipcRenderer.on('blankTheScreen', () => {
    activateMinimalMode();
});

electron.ipcRenderer.on('screenNumber', (number) => {
    screenNumber = number;
    if (blackScreen) {
        return;
    }
    if (!textOverlayInitialized) {
        initializeTextOverlay();
        ensureMetricsOverlay();
        return;
    }
    renderText();
});

electron.ipcRenderer.on('screensaverVisible', () => {
    textVisibilitySignaled = true;
    startInitialTextFadeIfReady();
});

electron.ipcRenderer.on('wallpaperFullscreenState', setWallpaperFullscreenActive);
