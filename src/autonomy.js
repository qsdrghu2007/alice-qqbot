import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { chat as defaultChat } from "./ai.js";
import {
  buildEnvironmentContext,
  fetchNanjingWeather,
} from "./weather.js";

const MINUTE_MS = 60_000;
const MIN_INTERVAL_MINUTES = 60;
const DEFAULT_INTERVAL_MINUTES = 240;
const DEFAULT_PROMPT = "写一条自然简短的动态，不编造真实经历。";
const STATE_FILE = path.join("data", "autonomy.json");

function autonomyConfig(config) {
  const raw = config?.autonomy ?? {};
  const interval = Number(raw.intervalMinutes);
  return {
    enabled: raw.enabled === true,
    intervalMinutes:
      Number.isFinite(interval) && interval >= MIN_INTERVAL_MINUTES
        ? Math.floor(interval)
        : DEFAULT_INTERVAL_MINUTES,
    prompt:
      typeof raw.prompt === "string" && raw.prompt.trim()
        ? raw.prompt.trim()
        : DEFAULT_PROMPT,
    quietHours: {
      start: clampHour(raw.quietHours?.start, 23),
      end: clampHour(raw.quietHours?.end, 8),
    },
    timezone:
      typeof raw.timezone === "string" && raw.timezone.trim()
        ? raw.timezone.trim()
        : "Asia/Shanghai",
  };
}

function clampHour(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 23 ? number : fallback;
}

function emptyState() {
  return {
    version: 1,
    intervalMinutes: null,
    nextAt: null,
    quietDeferred: false,
    lastRunAt: null,
    lastAttemptAt: null,
    lastStatus: "idle",
    lastError: null,
    lastResult: null,
  };
}

function safeError(error) {
  const text = String(error?.message ?? error ?? "未知错误");
  return text
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|apiKey)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function isQuietHour(hour, { start, end }) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function hourInTimezone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    if (!Number.isInteger(hour)) throw new Error("timezone hour unavailable");
    return hour;
  } catch {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .find((part) => part.type === "hour")?.value,
    );
    return Number.isInteger(hour) ? hour : date.getHours();
  }
}

export class Autonomy {
  constructor({
    root,
    getConfig,
    qzone,
    chat = defaultChat,
    weather = fetchNanjingWeather,
    fetchImpl = globalThis.fetch,
    logger = console,
    now = () => new Date(),
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
  } = {}) {
    if (typeof root !== "string" || !path.isAbsolute(root)) {
      throw new TypeError("Autonomy root must be an absolute path");
    }
    if (typeof getConfig !== "function") throw new TypeError("getConfig is required");
    if (!qzone || typeof qzone.publish !== "function") {
      throw new TypeError("qzone.publish is required");
    }
    if (typeof chat !== "function") throw new TypeError("chat is required");
    if (typeof weather !== "function") throw new TypeError("weather is required");
    this.root = root;
    this.getConfig = getConfig;
    this.qzone = qzone;
    this.chat = chat;
    this.weather = weather;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.statePath = path.join(root, STATE_FILE);
    this.state = emptyState();
    this.initialized = false;
    this.started = false;
    this.stopped = true;
    this.lastEnabled = false;
    this.timer = null;
    this.queue = Promise.resolve();
    this.inflight = null;
    this.catchUp = false;
  }

  async init() {
    if (this.initialized) return this;
    this.state = await this.#readState();
    this.initialized = true;
    const autonomy = autonomyConfig(await this.getConfig());
    this.lastEnabled = autonomy.enabled;
    if (autonomy.enabled) {
      const current = this.#now();
      const next = this.#parseDate(this.state.nextAt);
      if (!next) {
        this.state.nextAt = this.#nextDate(current, autonomy.intervalMinutes).toISOString();
        this.state.intervalMinutes = autonomy.intervalMinutes;
        this.state.quietDeferred = false;
        this.catchUp = false;
        this.state.lastStatus = "scheduled";
        await this.#writeState();
      } else {
        const overdue = next.getTime() <= current.getTime();
        const intervalChanged = this.state.intervalMinutes !== autonomy.intervalMinutes;
        if (overdue) {
          this.catchUp = this.state.quietDeferred !== true;
          this.state.intervalMinutes = autonomy.intervalMinutes;
          const status = this.catchUp ? "overdue" : "quiet_deferred";
          if (intervalChanged || this.state.lastStatus !== status) {
            this.state.lastStatus = status;
            await this.#writeState();
          }
        } else if (intervalChanged) {
          this.state.nextAt = this.#nextDate(current, autonomy.intervalMinutes).toISOString();
          this.state.intervalMinutes = autonomy.intervalMinutes;
          this.state.quietDeferred = false;
          this.catchUp = false;
          this.state.lastStatus = "scheduled";
          await this.#writeState();
        }
      }
    }
    return this;
  }

  async start() {
    if (this.started && !this.stopped) return this;
    await this.init();
    this.started = true;
    this.stopped = false;
    this.lastEnabled = autonomyConfig(await this.getConfig()).enabled === true;
    if (!this.timer) {
      this.timer = this.setIntervalImpl(() => {
        this.tick().catch((error) => {
          this.logger?.error?.("Autonomy tick failed", safeError(error));
        });
      }, MINUTE_MS);
      this.timer?.unref?.();
    }
    this.tick().catch((error) => {
      this.logger?.error?.("Autonomy startup self-check failed", safeError(error));
    });
    return this;
  }

  async reconcile() {
    await this.init();
    if (this.stopped) return this.status();
    return this.#serialize(async () => {
      const autonomy = autonomyConfig(await this.getConfig());
      this.lastEnabled = autonomy.enabled;
      const current = this.#now();
      if (!autonomy.enabled) {
        this.state.nextAt = null;
        this.state.quietDeferred = false;
        this.catchUp = false;
        this.state.intervalMinutes = autonomy.intervalMinutes;
        this.state.lastStatus = "disabled";
        await this.#writeState();
        return this.status();
      }
      const next = this.#parseDate(this.state.nextAt);
      if (!next) {
        this.state.nextAt = this.#nextDate(current, autonomy.intervalMinutes).toISOString();
        this.state.intervalMinutes = autonomy.intervalMinutes;
        this.state.quietDeferred = false;
        this.catchUp = false;
        this.state.lastStatus = "scheduled";
        await this.#writeState();
      } else {
        const overdue = next.getTime() <= current.getTime();
        const intervalChanged = this.state.intervalMinutes !== autonomy.intervalMinutes;
        if (overdue) {
          this.catchUp = this.state.quietDeferred !== true;
          this.state.intervalMinutes = autonomy.intervalMinutes;
          const status = this.catchUp ? "overdue" : "quiet_deferred";
          if (intervalChanged || this.state.lastStatus !== status) {
            this.state.lastStatus = status;
            await this.#writeState();
          }
        } else if (intervalChanged) {
          this.state.nextAt = this.#nextDate(current, autonomy.intervalMinutes).toISOString();
          this.state.intervalMinutes = autonomy.intervalMinutes;
          this.state.quietDeferred = false;
          this.catchUp = false;
          this.state.lastStatus = "scheduled";
          await this.#writeState();
        }
      }
      return this.status();
    });
  }

  async tick() {
    await this.init();
    if (this.stopped) return { skipped: true, reason: "stopped" };
    if (this.inflight) return this.inflight;
    this.inflight = this.#serialize(() => this.#tickNow());
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async stop() {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    this.state.lastStatus = "stopped";
    await this.queue.catch(() => {});
    return this.status();
  }

  status() {
    const next = this.#parseDate(this.state.nextAt);
    return {
      enabled: this.lastEnabled && !this.stopped,
      running: this.started && !this.stopped,
      nextAt: this.state.nextAt,
      due: Boolean(next && next.getTime() <= this.#now().getTime()),
      catchUp: this.catchUp,
      quietDeferred: this.state.quietDeferred === true,
      lastRunAt: this.state.lastRunAt,
      lastAttemptAt: this.state.lastAttemptAt,
      lastStatus: this.state.lastStatus,
      lastError: this.state.lastError,
      lastResult: this.state.lastResult,
    };
  }

  async #tickNow() {
    const config = await this.getConfig();
    const autonomy = autonomyConfig(config);
    this.lastEnabled = autonomy.enabled;
    const current = this.#now();
    const next = this.#parseDate(this.state.nextAt);
    if (!autonomy.enabled) return { skipped: true, reason: "disabled" };
    if (!next || current.getTime() < next.getTime()) {
      return { skipped: true, reason: "not_due" };
    }
    const isCatchUp = this.catchUp === true;
    if (
      !isCatchUp &&
      isQuietHour(hourInTimezone(current, autonomy.timezone), autonomy.quietHours)
    ) {
      this.state.quietDeferred = true;
      this.state.lastStatus = "quiet_hours";
      await this.#writeState();
      return { skipped: true, reason: "quiet_hours" };
    }
    const readiness = readinessReason(config, autonomy);
    if (readiness) return { skipped: true, reason: readiness };

    this.catchUp = false;
    this.state.quietDeferred = false;
    this.state.nextAt = this.#nextDate(current, autonomy.intervalMinutes).toISOString();
    this.state.intervalMinutes = autonomy.intervalMinutes;
    this.state.lastAttemptAt = current.toISOString();
    this.state.lastStatus = "generating";
    this.state.lastError = null;
    await this.#writeState();

    let weather = null;
    try {
      weather = await this.weather({ fetchImpl: this.fetchImpl, now: () => current });
    } catch (error) {
      try {
        this.logger?.debug?.("Autonomy weather failed", safeError(error));
      } catch {
        // Weather must never block publishing.
      }
    }
    const environment = buildEnvironmentContext({
      weather,
      now: current,
      timeZone: autonomy.timezone,
    });

    let generated;
    try {
      generated = await this.chat({
        config: config.ai,
        messages: [
          {
            role: "system",
            content: [
              config.ai.systemPrompt,
              `你的名字是${config.persona?.name ?? "Alice"}。`,
              environment,
              "环境信息只作背景，不要机械复述时间或逐项播报天气。按时间自然写：中午可以问大家吃饭没，下午问上课/上班，晚上提醒早睡，深夜关心休息；天气只作为氛围或关心，不要编造未提供的天气。",
              "你正在为本人准备一条 QQ 空间动态；只返回正文，不虚构现实经历。",
            ].join("\n\n"),
          },
          { role: "user", content: autonomy.prompt },
        ],
        timeoutMs: 45_000,
      });
    } catch (error) {
      return this.#recordFailure("generation_failed", error);
    }
    if (this.stopped) {
      this.state.lastStatus = "stopped";
      await this.#writeState();
      return { skipped: true, reason: "stopped_after_generation" };
    }

    const text = typeof generated?.content === "string" ? generated.content.trim() : "";
    if (!text || text.length > 5000) {
      return this.#recordFailure("invalid_generated_text", "生成内容为空或超过 5000 字");
    }
    const latestConfig = await this.getConfig();
    const latestAutonomy = autonomyConfig(latestConfig);
    this.lastEnabled = latestAutonomy.enabled;
    const latestReadiness = readinessReason(latestConfig, latestAutonomy);
    const latestNow = this.#now();
    const latestQuiet =
      !isCatchUp &&
      isQuietHour(
        hourInTimezone(latestNow, latestAutonomy.timezone),
        latestAutonomy.quietHours,
      );
    const latestBlocked = this.stopped || latestReadiness || latestQuiet;
    if (latestBlocked) {
      const reason = this.stopped
        ? "stopped_before_publish"
        : latestReadiness || "quiet_hours";
      this.state.lastRunAt = latestNow.toISOString();
      this.state.lastStatus = "cancelled";
      this.state.lastError = `生成完成时已不再满足发布条件：${reason}`;
      this.state.lastResult = { status: "cancelled", reason };
      await this.#writeState();
      return { skipped: true, reason };
    }

    let result;
    try {
      result = await this.qzone.publish(text, { images: [] });
    } catch (error) {
      return this.#recordFailure("publish_failed", error);
    }

    const allowed = new Set(["sent", "blocked", "failed", "unknown", "duplicate"]);
    const status = allowed.has(result?.status) ? result.status : "failed";
    this.state.lastRunAt = this.#now().toISOString();
    this.state.lastStatus = status;
    this.state.lastError = status === "sent" ? null : safeError(result?.message ?? status);
    this.state.lastResult = {
      status,
      reason: typeof result?.reason === "string" ? result.reason.slice(0, 200) : null,
      recordId: typeof result?.recordId === "string" ? result.recordId : null,
    };
    await this.#writeState();
    return { attempted: true, text, result };
  }

  async #recordFailure(code, error) {
    this.state.lastRunAt = this.#now().toISOString();
    this.state.lastStatus = code;
    this.state.lastError = safeError(error);
    this.state.lastResult = { status: code, reason: code };
    await this.#writeState();
    return { attempted: true, error: this.state.lastError, status: code };
  }

  async #readState() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!parsed || parsed.version !== 1) throw new Error("状态版本无效");
      return { ...emptyState(), ...parsed };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      return {
        ...emptyState(),
        lastStatus: "state_recovered",
        lastError: "自主发帖状态文件无效，已安全重新规划",
      };
    }
  }

  async #writeState() {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temporary = `${this.statePath}.${suffix}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporary, this.statePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #serialize(operation) {
    const current = this.queue.then(operation, operation);
    this.queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #now() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new TypeError("Autonomy now() returned invalid date");
    }
    return date;
  }

  #parseDate(value) {
    if (typeof value !== "string" || !value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  #nextDate(now, minutes) {
    return new Date(now.getTime() + Math.max(MIN_INTERVAL_MINUTES, minutes) * MINUTE_MS);
  }
}

function readinessReason(config, autonomy) {
  if (!autonomy.enabled) return "disabled";
  if (config?.qzone?.enabled !== true) return "qzone_disabled";
  if (config?.qzone?.autoPublish !== true) return "auto_publish_disabled";
  if (config?.demo === true) return "demo_mode";
  if (!config?.ai?.apiKey) return "ai_key_missing";
  if (config?.policy?.paused === true) return "paused";
  if (config?.policy?.autoActions === false) return "auto_actions_disabled";
  return null;
}
