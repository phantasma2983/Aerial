import {render} from "preact";
import {useEffect, useMemo, useRef, useState} from "preact/hooks";
import {GridStack} from "gridstack";
import type {GridStackNode} from "gridstack";
import {
    GRID_COLUMNS,
    GRID_ROWS,
    WIDGET_DEFINITIONS,
    WidgetConfigSchema,
    WidgetSchema,
    applyWidgetSize,
    createWidget,
    findOpenWidgetLayout,
    resolveWidgetProfile,
    systemSectionOrder
} from "../../shared/widget-schema";
import type {OwnedWidgetProfile, SystemSection, Widget, WidgetDisplay, WidgetMode, WidgetSize, WidgetType} from "../../shared/widget-schema";
import type {WeatherSnapshot} from "../../shared/weather";
import type {DriveMetric} from "../../main/system-metrics";
import {WidgetView} from "../widgets/widget-view";
import type {WidgetData} from "../widgets/widget-view";

type ConfigSnapshot = Awaited<ReturnType<typeof window.aerial.widgets.getConfig>>;

const MODE_LABELS: Record<WidgetMode, string> = {screensaver: "Screensaver", wallpaper: "Wallpaper", minimal: "Minimal"};
const PROFILE_SELECTION = "__profile__";
const WIDGET_ICONS: Record<WidgetType, string> = {
    text: "fa-font", "custom-html": "fa-code", clock: "fa-clock", weather: "fa-cloud-sun",
    astronomy: "fa-moon", "video-info": "fa-map-marker-alt", image: "fa-image", system: "fa-chart-line"
};

function previewForecastDate(offset: number): string {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

const PREVIEW_WEATHER: WeatherSnapshot = {
    available: true,
    stale: false,
    error: "",
    fetchedAt: new Date().toISOString(),
    latitude: 45.75,
    longitude: 21.23,
    source: "open-meteo",
    timezone: "Europe/Bucharest",
    temperatureC: 22,
    temperatureF: 71.6,
    windSpeedKmh: 9,
    weatherCode: 1,
    isDay: true,
    forecast: [
        {date: previewForecastDate(0), minTemperatureC: 16, maxTemperatureC: 27, weatherCode: 1},
        {date: previewForecastDate(1), minTemperatureC: 15, maxTemperatureC: 25, weatherCode: 2},
        {date: previewForecastDate(2), minTemperatureC: 14, maxTemperatureC: 22, weatherCode: 61},
        {date: previewForecastDate(3), minTemperatureC: 13, maxTemperatureC: 21, weatherCode: 3},
        {date: previewForecastDate(4), minTemperatureC: 14, maxTemperatureC: 24, weatherCode: 0},
        {date: previewForecastDate(5), minTemperatureC: 16, maxTemperatureC: 26, weatherCode: 1},
        {date: previewForecastDate(6), minTemperatureC: 17, maxTemperatureC: 23, weatherCode: 80}
    ]
};

const PREVIEW_DATA: WidgetData = {
    weather: PREVIEW_WEATHER,
    astronomy: {sunrise: new Date().setHours(6, 42), sunset: new Date().setHours(20, 18), moonrise: new Date().setHours(22, 4), moonset: new Date().setHours(7, 15)},
    video: {name: "Aerial coastline", location: "Pacific Coast", timeOfDay: "Sunset"},
    system: {
        latest: {timestamp: Date.now(), cpuPercent: 31, memoryPercent: 58, memoryUsed: 10e9, memoryTotal: 17e9, drives: []},
        history: Array.from({length: 32}, (_, index) => ({timestamp: Date.now() - (31 - index) * 1000, cpuPercent: 20 + Math.sin(index / 3) * 12, memoryPercent: 55 + Math.sin(index / 7) * 3, memoryUsed: 10e9, memoryTotal: 17e9, drives: []}))
    }
};

function cloneProfile(profile: OwnedWidgetProfile): OwnedWidgetProfile {
    return structuredClone(profile);
}

function WidgetConfigApp(): preact.JSX.Element {
    const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
    const [mode, setMode] = useState<WidgetMode>("screensaver");
    const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);
    const [selectedId, setSelectedId] = useState(PROFILE_SELECTION);
    const [addType, setAddType] = useState<WidgetType>("clock");
    const [status, setStatus] = useState("Loading…");
    const [fonts, setFonts] = useState<string[]>([]);
    const [systemDrives, setSystemDrives] = useState<DriveMetric[]>([]);
    const [previewScale, setPreviewScale] = useState(1);
    const [focusCanvas, setFocusCanvas] = useState(false);
    const gridElement = useRef<HTMLDivElement>(null);
    const gridInstance = useRef<GridStack | null>(null);
    const inspectorElement = useRef<HTMLElement>(null);
    const initializingGrid = useRef(false);
    const saveSequence = useRef(0);
    const editorState = useRef<{config: ConfigSnapshot["config"] | null; mode: WidgetMode; mirrored: boolean; profile: OwnedWidgetProfile | null}>({config: null, mode: "screensaver", mirrored: false, profile: null});

    useEffect(() => {
        window.aerial.widgets.getConfig().then((value) => { setSnapshot(value); setStatus("Saved"); });
        const removeConfigListener = window.aerial.widgets.onConfigChanged((value) => { setSnapshot(value); setStatus("Saved"); });
        window.electron.fontListUniversal.getFonts().then((value) => setFonts(Array.from(new Set(value)).sort())).catch(() => setFonts([]));
        const refreshDrives = () => window.aerial.widgets.getSystemDrives().then(setSystemDrives).catch(() => setSystemDrives([]));
        refreshDrives();
        const driveInterval = window.setInterval(refreshDrives, 30000);
        const modeRequestListener = (event: Event) => {
            const requestedMode = (event as CustomEvent<WidgetMode>).detail;
            if (requestedMode === "screensaver" || requestedMode === "wallpaper" || requestedMode === "minimal") {
                setMode(requestedMode);
                setSelectedId(PROFILE_SELECTION);
            }
        };
        window.addEventListener("aerial-widget-mode-request", modeRequestListener);
        return () => {
            removeConfigListener();
            window.clearInterval(driveInterval);
            window.removeEventListener("aerial-widget-mode-request", modeRequestListener);
        };
    }, []);

    const config = snapshot?.config ?? null;
    const displays = snapshot?.displays ?? [];
    const selectedDisplay = displays.find((display) => display.id === selectedDisplayId) ?? null;
    const storedProfile = config?.profiles[mode] ?? null;
    const mirrored = storedProfile?.source === "screensaver";
    const profile = useMemo(() => config ? resolveWidgetProfile(config, mode) : null, [config, mode]);
    const displayWidgets = useMemo(() => profile && selectedDisplayId !== null
        ? profile.widgets.filter((widget) => widget.layout.screen === selectedDisplayId)
        : [], [profile, selectedDisplayId]);
    const selectedWidget = displayWidgets.find((widget) => widget.id === selectedId) ?? null;
    const layoutSignature = displayWidgets.map((widget) => `${widget.id}:${widget.layout.x}:${widget.layout.y}:${widget.layout.w}:${widget.layout.h}:${widget.enabled}`).join("|");
    const previewData = useMemo<WidgetData>(() => ({...PREVIEW_DATA, system: PREVIEW_DATA.system ? {
        ...PREVIEW_DATA.system,
        latest: {...PREVIEW_DATA.system.latest, drives: systemDrives}
    } : null}), [systemDrives]);
    editorState.current = {config, mode, mirrored, profile};

    useEffect(() => {
        if (displays.length === 0) return;
        if (!displays.some((display) => display.id === selectedDisplayId)) {
            setSelectedDisplayId((displays.find((display) => display.isPrimary) ?? displays[0]).id);
        }
    }, [displays, selectedDisplayId]);

    useEffect(() => {
        if (selectedId !== PROFILE_SELECTION && !displayWidgets.some((widget) => widget.id === selectedId)) {
            setSelectedId(displayWidgets[0]?.id ?? PROFILE_SELECTION);
        }
    }, [displayWidgets, selectedId]);

    async function persistProfile(nextProfile: OwnedWidgetProfile): Promise<void> {
        const current = editorState.current;
        if (!current.config || current.mirrored) return;
        const saveMode = current.mode;
        const sequence = ++saveSequence.current;
        const optimistic = WidgetConfigSchema.parse({...current.config, profiles: {...current.config.profiles, [saveMode]: nextProfile}});
        setSnapshot((current) => current ? {...current, config: optimistic} : current);
        setStatus("Saving…");
        try {
            const saved = await window.aerial.widgets.saveProfile(saveMode, nextProfile);
            if (sequence === saveSequence.current) {
                setSnapshot(saved);
                setStatus("Saved");
            }
        } catch (error) {
            setStatus("Could not save");
            console.error(error);
        }
    }

    function mutateProfile(mutator: (draft: OwnedWidgetProfile) => void): void {
        const current = editorState.current;
        if (!current.profile || current.mirrored) return;
        const draft = cloneProfile(current.profile);
        mutator(draft);
        persistProfile(draft);
    }

    function updateWidget(widgetId: string, updater: (widget: Widget) => Widget): void {
        mutateProfile((draft) => {
            const index = draft.widgets.findIndex((widget) => widget.id === widgetId);
            if (index >= 0) draft.widgets[index] = WidgetSchema.parse(updater(draft.widgets[index]));
        });
    }

    useEffect(() => {
        const element = gridElement.current;
        if (!element || !profile || !selectedDisplay) return;
        gridInstance.current?.destroy(false);
        initializingGrid.current = true;
        const updatePreviewGeometry = (grid?: GridStack) => {
            const bounds = element.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return;
            setPreviewScale(Math.min(bounds.width / selectedDisplay.width, bounds.height / selectedDisplay.height));
            grid?.cellHeight(bounds.height / GRID_ROWS);
        };
        const bounds = element.getBoundingClientRect();
        const grid = GridStack.init({
            column: GRID_COLUMNS,
            cellHeight: Math.max(1, bounds.height / GRID_ROWS),
            margin: 0,
            row: GRID_ROWS,
            float: true,
            staticGrid: mirrored,
            animate: true,
            resizable: {handles: "nw, ne, se, sw"}
        }, element);
        if (!grid) return;
        gridInstance.current = grid;
        for (const item of Array.from(element.querySelectorAll<HTMLElement>(".grid-stack-item"))) {
            const widget = displayWidgets.find((candidate) => candidate.id === item.getAttribute("gs-id"));
            if (!widget) continue;
            grid.update(item, {
                x: widget.layout.x,
                y: widget.layout.y,
                w: widget.layout.w,
                h: widget.layout.h,
                noMove: mirrored,
                noResize: mirrored || selectedId !== widget.id
            });
        }
        updatePreviewGeometry(grid);
        const resizeObserver = new ResizeObserver(() => updatePreviewGeometry(grid));
        resizeObserver.observe(element);
        const onLayoutChange = (_event: Event, nodes: GridStackNode[]) => {
            if (initializingGrid.current || mirrored || !nodes?.length) return;
            mutateProfile((draft) => {
                for (const node of nodes) {
                    const id = String(node.id || node.el?.getAttribute("gs-id") || "");
                    const widget = draft.widgets.find((candidate) => candidate.id === id);
                    if (!widget) continue;
                    const width = Math.min(GRID_COLUMNS, Math.max(1, node.w ?? widget.layout.w));
                    const height = Math.min(GRID_ROWS, Math.max(1, node.h ?? widget.layout.h));
                    const x = Math.min(GRID_COLUMNS - width, Math.max(0, node.x ?? widget.layout.x));
                    const y = Math.min(GRID_ROWS - height, Math.max(0, node.y ?? widget.layout.y));
                    widget.layout = {...widget.layout, x, y, w: width, h: height};
                    widget.size = "custom";
                }
            });
        };
        grid.on("change", onLayoutChange);
        window.setTimeout(() => { initializingGrid.current = false; }, 50);
        return () => {
            resizeObserver.disconnect();
            grid.off("change");
            if (gridInstance.current === grid) gridInstance.current = null;
            grid.destroy(false);
        };
    }, [mode, mirrored, selectedDisplay?.id, selectedDisplay?.width, selectedDisplay?.height, selectedId, layoutSignature]);

    async function toggleMirroring(enabled: boolean): Promise<void> {
        if (mode === "screensaver") return;
        if (enabled && !mirrored && !window.confirm(`Mirror Screensaver widgets in ${MODE_LABELS[mode]}? The independent layout will be replaced.`)) return;
        setStatus(enabled ? "Linking…" : "Creating copy…");
        const next = await window.aerial.widgets.setMirroring(mode, enabled);
        setSnapshot(next);
        setStatus("Saved");
    }

    function addWidget(): void {
        if (!profile || mirrored || selectedDisplayId === null) return;
        const layout = findOpenWidgetLayout(profile, addType, selectedDisplayId);
        const widget = createWidget(addType, profile.widgets.length, {layout});
        mutateProfile((draft) => draft.widgets.push(widget));
        setSelectedId(widget.id);
    }

    function duplicateSelected(): void {
        if (!selectedWidget || !profile || mirrored || selectedDisplayId === null) return;
        const duplicate = createWidget(selectedWidget.type, profile.widgets.length, {
            ...structuredClone(selectedWidget),
            id: `widget-${selectedWidget.type}-${Date.now().toString(36)}`,
            name: `${selectedWidget.name} copy`,
            layout: findOpenWidgetLayout(profile, selectedWidget.type, selectedDisplayId)
        });
        mutateProfile((draft) => draft.widgets.push(duplicate));
        setSelectedId(duplicate.id);
    }

    function removeSelected(): void {
        if (!selectedWidget || mirrored) return;
        mutateProfile((draft) => { draft.widgets = draft.widgets.filter((widget) => widget.id !== selectedWidget.id); });
        setSelectedId(PROFILE_SELECTION);
    }

    function revealInspector(): void {
        setFocusCanvas(false);
        window.setTimeout(() => inspectorElement.current?.scrollIntoView({behavior: "smooth", block: "start"}), 0);
    }

    if (!snapshot || !profile || !selectedDisplay) {
        return <div class="widgetConfigApp"><div class="widgetEmptyState">Loading the widget workspace…</div></div>;
    }

    return <div class="widgetConfigApp">
        <header class="widgetModeBar">
            <div class="widgetModeTabs" role="tablist" aria-label="Widget mode">
                {(Object.keys(MODE_LABELS) as WidgetMode[]).map((candidate) => <button key={candidate} type="button" role="tab" aria-selected={mode === candidate} class={`widgetModeButton ${mode === candidate ? "is-active" : ""}`} onClick={() => setMode(candidate)}>{MODE_LABELS[candidate]}</button>)}
            </div>
            {mode !== "screensaver" && <label class="widgetMirrorControl"><input class="widgetCheckbox" type="checkbox" checked={mirrored} onChange={(event) => toggleMirroring(event.currentTarget.checked)}/><span>Mirror Screensaver widgets</span></label>}
            <div class="widgetModeSpacer"/>
            <button type="button" class="widgetActionButton" onClick={() => window.aerial.widgets.openPreview(mode, selectedDisplay.id)}>Preview {MODE_LABELS[mode]} on {selectedDisplay.label}</button>
            <span class="widgetStatus" role="status">{status}</span>
        </header>

        <main class={`widgetEditorLayout ${focusCanvas ? "is-focus" : ""}`}>
            <aside class={`widgetLibraryPanel ${mirrored ? "widgetLocked" : ""}`}>
                <h2 class="widgetPanelTitle">Widgets on {selectedDisplay.label}</h2>
                <div class="widgetAddRow">
                    <select value={addType} aria-label="Widget type" onChange={(event) => setAddType(event.currentTarget.value as WidgetType)}>
                        {(Object.keys(WIDGET_DEFINITIONS) as WidgetType[]).map((type) => <option key={type} value={type}>{WIDGET_DEFINITIONS[type].label}</option>)}
                    </select>
                    <button type="button" class="widgetActionButton is-primary" onClick={addWidget}>Add</button>
                </div>
                <div class="widgetList">
                    <div class={`widgetListItem ${selectedId === PROFILE_SELECTION ? "is-selected" : ""}`} onClick={() => setSelectedId(PROFILE_SELECTION)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(PROFILE_SELECTION); }}>
                        <span class="widgetListIcon"><i class="fa fa-palette"/></span>
                        <span class="widgetListLabel"><strong>Profile appearance</strong><span>Defaults for this mode</span></span>
                    </div>
                    {displayWidgets.map((widget) => <div key={widget.id} class={`widgetListItem ${selectedId === widget.id ? "is-selected" : ""}`} onClick={() => setSelectedId(widget.id)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(widget.id); }}>
                        <span class="widgetListIcon"><i class={`fa ${WIDGET_ICONS[widget.type]}`}/></span>
                        <span class="widgetListLabel"><strong>{widget.name}</strong><span>{widget.type} · {widget.size}</span></span>
                        <input class="widgetCheckbox" type="checkbox" aria-label={`Enable ${widget.name}`} checked={widget.enabled} onClick={(event) => event.stopPropagation()} onChange={(event) => updateWidget(widget.id, (current) => ({...current, enabled: event.currentTarget.checked}))}/>
                    </div>)}
                    {displayWidgets.length === 0 && <div class="widgetEmptyState">Add a widget to begin building this display layout.</div>}
                </div>
            </aside>

            <section class="widgetCanvasPanel">
                {mirrored && <div class="widgetMirrorBanner"><span><strong>Mirroring Screensaver.</strong> Changes made in Screensaver appear here automatically.</span><button type="button" class="widgetActionButton" onClick={() => toggleMirroring(false)}>Make independent</button></div>}
                <DisplayStrip displays={displays} selectedDisplayId={selectedDisplay.id} profile={profile} onSelect={(displayId) => { setSelectedDisplayId(displayId); setSelectedId(PROFILE_SELECTION); }}/>
                <div class={`widgetContextBar ${selectedWidget ? "has-selection" : ""}`}>
                    {selectedWidget ? <>
                        <div class="widgetContextIdentity"><span class="widgetListIcon"><i class={`fa ${WIDGET_ICONS[selectedWidget.type]}`}/></span><span><strong>{selectedWidget.name}</strong><small>{(selectedWidget.style.useProfileStyle ? profile.defaultStyle.fontSizeMode : selectedWidget.style.fontSizeMode) === "auto" ? "Fit widget" : "Fixed size"}</small></span></div>
                        <label class="widgetQuickField"><span>Size</span><select value={selectedWidget.size} disabled={mirrored} onChange={(event) => updateWidget(selectedWidget.id, (current) => applyWidgetSize(current, event.currentTarget.value as WidgetSize))}>{["small", "medium", "large", "custom"].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
                        <div class="widgetContextActions"><button type="button" class="widgetActionButton" disabled={mirrored} onClick={duplicateSelected}>Duplicate</button><button type="button" class="widgetActionButton" onClick={revealInspector}>Edit properties</button></div>
                    </> : <div class="widgetContextEmpty"><strong>Arrange widgets</strong><span>Drag any widget to move it. Select one to reveal resize handles.</span></div>}
                    <button type="button" class={`widgetFocusButton ${focusCanvas ? "is-active" : ""}`} aria-pressed={focusCanvas} onClick={() => setFocusCanvas((current) => !current)} title={focusCanvas ? "Exit canvas focus" : "Focus canvas"}><i class={`fa ${focusCanvas ? "fa-compress" : "fa-expand"}`}/><span>{focusCanvas ? "Exit focus" : "Focus canvas"}</span></button>
                </div>
                <div class="widgetCanvasHeader"><div><h2>{selectedDisplay.label} · {MODE_LABELS[mode]}</h2><p>{selectedDisplay.nativeWidth} × {selectedDisplay.nativeHeight} at {Math.round(selectedDisplay.scaleFactor * 100)}%. Move and resize by whole cells on the {GRID_COLUMNS} × {GRID_ROWS} grid.</p></div><span>{displayWidgets.length} widget{displayWidgets.length === 1 ? "" : "s"}</span></div>
                <div class="widgetCanvasStage">
                    <div class={`widgetCanvas ${mode === "minimal" ? "is-minimal" : ""}`} style={{aspectRatio: `${selectedDisplay.width} / ${selectedDisplay.height}`}} onClick={() => setSelectedId(PROFILE_SELECTION)}>
                        <div key={`${mode}-${selectedDisplay.id}`} class="grid-stack" ref={gridElement}>
                            {displayWidgets.map((widget) => <div key={widget.id} class={`grid-stack-item ${selectedId === widget.id ? "is-selected" : ""}`} {...({"gs-id": widget.id, "gs-x": widget.layout.x, "gs-y": widget.layout.y, "gs-w": widget.layout.w, "gs-h": widget.layout.h, "gs-no-move": mirrored, "gs-no-resize": mirrored || selectedId !== widget.id} as Record<string, unknown>)} onClick={(event) => { event.stopPropagation(); setSelectedId(widget.id); }}>
                                <div class="grid-stack-item-content"><WidgetView widget={widget} profile={profile} mode={mode} data={previewData} preview previewDisplay={selectedDisplay} previewScale={previewScale}/></div>
                            </div>)}
                        </div>
                    </div>
                </div>
            </section>

            <aside ref={inspectorElement} class={`widgetInspectorPanel ${mirrored ? "widgetLocked" : ""}`}>
                <h2 class="widgetPanelTitle">{selectedWidget ? selectedWidget.name : "Profile appearance"}</h2>
                {selectedWidget ? <WidgetInspector widget={selectedWidget} fonts={fonts} drives={systemDrives} onUpdate={(updater) => updateWidget(selectedWidget.id, updater)} onDuplicate={duplicateSelected} onRemove={removeSelected} onEditProfile={() => { if (mirrored) setMode("screensaver"); setSelectedId(PROFILE_SELECTION); inspectorElement.current?.scrollTo({top: 0, behavior: "smooth"}); }}/> : <ProfileInspector mode={mode} profile={profile} fonts={fonts} onUpdate={(updater) => mutateProfile((draft) => Object.assign(draft, updater(draft)))}/>}
            </aside>
        </main>
    </div>;
}

function DisplayStrip({displays, selectedDisplayId, profile, onSelect}: {displays: WidgetDisplay[]; selectedDisplayId: number; profile: OwnedWidgetProfile; onSelect(displayId: number): void}): preact.JSX.Element {
    return <div class="widgetDisplaySection">
        <div class="widgetDisplaySectionTitle"><strong>Connected displays</strong><span>Each display has its own widgets and layout.</span></div>
        <div class="widgetDisplayStrip" role="tablist" aria-label="Connected displays">
            {displays.map((display) => {
                const widgets = profile.widgets.filter((widget) => widget.enabled && widget.layout.screen === display.id);
                return <button key={display.id} type="button" role="tab" aria-selected={selectedDisplayId === display.id} class={`widgetDisplayCard ${selectedDisplayId === display.id ? "is-active" : ""}`} onClick={() => onSelect(display.id)}>
                    <span class="widgetDisplayThumb" style={{aspectRatio: `${display.width} / ${display.height}`}}>
                        {widgets.map((widget) => <span key={widget.id} class="widgetDisplayMiniItem" title={widget.name} style={{
                            left: `${widget.layout.x / GRID_COLUMNS * 100}%`,
                            top: `${widget.layout.y / GRID_ROWS * 100}%`,
                            width: `${widget.layout.w / GRID_COLUMNS * 100}%`,
                            height: `${widget.layout.h / GRID_ROWS * 100}%`
                        }}><i class={`fa ${WIDGET_ICONS[widget.type]}`}/></span>)}
                    </span>
                    <span class="widgetDisplayMeta"><strong>{display.label}{display.isPrimary ? " · Primary" : ""}</strong><small>{display.nativeWidth} × {display.nativeHeight} · {widgets.length} widget{widgets.length === 1 ? "" : "s"}</small></span>
                </button>;
            })}
        </div>
    </div>;
}

function ProfileInspector({mode, profile, fonts, onUpdate}: {mode: WidgetMode; profile: OwnedWidgetProfile; fonts: string[]; onUpdate(updater: (profile: OwnedWidgetProfile) => OwnedWidgetProfile): void}): preact.JSX.Element {
    const style = profile.defaultStyle;
    const updateStyle = (updater: (style: OwnedWidgetProfile["defaultStyle"]) => OwnedWidgetProfile["defaultStyle"]) => onUpdate((current) => ({...current, defaultStyle: updater(current.defaultStyle)}));
    return <>
        <FontField value={style.fontFamily} fonts={fonts} onChange={(fontFamily) => updateStyle((current) => ({...current, fontFamily}))}/>
        <SelectField label="Text sizing" value={style.fontSizeMode} options={["auto", "fixed"]} optionLabels={{auto: "Fit widget", fixed: "Fixed size override"}} onChange={(fontSizeMode) => updateStyle((current) => ({...current, fontSizeMode: fontSizeMode as typeof current.fontSizeMode}))}/>
        {style.fontSizeMode === "auto" && <p class="widgetFieldHint">Content scales automatically when its widget is resized.</p>}
        {style.fontSizeMode === "fixed" && <div class="widgetInlineFields"><NumberField label="Font size" value={style.fontSize} min={0.5} max={20} step={0.1} onChange={(fontSize) => updateStyle((current) => ({...current, fontSize}))}/><SelectField label="Unit" value={style.fontSizeUnit} options={["vmin", "vw", "vh", "px", "rem"]} onChange={(fontSizeUnit) => updateStyle((current) => ({...current, fontSizeUnit: fontSizeUnit as typeof current.fontSizeUnit}))}/></div>}
        <div class="widgetInlineFields"><NumberField label="Weight" value={style.fontWeight} min={100} max={900} step={100} onChange={(fontWeight) => updateStyle((current) => ({...current, fontWeight}))}/><SelectField label="Alignment" value={style.textAlign} options={["left", "center", "right"]} onChange={(textAlign) => updateStyle((current) => ({...current, textAlign: textAlign as typeof current.textAlign}))}/></div>
        <div class="widgetInlineFields"><ColorField label="Text color" value={style.color} onChange={(color) => updateStyle((current) => ({...current, color}))}/><NumberField label="Text opacity" value={style.opacity} min={0} max={1} step={0.05} onChange={(opacity) => updateStyle((current) => ({...current, opacity}))}/></div>
        <div class="widgetInlineFields"><ColorField label="Card color" value={style.background} onChange={(background) => updateStyle((current) => ({...current, background}))}/><NumberField label="Card opacity" value={style.backgroundOpacity} min={0} max={1} step={0.05} onChange={(backgroundOpacity) => updateStyle((current) => ({...current, backgroundOpacity}))}/></div>
        <SpacingFields style={style} onChange={(patch) => updateStyle((current) => ({...current, ...patch}))}/>
        {mode === "minimal" && <><div class="widgetSectionLabel">Subtle movement</div><label class="widgetCheckRow"><input class="widgetCheckbox" type="checkbox" checked={profile.minimalMotion.enabled} onChange={(event) => onUpdate((current) => ({...current, minimalMotion: {...current.minimalMotion, enabled: event.currentTarget.checked}}))}/><span>Prevent static pixels with gentle repositioning</span></label><div class="widgetInlineFields"><NumberField label="Interval (seconds)" value={profile.minimalMotion.intervalSeconds} min={15} max={3600} step={15} onChange={(intervalSeconds) => onUpdate((current) => ({...current, minimalMotion: {...current.minimalMotion, intervalSeconds}}))}/><NumberField label="Maximum cells" value={profile.minimalMotion.maxOffsetCells} min={0} max={4} step={1} onChange={(maxOffsetCells) => onUpdate((current) => ({...current, minimalMotion: {...current.minimalMotion, maxOffsetCells}}))}/></div></>}
        <div class="widgetEmptyState">Widgets use these values by default. Select a widget to configure its content, size, placement, or appearance override.</div>
    </>;
}

function WidgetInspector({widget, fonts, drives, onUpdate, onDuplicate, onRemove, onEditProfile}: {widget: Widget; fonts: string[]; drives: DriveMetric[]; onUpdate(updater: (widget: Widget) => Widget): void; onDuplicate(): void; onRemove(): void; onEditProfile(): void}): preact.JSX.Element {
    const updateSettings = (patch: Record<string, unknown>) => onUpdate((current) => ({...current, settings: {...current.settings, ...patch}}));
    return <>
        <TextField label="Name" value={widget.name} onChange={(name) => onUpdate((current) => ({...current, name}))}/>
        <SelectField label="Size" value={widget.size} options={["small", "medium", "large", "custom"]} onChange={(size) => onUpdate((current) => applyWidgetSize(current, size as WidgetSize))}/>
        <WidgetContentFields widget={widget} drives={drives} updateSettings={updateSettings}/>
        <div class="widgetSectionLabel">Appearance</div>
        <div class="widgetProfileAppearanceRow"><label class="widgetCheckRow"><input class="widgetCheckbox" type="checkbox" checked={widget.style.useProfileStyle} onChange={(event) => onUpdate((current) => ({...current, style: {...current.style, useProfileStyle: event.currentTarget.checked}}))}/><span>Use profile appearance</span></label><button type="button" class="widgetProfileAppearanceLink" onClick={onEditProfile}>Edit profile <span aria-hidden="true">↗</span></button></div>
        {!widget.style.useProfileStyle && <>
            <FontField value={widget.style.fontFamily} fonts={fonts} onChange={(fontFamily) => onUpdate((current) => ({...current, style: {...current.style, fontFamily}}))}/>
            <SelectField label="Text sizing" value={widget.style.fontSizeMode} options={["auto", "fixed"]} optionLabels={{auto: "Fit widget", fixed: "Fixed size override"}} onChange={(fontSizeMode) => onUpdate((current) => ({...current, style: {...current.style, fontSizeMode: fontSizeMode as typeof current.style.fontSizeMode}}))}/>
            {widget.style.fontSizeMode === "auto" && <p class="widgetFieldHint">Content scales automatically when this widget is resized.</p>}
            {widget.style.fontSizeMode === "fixed" && <div class="widgetInlineFields"><NumberField label="Font size" value={widget.style.fontSize} min={0.5} max={20} step={0.1} onChange={(fontSize) => onUpdate((current) => ({...current, style: {...current.style, fontSize}}))}/><SelectField label="Unit" value={widget.style.fontSizeUnit} options={["vmin", "vw", "vh", "px", "rem"]} onChange={(fontSizeUnit) => onUpdate((current) => ({...current, style: {...current.style, fontSizeUnit: fontSizeUnit as typeof current.style.fontSizeUnit}}))}/></div>}
            <div class="widgetInlineFields"><NumberField label="Weight" value={widget.style.fontWeight} min={100} max={900} step={100} onChange={(fontWeight) => onUpdate((current) => ({...current, style: {...current.style, fontWeight}}))}/><SelectField label="Alignment" value={widget.style.textAlign} options={["left", "center", "right"]} onChange={(textAlign) => onUpdate((current) => ({...current, style: {...current.style, textAlign: textAlign as typeof current.style.textAlign}}))}/></div>
            <div class="widgetInlineFields"><ColorField label="Text color" value={widget.style.color} onChange={(color) => onUpdate((current) => ({...current, style: {...current.style, color}}))}/><NumberField label="Text opacity" value={widget.style.opacity} min={0} max={1} step={0.05} onChange={(opacity) => onUpdate((current) => ({...current, style: {...current.style, opacity}}))}/></div>
            <div class="widgetInlineFields"><ColorField label="Card color" value={widget.style.background} onChange={(background) => onUpdate((current) => ({...current, style: {...current.style, background}}))}/><NumberField label="Card opacity" value={widget.style.backgroundOpacity} min={0} max={1} step={0.05} onChange={(backgroundOpacity) => onUpdate((current) => ({...current, style: {...current.style, backgroundOpacity}}))}/></div>
            <SpacingFields style={widget.style} onChange={(patch) => onUpdate((current) => ({...current, style: {...current.style, ...patch}}))}/>
        </>}
        <div class="widgetInspectorActions"><button type="button" class="widgetActionButton" onClick={onDuplicate}>Duplicate</button><button type="button" class="widgetActionButton is-danger" onClick={onRemove}>Remove</button></div>
    </>;
}

function WidgetContentFields({widget, drives, updateSettings}: {widget: Widget; drives: DriveMetric[]; updateSettings(patch: Record<string, unknown>): void}): preact.JSX.Element | null {
    switch (widget.type) {
        case "text": return <TextAreaField label="Text" value={String(widget.settings.text ?? "")} onChange={(text) => updateSettings({text})}/>;
        case "custom-html": return <TextAreaField label="Markup" value={String(widget.settings.html ?? "")} onChange={(html) => updateSettings({html})}/>;
        case "clock": return <TextField label="Date/time format" value={String(widget.settings.format ?? "HH:mm")} onChange={(format) => updateSettings({format})}/>;
        case "weather": return <><SelectField label="Weather layout" value={String(widget.settings.view ?? "current")} options={["current", "three-day", "seven-day"]} optionLabels={{current: "Current day", "three-day": "3-day forecast", "seven-day": "7-day forecast"}} onChange={(view) => updateSettings({view})}/><SelectField label="Temperature unit" value={String(widget.settings.unit ?? "c")} options={["c", "f"]} optionLabels={{c: "Celsius", f: "Fahrenheit"}} onChange={(unit) => updateSettings({unit})}/><p class="widgetFieldHint">Current day includes today’s minimum and maximum. The large widget size works best for a 7-day forecast.</p></>;
        case "astronomy": return <><SelectField label="Event" value={String(widget.settings.event ?? "sunrise")} options={["sunrise", "sunset", "moonrise", "moonset"]} onChange={(event) => updateSettings({event})}/><TextField label="Time format" value={String(widget.settings.format ?? "HH:mm")} onChange={(format) => updateSettings({format})}/></>;
        case "video-info": return <SelectField label="Information" value={String(widget.settings.field ?? "name")} options={["name", "location", "timeOfDay", "type"]} onChange={(field) => updateSettings({field})}/>;
        case "image": return <><TextField label="Image path" value={String(widget.settings.path ?? "")} onChange={(path) => updateSettings({path})}/><button type="button" class="widgetActionButton widgetBrowseButton" onClick={async () => { const result = await window.aerial.widgets.selectImage(); if (!result.canceled) updateSettings({path: result.path}); }}>Choose image…</button><SelectField label="Fit" value={String(widget.settings.fit ?? "contain")} options={["contain", "cover"]} onChange={(fit) => updateSettings({fit})}/></>;
        case "system": return <SystemMonitorFields key={widget.id} widget={widget} drives={drives} updateSettings={updateSettings}/>;
        default: return null;
    }
}

function SystemMonitorFields({widget, drives, updateSettings}: {widget: Widget; drives: DriveMetric[]; updateSettings(patch: Record<string, unknown>): void}): preact.JSX.Element {
    const metrics = Array.isArray(widget.settings.metrics) ? widget.settings.metrics.map(String) : ["cpu", "memory"];
    const excludedDrives = Array.isArray(widget.settings.excludedDrives) ? widget.settings.excludedDrives.map(String) : [];
    const rowBreaks = Array.isArray(widget.settings.rowBreakBefore) ? widget.settings.rowBreakBefore.map(String) : [];
    const sections = systemSectionOrder(widget.settings);
    const visibleSections = sections.filter((section) => metrics.includes(section));
    const [expanded, setExpanded] = useState<Record<SystemSection, boolean>>({cpu: true, memory: true, storage: metrics.includes("storage")});
    const [dropTarget, setDropTarget] = useState<{section: SystemSection; after: boolean} | null>(null);
    const draggedSection = useRef<SystemSection | null>(null);

    function moveSection(section: SystemSection, target: SystemSection, after: boolean): void {
        if (section === target) return;
        const next = sections.filter((value) => value !== section);
        next.splice(next.indexOf(target) + (after ? 1 : 0), 0, section);
        updateSettings({sectionOrder: next});
    }

    function toggleSection(section: SystemSection, enabled: boolean): void {
        updateSettings({metrics: enabled ? [...metrics, section] : metrics.filter((value) => value !== section)});
        if (enabled) setExpanded((current) => ({...current, [section]: true}));
    }

    return <>
        <SelectField label="Visualization" value={String(widget.settings.view ?? "combined")} options={["numbers", "charts", "combined"]} onChange={(view) => updateSettings({view})}/>
        <div class="widgetSectionLabel">System monitor sections</div>
        <p class="widgetFieldHint">Drag the handles to change their order. Enabled sections wrap when the widget gets narrow.</p>
        <div class="widgetSystemSections">{sections.map((section, index) => {
            const enabled = metrics.includes(section);
            const open = expanded[section];
            const previous = visibleSections[visibleSections.indexOf(section) - 1];
            const canBreak = enabled && section !== "storage" && previous && previous !== "storage";
            return <section key={section} class={`widgetSystemSection ${enabled ? "is-enabled" : ""} ${dropTarget?.section === section ? dropTarget.after ? "is-drop-after" : "is-drop-before" : ""}`}
                onDragOver={(event) => { if (!draggedSection.current || draggedSection.current === section) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2; setDropTarget({section, after}); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null); }}
                onDrop={(event) => { event.preventDefault(); const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2; if (draggedSection.current) moveSection(draggedSection.current, section, after); draggedSection.current = null; setDropTarget(null); }}>
                <div class="widgetSystemSectionHeader">
                    <button type="button" class="widgetSystemDragHandle" draggable aria-label={`Drag ${section} to reorder; use arrow keys to move it`} title="Drag to reorder" onDragStart={(event) => { draggedSection.current = section; if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", section); } }} onDragEnd={() => { draggedSection.current = null; setDropTarget(null); }} onKeyDown={(event) => { if (event.key === "ArrowUp" && index > 0) { event.preventDefault(); moveSection(section, sections[index - 1], false); } else if (event.key === "ArrowDown" && index < sections.length - 1) { event.preventDefault(); moveSection(section, sections[index + 1], true); } }}><i class="fa fa-bars" aria-hidden="true"/></button>
                    <div class="widgetSystemSectionEnabled"><input class="widgetCheckbox" type="checkbox" aria-label={`Enable ${section}`} checked={enabled} onChange={(event) => toggleSection(section, event.currentTarget.checked)}/><span>{section === "cpu" ? "CPU" : section === "memory" ? "Memory" : "Storage"}</span></div>
                    <button type="button" class="widgetSystemCollapse" aria-label={`${open ? "Collapse" : "Expand"} ${section} options`} aria-expanded={open} aria-controls={`widget-${widget.id}-${section}-options`} onClick={() => setExpanded((current) => ({...current, [section]: !current[section]}))}><i class={`fa ${open ? "fa-chevron-up" : "fa-chevron-down"}`} aria-hidden="true"/></button>
                </div>
                {open && <div id={`widget-${widget.id}-${section}-options`} class="widgetSystemSectionBody">
                    {section !== "storage" && <>
                        <SelectField label="Chart style" value={String(widget.settings[`${section}Chart`] ?? "line")} options={["line", "area", "bars"]} optionLabels={{line: "Line", area: "Filled area", bars: "Thin bars"}} onChange={(chart) => updateSettings({[`${section}Chart`]: chart})}/>
                        {canBreak ? <label class="widgetCheckRow is-compact"><input class="widgetCheckbox" type="checkbox" checked={rowBreaks.includes(section)} onChange={(event) => updateSettings({rowBreakBefore: event.currentTarget.checked ? [...rowBreaks, section] : rowBreaks.filter((value) => value !== section)})}/><span>Start on a new row</span></label> : <p class="widgetFieldHint">{section === visibleSections[0] ? "First enabled section in the layout." : "Wraps automatically when space is limited."}</p>}
                    </>}
                    {section === "storage" && <>
                        {widget.settings.view !== "numbers" && <><SelectField label="Chart type" value={String(widget.settings.storageChart ?? "pie")} options={["pie", "bar"]} optionLabels={{pie: "Pie charts", bar: "Bar charts"}} onChange={(storageChart) => updateSettings({storageChart})}/><SelectField label="Chart size" value={String(widget.settings.driveChartSize ?? "compact")} options={["compact", "regular", "large"]} optionLabels={{compact: "Compact · more per row", regular: "Regular", large: "Large · fewer per row"}} onChange={(driveChartSize) => updateSettings({driveChartSize})}/></>}
                        <div class="widgetField"><span class="widgetFieldLegend">Drives</span><div class="widgetDriveChecks">{drives.length === 0 ? <span class="widgetFieldHint">No drives detected</span> : drives.map((drive) => <label key={drive.id} class="widgetCheckRow is-compact"><input class="widgetCheckbox" type="checkbox" checked={!excludedDrives.includes(drive.id)} onChange={(event) => updateSettings({excludedDrives: event.currentTarget.checked ? excludedDrives.filter((id) => id !== drive.id) : [...excludedDrives, drive.id]})}/><span>{drive.id}{drive.label ? ` ${drive.label}` : ""}</span></label>)}</div></div>
                        <p class="widgetFieldHint">Drives use their own row and wrap automatically.</p>
                    </>}
                </div>}
            </section>;
        })}</div>
    </>;
}

function TextField({label, value, onChange, placeholder}: {label: string; value: string; onChange(value: string): void; placeholder?: string}): preact.JSX.Element { return <label class="widgetField"><span>{label}</span><input value={value} placeholder={placeholder} onInput={(event) => onChange(event.currentTarget.value)}/></label>; }
function TextAreaField({label, value, onChange}: {label: string; value: string; onChange(value: string): void}): preact.JSX.Element { return <label class="widgetField"><span>{label}</span><textarea rows={4} value={value} onInput={(event) => onChange(event.currentTarget.value)}/></label>; }
type SpacingStyle = Pick<Widget["style"], "paddingMode" | "padding" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "borderRadius">;
function SpacingFields({style, onChange}: {style: SpacingStyle; onChange(patch: Partial<SpacingStyle>): void}): preact.JSX.Element {
    const individual = style.paddingMode === "individual";
    return <div class="widgetSpacingFields">
        <label class="widgetCheckRow widgetPaddingToggle"><input class="widgetCheckbox" type="checkbox" checked={individual} onChange={(event) => onChange(event.currentTarget.checked ? {paddingMode: "individual", paddingTop: style.padding, paddingRight: style.padding, paddingBottom: style.padding, paddingLeft: style.padding} : {paddingMode: "all"})}/><span>Set padding for each side</span></label>
        {individual ? <>
            <div class="widgetInlineFields"><NumberField label="Padding top" value={style.paddingTop} min={0} max={64} step={1} onChange={(paddingTop) => onChange({paddingTop})}/><NumberField label="Padding right" value={style.paddingRight} min={0} max={64} step={1} onChange={(paddingRight) => onChange({paddingRight})}/></div>
            <div class="widgetInlineFields"><NumberField label="Padding bottom" value={style.paddingBottom} min={0} max={64} step={1} onChange={(paddingBottom) => onChange({paddingBottom})}/><NumberField label="Padding left" value={style.paddingLeft} min={0} max={64} step={1} onChange={(paddingLeft) => onChange({paddingLeft})}/></div>
            <NumberField label="Corner radius" value={style.borderRadius} min={0} max={64} step={1} onChange={(borderRadius) => onChange({borderRadius})}/>
        </> : <div class="widgetInlineFields"><NumberField label="Padding" value={style.padding} min={0} max={64} step={1} onChange={(padding) => onChange({padding})}/><NumberField label="Corner radius" value={style.borderRadius} min={0} max={64} step={1} onChange={(borderRadius) => onChange({borderRadius})}/></div>}
    </div>;
}
function parseNumberDraft(draft: string): number | null {
    const normalized = draft.trim().replace(",", ".");
    if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}
function NumberField({label, value, min, max, step, onChange}: {label: string; value: number; min: number; max: number; step: number; onChange(value: number): void}): preact.JSX.Element {
    const [draft, setDraft] = useState(String(value));
    const focused = useRef(false);
    const cancelBlurCommit = useRef(false);
    useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
    const commit = (candidate = draft) => {
        const parsed = parseNumberDraft(candidate);
        const normalized = parsed === null ? value : Math.min(max, Math.max(min, parsed));
        setDraft(String(normalized));
        if (normalized !== value) onChange(normalized);
    };
    return <label class="widgetField"><span>{label}</span><input type="text" inputMode="decimal" role="spinbutton" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} value={draft} onFocus={() => { focused.current = true; }} onInput={(event) => { const next = event.currentTarget.value; setDraft(next); const parsed = parseNumberDraft(next); if (parsed !== null && parsed >= min && parsed <= max) onChange(parsed); }} onBlur={() => { focused.current = false; if (cancelBlurCommit.current) { cancelBlurCommit.current = false; setDraft(String(value)); } else { commit(); } }} onKeyDown={(event) => { if (event.key === "Enter") { event.currentTarget.blur(); } else if (event.key === "Escape") { cancelBlurCommit.current = true; event.currentTarget.blur(); } else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const current = parseNumberDraft(draft) ?? value; const direction = event.key === "ArrowUp" ? 1 : -1; const next = Math.min(max, Math.max(min, Number((current + direction * step).toFixed(10)))); setDraft(String(next)); if (next !== value) onChange(next); } }}/></label>;
}
function ColorField({label, value, onChange}: {label: string; value: string; onChange(value: string): void}): preact.JSX.Element { return <label class="widgetField"><span>{label}</span><input type="color" value={value} onInput={(event) => onChange(event.currentTarget.value)}/></label>; }
function SelectField({label, value, options, optionLabels = {}, onChange}: {label: string; value: string; options: string[]; optionLabels?: Record<string, string>; onChange(value: string): void}): preact.JSX.Element { return <label class="widgetField"><span>{label}</span><select value={value} onChange={(event) => onChange(event.currentTarget.value)}>{options.map((option) => <option key={option} value={option}>{optionLabels[option] ?? option.replaceAll("-", " ")}</option>)}</select></label>; }
function FontField({value, fonts, onChange}: {value: string; fonts: string[]; onChange(value: string): void}): preact.JSX.Element { return <label class="widgetField"><span>Font</span><input list="widget-font-list" value={value} onChange={(event) => onChange(event.currentTarget.value)}/><datalist id="widget-font-list">{fonts.map((font) => <option key={font} value={font}/>)}</datalist></label>; }

const root = document.getElementById("widgetConfigRoot");
if (root) render(<WidgetConfigApp/>, root);
