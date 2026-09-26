import {useEffect, useLayoutEffect, useMemo, useRef, useState} from "preact/hooks";
import type {OwnedWidgetProfile, Widget, WidgetDisplay, WidgetMode, WidgetStyle} from "../../shared/widget-schema";
import {WIDGET_DEFINITIONS, systemSectionOrder} from "../../shared/widget-schema";
import type {WeatherForecastDay, WeatherSnapshot} from "../../shared/weather";
import type {SystemMetricPoint} from "../../main/system-metrics";

export type WidgetData = {
    weather?: WeatherSnapshot | null;
    system?: {latest: SystemMetricPoint; history: SystemMetricPoint[]} | null;
    astronomy?: Record<string, unknown>;
    video?: Record<string, unknown> | null;
};

type Props = {
    widget: Widget;
    profile: OwnedWidgetProfile;
    mode: WidgetMode;
    data: WidgetData;
    preview?: boolean;
    previewDisplay?: WidgetDisplay;
    previewScale?: number;
};

const AUTO_FIT_TEXT_TYPES = new Set<Widget["type"]>(["clock", "astronomy", "video-info"]);

function effectiveStyle(widget: Widget, profile: OwnedWidgetProfile): Omit<WidgetStyle, "useProfileStyle"> {
    if (widget.style.useProfileStyle) {
        return profile.defaultStyle;
    }
    const {useProfileStyle: _unused, ...style} = widget.style;
    return style;
}

function hexToRgba(hex: string, opacity: number): string {
    const value = hex.replace("#", "");
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function fixedFontSizeValue(style: Omit<WidgetStyle, "useProfileStyle">, previewDisplay?: WidgetDisplay, previewScale = 1): string {
    if (!previewDisplay) {
        return `${style.fontSize}${style.fontSizeUnit}`;
    }
    const viewportValue = style.fontSize / 100;
    const pixelsByUnit: Record<WidgetStyle["fontSizeUnit"], number> = {
        vw: previewDisplay.width * viewportValue,
        vh: previewDisplay.height * viewportValue,
        vmin: Math.min(previewDisplay.width, previewDisplay.height) * viewportValue,
        vmax: Math.max(previewDisplay.width, previewDisplay.height) * viewportValue,
        rem: style.fontSize * 16,
        em: style.fontSize * 16,
        px: style.fontSize,
        "%": style.fontSize / 100 * 16
    };
    return `${pixelsByUnit[style.fontSizeUnit] * previewScale}px`;
}

function paddingValue(style: Omit<WidgetStyle, "useProfileStyle">, scale: number): string {
    if (style.paddingMode === "individual") {
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
            .map((value) => `${value * scale}px`)
            .join(" ");
    }
    return `${style.padding * scale}px`;
}

function useAutoFitText(enabled: boolean, fitKey: string): preact.RefObject<HTMLDivElement> {
    const elementRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const element = elementRef.current;
        const content = element?.querySelector<HTMLElement>(".widgetFitContent");
        if (!element || !content || !enabled) return;
        let disposed = false;
        const fit = () => {
            if (disposed) return;
            const computed = window.getComputedStyle(element);
            const availableWidth = element.clientWidth - Number.parseFloat(computed.paddingLeft) - Number.parseFloat(computed.paddingRight);
            const availableHeight = element.clientHeight - Number.parseFloat(computed.paddingTop) - Number.parseFloat(computed.paddingBottom);
            if (availableWidth <= 0 || availableHeight <= 0) return;
            element.style.fontSize = "100px";
            const contentBounds = content.getBoundingClientRect();
            if (contentBounds.width <= 0 || contentBounds.height <= 0) return;
            const scale = Math.min(availableWidth / contentBounds.width, availableHeight / contentBounds.height);
            element.style.fontSize = `${Math.max(1, 100 * scale * 0.96)}px`;
        };
        const resizeObserver = new ResizeObserver(fit);
        const mutationObserver = new MutationObserver(fit);
        resizeObserver.observe(element);
        mutationObserver.observe(content, {characterData: true, childList: true, subtree: true});
        fit();
        document.fonts.ready.then(fit).catch(() => undefined);
        return () => {
            disposed = true;
            resizeObserver.disconnect();
            mutationObserver.disconnect();
            element.style.removeProperty("font-size");
        };
    }, [enabled, fitKey]);
    return elementRef;
}

function sanitizeMarkup(value: unknown): string {
    const documentNode = new DOMParser().parseFromString(String(value ?? ""), "text/html");
    documentNode.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((element) => element.remove());
    documentNode.body.querySelectorAll("*").forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
            if (attribute.name.toLowerCase().startsWith("on") || /javascript:/i.test(attribute.value)) {
                element.removeAttribute(attribute.name);
            }
        }
    });
    return documentNode.body.innerHTML;
}

function formatMoment(date: Date | string | number, format: unknown, fallback: string): string {
    const momentFactory = (window as unknown as {moment?: (value?: unknown) => {format(pattern: string): string}}).moment;
    if (momentFactory) {
        return momentFactory(date).format(String(format || fallback));
    }
    return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(new Date(date));
}

function weatherIcon(code: unknown, isDay: unknown): string {
    if (code === null || code === undefined || code === "") return "cloud.svg";
    const value = Number(code);
    if ([95, 96, 99].includes(value)) return "cloud-lightning.svg";
    if ([71, 73, 75, 77, 85, 86].includes(value)) return "cloud-snow.svg";
    if ([45, 48].includes(value)) return "cloud-fog.svg";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return "cloud-rain.svg";
    if (value === 0) return Number(isDay) === 1 ? "sun.svg" : "moon.svg";
    if ([1, 2].includes(value)) return Number(isDay) === 1 ? "cloud-sun.svg" : "cloud-moon.svg";
    return "cloud.svg";
}

function weatherCondition(code: unknown): string {
    if (code === null || code === undefined || code === "") return "Forecast";
    const value = Number(code);
    if ([95, 96, 99].includes(value)) return "Thunderstorms";
    if ([71, 73, 75, 77, 85, 86].includes(value)) return "Snow";
    if ([45, 48].includes(value)) return "Fog";
    if ([51, 53, 55, 56, 57].includes(value)) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return "Rain";
    if (value === 0) return "Clear";
    if (value === 1) return "Mostly clear";
    if (value === 2) return "Partly cloudy";
    if (value === 3) return "Cloudy";
    return "Forecast";
}

function temperatureValue(celsius: unknown, unit: "c" | "f"): number | null {
    if (celsius === null || celsius === undefined || celsius === "") return null;
    const value = Number(celsius);
    if (!Number.isFinite(value)) return null;
    return unit === "f" ? value * 9 / 5 + 32 : value;
}

function temperatureLabel(celsius: unknown, unit: "c" | "f", includeUnit = false): string {
    const value = temperatureValue(celsius, unit);
    return value === null ? "--" : `${Math.round(value)}°${includeUnit ? unit.toUpperCase() : ""}`;
}

function forecastDayLabel(day: WeatherForecastDay, index: number): string {
    if (index === 0) return "Today";
    const date = new Date(`${day.date}T12:00:00`);
    if (!Number.isFinite(date.getTime())) return day.date;
    return new Intl.DateTimeFormat(undefined, {weekday: "short"}).format(date);
}

function bytes(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "Unavailable";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let amount = value;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
        amount /= 1024;
        index++;
    }
    return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function imageSource(value: unknown): string {
    const source = String(value ?? "").trim();
    if (/^[a-z]:[\\/]/i.test(source)) {
        return encodeURI(`file:///${source.replaceAll("\\", "/")}`);
    }
    if (source.startsWith("\\\\")) {
        return encodeURI(`file:${source.replaceAll("\\", "/")}`);
    }
    return source;
}

type PerformanceChartStyle = "line" | "area" | "bars";

function Sparkline({values, style}: {values: number[]; style: PerformanceChartStyle}): preact.JSX.Element {
    const chartY = (value: number) => 28 - Math.min(100, Math.max(0, value)) * 0.28;
    const points = values.length > 1
        ? values.map((value, index) => `${index / (values.length - 1) * 100},${chartY(value)}`).join(" ")
        : "0,28 100,28";
    const barCellWidth = 100 / Math.max(values.length, 1);
    const barWidth = Math.min(2.4, barCellWidth * 0.6);
    return <svg class={`widgetSparkline widgetSparkline-${style}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
        {style === "area" && <polygon points={`0,28 ${points} 100,28`}/>}
        {style === "bars" ? values.map((value, index) => <rect key={index} x={(index + 0.5) * barCellWidth - barWidth / 2} y={chartY(value)} width={barWidth} height={Math.max(0.3, 28 - chartY(value))}/>) : <polyline points={points}/>}
    </svg>;
}

function ClockWidget({widget}: {widget: Widget}): preact.JSX.Element {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const interval = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(interval);
    }, []);
    return <span class="widgetClock">{formatMoment(now, widget.settings.format, "HH:mm")}</span>;
}

function WeatherForecast({days, unit}: {days: WeatherForecastDay[]; unit: "c" | "f"}): preact.JSX.Element {
    const forecastRef = useRef<HTMLDivElement>(null);
    const forecastSignature = days.map((day) => `${day.date}:${day.minTemperatureC}:${day.maxTemperatureC}:${day.weatherCode}`).join("|");
    useLayoutEffect(() => {
        const forecast = forecastRef.current;
        if (!forecast) return;
        let disposed = false;
        const fit = () => {
            if (disposed) return;
            for (const card of forecast.querySelectorAll<HTMLElement>(".weatherForecastDay")) {
                const content = card.querySelector<HTMLElement>(".weatherForecastDayContent");
                const label = content?.querySelector<HTMLElement>("strong");
                const range = content?.querySelector<HTMLElement>(".weatherForecastRange");
                if (!content || !label || !range) continue;
                const style = window.getComputedStyle(card);
                const width = card.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
                const height = card.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
                if (width <= 0 || height <= 0) continue;
                const baseFontSize = Math.min(28, height * 0.24);
                content.style.fontSize = `${baseFontSize}px`;
                const textWidth = Math.max(label.scrollWidth, range.scrollWidth);
                const fittedFontSize = textWidth > width ? baseFontSize * width / textWidth : baseFontSize;
                content.style.fontSize = `${fittedFontSize}px`;
            }
        };
        const resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(forecast);
        forecast.querySelectorAll<HTMLElement>(".weatherForecastDay").forEach((card) => resizeObserver.observe(card));
        fit();
        document.fonts.ready.then(fit).catch(() => undefined);
        return () => { disposed = true; resizeObserver.disconnect(); };
    }, [forecastSignature, unit]);
    return <div ref={forecastRef} class={`weatherForecast weatherForecast-${days.length}`}>
        {days.map((day, index) => <div class="weatherForecastDay" key={day.date}>
            <div class="weatherForecastDayContent">
                <strong>{forecastDayLabel(day, index)}</strong>
                <img src={`../assets/weather-icons/lucide/${weatherIcon(day.weatherCode, 1)}`} alt={weatherCondition(day.weatherCode)}/>
                <div class="weatherForecastRange"><span class="weatherHigh">{temperatureLabel(day.maxTemperatureC, unit)}</span><span class="weatherLow">{temperatureLabel(day.minTemperatureC, unit)}</span></div>
            </div>
        </div>)}
    </div>;
}

function WeatherWidget({widget, weather}: {widget: Widget; weather?: WeatherSnapshot | null}): preact.JSX.Element {
    if (!weather || weather.available === false) {
        return <span class="widgetUnavailable">Weather unavailable</span>;
    }
    const unit = widget.settings.unit === "f" ? "f" : "c";
    const view = widget.settings.view === "three-day" || widget.settings.view === "seven-day" ? widget.settings.view : "current";
    const forecastLength = view === "seven-day" ? 7 : 3;
    const forecast = Array.isArray(weather.forecast) ? weather.forecast : [];
    if (view !== "current" && forecast.length > 0) {
        const days = forecast.slice(0, forecastLength);
        return <WeatherForecast days={days} unit={unit}/>;
    }
    const today = forecast[0];
    return <div class="weatherWidget weatherWidget-current">
        <img src={`../assets/weather-icons/lucide/${weatherIcon(weather.weatherCode, weather.isDay)}`} alt={weatherCondition(weather.weatherCode)}/>
        <div class="weatherCurrentSummary"><strong>{temperatureLabel(weather.temperatureC, unit, true)}</strong>
            <span class="weatherCondition">{weatherCondition(weather.weatherCode)}</span>
            <div class="weatherCurrentRange"><span>Min {temperatureLabel(today?.minTemperatureC, unit)}</span><span>Max {temperatureLabel(today?.maxTemperatureC, unit)}</span></div>
        </div>
    </div>;
}

function SystemWidget({widget, system}: {widget: Widget; system?: WidgetData["system"]}): preact.JSX.Element {
    if (!system?.latest) {
        return <span class="widgetUnavailable">Collecting system metrics…</span>;
    }
    const metrics = Array.isArray(widget.settings.metrics) ? widget.settings.metrics.map(String) : ["cpu", "memory"];
    const history = system.history ?? [];
    const sections = systemSectionOrder(widget.settings).filter((section) => metrics.includes(section));
    const rowBreaks = Array.isArray(widget.settings.rowBreakBefore) ? widget.settings.rowBreakBefore.map(String) : [];
    const excludedDrives = Array.isArray(widget.settings.excludedDrives) ? widget.settings.excludedDrives.map(String) : [];
    const drives = system.latest.drives.filter((drive) => !excludedDrives.includes(drive.id));
    const storageChart = widget.settings.storageChart === "bar" ? "bar" : "pie";
    const driveChartSize = widget.settings.driveChartSize === "regular" || widget.settings.driveChartSize === "large"
        ? widget.settings.driveChartSize : "compact";
    const content: preact.JSX.Element[] = [];
    sections.forEach((section, index) => {
        if (index > 0 && section !== "storage" && sections[index - 1] !== "storage" && rowBreaks.includes(section)) {
            content.push(<div class="systemRowBreak" key={`break-${section}`}/>);
        }
        if (section === "storage") {
            content.push(<div class={`systemStorageMetrics systemStorageMetrics-${driveChartSize}`} key="storage">
                {drives.length === 0 ? <span class="widgetUnavailable">No drives selected or available</span> : drives.map((drive) => <div class={`systemMetric systemDrive ${storageChart === "pie" && widget.settings.view !== "numbers" ? "is-pie" : ""}`} key={drive.id} title={`${drive.id} ${drive.label}`}>
                    {widget.settings.view !== "numbers" && (storageChart === "pie"
                        ? <div class="systemDrivePie" style={{background: `conic-gradient(currentColor ${drive.percent}%, rgba(255,255,255,.16) 0)`}} role="img" aria-label={`${drive.id} ${Math.round(drive.percent)}% used`}/>
                        : <div class="systemDriveBar" role="img" aria-label={`${drive.id} ${Math.round(drive.percent)}% used`}><span style={{width: `${drive.percent}%`}}/></div>)}
                    <div class="systemDriveCaption"><div class="systemDriveIdentity"><span class="systemDriveName">{drive.id}{drive.label ? ` ${drive.label}` : ""}</span><strong class="systemDrivePercent">{Math.round(drive.percent)}%</strong></div><span class="systemDriveCapacity">{bytes(drive.used)} / {bytes(drive.total)}</span></div>
                </div>)}
            </div>);
            return;
        }
        const isMemory = section === "memory";
        const value = isMemory ? system.latest.memoryPercent : system.latest.cpuPercent;
        const detail = isMemory ? `${bytes(system.latest.memoryUsed)} / ${bytes(system.latest.memoryTotal)}` : "";
        const values = history.map((point) => isMemory ? point.memoryPercent : point.cpuPercent);
        const savedChart = widget.settings[`${section}Chart`];
        const chartStyle: PerformanceChartStyle = savedChart === "area" || savedChart === "bars" ? savedChart : "line";
        content.push(<div class="systemMetric systemPerformanceMetric" key={section}>
            <div class="systemMetricHeader"><span>{isMemory ? "Memory" : "CPU"}</span><strong>{Math.round(value)}%</strong></div>
            {widget.settings.view !== "numbers" && <Sparkline values={values} style={chartStyle}/>}
            {widget.size === "large" && detail && <small>{detail}</small>}
        </div>);
    });
    return <div class={`systemWidget systemWidget-${widget.size}`}>
        {content}
    </div>;
}

export function WidgetView({widget, profile, mode, data, preview = false, previewDisplay, previewScale = 1}: Props): preact.JSX.Element | null {
    const definition = WIDGET_DEFINITIONS[widget.type];
    const unsupported = definition.unsupportedModes?.includes(mode) ?? false;
    const style = effectiveStyle(widget, profile);
    const markup = useMemo(() => sanitizeMarkup(widget.settings.html), [widget.settings.html]);
    const autoFitText = style.fontSizeMode === "auto" && AUTO_FIT_TEXT_TYPES.has(widget.type);
    const elementRef = useAutoFitText(autoFitText, `${widget.type}:${JSON.stringify(widget.settings)}:${style.fontFamily}:${style.fontWeight}:${style.paddingMode}:${style.padding}:${style.paddingTop}:${style.paddingRight}:${style.paddingBottom}:${style.paddingLeft}:${previewScale}`);
    if (!widget.enabled) return null;
    if (unsupported) {
        return preview ? <div class="widgetUnavailable">Not available in {mode}</div> : null;
    }

    let content: preact.JSX.Element;
    switch (widget.type) {
        case "text": content = <span>{String(widget.settings.text ?? "")}</span>; break;
        case "custom-html": content = <div dangerouslySetInnerHTML={{__html: markup}}/>; break;
        case "clock": content = <ClockWidget widget={widget}/>; break;
        case "weather": content = <WeatherWidget widget={widget} weather={data.weather}/>; break;
        case "astronomy": {
            const event = String(widget.settings.event ?? "sunrise");
            const value = data.astronomy?.[event];
            content = <span>{event.replace("rise", "rise ").replace("set", "set ")} {value ? formatMoment(String(value), widget.settings.format, "HH:mm") : "--"}</span>;
            break;
        }
        case "video-info": {
            const field = String(widget.settings.field ?? "name");
            content = <span>{String(data.video?.[field] ?? (preview ? "Current aerial information" : ""))}</span>;
            break;
        }
        case "image": {
            const source = String(widget.settings.path ?? "");
            content = source ? <img class="imageWidget" src={imageSource(source)} alt=""/> : <span class="widgetUnavailable">Choose an image</span>;
            break;
        }
        case "system": content = <SystemWidget widget={widget} system={data.system}/>; break;
        default: content = <span/>;
    }

    return <div ref={elementRef} class={`aerialWidget aerialWidget-${widget.type} aerialWidget-${widget.size} ${style.fontSizeMode === "auto" ? "is-auto-size" : "is-fixed-size"} ${autoFitText ? "uses-measured-fit" : ""}`} style={{
        fontFamily: style.fontFamily,
        fontSize: style.fontSizeMode === "fixed" ? fixedFontSizeValue(style, preview ? previewDisplay : undefined, previewScale) : undefined,
        fontWeight: style.fontWeight,
        color: style.color,
        opacity: style.opacity,
        textAlign: style.textAlign,
        justifyContent: style.textAlign === "right" ? "flex-end" : style.textAlign === "center" ? "center" : "flex-start",
        backgroundColor: hexToRgba(style.background, style.backgroundOpacity),
        borderRadius: `${style.borderRadius * (preview ? previewScale : 1)}px`,
        padding: paddingValue(style, preview ? previewScale : 1)
    }}>{autoFitText ? <span class="widgetFitContent">{content}</span> : content}</div>;
}
