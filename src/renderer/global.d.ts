import type {OwnedWidgetProfile, WidgetConfig, WidgetDisplay, WidgetMode} from "../shared/widget-schema";
import type {DriveMetric, SystemMetricPoint} from "../main/system-metrics";
import type {WeatherSnapshot} from "../shared/weather";

type WidgetConfigSnapshot = {
    config: WidgetConfig;
    displays: WidgetDisplay[];
    context: {
        astronomy: Record<string, unknown>;
        latitude: string;
        longitude: string;
    };
};

type SystemMetricsSnapshot = {
    latest: SystemMetricPoint;
    history: SystemMetricPoint[];
};

declare global {
    interface Window {
        aerial: {
            widgets: {
                getConfig(): Promise<WidgetConfigSnapshot>;
                saveProfile(mode: WidgetMode, profile: OwnedWidgetProfile): Promise<WidgetConfigSnapshot>;
                setMirroring(mode: Exclude<WidgetMode, "screensaver">, enabled: boolean): Promise<WidgetConfigSnapshot>;
                reset(): Promise<WidgetConfigSnapshot>;
                getWeather(force?: boolean): Promise<WeatherSnapshot>;
                selectImage(): Promise<{canceled: boolean; path: string}>;
                getSystemDrives(): Promise<DriveMetric[]>;
                subscribeSystemMetrics(includeStorage?: boolean): Promise<{subscribed: boolean}>;
                unsubscribeSystemMetrics(): Promise<{subscribed: boolean}>;
                openPreview(mode: WidgetMode, displayId: number): Promise<{opened: boolean; mode: WidgetMode}>;
                onConfigChanged(callback: (snapshot: WidgetConfigSnapshot) => void): () => void;
                onDataChanged(callback: (payload: {source: string; snapshot: SystemMetricsSnapshot}) => void): () => void;
            };
        };
        electron: {
            videos: Array<Record<string, unknown>>;
            store: {get(key: string): unknown; set(key: string, value: unknown): void};
            ipcRenderer: {
                on(channel: string, callback: (...args: unknown[]) => void): void;
                send(channel: string, data?: unknown): void;
                invoke(channel: string, data?: unknown): Promise<unknown>;
            };
            fontListUniversal: {getFonts(): Promise<string[]>};
        };
    }
}

export {};
