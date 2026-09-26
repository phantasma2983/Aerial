const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
    GRID_COLUMNS,
    GRID_ROWS,
    WidgetConfigSchema,
    applyWidgetSize,
    createDefaultWidgetConfig,
    createOwnedProfile,
    createWidget,
    detachWidgetProfile,
    findOpenWidgetLayout,
    materializeWidgetDisplays,
    mirrorScreensaverProfile,
    resolveWidgetProfile,
    systemSectionOrder,
    widgetLayoutsOverlap
} = require("../runtime/shared/widget-schema.js");
const {migrateLegacyWidgetConfig} = require("../runtime/shared/widget-migration.js");
const {
    WEATHER_FORECAST_DAYS,
    buildWeatherUrl,
    normalizeWeatherSnapshot
} = require("../runtime/shared/weather.js");
const {SystemMetricsSampler, parseWindowsLogicalDrives} = require("../runtime/main/system-metrics.js");

function display(id, index, label = `Display ${index + 1}`) {
    const width = index === 0 ? 2560 : 1920;
    const height = index === 0 ? 1440 : 1080;
    const x = index === 0 ? 0 : 2560;
    const bounds = {x, y: 0, width, height};
    return {id, index, label, isPrimary: index === 0, width, height,
        nativeWidth: width, nativeHeight: height, scaleFactor: 1, bounds};
}

test("new configurations mirror the screensaver profile by default", () => {
    const config = createDefaultWidgetConfig();
    assert.deepEqual(config.profiles.screensaver.grid, {columns: 48, rows: 28});
    assert.equal(config.profiles.wallpaper.source, "screensaver");
    assert.equal(config.profiles.minimal.source, "screensaver");
    assert.equal(resolveWidgetProfile(config, "wallpaper"), config.profiles.screensaver);
    assert.equal(config.profiles.screensaver.defaultStyle.fontSizeMode, "auto");
    assert.equal(config.profiles.screensaver.defaultStyle.paddingMode, "all");
    assert.deepEqual([
        config.profiles.screensaver.defaultStyle.paddingTop,
        config.profiles.screensaver.defaultStyle.paddingRight,
        config.profiles.screensaver.defaultStyle.paddingBottom,
        config.profiles.screensaver.defaultStyle.paddingLeft
    ], [12, 12, 12, 12]);
    assert.equal(config.profiles.screensaver.widgets[0].style.fontSizeMode, "auto");
    assert.equal(config.profiles.screensaver.widgets[0].layout.x + config.profiles.screensaver.widgets[0].layout.w, GRID_COLUMNS);
});

test("detaching creates an independent copy and mirroring can be restored", () => {
    const original = createDefaultWidgetConfig();
    const detached = detachWidgetProfile(original, "wallpaper");
    assert.equal(detached.profiles.wallpaper.source, "self");
    detached.profiles.screensaver.widgets[0].name = "Changed later";
    assert.equal(detached.profiles.wallpaper.widgets[0].name, "Clock");

    const mirrored = mirrorScreensaverProfile(detached, "wallpaper");
    assert.equal(mirrored.profiles.wallpaper.source, "screensaver");
    assert.equal(resolveWidgetProfile(mirrored, "wallpaper").widgets[0].name, "Changed later");
});

test("shared widgets become independent instances for every connected display", () => {
    const materialized = materializeWidgetDisplays(createDefaultWidgetConfig(), [display(101, 0), display(202, 1)]);
    const widgets = materialized.profiles.screensaver.widgets;
    assert.deepEqual(widgets.map((widget) => widget.layout.screen), [101, 202]);
    assert.equal(new Set(widgets.map((widget) => widget.id)).size, 2);
    widgets[0].layout.x = 0;
    assert.notEqual(widgets[0].layout.x, widgets[1].layout.x);
    assert.equal(materialized.profiles.wallpaper.source, "screensaver");
});

test("legacy display indexes bind to the corresponding connected display id", () => {
    const config = createDefaultWidgetConfig();
    config.profiles.screensaver.widgets[0].layout.screen = 1;
    const materialized = materializeWidgetDisplays(config, [display(101, 0), display(202, 1)]);
    assert.equal(materialized.profiles.screensaver.widgets[0].layout.screen, 202);
});

test("saved widgets recover after both Windows display ids change", () => {
    const original = createDefaultWidgetConfig();
    original.profiles.screensaver.widgets = [
        createWidget("clock", 0, {layout: {x: 41, y: 2, w: 7, h: 3, strategy: "fixed", screen: 1018631849}}),
        createWidget("weather", 1, {layout: {x: 28, y: 23, w: 20, h: 3, strategy: "fixed", screen: 1998398546}})
    ];
    const displays = [display(2022492355, 0, "DELL S3220DGF"), display(733305938, 1, "MP59G")];
    const recovered = materializeWidgetDisplays(original, displays);
    assert.deepEqual(recovered.profiles.screensaver.widgets.map((widget) => widget.layout.screen), [2022492355, 733305938]);
    assert.deepEqual(recovered.profiles.screensaver.widgets.map((widget) => widget.layout.x), [41, 28]);
    assert.deepEqual(recovered.displayBindings.map((binding) => binding.label), ["DELL S3220DGF", "MP59G"]);

    const changedAgain = materializeWidgetDisplays(recovered, [display(777, 1, "MP59G"), display(888, 0, "DELL S3220DGF")]);
    assert.deepEqual(changedAgain.profiles.screensaver.widgets.map((widget) => widget.layout.screen), [888, 777]);
    assert.deepEqual(changedAgain.displayBindings.map((binding) => binding.id), [888, 777]);
});

test("a temporarily disconnected display retains its widgets and binding", () => {
    const initial = materializeWidgetDisplays(createDefaultWidgetConfig(), [display(101, 0), display(202, 1)]);
    const oneScreen = materializeWidgetDisplays(initial, [display(101, 0)]);
    assert.deepEqual(oneScreen.profiles.screensaver.widgets.map((widget) => widget.layout.screen), [101, 202]);
    assert.deepEqual(oneScreen.displayBindings.map((binding) => binding.id), [101, 202]);
    const reconnected = materializeWidgetDisplays(oneScreen, [display(101, 0), display(303, 1)]);
    assert.deepEqual(reconnected.profiles.screensaver.widgets.map((widget) => widget.layout.screen), [101, 303]);
});

test("unbound stale widgets wait for all monitors before rebinding", () => {
    const original = createDefaultWidgetConfig();
    original.profiles.screensaver.widgets = [
        createWidget("clock", 0, {layout: {x: 0, y: 0, w: 8, h: 2, strategy: "fixed", screen: 900}}),
        createWidget("clock", 1, {layout: {x: 0, y: 4, w: 8, h: 2, strategy: "fixed", screen: 901}})
    ];
    const partial = materializeWidgetDisplays(original, [display(101, 0)]);
    assert.deepEqual(partial.profiles.screensaver.widgets.map((widget) => widget.layout.screen), [900, 901]);
    assert.deepEqual(partial.displayBindings, []);
    const full = materializeWidgetDisplays(partial, [display(101, 0), display(202, 1)]);
    assert.deepEqual(full.profiles.screensaver.widgets.map((widget) => widget.layout.screen), [101, 202]);
});

test("grid overlap respects geometry and display targeting", () => {
    const left = {x: 0, y: 0, w: 4, h: 2, strategy: "fixed", screen: 0};
    assert.equal(widgetLayoutsOverlap(left, {...left, x: 3, screen: 0}), true);
    assert.equal(widgetLayoutsOverlap(left, {...left, x: 4, screen: 0}), false);
    assert.equal(widgetLayoutsOverlap(left, {...left, x: 0, screen: 1}), false);
    assert.equal(widgetLayoutsOverlap(left, {...left, x: 0, screen: "all"}), true);
});

test("new widgets are placed in the first available grid area", () => {
    const first = createWidget("clock", 0, {
        layout: {x: 0, y: 0, w: 12, h: 4, strategy: "fixed", screen: 101}
    });
    const layout = findOpenWidgetLayout(createOwnedProfile([first]), "clock", 101);
    assert.deepEqual({x: layout.x, y: layout.y}, {x: 12, y: 0});
    const otherDisplayLayout = findOpenWidgetLayout(createOwnedProfile([first]), "clock", 202);
    assert.deepEqual({x: otherDisplayLayout.x, y: otherDisplayLayout.y}, {x: 0, y: 0});
});

test("predefined widget sizes remain inside the grid", () => {
    const widget = createWidget("system", 0, {
        layout: {x: GRID_COLUMNS - 2, y: GRID_ROWS - 2, w: 2, h: 2, strategy: "fixed", screen: "all"}
    });
    const resized = applyWidgetSize(widget, "large");
    assert.equal(resized.layout.x + resized.layout.w, GRID_COLUMNS);
    assert.ok(resized.layout.y + resized.layout.h <= GRID_ROWS);
});

test("24 by 14 widget layouts migrate to the finer grid without moving on screen", () => {
    const oldConfig = structuredClone(createDefaultWidgetConfig());
    oldConfig.schemaVersion = 1;
    oldConfig.profiles.screensaver.grid = {columns: 24, rows: 14};
    oldConfig.profiles.screensaver.widgets[0].layout = {x: 17, y: 11, w: 7, h: 2, strategy: "fixed", screen: "all"};
    oldConfig.profiles.screensaver.minimalMotion.maxOffsetCells = 1;

    const migrated = migrateLegacyWidgetConfig({widgetConfig: oldConfig});
    const layout = migrated.profiles.screensaver.widgets[0].layout;
    assert.deepEqual({x: layout.x, y: layout.y, w: layout.w, h: layout.h}, {x: 34, y: 22, w: 14, h: 4});
    assert.equal(migrated.profiles.screensaver.minimalMotion.maxOffsetCells, 2);
});

test("stored styles gain default all-sides padding controls", () => {
    const stored = createDefaultWidgetConfig();
    const profileStyle = stored.profiles.screensaver.defaultStyle;
    const widgetStyle = stored.profiles.screensaver.widgets[0].style;
    for (const style of [profileStyle, widgetStyle]) {
        delete style.paddingMode;
        delete style.paddingTop;
        delete style.paddingRight;
        delete style.paddingBottom;
        delete style.paddingLeft;
    }
    const parsed = WidgetConfigSchema.parse(stored);
    assert.equal(parsed.profiles.screensaver.defaultStyle.paddingMode, "all");
    assert.equal(parsed.profiles.screensaver.widgets[0].style.paddingLeft, 12);
});

test("minimal mode preview and widget settings remain discoverable", () => {
    const configHtml = fs.readFileSync(path.join(__dirname, "..", "web", "config.html"), "utf8");
    const configScript = fs.readFileSync(path.join(__dirname, "..", "web", "config.js"), "utf8");
    assert.match(configHtml, /onclick="openMinimalPreview\(\)">Preview Minimal/);
    assert.match(configHtml, /onclick="openMinimalWidgetSettings\(\)"/);
    assert.match(configScript, /aerial-widget-mode-request[\s\S]*detail: 'minimal'/);
});

test("screensaver preview uses the correct product language", () => {
    const configHtml = fs.readFileSync(path.join(__dirname, "..", "web", "config.html"), "utf8");
    assert.match(configHtml, /onclick="openPreview\(\)">Preview Screensaver<\/button>/);
    assert.doesNotMatch(configHtml, /Preview Aerial/);
});

test("weather requests and normalizes a seven-day daily forecast", () => {
    const url = new URL(buildWeatherUrl("https://api.open-meteo.com/v1/forecast", 45.75, 21.23));
    assert.equal(url.searchParams.get("forecast_days"), String(WEATHER_FORECAST_DAYS));
    assert.equal(url.searchParams.get("daily"), "weather_code,temperature_2m_max,temperature_2m_min");
    assert.equal(url.searchParams.get("timezone"), "auto");

    const dates = Array.from({length: 7}, (_, index) => `2026-09-0${index + 1}`);
    const snapshot = normalizeWeatherSnapshot({
        timezone: "Europe/Bucharest",
        current: {temperature_2m: 22.26, weather_code: 2, is_day: 1, wind_speed_10m: 8.84},
        daily: {
            time: dates,
            temperature_2m_min: [14.14, 15, 16, 17, 18, 19, 20],
            temperature_2m_max: [26.86, 27, 28, 29, 30, 31, 32],
            weather_code: [2, 61, 3, 0, 1, 80, 95]
        }
    }, 45.75, 21.23);

    assert.equal(snapshot.timezone, "Europe/Bucharest");
    assert.equal(snapshot.temperatureC, 22.3);
    assert.equal(snapshot.forecast.length, 7);
    assert.deepEqual(snapshot.forecast[0], {
        date: "2026-09-01",
        minTemperatureC: 14.1,
        maxTemperatureC: 26.9,
        weatherCode: 2
    });
});

test("weather widget exposes current, three-day, and seven-day layouts", () => {
    const configSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "config", "widget-app.tsx"), "utf8");
    const widgetSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "widgets", "widget-view.tsx"), "utf8");
    const widgetCss = fs.readFileSync(path.join(__dirname, "..", "web", "widgets.css"), "utf8");
    assert.match(configSource, /options=\{\["current", "three-day", "seven-day"\]\}/);
    assert.match(configSource, /Current day/);
    assert.match(configSource, /3-day forecast/);
    assert.match(configSource, /7-day forecast/);
    assert.match(configSource, /previewForecastDate\(6\)/);
    assert.match(configSource, /grid\.update\(item,[\s\S]*w: widget\.layout\.w,[\s\S]*h: widget\.layout\.h/);
    assert.match(widgetSource, /Array\.isArray\(weather\.forecast\) \? weather\.forecast : \[\]/);
    assert.match(widgetSource, /height \* 0\.24/);
    assert.match(widgetSource, /baseFontSize \* width \/ textWidth/);
    assert.match(widgetCss, /\.weatherForecast \{[^}]*grid-template-rows: minmax\(0, 1fr\)/);
});

test("legacy text positions migrate into typed widgets", () => {
    const migrated = migrateLegacyWidgetConfig({
        textFont: "Segoe UI",
        textSize: 999,
        textSizeUnit: "invalid-unit",
        textFontWeight: 5000,
        displayText: {
            positionList: ["topleft", "random"],
            topleft: [{type: "time", timeString: "HH:mm:ss"}],
            random: [{type: "weather", weatherUnit: "f"}]
        }
    });
    const widgets = migrated.profiles.screensaver.widgets;
    assert.deepEqual(widgets.map((widget) => widget.type), ["clock", "weather"]);
    assert.equal(widgets[1].layout.strategy, "roaming");
    assert.equal(widgets[0].style.fontSize, 20);
    assert.equal(widgets[0].style.fontSizeMode, "auto");
    assert.equal(widgets[0].style.fontSizeUnit, "vmin");
    assert.equal(widgets[0].style.fontWeight, 900);
    assert.doesNotThrow(() => WidgetConfigSchema.parse(migrated));
});

test("invalid stored widget data falls back to a valid default configuration", () => {
    const migrated = migrateLegacyWidgetConfig({widgetConfig: {schemaVersion: 999}});
    assert.equal(migrated.profiles.screensaver.widgets[0].type, "clock");
    assert.doesNotThrow(() => WidgetConfigSchema.parse(migrated));
});

test("logical drive discovery includes multiple drives and clamps usage", () => {
    const drives = parseWindowsLogicalDrives([
        {DeviceID: "I:", VolumeName: "MightySSD", Size: 1000, FreeSpace: 250},
        {DeviceID: "C:", VolumeName: "", Size: 500, FreeSpace: 100},
        {DeviceID: "D:", VolumeName: "Empty", Size: 0, FreeSpace: 0}
    ]);
    assert.deepEqual(drives.map((drive) => drive.id), ["C:", "I:"]);
    assert.deepEqual(drives.map((drive) => drive.percent), [80, 75]);
    assert.equal(drives[1].label, "MightySSD");
    assert.equal(parseWindowsLogicalDrives({DeviceID: "J:", Size: 100, FreeSpace: 200})[0].percent, 0);
});

test("system metrics share the discovered drives and cap history", async () => {
    let driveQueries = 0;
    const sampler = new SystemMetricsSampler(async () => {
        driveQueries++;
        return [{id: "C:", label: "System", used: 75, total: 100, percent: 75},
            {id: "I:", label: "Data", used: 25, total: 100, percent: 25}];
    });
    let snapshot;
    for (let index = 0; index < 62; index++) {
        snapshot = await sampler.sample();
    }
    assert.ok(snapshot.latest.cpuPercent >= 0 && snapshot.latest.cpuPercent <= 100);
    assert.ok(snapshot.latest.memoryPercent >= 0 && snapshot.latest.memoryPercent <= 100);
    assert.deepEqual(snapshot.latest.drives.map((drive) => drive.id), ["C:", "I:"]);
    assert.equal(driveQueries, 1);
    assert.equal(snapshot.history.length, 60);
});

test("CPU and memory widgets do not query drives", async () => {
    let driveQueries = 0;
    const sampler = new SystemMetricsSampler(async () => { driveQueries++; return []; });
    const snapshot = await sampler.sample(false);
    assert.deepEqual(snapshot.latest.drives, []);
    assert.equal(driveQueries, 0);
});

test("system widget section order preserves manual order and restores omitted sections", () => {
    assert.deepEqual(systemSectionOrder({}), ["cpu", "memory", "storage"]);
    assert.deepEqual(systemSectionOrder({sectionOrder: ["storage", "cpu", "storage", "invalid"]}), ["storage", "cpu", "memory"]);
});

test("widget updates reach wallpaper without reloading its video page", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
    const widgetHostSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "widgets", "widget-host.tsx"), "utf8");
    const widgetConfigHandlers = mainSource.slice(
        mainSource.indexOf("function saveOwnedWidgetProfile("),
        mainSource.indexOf("async function sampleAndBroadcastSystemMetrics(")
    );
    assert.match(widgetConfigHandlers, /broadcastRendererEvent\("widgetConfigChanged",/);
    assert.doesNotMatch(widgetConfigHandlers, /scheduleWallpaperRefresh\(/);
    assert.match(widgetHostSource, /return window\.aerial\.widgets\.onConfigChanged\(setSnapshot\)/);
    assert.match(mainSource, /if \(isWallpaperScopedConfigKey\(payload\.key\)\) \{\s*scheduleWallpaperRefresh\(payload\.key\)/);
});
