import {
    GRID_COLUMNS,
    GRID_ROWS,
    WIDGET_SCHEMA_VERSION,
    OwnedWidgetProfile,
    Widget,
    WidgetConfig,
    WidgetConfigSchema,
    WidgetLayout,
    WidgetMode,
    WidgetType,
    createDefaultWidgetConfig,
    createOwnedProfile,
    createWidget
} from "./widget-schema";

type LegacyLine = Record<string, unknown> & {type?: string};
type LegacyDisplayText = Record<string, unknown> & {positionList?: string[]};

const POSITION_COLUMNS: Record<string, number> = {
    topleft: 0,
    left: 0,
    bottomleft: 0,
    topmiddle: 16,
    middle: 16,
    bottommiddle: 16,
    topright: 32,
    right: 32,
    bottomright: 32,
    random: 16
};

const PREVIOUS_GRID_COLUMNS = 24;
const PREVIOUS_GRID_ROWS = 14;
const GRID_SCALE = 2;

function numberValue(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeColor(value: unknown, fallback = "#ffffff"): string {
    const normalized = String(value || "");
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback;
}

const FONT_SIZE_UNITS = new Set(["vw", "vh", "vmin", "vmax", "rem", "em", "px", "%"]);

function normalizeFontSize(value: unknown, fallback = 2): number {
    return Math.min(20, Math.max(0.5, numberValue(value, fallback)));
}

function normalizeFontSizeUnit(value: unknown): Widget["style"]["fontSizeUnit"] {
    const unit = String(value ?? "vmin");
    return FONT_SIZE_UNITS.has(unit) ? unit as Widget["style"]["fontSizeUnit"] : "vmin";
}

function normalizeFontWeight(value: unknown): number {
    return Math.min(900, Math.max(100, Math.round(numberValue(value, 400) / 100) * 100));
}

function mapLegacyType(type: string): WidgetType | null {
    const mapped: Record<string, WidgetType> = {
        text: "text",
        html: "custom-html",
        time: "clock",
        weather: "weather",
        astronomy: "astronomy",
        information: "video-info",
        image: "image"
    };
    return mapped[type] ?? null;
}

function legacyWidgetSettings(type: WidgetType, line: LegacyLine): Record<string, unknown> {
    switch (type) {
        case "text": return {text: String(line.text ?? "")};
        case "custom-html": return {html: String(line.html ?? "")};
        case "clock": return {format: String(line.timeString ?? "HH:mm")};
        case "weather": return {unit: line.weatherUnit === "f" ? "f" : "c", view: "current"};
        case "astronomy": return {event: String(line.astronomy ?? "sunrise"), format: String(line.astroTimeString ?? "HH:mm")};
        case "video-info": return {field: String(line.infoType ?? "name")};
        case "image": return {path: String(line.imagePath ?? ""), fit: "contain"};
        default: return {};
    }
}

function getLegacyLines(displayText: LegacyDisplayText, position: string): LegacyLine[] {
    const value = displayText[position];
    return Array.isArray(value) ? value.filter((line): line is LegacyLine => Boolean(line && typeof line === "object")) : [];
}

function legacyGroupStartRow(position: string, count: number): number {
    const height = Math.max(2, count * 4);
    if (position.startsWith("bottom")) {
        return Math.max(0, GRID_ROWS - height);
    }
    if (position === "left" || position === "right" || position === "middle" || position === "random") {
        return Math.max(0, Math.floor((GRID_ROWS - height) / 2));
    }
    return 0;
}

function convertDisplayText(displayText: unknown, mode: WidgetMode, legacy: Record<string, unknown>): OwnedWidgetProfile {
    const source = displayText && typeof displayText === "object" ? displayText as LegacyDisplayText : {};
    const positions = Array.isArray(source.positionList) ? source.positionList : [];
    const widgets: Widget[] = [];
    let idIndex = 0;

    for (const position of positions) {
        const activeLines = getLegacyLines(source, position).filter((line) => mapLegacyType(String(line.type ?? "")) !== null);
        let y = legacyGroupStartRow(position, activeLines.length);
        for (const line of activeLines) {
            const type = mapLegacyType(String(line.type ?? ""));
            if (!type) {
                continue;
            }
            const h = type === "image" ? 8 : 4;
            const w = type === "image" ? 12 : 16;
            const layout: WidgetLayout = {
                x: Math.min(POSITION_COLUMNS[position] ?? 8, GRID_COLUMNS - w),
                y: Math.min(y, GRID_ROWS - h),
                w,
                h,
                strategy: position === "random" ? "roaming" : "fixed",
                screen: typeof line.onlyShowOnScreen === "number" || /^\d+$/.test(String(line.onlyShowOnScreen ?? ""))
                    ? Number(line.onlyShowOnScreen)
                    : "all"
            };
            const useProfileStyle = line.defaultFont !== false;
            const widget = createWidget(type, idIndex, {
                id: `migrated-${mode}-${idIndex}`,
                name: `${type === "clock" ? "Time & date" : type.replaceAll("-", " ")} ${idIndex + 1}`,
                layout,
                style: {
                    useProfileStyle,
                    fontFamily: String(line.font || legacy.textFont || "Segoe UI"),
                    fontSizeMode: "auto",
                    fontSize: normalizeFontSize(line.fontSize ?? legacy.textSize),
                    fontSizeUnit: normalizeFontSizeUnit(line.fontSizeUnit ?? legacy.textSizeUnit),
                    fontWeight: normalizeFontWeight(line.fontWeight ?? legacy.textFontWeight),
                    color: normalizeColor(line.fontColor ?? legacy.textColor),
                    opacity: Math.min(1, Math.max(0, numberValue(line.opacity ?? legacy.textOpacity, 1))),
                    textAlign: position.includes("right") || position === "right" ? "right" : position.includes("middle") || position === "middle" ? "center" : "left",
                    background: "#000000",
                    backgroundOpacity: 0,
                    borderRadius: 12,
                    paddingMode: "all",
                    padding: 12,
                    paddingTop: 12,
                    paddingRight: 12,
                    paddingBottom: 12,
                    paddingLeft: 12
                },
                settings: legacyWidgetSettings(type, line)
            });
            widgets.push(widget);
            idIndex++;
            y += h;
        }
    }

    const profile = createOwnedProfile(widgets);
    profile.defaultStyle = {
        ...profile.defaultStyle,
        fontFamily: String(legacy.textFont ?? "Segoe UI"),
        fontSizeMode: "auto",
        fontSize: normalizeFontSize(legacy.textSize),
        fontSizeUnit: normalizeFontSizeUnit(legacy.textSizeUnit) as OwnedWidgetProfile["defaultStyle"]["fontSizeUnit"],
        fontWeight: normalizeFontWeight(legacy.textFontWeight),
        color: normalizeColor(legacy.textColor),
        opacity: Math.min(1, Math.max(0, numberValue(legacy.textOpacity, 1)))
    };
    return profile;
}

function migrateCoarseGridConfig(existing: unknown): WidgetConfig | null {
    if (!existing || typeof existing !== "object" || (existing as {schemaVersion?: unknown}).schemaVersion !== 1) {
        return null;
    }

    const candidate = structuredClone(existing) as Record<string, unknown>;
    const profiles = candidate.profiles;
    if (!profiles || typeof profiles !== "object") {
        return null;
    }

    for (const profile of Object.values(profiles)) {
        if (!profile || typeof profile !== "object" || (profile as {source?: unknown}).source !== "self") {
            continue;
        }
        const owned = profile as Record<string, unknown>;
        const grid = owned.grid as {columns?: unknown; rows?: unknown} | undefined;
        if (grid?.columns !== PREVIOUS_GRID_COLUMNS || grid?.rows !== PREVIOUS_GRID_ROWS || !Array.isArray(owned.widgets)) {
            return null;
        }
        owned.grid = {columns: GRID_COLUMNS, rows: GRID_ROWS};
        owned.widgets = owned.widgets.map((widget) => {
            if (!widget || typeof widget !== "object") {
                return widget;
            }
            const clonedWidget = widget as Record<string, unknown>;
            const layout = clonedWidget.layout;
            if (!layout || typeof layout !== "object") {
                return widget;
            }
            const oldLayout = layout as Record<string, unknown>;
            clonedWidget.layout = {
                ...oldLayout,
                x: Number(oldLayout.x) * GRID_SCALE,
                y: Number(oldLayout.y) * GRID_SCALE,
                w: Number(oldLayout.w) * GRID_SCALE,
                h: Number(oldLayout.h) * GRID_SCALE
            };
            return clonedWidget;
        });
        const minimalMotion = owned.minimalMotion;
        if (minimalMotion && typeof minimalMotion === "object") {
            const motion = minimalMotion as Record<string, unknown>;
            motion.maxOffsetCells = Number(motion.maxOffsetCells ?? 1) * GRID_SCALE;
        }
    }
    candidate.schemaVersion = WIDGET_SCHEMA_VERSION;
    const migrated = WidgetConfigSchema.safeParse(candidate);
    return migrated.success ? migrated.data : null;
}

export function migrateLegacyWidgetConfig(legacy: Record<string, unknown>): WidgetConfig {
    const existing = legacy.widgetConfig;
    const parsedExisting = WidgetConfigSchema.safeParse(existing);
    if (parsedExisting.success) {
        return parsedExisting.data;
    }
    const migratedGrid = migrateCoarseGridConfig(existing);
    if (migratedGrid) {
        return migratedGrid;
    }

    const screensaver = convertDisplayText(legacy.displayText, "screensaver", legacy);
    if (screensaver.widgets.length === 0) {
        const defaultConfig = createDefaultWidgetConfig();
        screensaver.widgets = defaultConfig.profiles.screensaver.widgets;
    }
    return WidgetConfigSchema.parse({
        schemaVersion: WIDGET_SCHEMA_VERSION,
        profiles: {
            screensaver,
            wallpaper: {source: "screensaver"},
            minimal: {source: "screensaver"}
        }
    });
}

export const LEGACY_WIDGET_SETTING_KEYS = [
    "displayText", "wallpaperDisplayText", "randomSpeed", "wallpaperRandomSpeed",
    "textFont", "textSize", "textSizeUnit", "textColor", "textOpacity", "textLineHeight",
    "textFontWeight", "textFadeInDuration", "textFadeOutDuration",
    "wallpaperTextFont", "wallpaperTextSize", "wallpaperTextSizeUnit", "wallpaperTextColor",
    "wallpaperTextOpacity", "wallpaperTextLineHeight", "wallpaperTextFontWeight",
    "wallpaperTextFadeInDuration", "wallpaperTextFadeOutDuration",
    "minimalTimeFormat", "minimalModeDefaultFont", "minimalModeFont", "minimalModeFontSize",
    "minimalModeFontSizeUnit", "minimalModeFontColor", "minimalModeOpacity", "minimalModeFontWeight"
] as const;
