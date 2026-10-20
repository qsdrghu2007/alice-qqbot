import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvironmentContext,
  describeWeatherCode,
  fetchNanjingWeather,
  formatLocalContext,
} from "../src/weather.js";

test("Nanjing weather parses Open-Meteo fields and maps codes", async () => {
  const requests = [];
  const weather = await fetchNanjingWeather({
    now: () => new Date("2026-10-19T04:15:00.000Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            current: {
              time: "2026-10-19T12:15",
              temperature_2m: 18.6,
              apparent_temperature: 17.2,
              relative_humidity_2m: 64.4,
              weather_code: 3,
              wind_speed_10m: 6.14,
            },
          };
        },
      };
    },
  });
  assert.equal(weather.description, "阴");
  assert.equal(weather.temperature, 19);
  assert.equal(weather.apparentTemperature, 17);
  assert.equal(weather.humidity, 64);
  assert.equal(weather.windSpeed, 6.1);
  assert.equal(weather.observedAt, "2026-10-19T12:15");
  assert.match(requests[0].url, /latitude=32\.0603/);
  assert.match(requests[0].url, /longitude=118\.7969/);
  assert.match(requests[0].url, /timezone=Asia%2FShanghai/);
  assert.match(requests[0].options.headers["User-Agent"], /xiaoyu-qqbot/);
});

test("weather codes and natural time context are deterministic", () => {
  assert.equal(describeWeatherCode(0), "晴");
  assert.equal(describeWeatherCode(61), "小雨");
  assert.equal(describeWeatherCode(95), "雷雨");
  assert.equal(describeWeatherCode(999), "未知天气");
  const local = formatLocalContext(new Date("2026-10-19T04:15:00.000Z"));
  assert.equal(local.time, "2026-10-19 12:15");
  assert.equal(local.weekday, "星期一");
  assert.equal(local.dayPart, "中午");
});

test("environment context includes weather or an explicit no-fabrication fallback", () => {
  const now = new Date("2026-10-19T04:15:00.000Z");
  const withWeather = buildEnvironmentContext({
    now,
    weather: {
      description: "多云",
      temperature: 21,
      apparentTemperature: 20,
      humidity: 55,
      windSpeed: 8,
    },
  });
  assert.match(withWeather, /当前时间：2026-10-19 12:15（星期一，中午）/);
  assert.match(withWeather, /南京当前天气：多云，气温 21°C，体感 20°C/);
  assert.match(withWeather, /湿度 55%/);

  const withoutWeather = buildEnvironmentContext({ now, weather: null });
  assert.match(withoutWeather, /南京当前天气：暂时获取失败/);
  assert.match(withoutWeather, /不要编造天气/);
});

test("weather HTTP and payload failures are rejected", async () => {
  await assert.rejects(
    fetchNanjingWeather({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /weather HTTP 503/,
  );
  await assert.rejects(
    fetchNanjingWeather({
      fetchImpl: async () => ({ ok: true, json: async () => ({ current: {} }) }),
    }),
    /temperature missing/,
  );
});
