import { chat as defaultChat } from "./ai.js";
import { followUpDefaults } from "./config.js";
import { extractJson } from "./memory.js";
import { STYLE_CONTRACT } from "./style.js";

const TICK_MS = 60_000;
const QUIET_JITTER_MINUTES = 15;

function settingsFor(config) {
  return {
    ...followUpDefaults,
    ...(config?.followUp ?? {}),
    quietHours: {
      ...followUpDefaults.quietHours,
      ...(config?.followUp?.quietHours ?? {}),
    },
  };
}

function contextText(history, text) {
  const lines = Array.isArray(history)
    ? history.map((message) => {
        const role = message.role === "user" ? "用户" : "Alice";
        return `${role}：${String(message.content ?? "").slice(0, 300)}`;
      })
    : [];
  if (typeof text === "string" && text.trim()) {
    lines.push(`用户：${text.trim().slice(0, 300)}`);
  }
  return lines.slice(-20).join("\n") || "（无）";
}

export function buildFollowUpTimeMessages({
  history = [],
  text,
  minMinutes,
  maxMinutes,
  feedback,
  idleCount = 0,
}) {
  const system = `你是 Alice 的回访时间选择器。根据最近 20 条对话判断 Alice 过多久适合主动给对方发消息。

有效范围：${minMinutes}–${maxMinutes} 分钟，必须是整数。
- 晚安/去睡了通常 360–600 分钟。
- 去吃饭/洗澡/忙一会儿通常 20–90 分钟。
- 等下再说/晚点聊通常 10–60 分钟。
- 好吧/收到/知道了通常 120–480 分钟。
- 不想聊了/让我静静/烦通常 480–1440 分钟。
- 拜拜/下次聊通常 360–1440 分钟。
- 如果是用户连续多次未回复，可以适当延长；具体延长多久由你判断，不要机械固定。

如果对话里已有合法时间，优先沿用，不要省略。如果明显是 0、负数或超出范围，重新选择。
只输出合法 JSON，不要 Markdown，不要解释：
{"followup_minutes": 60}`;
  const content = [
    `最近对话：\n${contextText(history, text)}`,
    idleCount > 0
      ? `本次是用户连续第 ${idleCount} 次因超时未回复而结束。请根据上下文决定是否延长回访时间；可以适当延长，但不要机械固定。`
      : "",
    feedback ? `上次输出不合法：${feedback}\n请重新按规则选择一个合法整数。` : "",
    "请只输出 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content },
  ];
}

export function parseFollowUpMinutes(text) {
  const parsed = extractJson(text);
  const raw =
    parsed?.followup_minutes ??
    parsed?.followUpMinutes ??
    parsed?.followupMinutes ??
    parsed?.minutes;
  const numeric = Number(raw ?? String(text ?? "").trim());
  return Number.isInteger(numeric) ? numeric : null;
}

function localParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isInteger(hour) && Number.isInteger(minute)) return { hour, minute };
  } catch {
    // Fall back to Asia/Shanghai below.
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    minute: Number(parts.find((part) => part.type === "minute")?.value),
  };
}

function isQuietHour(hour, { start, end }) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function nextQuietEnd(date, quietHours, timeZone) {
  const candidate = new Date(date);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let index = 0; index < 24 * 60; index += 1) {
    const parts = localParts(candidate, timeZone);
    if (parts.hour === quietHours.end && parts.minute === 0) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return new Date(date.getTime() + 60 * 60 * 1000);
}

function formatLocalTime(date, timeZone) {
  try {
    return date.toLocaleString("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return date.toISOString();
  }
}

export function buildFollowUpMessages({ config, history = [], entry, now, timeZone }) {
  const recent = history
    .slice(-8)
    .map((message) => {
      const role = message.role === "user" ? "用户" : "Alice";
      return `${role}：${String(message.content ?? "").slice(0, 300)}`;
    })
    .join("\n");
  const systemPrompt = [
    config.ai.systemPrompt,
    `你的名字是${config.persona?.name ?? "Alice"}。`,
    STYLE_CONTRACT,
    "现在你要主动给对方发一条 QQ 私聊消息。结合最近对话自然接上话题或关心对方，不要解释为什么现在发，不要提“结束/离开/终止/回访”，不要道歉，不要连续追问。只输出消息正文，不要引号。",
  ].join("\n\n");
  const content = [
    `最近对话：\n${recent || "（无）"}`,
    `当前时间：${formatLocalTime(now, timeZone ?? "Asia/Shanghai")}`,
    "请主动发一条很短、很自然的消息。",
  ].join("\n\n");
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];
}

export class FollowUpScheduler {
  constructor({
    getConfig,
    state,
    store,
    chat = defaultChat,
    deliver,
    isReady = () => true,
    logger = console,
    now = () => new Date(),
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    fetchImpl,
    random = Math.random,
    onTick = null,
  } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (!state) throw new TypeError("state 不能为空");
    if (!store || typeof store.history !== "function" || typeof store.append !== "function") {
      throw new TypeError("store 必须提供 history/append");
    }
    if (typeof chat !== "function") throw new TypeError("chat 必须是函数");
    if (typeof deliver !== "function") throw new TypeError("deliver 必须是函数");
    if (typeof isReady !== "function") throw new TypeError("isReady 必须是函数");
    if (onTick !== null && typeof onTick !== "function") {
      throw new TypeError("onTick 必须是函数或 null");
    }
    this.getConfig = getConfig;
    this.state = state;
    this.store = store;
    this.chat = chat;
    this.deliver = deliver;
    this.isReady = isReady;
    this.logger = logger;
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.onTick = onTick;
    this.timer = null;
    this.started = false;
    this.stopped = true;
    this.queue = Promise.resolve();
    this.inflight = null;
    this._timeTasks = new Map();
  }

  async init() {
    return this;
  }

  async start() {
    if (this.started && !this.stopped) return this;
    this.started = true;
    this.stopped = false;
    if (!this.timer) {
      this.timer = this.setIntervalImpl(() => {
        this.tick().catch((error) => this._warn("主动回访 tick 失败", error));
      }, TICK_MS);
      this.timer?.unref?.();
    }
    this.tick().catch((error) => this._warn("主动回访启动检查失败", error));
    this.resolvePendingTimes().catch((error) =>
      this._warn("回访时间恢复解析失败", error),
    );
    return this;
  }

  async stop() {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    await this.queue.catch(() => {});
    return { stopped: true };
  }

  async tick() {
    if (this.inflight) return this.inflight;
    this.inflight = this._serialize(() => this._tickNow());
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async notifyNeedsTime(context = {}) {
    return this.resolvePendingTimes(context);
  }

  async resolvePendingTimes(context = {}) {
    if (context?.key) {
      return this._startTimeResolution(context);
    }
    const pending = await this.state.needsTimeFollowUps();
    const tasks = pending.map((entry) =>
      this._startTimeResolution({ key: entry.key }),
    );
    return Promise.allSettled(tasks);
  }

  _startTimeResolution(context) {
    const key = context?.key;
    if (typeof key !== "string" || !key) return Promise.resolve(null);
    if (this._timeTasks.has(key)) return this._timeTasks.get(key);
    const task = this._resolveTimeLoop(context)
      .catch((error) => {
        this._warn("回访时间解析失败", error);
        return null;
      })
      .finally(() => {
        this._timeTasks.delete(key);
      });
    this._timeTasks.set(key, task);
    return task;
  }

  async _resolveTimeLoop({ key, history, text, config, idleCount = 0 }) {
    const currentConfig = config ?? (await this.getConfig());
    const settings = settingsFor(currentConfig);
    if (!settings.enabled) return { key, status: "disabled" };
    let currentHistory = history;
    let feedback = null;

    while (true) {
      let entry = await this.state.getEntryByKey(key);
      if (!entry) return { key, status: "cancelled", reason: "missing" };
      if (entry.followUpStatus === "needs_time") {
        const claimed = await this.state.claimTimeResolution(
          key,
          this._now().toISOString(),
        );
        if (!claimed) {
          entry = await this.state.getEntryByKey(key);
          if (!entry || entry.followUpStatus !== "resolving") {
            return { key, status: "cancelled", reason: "busy" };
          }
        }
      } else if (entry.followUpStatus !== "resolving") {
        return { key, status: "cancelled", reason: entry.followUpStatus };
      }

      if (!currentHistory) {
        try {
          currentHistory = await this.store.history(entry.conversationKey);
        } catch (error) {
          await this.state.markFollowUpSkipped(key, `history_failed: ${error?.message ?? error}`);
          return { key, status: "skipped", reason: "history_failed" };
        }
      }

      let reply;
      try {
        reply = await this.chat({
          config: {
            ...currentConfig.ai,
            temperature: 0,
          },
          messages: buildFollowUpTimeMessages({
            history: currentHistory,
            text,
            minMinutes: settings.minMinutes,
            maxMinutes: settings.maxMinutes,
            feedback,
            idleCount,
          }),
          timeoutMs: 10_000,
          maxTokens: 60,
          thinking: "disabled",
          fetchImpl: this.fetchImpl,
        });
      } catch (error) {
        await this.state.markFollowUpSkipped(
          key,
          `time_request_failed: ${String(error?.message ?? error).slice(0, 200)}`,
        );
        return { key, status: "skipped", reason: "time_request_failed" };
      }

      const minutes = parseFollowUpMinutes(reply.content);
      if (
        Number.isInteger(minutes) &&
        minutes >= settings.minMinutes &&
        minutes <= settings.maxMinutes
      ) {
        const dueAt = new Date(
          Date.parse(entry.terminatedAt) + minutes * 60_000,
        ).toISOString();
        await this.state.setFollowUpTime(key, { minutes, at: dueAt });
        return { key, status: "scheduled", minutes };
      }

      feedback = `followup_minutes=${minutes ?? String(reply.content ?? "").slice(0, 80)}，有效范围 ${settings.minMinutes}–${settings.maxMinutes}`;
      await this.state.markTimeInvalid(
        key,
        `invalid_followup_minutes: ${feedback}`,
      );
      // Continue immediately with the validation feedback.
    }
  }

  _serialize(operation) {
    const current = this.queue.then(operation, operation);
    this.queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  _warn(message, error) {
    try {
      this.logger?.warn?.(message, String(error?.message ?? error).slice(0, 300));
    } catch {
      // Logging must not affect scheduling.
    }
  }

  _now() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("now() 返回了无效日期");
    return date;
  }

  async _tickNow() {
    if (this.onTick) {
      try {
        Promise.resolve(this.onTick()).catch((error) => {
          this._warn("定时空间检查失败", error);
        });
      } catch (error) {
        this._warn("定时空间检查失败", error);
      }
    }
    const config = await this.getConfig();
    const settings = settingsFor(config);
    if (!settings.enabled) return { processed: 0, skipped: "disabled" };
    const entries = await this.state.dueFollowUps(this._now());
    const results = [];
    for (const entry of entries) {
      results.push(await this._process(entry, config, settings));
    }
    return { processed: results.length, results };
  }

  async _process(entry, config, settings) {
    if (entry.channel !== "onebot") {
      await this.state.markFollowUpSkipped(entry.key, "unsupported_channel");
      return { key: entry.key, status: "skipped", reason: "unsupported_channel" };
    }
    const allowedUsers = Array.isArray(config.policy?.allowedUsers)
      ? config.policy.allowedUsers
      : [];
    if (allowedUsers.length && !allowedUsers.includes(entry.userId)) {
      await this.state.markFollowUpSkipped(entry.key, "user_not_allowed");
      return { key: entry.key, status: "skipped", reason: "user_not_allowed" };
    }

    const now = this._now();
    const current = localParts(now, settings.timezone);
    if (isQuietHour(current.hour, settings.quietHours)) {
      const next = nextQuietEnd(now, settings.quietHours, settings.timezone);
      next.setMinutes(next.getMinutes() + Math.floor(this.random() * QUIET_JITTER_MINUTES));
      await this.state.rescheduleFollowUp(entry.key, next.toISOString(), "quiet_hours");
      return { key: entry.key, status: "deferred", reason: "quiet_hours" };
    }

    if (
      config.demo ||
      !config.ai?.apiKey ||
      config.policy?.paused ||
      config.policy?.autoActions === false
    ) {
      await this._retry(entry.key, now, settings, "not_ready");
      return { key: entry.key, status: "deferred", reason: "not_ready" };
    }
    if (!this.isReady(entry)) {
      await this._retry(entry.key, now, settings, "onebot_not_ready");
      return { key: entry.key, status: "deferred", reason: "onebot_not_ready" };
    }

    const claimed = await this.state.claimFollowUp(entry.key, now.toISOString());
    if (!claimed) {
      return { key: entry.key, status: "skipped", reason: "not_due" };
    }

    let history;
    try {
      history = await this.store.history(entry.conversationKey);
    } catch (error) {
      await this._retry(entry.key, now, settings, "history_failed", error);
      return { key: entry.key, status: "retry", reason: "history_failed" };
    }

    let generated;
    try {
      generated = await this.chat({
        config: {
          ...config.ai,
          temperature: config.ai.temperature ?? 0.8,
        },
        messages: buildFollowUpMessages({
          config,
          history,
          entry,
          now,
          timeZone: settings.timezone,
        }),
        timeoutMs: 30_000,
        maxTokens: 120,
        thinking: "disabled",
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      await this._retry(entry.key, now, settings, "generation_failed", error);
      return { key: entry.key, status: "retry", reason: "generation_failed" };
    }

    const text = typeof generated?.content === "string" ? generated.content.trim() : "";
    if (!text || text.length > 500) {
      await this._retry(entry.key, now, settings, "invalid_follow_up_text");
      return { key: entry.key, status: "retry", reason: "invalid_follow_up_text" };
    }

    const live = await this.state.getEntry({
      channel: entry.channel,
      scope: "private",
      conversationId: entry.conversationId,
      userId: entry.userId,
    });
    if (!live || live.followUpStatus !== "sending") {
      return { key: entry.key, status: "cancelled", reason: "state_changed" };
    }

    const event = {
      id: `followup-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      channel: "onebot",
      scope: "private",
      userId: entry.userId,
      conversationId: entry.conversationId,
      text: "",
      timestamp: now.toISOString(),
    };
    let outcome;
    try {
      outcome = await this.deliver(event, { text, faces: [], images: [] });
    } catch (error) {
      await this._retry(entry.key, now, settings, "send_failed", error);
      return { key: entry.key, status: "retry", reason: "send_failed" };
    }
    if (outcome?.status !== "sent") {
      await this._retry(entry.key, now, settings, outcome?.status ?? "send_failed");
      return {
        key: entry.key,
        status: "deferred",
        reason: outcome?.status ?? "send_failed",
      };
    }

    try {
      await this.store.append(entry.conversationKey, [
        { role: "assistant", content: text },
      ]);
    } catch (error) {
      this._warn("保存主动回访消息失败", error);
    }
    await this.state.markFollowUpSent(entry.key, now.toISOString());
    return { key: entry.key, status: "sent", text };
  }

  async _retry(key, now, settings, reason, error) {
    const next = new Date(
      now.getTime() + Math.max(1, settings.retryDelayMinutes) * 60_000,
    );
    await this.state.rescheduleFollowUp(
      key,
      next.toISOString(),
      error ? `${reason}: ${String(error?.message ?? error).slice(0, 200)}` : reason,
    );
  }
}
