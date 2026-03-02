const FONT_SIZE_UNITS = Object.freeze(["vw", "vh", "vmin", "vmax", "rem", "em", "px", "%"]);

function normalizeOpacity(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    if (parsed < 0) {
        return 0;
    }
    if (parsed > 1) {
        return 1;
    }
    return parsed;
}

function normalizeFontSizeUnit(unit, fallbackUnit = "vw") {
    const normalizedFallback = String(fallbackUnit ?? "vw").trim().toLowerCase();
    const normalizedUnit = String(unit ?? "").trim().toLowerCase();
    if (FONT_SIZE_UNITS.includes(normalizedUnit)) {
        return normalizedUnit;
    }
    if (FONT_SIZE_UNITS.includes(normalizedFallback)) {
        return normalizedFallback;
    }
    return "vw";
}

function normalizeFontSizeValue(value, fallbackValue = 2) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
        return parsed;
    }
    return fallbackValue;
}

function getFontSizeCssValue(size, unit, fallbackSize = 2, fallbackUnit = "vw") {
    const normalizedUnit = normalizeFontSizeUnit(unit, fallbackUnit);
    const normalizedSize = normalizeFontSizeValue(size, fallbackSize);
    return `${normalizedSize}${normalizedUnit}`;
}

module.exports = {
    FONT_SIZE_UNITS,
    normalizeOpacity,
    normalizeFontSizeUnit,
    normalizeFontSizeValue,
    getFontSizeCssValue
};
