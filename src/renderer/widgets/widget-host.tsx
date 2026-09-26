import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";
import {GRID_COLUMNS, GRID_ROWS, WIDGET_DEFINITIONS, resolveWidgetProfile} from "../../shared/widget-schema";
import type {WidgetConfig, WidgetMode} from "../../shared/widget-schema";
import {WidgetView} from "./widget-view";
import type {WidgetData} from "./widget-view";

type ConfigSnapshot = Awaited<ReturnType<typeof window.aerial.widgets.getConfig>>;

function getInitialMode(): WidgetMode {
    const query = new URLSearchParams(window.location.search);
    const widgetMode = query.get("widgetMode");
    if (widgetMode === "wallpaper" || widgetMode === "minimal") return widgetMode;
    if (query.get("startMode") === "minimal") return "minimal";
    return query.get("mode") === "wallpaper" ? "wallpaper" : "screensaver";
}

function profileNeedsSource(config: WidgetConfig, mode: WidgetMode, source: string, displayId: number | null): boolean {
    return resolveWidgetProfile(config, mode).widgets.some((widget) => widget.enabled
        && (widget.layout.screen === "all" || widget.layout.screen === displayId)
        && WIDGET_DEFINITIONS[widget.type].dataSources.includes(source));
}

function WidgetHost(): preact.JSX.Element | null {
    const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
    const [mode, setMode] = useState<WidgetMode>(getInitialMode);
    const [displayId, setDisplayId] = useState<number | null>(null);
    const [data, setData] = useState<WidgetData>({});
    const [minimalOffset, setMinimalOffset] = useState({x: 0, y: 0});

    useEffect(() => {
        window.aerial.widgets.getConfig().then(setSnapshot);
        return window.aerial.widgets.onConfigChanged(setSnapshot);
    }, []);

    useEffect(() => {
        const modeListener = (event: Event) => setMode((event as CustomEvent<WidgetMode>).detail);
        const videoListener = (event: Event) => setData((current) => ({...current, video: (event as CustomEvent<Record<string, unknown>>).detail}));
        window.addEventListener("aerial-mode-change", modeListener);
        window.addEventListener("aerial-video-context", videoListener);
        window.electron.ipcRenderer.on("widgetDisplayId", (...args: unknown[]) => setDisplayId(Number(args[0])));
        return () => {
            window.removeEventListener("aerial-mode-change", modeListener);
            window.removeEventListener("aerial-video-context", videoListener);
        };
    }, []);

    const config = snapshot?.config;
    const profile = useMemo(() => config ? resolveWidgetProfile(config, mode) : null, [config, mode]);
    const needsWeather = config ? profileNeedsSource(config, mode, "weather", displayId) : false;
    const needsSystem = config ? profileNeedsSource(config, mode, "system", displayId) : false;
    const needsStorage = profile?.widgets.some((widget) => widget.enabled && widget.type === "system"
        && (widget.layout.screen === "all" || widget.layout.screen === displayId)
        && Array.isArray(widget.settings.metrics) && widget.settings.metrics.includes("storage")) ?? false;

    useEffect(() => {
        if (!snapshot) return;
        setData((current) => ({...current, astronomy: snapshot.context.astronomy}));
    }, [snapshot]);

    useEffect(() => {
        if (!needsWeather) return;
        let cancelled = false;
        const refresh = () => window.aerial.widgets.getWeather(false).then((weather) => {
            if (!cancelled) setData((current) => ({...current, weather}));
        });
        refresh();
        const interval = window.setInterval(refresh, 20 * 60 * 1000);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, [needsWeather]);

    useEffect(() => {
        if (!needsSystem) return;
        window.aerial.widgets.subscribeSystemMetrics(needsStorage);
        const removeListener = window.aerial.widgets.onDataChanged((payload) => {
            if (payload.source === "system") setData((current) => ({...current, system: payload.snapshot}));
        });
        return () => {
            removeListener();
            window.aerial.widgets.unsubscribeSystemMetrics();
        };
    }, [needsSystem, needsStorage]);

    useEffect(() => {
        if (mode !== "minimal" || !profile?.minimalMotion.enabled || profile.minimalMotion.maxOffsetCells === 0) {
            setMinimalOffset({x: 0, y: 0});
            return;
        }
        let direction = 0;
        const offsets = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}];
        const interval = window.setInterval(() => {
            direction = (direction + 1) % offsets.length;
            setMinimalOffset(offsets[direction]);
        }, profile.minimalMotion.intervalSeconds * 1000);
        return () => window.clearInterval(interval);
    }, [mode, profile]);

    if (!profile || displayId === null) return null;
    return <div class={`widgetHostGrid widgetHostGrid-${mode}`} style={{
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
        inset: 0,
        transform: `translate(${minimalOffset.x * 0.2}vw, ${minimalOffset.y * 0.2}vh)`
    }}>
        {profile.widgets.filter((widget) => widget.enabled && (widget.layout.screen === "all" || widget.layout.screen === displayId)).map((widget) =>
            <div class="widgetHostItem" key={widget.id} style={{
                gridColumn: `${widget.layout.x + 1} / span ${widget.layout.w}`,
                gridRow: `${widget.layout.y + 1} / span ${widget.layout.h}`
            }}><WidgetView widget={widget} profile={profile} mode={mode} data={data}/></div>
        )}
    </div>;
}

const root = document.getElementById("widgetHostRoot");
if (root) {
    render(<WidgetHost/>, root);
    window.dispatchEvent(new Event("aerial-widget-host-ready"));
}
