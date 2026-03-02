function isValidVideoSourceMap(src) {
    if (!src || typeof src !== "object") {
        return false;
    }
    return Object.values(src).some((value) => typeof value === "string" && value.trim().length > 0);
}

function sanitizeExtraVideo(video) {
    if (!video || typeof video !== "object") {
        return null;
    }
    if (typeof video.id !== "string" || video.id.trim().length === 0 || video.id.startsWith("_")) {
        return null;
    }
    if (!isValidVideoSourceMap(video.src)) {
        return null;
    }

    const trimmedId = video.id.trim();
    const src = {};
    for (const [key, value] of Object.entries(video.src)) {
        if (typeof value === "string" && value.trim().length > 0) {
            src[key] = value.trim();
        }
    }
    if (!isValidVideoSourceMap(src)) {
        return null;
    }

    const normalizedName = typeof video.name === "string" && video.name.trim().length > 0
        ? video.name.trim()
        : undefined;

    return {
        ...video,
        id: trimmedId,
        src,
        type: typeof video.type === "string" && video.type.trim().length > 0 ? video.type.trim() : "landscape",
        timeOfDay: typeof video.timeOfDay === "string" && video.timeOfDay.trim().length > 0 ? video.timeOfDay.trim() : "none",
        name: normalizedName,
        accessibilityLabel: typeof video.accessibilityLabel === "string" && video.accessibilityLabel.trim().length > 0
            ? video.accessibilityLabel.trim()
            : (normalizedName ?? trimmedId),
        userAdded: true
    };
}

function getVideoSource(videoInfo, preferredType) {
    if (!videoInfo || !videoInfo.src) {
        return undefined;
    }

    const aliases = {
        H2651080p: "HEVC1080p",
        H2654k: "HEVC2160p",
        HEVC1080p: "H2651080p",
        HEVC2160p: "H2654k"
    };
    const preferredCandidates = [preferredType, aliases[preferredType]].filter(Boolean);
    for (const preferredCandidate of preferredCandidates) {
        if (videoInfo.src[preferredCandidate]) {
            return videoInfo.src[preferredCandidate];
        }
    }

    const fallbackOrder = ["H2641080p", "HEVC1080p", "H2651080p", "HEVC2160p", "H2654k"];
    for (const fallbackType of fallbackOrder) {
        if (videoInfo.src[fallbackType]) {
            return videoInfo.src[fallbackType];
        }
    }

    for (const value of Object.values(videoInfo.src)) {
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

module.exports = {
    getVideoSource,
    isValidVideoSourceMap,
    sanitizeExtraVideo
};
