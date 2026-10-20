const NANJING = Object.freeze({
  city: "南京",
  latitude: 32.0603,
  longitude: 118.7969,
  timezone: "Asia/Shanghai",
});

const WEATHER_CODES = new Map([
  [0, "晴"],
  [1, "晴间多云"],
  [2, "多云"],
  [3, "阴"],
  [45, "雾"],
  [48, "雾凇"],
  [51, "毛毛雨"],
  [53, "毛毛雨"],
  [55, "毛毛雨"],
  [56, "冻毛毛雨"],
  [57, "冻毛毛雨"],
  [61, "小雨"],
  [63, "中雨"],
  [65, "大雨"],
  [66, "冻雨"],
  [67, "冻雨"],
  [71, "小雪"],
  [73, "中雪"],
  [75, "大雪"],
  [77, "米雪"],
  [80, "小阵雨"],
  [81, "中阵雨"],
  [82, "强阵雨"],
  [85, "小阵雪"],
  [86, "强阵雪"],
  [95, "雷雨"],
  [96, "雷雨伴冰雹"],
  [99, "雷雨伴冰雹"],
]);

export function describeWeatherCode(value) {
  const code = Number(value);
  return WEATHER_CODES.get(code) ?? "未知天气";
}

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

function dayPart(hour) {
  if (hour >= 5 && hour < 9) return "早上";
  if (hour >= 9 && hour < 11) return "上午";
  if (hour >= 11 && hour < 13) return "中午";
  if (hour >= 13 && hour < 17) return "下午";
  if (hour >= 17 && hour < 19) return "傍晚";
  if (hour >= 19 && hour < 23) return "晚上";
  return "深夜";
}

export function formatLocalContext(date, timeZone = NANJING.timezone) {
  try {
    const parts = localParts(date, timeZone);
    const hour = String(parts.hour).padStart(2, "0");
    const minute = String(parts.minute).padStart(2, "0");
    return {
      time: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${hour}:${minute}`,
      weekday: parts.weekday,
      dayPart: dayPart(parts.hour),
    };
  } catch {
    const parts = localParts(date, NANJING.timezone);
    const hour = String(parts.hour).padStart(2, "0");
    const minute = String(parts.minute).padStart(2, "0");
    return {
      time: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${hour}:${minute}`,
      weekday: parts.weekday,
      dayPart: dayPart(parts.hour),
    };
  }
}

export function buildEnvironmentContext({ weather, now = new Date(), timeZone = NANJING.timezone } = {}) {
  const local = formatLocalContext(now, timeZone);
  const lines = [`当前时间：${local.time}（${local.weekday}，${local.dayPart}）`];
  if (weather) {
    const details = [
      `${weather.description}，气温 ${weather.temperature}°C`,
      `体感 ${weather.apparentTemperature}°C`,
    ];
    if (Number.isFinite(weather.humidity)) details.push(`湿度 ${weather.humidity}%`);
    if (Number.isFinite(weather.windSpeed)) details.push(`风速 ${weather.windSpeed} km/h`);
    lines.push(`南京当前天气：${details.join("，")}`);
  } else {
    lines.push("南京当前天气：暂时获取失败（不要编造天气）");
  }
  return lines.join("\n");
}

export async function fetchNanjingWeather({
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数");
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(NANJING.latitude));
  url.searchParams.set("longitude", String(NANJING.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
  );
  url.searchParams.set("timezone", NANJING.timezone);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 5_000));
  timer?.unref?.();
  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "xiaoyu-qqbot/0.1" },
    });
    if (!response.ok) {
      throw new Error(`weather HTTP ${response.status}`);
    }
    const payload = await response.json();
    const current = payload?.current;
    const temperature = Number(current?.temperature_2m);
    if (!Number.isFinite(temperature)) throw new Error("weather temperature missing");
    const apparent = Number(current?.apparent_temperature);
    const humidity = Number(current?.relative_humidity_2m);
    const windSpeed = Number(current?.wind_speed_10m);
    const fetched = now();
    const fetchedDate = fetched instanceof Date ? fetched : new Date(fetched);
    return {
      city: NANJING.city,
      description: describeWeatherCode(current?.weather_code),
      weatherCode: Number(current?.weather_code),
      temperature: Math.round(temperature),
      apparentTemperature: Number.isFinite(apparent) ? Math.round(apparent) : Math.round(temperature),
      humidity: Number.isFinite(humidity) ? Math.round(humidity) : null,
      windSpeed: Number.isFinite(windSpeed) ? Math.round(windSpeed * 10) / 10 : null,
      observedAt: typeof current?.time === "string" ? current.time : null,
      fetchedAt: Number.isFinite(fetchedDate.getTime())
        ? fetchedDate.toISOString()
        : new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export { NANJING };
