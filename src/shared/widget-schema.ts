import {z} from "zod";

export const WIDGET_SCHEMA_VERSION = 2;
export const GRID_COLUMNS = 48;
export const GRID_ROWS = 28;

export const WidgetModeSchema = z.enum(["screensaver", "wallpaper", "minimal"]);
export type WidgetMode = z.infer<typeof WidgetModeSchema>;

export type WidgetDisplay = {
    id: number;
    index: number;
    label: string;
    isPrimary: boolean;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
    scaleFactor: number;
    bounds: {x: number; y: number; width: number; height: number};
};

const WidgetDisplayBindingSchema = z.object({
    id: z.number().int().min(0),
    label: z.string(),
    isPrimary: z.boolean(),
    nativeWidth: z.number().int().positive(),
    nativeHeight: z.number().int().positive(),
    bounds: z.object({x: z.number(), y: z.number(), width: z.number(), height: z.number()})
});
type WidgetDisplayBinding = z.infer<typeof WidgetDisplayBindingSchema>;

export const WidgetTypeSchema = z.enum([
    "text",
    "custom-html",
    "clock",
    "weather",
    "astronomy",
    "video-info",
    "image",
    "system"
]);
export type WidgetType = z.infer<typeof WidgetTypeSchema>;

export const SYSTEM_SECTIONS = ["cpu", "memory", "storage"] as const;
export type SystemSection = typeof SYSTEM_SECTIONS[number];

export function systemSectionOrder(settings: Record<string, unknown>): SystemSection[] {
    const saved = Array.isArray(settings.sectionOrder) ? settings.sectionOrder : [];
    return [...new Set([...saved, ...SYSTEM_SECTIONS].filter((value): value is SystemSection =>
        typeof value === "string" && SYSTEM_SECTIONS.includes(value as SystemSection)))];
}

export const WidgetSizeSchema = z.enum(["small", "medium", "large", "custom"]);
export type WidgetSize = z.infer<typeof WidgetSizeSchema>;

export const WidgetLayoutSchema = z.object({
    x: z.number().int().min(0).max(GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(GRID_ROWS - 1),
    w: z.number().int().min(1).max(GRID_COLUMNS),
    h: z.number().int().min(1).max(GRID_ROWS),
    strategy: z.enum(["fixed", "roaming"]).default("fixed"),
    screen: z.union([z.literal("all"), z.number().int().min(0)]).default("all")
}).superRefine((layout, context) => {
    if (layout.x + layout.w > GRID_COLUMNS) {
        context.addIssue({code: "custom", message: "Widget extends beyond the grid width."});
    }
    if (layout.y + layout.h > GRID_ROWS) {
        context.addIssue({code: "custom", message: "Widget extends beyond the grid height."});
    }
});
export type WidgetLayout = z.infer<typeof WidgetLayoutSchema>;

export const WidgetStyleSchema = z.object({
    useProfileStyle: z.boolean().default(true),
    fontFamily: z.string().min(1).default("Segoe UI"),
    fontSizeMode: z.enum(["auto", "fixed"]).default("auto"),
    fontSize: z.number().min(0.5).max(20).default(2),
    fontSizeUnit: z.enum(["vw", "vh", "vmin", "vmax", "rem", "em", "px", "%"]).default("vmin"),
    fontWeight: z.number().int().min(100).max(900).default(400),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#ffffff"),
    opacity: z.number().min(0).max(1).default(1),
    textAlign: z.enum(["left", "center", "right"]).default("left"),
    background: z.string().regex(/^#[0-9a-f]{6}$/i).default("#000000"),
    backgroundOpacity: z.number().min(0).max(1).default(0),
    borderRadius: z.number().min(0).max(64).default(12),
    paddingMode: z.enum(["all", "individual"]).default("all"),
    padding: z.number().min(0).max(64).default(12),
    paddingTop: z.number().min(0).max(64).default(12),
    paddingRight: z.number().min(0).max(64).default(12),
    paddingBottom: z.number().min(0).max(64).default(12),
    paddingLeft: z.number().min(0).max(64).default(12)
});
export type WidgetStyle = z.infer<typeof WidgetStyleSchema>;

export const WidgetSchema = z.object({
    id: z.string().min(1),
    type: WidgetTypeSchema,
    name: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    size: WidgetSizeSchema.default("medium"),
    layout: WidgetLayoutSchema,
    style: WidgetStyleSchema,
    settings: z.record(z.string(), z.unknown()).default({})
});
export type Widget = z.infer<typeof WidgetSchema>;

export const ProfileStyleSchema = WidgetStyleSchema.omit({useProfileStyle: true});
export type ProfileStyle = z.infer<typeof ProfileStyleSchema>;

export const OwnedWidgetProfileSchema = z.object({
    source: z.literal("self"),
    grid: z.object({
        columns: z.literal(GRID_COLUMNS).default(GRID_COLUMNS),
        rows: z.literal(GRID_ROWS).default(GRID_ROWS)
    }),
    defaultStyle: ProfileStyleSchema,
    widgets: z.array(WidgetSchema),
    minimalMotion: z.object({
        enabled: z.boolean().default(true),
        intervalSeconds: z.number().int().min(15).max(3600).default(60),
        maxOffsetCells: z.number().int().min(0).max(4).default(2)
    }).default({enabled: true, intervalSeconds: 60, maxOffsetCells: 2})
});
export type OwnedWidgetProfile = z.infer<typeof OwnedWidgetProfileSchema>;

export const MirroredWidgetProfileSchema = z.object({
    source: z.literal("screensaver")
});
export type MirroredWidgetProfile = z.infer<typeof MirroredWidgetProfileSchema>;

export const WidgetProfileSchema = z.union([OwnedWidgetProfileSchema, MirroredWidgetProfileSchema]);
export type WidgetProfile = z.infer<typeof WidgetProfileSchema>;

export const WidgetConfigSchema = z.object({
    schemaVersion: z.literal(WIDGET_SCHEMA_VERSION),
    displayBindings: z.array(WidgetDisplayBindingSchema).default([]),
    profiles: z.object({
        screensaver: OwnedWidgetProfileSchema,
        wallpaper: WidgetProfileSchema,
        minimal: WidgetProfileSchema
    })
});
export type WidgetConfig = z.infer<typeof WidgetConfigSchema>;

export type WidgetDefinition = {
    type: WidgetType;
    label: string;
    description: string;
    sizes: Record<Exclude<WidgetSize, "custom">, {w: number; h: number}>;
    defaultSettings: Record<string, unknown>;
    dataSources: string[];
    unsupportedModes?: WidgetMode[];
};

export const WIDGET_DEFINITIONS: Record<WidgetType, WidgetDefinition> = {
    text: {
        type: "text", label: "Text", description: "A custom line or block of text.",
        sizes: {small: {w: 8, h: 2}, medium: {w: 14, h: 4}, large: {w: 20, h: 6}},
        defaultSettings: {text: "Custom text"}, dataSources: []
    },
    "custom-html": {
        type: "custom-html", label: "Custom markup", description: "Advanced local markup without scripts.",
        sizes: {small: {w: 8, h: 4}, medium: {w: 16, h: 6}, large: {w: 24, h: 10}},
        defaultSettings: {html: "<strong>Custom markup</strong>"}, dataSources: []
    },
    clock: {
        type: "clock", label: "Time & date", description: "A clock or formatted date.",
        sizes: {small: {w: 8, h: 2}, medium: {w: 12, h: 4}, large: {w: 18, h: 6}},
        defaultSettings: {format: "HH:mm"}, dataSources: ["time"]
    },
    weather: {
        type: "weather", label: "Weather", description: "Current conditions or a multi-day forecast.",
        sizes: {small: {w: 8, h: 4}, medium: {w: 18, h: 6}, large: {w: 32, h: 8}},
        defaultSettings: {unit: "c", view: "current"}, dataSources: ["weather"]
    },
    astronomy: {
        type: "astronomy", label: "Astronomy", description: "Sunrise, sunset, moonrise, or moonset.",
        sizes: {small: {w: 8, h: 2}, medium: {w: 12, h: 4}, large: {w: 16, h: 6}},
        defaultSettings: {event: "sunrise", format: "HH:mm"}, dataSources: ["astronomy"]
    },
    "video-info": {
        type: "video-info", label: "Aerial information", description: "Information about the current aerial video.",
        sizes: {small: {w: 8, h: 2}, medium: {w: 14, h: 4}, large: {w: 20, h: 6}},
        defaultSettings: {field: "name"}, dataSources: ["video"]
    },
    image: {
        type: "image", label: "Image", description: "A local image overlay.",
        sizes: {small: {w: 6, h: 4}, medium: {w: 12, h: 8}, large: {w: 20, h: 12}},
        defaultSettings: {path: "", fit: "contain"}, dataSources: []
    },
    system: {
        type: "system", label: "System monitor", description: "CPU, memory, and storage usage.",
        sizes: {small: {w: 8, h: 4}, medium: {w: 14, h: 6}, large: {w: 22, h: 10}},
        defaultSettings: {metrics: ["cpu", "memory"], view: "combined", excludedDrives: [], storageChart: "pie", driveChartSize: "compact", sectionOrder: ["cpu", "memory", "storage"], rowBreakBefore: []}, dataSources: ["system"]
    }
};

const DEFAULT_PROFILE_STYLE: ProfileStyle = {
    fontFamily: "Segoe UI",
    fontSizeMode: "auto",
    fontSize: 2,
    fontSizeUnit: "vmin",
    fontWeight: 400,
    color: "#ffffff",
    opacity: 1,
    textAlign: "left",
    background: "#000000",
    backgroundOpacity: 0,
    borderRadius: 12,
    paddingMode: "all",
    padding: 12,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 12
};

export function createWidget(type: WidgetType, index = 0, overrides: Partial<Widget> = {}): Widget {
    const definition = WIDGET_DEFINITIONS[type];
    const defaultSize = definition.sizes.medium;
    const widget: Widget = {
        id: `widget-${type}-${Date.now().toString(36)}-${index.toString(36)}`,
        type,
        name: definition.label,
        enabled: true,
        size: "medium",
        layout: {x: 2 + (index % 3) * 14, y: 2 + Math.floor(index / 3) * 6, w: defaultSize.w, h: defaultSize.h, strategy: "fixed", screen: "all"},
        style: {...DEFAULT_PROFILE_STYLE, useProfileStyle: true},
        settings: structuredClone(definition.defaultSettings)
    };
    return WidgetSchema.parse({...widget, ...overrides});
}

export function createOwnedProfile(widgets: Widget[] = []): OwnedWidgetProfile {
    return OwnedWidgetProfileSchema.parse({
        source: "self",
        grid: {columns: GRID_COLUMNS, rows: GRID_ROWS},
        defaultStyle: DEFAULT_PROFILE_STYLE,
        widgets,
        minimalMotion: {enabled: true, intervalSeconds: 60, maxOffsetCells: 2}
    });
}

export function createDefaultWidgetConfig(): WidgetConfig {
    const clock = createWidget("clock", 0, {
        name: "Clock",
        layout: {x: GRID_COLUMNS - 14, y: 22, w: 14, h: 4, strategy: "fixed", screen: "all"}
    });
    return WidgetConfigSchema.parse({
        schemaVersion: WIDGET_SCHEMA_VERSION,
        profiles: {
            screensaver: createOwnedProfile([clock]),
            wallpaper: {source: "screensaver"},
            minimal: {source: "screensaver"}
        }
    });
}

export function resolveWidgetProfile(config: WidgetConfig, mode: WidgetMode): OwnedWidgetProfile {
    const profile = config.profiles[mode];
    return profile.source === "screensaver" ? config.profiles.screensaver : profile;
}

export function detachWidgetProfile(config: WidgetConfig, mode: Exclude<WidgetMode, "screensaver">): WidgetConfig {
    const parsed = WidgetConfigSchema.parse(config);
    const clone = structuredClone(resolveWidgetProfile(parsed, mode));
    return WidgetConfigSchema.parse({...parsed, profiles: {...parsed.profiles, [mode]: clone}});
}

export function mirrorScreensaverProfile(config: WidgetConfig, mode: Exclude<WidgetMode, "screensaver">): WidgetConfig {
    const parsed = WidgetConfigSchema.parse(config);
    return WidgetConfigSchema.parse({...parsed, profiles: {...parsed.profiles, [mode]: {source: "screensaver"}}});
}

export function widgetLayoutsOverlap(left: WidgetLayout, right: WidgetLayout): boolean {
    if (left.screen !== "all" && right.screen !== "all" && left.screen !== right.screen) {
        return false;
    }
    return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y;
}

function toDisplayBinding(display: WidgetDisplay): WidgetDisplayBinding {
    return {
        id: display.id,
        label: display.label,
        isPrimary: display.isPrimary,
        nativeWidth: display.nativeWidth,
        nativeHeight: display.nativeHeight,
        bounds: display.bounds
    };
}

function displayMatchScore(previous: WidgetDisplayBinding, current: WidgetDisplayBinding): number {
    let score = 0;
    if (previous.label !== current.label) return 0;
    score += 5;
    if (previous.nativeWidth === current.nativeWidth && previous.nativeHeight === current.nativeHeight) score += 3;
    if (previous.bounds.x === current.bounds.x && previous.bounds.y === current.bounds.y) score += 2;
    if (previous.isPrimary === current.isPrimary) score += 1;
    return score;
}

export function materializeWidgetDisplays(config: WidgetConfig, displays: WidgetDisplay[]): WidgetConfig {
    const parsed = WidgetConfigSchema.parse(config);
    if (displays.length === 0) {
        return parsed;
    }
    const displayIds = displays.map((display) => display.id);
    const currentBindings = displays.map(toDisplayBinding);
    const previousBindings = parsed.displayBindings;
    const profiles = structuredClone(parsed.profiles);
    const remappedIds = new Map<number, number>();
    const matchedCurrentIds = new Set<number>();
    const nextBindings = previousBindings.map((binding) => {
        const current = currentBindings.find((candidate) => candidate.id === binding.id);
        if (current) {
            matchedCurrentIds.add(current.id);
            return current;
        }
        return binding;
    });

    // A pre-binding config can only be recovered safely when every saved display
    // has a corresponding connected display. Its first appearance follows the
    // original Electron display order used to create the per-display widgets.
    let canRecordBindings = true;
    if (previousBindings.length === 0) {
        const savedIds = [...new Set((Object.values(profiles) as WidgetProfile[])
            .filter((profile): profile is OwnedWidgetProfile => profile.source === "self")
            .flatMap((profile) => profile.widgets.map((widget) => widget.layout.screen))
            .filter((id): id is number => typeof id === "number" && id >= displays.length))];
        const staleIds = savedIds.filter((id) => !displayIds.includes(id));
        if (staleIds.length > 0) {
            canRecordBindings = savedIds.length === displays.length;
            if (canRecordBindings) {
                const available = displays.filter((display) => !savedIds.includes(display.id));
                staleIds.forEach((id, index) => {
                    if (available[index]) remappedIds.set(id, available[index].id);
                });
            }
        }
    } else {
        const missing = previousBindings.filter((binding) => !matchedCurrentIds.has(binding.id));
        const available = currentBindings.filter((binding) => !matchedCurrentIds.has(binding.id));
        for (const previous of missing) {
            const scores = available.map((candidate) => ({candidate, score: displayMatchScore(previous, candidate)}));
            const best = Math.max(0, ...scores.map(({score}) => score));
            const matches = scores.filter(({score}) => score === best && score >= 5);
            if (matches.length !== 1) continue;
            const [{candidate}] = matches;
            const competing = missing.filter((other) => other !== previous && displayMatchScore(other, candidate) >= best);
            if (competing.length > 0) continue;
            remappedIds.set(previous.id, candidate.id);
            matchedCurrentIds.add(candidate.id);
            const bindingIndex = nextBindings.findIndex((binding) => binding.id === previous.id);
            nextBindings[bindingIndex] = candidate;
            available.splice(available.indexOf(candidate), 1);
        }
    }
    if (canRecordBindings) {
        for (const binding of currentBindings) {
            if (!nextBindings.some((stored) => stored.id === binding.id)) nextBindings.push(binding);
        }
    }
    for (const mode of ["screensaver", "wallpaper", "minimal"] as WidgetMode[]) {
        const profile = profiles[mode];
        if (profile.source !== "self") {
            continue;
        }
        profile.widgets = profile.widgets.flatMap((widget) => {
            if (widget.layout.screen !== "all") {
                const displayId = remappedIds.get(widget.layout.screen)
                    ?? (displayIds.includes(widget.layout.screen) ? widget.layout.screen : displayIds[widget.layout.screen]);
                return displayId === undefined ? widget : WidgetSchema.parse({
                    ...widget,
                    layout: {...widget.layout, screen: displayId}
                });
            }
            return displayIds.map((displayId) => WidgetSchema.parse({
                ...structuredClone(widget),
                id: `${widget.id}-display-${displayId}`,
                layout: {...widget.layout, screen: displayId}
            }));
        });
    }
    return WidgetConfigSchema.parse({...parsed, displayBindings: nextBindings, profiles});
}

export function findOpenWidgetLayout(profile: OwnedWidgetProfile, type: WidgetType, screen: WidgetLayout["screen"] = "all"): WidgetLayout {
    const {w, h} = WIDGET_DEFINITIONS[type].sizes.medium;
    for (let y = 0; y <= GRID_ROWS - h; y++) {
        for (let x = 0; x <= GRID_COLUMNS - w; x++) {
            const candidate: WidgetLayout = {x, y, w, h, strategy: "fixed", screen};
            if (!profile.widgets.some((widget) => widget.enabled && widgetLayoutsOverlap(candidate, widget.layout))) {
                return candidate;
            }
        }
    }
    return {x: 0, y: 0, w, h, strategy: "fixed", screen: "all"};
}

export function applyWidgetSize(widget: Widget, size: WidgetSize): Widget {
    if (size === "custom") {
        return WidgetSchema.parse({...widget, size});
    }
    const dimensions = WIDGET_DEFINITIONS[widget.type].sizes[size];
    const x = Math.min(widget.layout.x, GRID_COLUMNS - dimensions.w);
    const y = Math.min(widget.layout.y, GRID_ROWS - dimensions.h);
    return WidgetSchema.parse({...widget, size, layout: {...widget.layout, x, y, ...dimensions}});
}
