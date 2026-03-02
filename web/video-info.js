const videos = structuredClone(electron.videos);
const types = ["cityscape", "landscape", "underwater", "space"];
const timeOfDays = [undefined, "day", "night"];

applyTheme(electron.store.get("configTheme") ?? "dark");

function applyTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    document.body.setAttribute("data-theme", normalized);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function getVideoTitle(video) {
    return video.name || video.accessibilityLabel || video.id || "Untitled Video";
}

function getPreviewSource(video) {
    if (!video || !video.src || typeof video.src !== "object") {
        return "";
    }
    const preferredType = electron.store.get("videoFileType");
    const aliases = {
        H2651080p: "HEVC1080p",
        H2654k: "HEVC2160p",
        HEVC1080p: "H2651080p",
        HEVC2160p: "H2654k"
    };
    const candidates = [preferredType, aliases[preferredType], "H2641080p", "HEVC1080p", "H2651080p", "HEVC2160p", "H2654k"];
    for (const candidate of candidates) {
        if (candidate && typeof video.src[candidate] === "string" && video.src[candidate].length > 0) {
            return video.src[candidate];
        }
    }
    for (const value of Object.values(video.src)) {
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return "";
}

function normalizeTimeOfDay(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    return value;
}

function createTypeSelect(selected, id) {
    let html = `<select id="${id}">`;
    for (const value of types) {
        html += `<option ${value === selected ? "selected" : ""} value="${value}">${value}</option>`;
    }
    html += "</select>";
    return html;
}

function createTimeOfDaySelect(selected, id) {
    let html = `<select id="${id}">`;
    for (const value of timeOfDays) {
        const optionValue = value === undefined ? "undefined" : value;
        html += `<option ${value === selected ? "selected" : ""} value="${optionValue}">${optionValue}</option>`;
    }
    html += "</select>";
    return html;
}

function renderVideos() {
    const typeFilter = document.getElementById("filterTypeSelect").value;
    const toDFilterRaw = document.getElementById("filterToDSelect").value;
    const toDFilter = toDFilterRaw === "undefined" ? undefined : toDFilterRaw;
    let html = "";
    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        const videoTimeOfDay = normalizeTimeOfDay(video.timeOfDay);
        const matchesType = typeFilter === ".*" || video.type === typeFilter;
        const matchesToD = toDFilterRaw === ".*" || videoTimeOfDay === toDFilter;
        if (!matchesType || !matchesToD) {
            continue;
        }

        const previewSrc = getPreviewSource(video);
        const sourceJson = JSON.stringify(video.src ?? {}, null, 2);
        const poiJson = JSON.stringify(video.pointsOfInterest ?? {}, null, 2);
        html += `<section id="video-${i}" class="editorCard">
                    <div class="editorCardHeader">
                        <h3>${escapeHtml(getVideoTitle(video))}</h3>
                        <button ${previewSrc ? "" : "disabled"} onclick="displayVideoModal('${escapeAttr(previewSrc)}')">Show Video</button>
                    </div>
                    <div class="editorGrid">
                        <div class="editorFields">
                            <div class="fieldRow">
                                <label>ID</label>
                                <span class="idValue">${escapeHtml(video.id)}</span>
                            </div>
                            <div class="fieldRow">
                                <label for="video-${i}-accessibilityLabel">Accessibility Label</label>
                                <input id="video-${i}-accessibilityLabel" type="text" value="${escapeAttr(video.accessibilityLabel)}">
                            </div>
                            <div class="fieldRow">
                                <label for="video-${i}-name">Name</label>
                                <input id="video-${i}-name" type="text" value="${escapeAttr(video.name)}">
                            </div>
                            <div class="fieldRow">
                                <label for="video-${i}-type">Type</label>
                                ${createTypeSelect(video.type, `video-${i}-type`)}
                            </div>
                            <div class="fieldRow">
                                <label for="video-${i}-timeOfDay">Time of Day</label>
                                ${createTimeOfDaySelect(videoTimeOfDay, `video-${i}-timeOfDay`)}
                            </div>
                        </div>
                        <div class="editorJson">
                            <div class="fieldRow">
                                <label for="videoSource-${i}">Source JSON</label>
                                <textarea id="videoSource-${i}" class="editorTextarea">${escapeHtml(sourceJson)}</textarea>
                            </div>
                            <div class="fieldRow">
                                <label for="videoPOI-${i}">Points of Interest JSON</label>
                                <textarea id="videoPOI-${i}" class="editorTextarea">${escapeHtml(poiJson)}</textarea>
                            </div>
                        </div>
                    </div>
                 </section>`;
    }
    document.getElementById("videoList").innerHTML = html;
}

function displayVideoModal(videoSRC) {
    document.getElementById("videoModal").style.display = "block";
    document.getElementById("modalVideo").src = videoSRC;
}

function closeVideoModal() {
    const modalVideo = document.getElementById("modalVideo");
    modalVideo.pause();
    modalVideo.removeAttribute("src");
    modalVideo.load();
    document.getElementById("videoModal").style.display = "none";
}

function closeExportModal() {
    document.getElementById("exportModal").style.display = "none";
}

function displayFilterModal() {
    document.getElementById("filterModal").style.display = "block";
}

function exportData() {
    const data = collectData();
    if (!data) {
        return;
    }
    document.getElementById("exportModal").style.display = "block";
    document.getElementById("exportText").value = JSON.stringify(data, null, 2);
}

function collectData() {
    for (let i = 0; i < videos.length; i++) {
        videos[i].accessibilityLabel = document.getElementById(`video-${i}-accessibilityLabel`).value;
        videos[i].name = document.getElementById(`video-${i}-name`).value;
        videos[i].type = document.getElementById(`video-${i}-type`).value;
        const timeOfDayValue = document.getElementById(`video-${i}-timeOfDay`).value;
        videos[i].timeOfDay = timeOfDayValue === "undefined" ? undefined : timeOfDayValue;
        let srcData = document.getElementById(`videoSource-${i}`).value;
        try {
            srcData = JSON.parse(srcData);
            videos[i].src = srcData;
        } catch (err) {
            alert(`Invalid source JSON for ${videos[i].name} (${videos[i].id})`);
            return false;
        }
        let poiData = document.getElementById(`videoPOI-${i}`).value;
        try {
            poiData = JSON.parse(poiData);
            videos[i].pointsOfInterest = poiData;
        } catch (err) {
            alert(`Invalid PoI JSON for ${videos[i].name} (${videos[i].id})`);
            return false;
        }
    }
    return videos;
}

function setFilters() {
    document.getElementById("filterModal").style.display = "none";
    renderVideos();
}

renderVideos();
