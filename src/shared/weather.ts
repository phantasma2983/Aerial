export const WEATHER_FORECAST_DAYS = 7;

export type WeatherForecastDay = {
    date: string;
    minTemperatureC: number | null;
    maxTemperatureC: number | null;
    weatherCode: number | null;
};

export type WeatherSnapshot = {
    available: boolean;
    stale: boolean;
    error: string;
    fetchedAt: string;
    latitude: number | null;
    longitude: number | null;
    source: "open-meteo";
    timezone: string;
    temperatureC: number | null;
    temperatureF: number | null;
    windSpeedKmh: number | null;
    weatherCode: number | null;
    isDay: boolean;
    forecast: WeatherForecastDay[];
};

type OpenMeteoPayload = {
    timezone?: unknown;
    current?: Record<string, unknown>;
    daily?: Record<string, unknown>;
};

function roundedNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(1)) : null;
}

export function getWeatherUnavailableSnapshot(message: string, latitude: number | null = null, longitude: number | null = null): WeatherSnapshot {
    return {
        available: false,
        stale: false,
        error: message,
        fetchedAt: "",
        latitude,
        longitude,
        source: "open-meteo",
        timezone: "",
        temperatureC: null,
        temperatureF: null,
        windSpeedKmh: null,
        weatherCode: null,
        isDay: true,
        forecast: []
    };
}

export function buildWeatherUrl(baseUrl: string, latitude: number, longitude: number): string {
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m,weather_code,is_day,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min",
        forecast_days: String(WEATHER_FORECAST_DAYS),
        wind_speed_unit: "kmh",
        timezone: "auto"
    });
    return `${baseUrl}?${params.toString()}`;
}

export function normalizeWeatherSnapshot(payload: OpenMeteoPayload, latitude: number, longitude: number): WeatherSnapshot {
    const current = payload?.current;
    if (!current) {
        throw new Error("Weather response did not include current conditions.");
    }
    const temperatureC = roundedNumber(current.temperature_2m);
    const weatherCode = roundedNumber(current.weather_code);
    if (temperatureC === null || weatherCode === null) {
        throw new Error("Weather response was missing temperature or weather code.");
    }

    const dates = Array.isArray(payload.daily?.time) ? payload.daily.time : [];
    const minimums = Array.isArray(payload.daily?.temperature_2m_min) ? payload.daily.temperature_2m_min : [];
    const maximums = Array.isArray(payload.daily?.temperature_2m_max) ? payload.daily.temperature_2m_max : [];
    const weatherCodes = Array.isArray(payload.daily?.weather_code) ? payload.daily.weather_code : [];
    const forecast = dates.slice(0, WEATHER_FORECAST_DAYS).map((date, index) => ({
        date: String(date ?? ""),
        minTemperatureC: roundedNumber(minimums[index]),
        maxTemperatureC: roundedNumber(maximums[index]),
        weatherCode: roundedNumber(weatherCodes[index])
    })).filter((day) => day.date !== "");
    if (forecast.length === 0) {
        throw new Error("Weather response did not include a daily forecast.");
    }

    const windSpeedKmh = roundedNumber(current.wind_speed_10m);
    return {
        available: true,
        stale: false,
        error: "",
        fetchedAt: new Date().toISOString(),
        latitude,
        longitude,
        source: "open-meteo",
        timezone: typeof payload.timezone === "string" ? payload.timezone : "",
        temperatureC,
        temperatureF: Number((((temperatureC * 9) / 5) + 32).toFixed(1)),
        windSpeedKmh,
        weatherCode,
        isDay: Number(current.is_day) === 1,
        forecast
    };
}
