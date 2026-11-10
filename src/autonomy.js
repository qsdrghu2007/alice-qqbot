// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { chat as defaultChat } from "./ai.js";
import {
  buildEnvironmentContext,
  fetchNanjingWeather,
} from "./weather.js";
import { buildPersonaPrompt } from "./persona.js";
import {
  isRecentPostVisibleToTarget,
  qzoneVisibilityLabel,
} from "./qzone.js";

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

function plannedQzoneTarget(config) {
  const qzone = config?.qzone ?? {};
  const configuredRight = qzone.ugc_right ?? qzone.ugcRight;
  const configuredTargets = qzone.target_uins ?? qzone.targetUins ?? [];
  return {
    ugc_right: configuredRight === undefined || configuredRight === null
      ? 4
      : Number(configuredRight),
    target_uins: Array.isArray(configuredTargets)
      ? configuredTargets.map(String)
      : configuredTargets,
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

function parsePostDecision(content) {
  const raw = String(content ?? "").trim();
  if (!raw) return null;
  const json = raw
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value.publish !== "boolean") return null;
  const reason =
    typeof value.reason === "string" ? value.reason.trim().slice(0, 200) : "";
  if (!value.publish) {
    return { publish: false, text: "", reason: reason || "ai_silence" };
  }
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return null;
  return { publish: true, text, reason };
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
    const plannedTarget = plannedQzoneTarget(config);
    let recentPosts = [];
    if (typeof this.qzone.recentPosts === "function") {
      try {
        recentPosts = await this.qzone.recentPosts({
          limit: 5,
          ugc_right: plannedTarget.ugc_right,
          target_uins: plannedTarget.target_uins,
        });
      } catch (error) {
        this.logger?.debug?.("Autonomy recent post lookup failed", safeError(error));
      }
    }
    const recentPostContext = Array.isArray(recentPosts)
      ? recentPosts
          .filter(
            (item) =>
              typeof item?.text === "string" &&
              item.text.trim() &&
              isRecentPostVisibleToTarget(item, plannedTarget),
          )
          .slice(0, 5)
          .map(
            (item) =>
              `- [${qzoneVisibilityLabel(item.ugc_right)}] ${item.text.trim().slice(0, 300)}`,
          )
          .join("\n")
      : "";

    let generated;
    try {
      generated = await this.chat({
        config: config.ai,
        messages: [
          {
            role: "system",
            content: [
              buildPersonaPrompt(config),
              environment,
              `本次计划发布范围：${qzoneVisibilityLabel(plannedTarget.ugc_right)}。历史动态素材已按该范围筛选，方括号只标明原说说的可见范围。`,
              recentPostContext
                ? `本人历史动态素材（只用于避免重复，不要照抄）：\n${recentPostContext}`
                : "",
              "你正在决定是否准备一条 QQ 空间动态。只能使用本次真实环境、用户明确配置的内容和上面列出的已筛选素材；不要读取或推测私聊、群聊或私人历史，也不要编造现实经历。没有自然话题时可以静默，不要为了固定问候或时段机械发帖。",
              '只返回一个 JSON 对象：发布时返回 {"publish":true,"text":"正文"}；本次不发布时返回 {"publish":false,"reason":"简短原因"}。不要返回 JSON 以外的内容。',
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          { role: "user", content: autonomy.prompt },
        ],
        timeoutMs: 45_000,
        maxTokens: 300,
        thinking: "disabled",
      });
    } catch (error) {
      return this.#recordFailure("generation_failed", error);
    }
    if (this.stopped) {
      this.state.lastStatus = "stopped";
      await this.#writeState();
      return { skipped: true, reason: "stopped_after_generation" };
    }

    const decision = parsePostDecision(generated?.content);
    if (!decision) {
      return this.#recordFailure("invalid_generated_text", "生成内容不是有效发布决策 JSON");
    }
    if (!decision.publish) {
      this.state.lastRunAt = this.#now().toISOString();
      this.state.lastStatus = "skipped";
      this.state.lastError = null;
      this.state.lastResult = {
        status: "skipped",
        reason: decision.reason,
      };
      await this.#writeState();
      return { skipped: true, reason: "ai_silence" };
    }
    const text = decision.text;
    if (text.length > 5000) {
      return this.#recordFailure("invalid_generated_text", "生成正文超过 5000 字");
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
      result = await this.qzone.publish(text, {
        images: [],
        autonomous: true,
        ugc_right: plannedTarget.ugc_right,
        target_uins: Array.isArray(plannedTarget.target_uins)
          ? [...plannedTarget.target_uins]
          : plannedTarget.target_uins,
      });
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
