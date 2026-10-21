import { chat as defaultChat } from "./ai.js";
import { followUpDefaults } from "./config.js";
import { conversationStateKey } from "./conversation-state.js";
import { extractJson } from "./memory.js";
import { STYLE_CONTRACT } from "./style.js";

const TICK_MS = 60_000;
const QUIET_JITTER_MINUTES = 15;
const MAX_FOLLOW_UP_ATTEMPTS = 3;
const MAX_TIME_RESOLUTION_ATTEMPTS = 3;

export const FOLLOW_UP_TIME_SYSTEM_PROMPT = `你是 Alice 的回访时间选择器。根据 user 消息里的最近对话、话题依据、当前时间和允许范围，判断 Alice 之后是否适合主动联系，以及何时联系。

先判断 should_follow_up：
- 有未完成话题、明确事件或自然关心由头时才为 true。
- 对方明确说不想联系、不要找、需要独处，或上下文已经收尾且没有合适由头时，必须为 false。
- 用户连续多次未回复时可以延长或取消，不能机械固定延长。

如果应该回访，followup_reason 写一句简短依据，说明接续哪个未完成话题或明确事件。不要写“主动问候”“关心一下”这种空泛理由，不要复述敏感信息。
如果 followup_minutes 是合法整数，可以沿用；非法值必须重新选择。
如果不应回访，followup_reason 为空字符串，followup_minutes 为 null。

只输出合法 JSON，不要 Markdown，不要解释：
{"should_follow_up": true, "followup_reason": "接续考试结果的话题", "followup_minutes": 60}`;

export const FOLLOW_UP_CHECK_SYSTEM_PROMPT = `你是 Alice 主动回访前的独立检查器。判断现在是否仍然值得发送一条主动私聊。

只在有清晰、未过期的未完成话题、明确事件或自然关心由头时返回 should_send_now=true。
如果事件已经过去、话题不再适合接续、对方明确不想联系、上下文已经自然结束，或现在发送像机械问候，返回 false。
如果结构化短期状态与最近对话冲突，以最近对话为准；已经完成或撤销的事项不能继续当作回访理由。
不要因为到了预定时间就默认发送。对不确定或过时的内容采取保守策略。
reason 只写一句简短依据，不复述敏感信息。

只输出合法 JSON，不要 Markdown，不要解释：
{"should_send_now": true, "reason": "对方说晚点会告知考试结果"}`;

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

function profileLabels(value, labels, limit = 4) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)]
    .filter((item) => Object.hasOwn(labels, item))
    .map((item) => labels[item])
    .slice(0, limit);
}

function unfinishedTexts(value, limit = 4) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : typeof item?.text === "string" &&
            item.status !== "done" &&
            item.status !== "cancelled"
          ? item.text
          : "",
    )
    .filter((item) => item.trim())
    .map((item) => item.trim().slice(0, 160))
    .slice(0, limit);
}

function memeTexts(value, limit = 4) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : typeof item?.text === "string"
          ? item.text
          : "",
    )
    .filter((item) => item.trim())
    .map((item) => item.trim().slice(0, 80))
    .slice(0, limit);
}

const PROFILE_PREFERENCE_LABELS = Object.freeze({
  short_replies: "喜欢短句",
  direct_tone: "偏好直接表达",
  gentle_tone: "偏好温和语气",
  no_nickname: "不喜欢昵称或称呼",
  no_teasing: "不喜欢被调侃玩梗",
  no_topic_push: "不希望被追问特定话题",
});

const PROFILE_BOUNDARY_LABELS = Object.freeze({
  nickname: "不要擅自使用昵称",
  joke: "不要拿玩笑或玩梗越界",
  topic: "不要追问他明确避开的话题",
  contact_frequency: "不要频繁催促或连续找",
});

const USER_EMOTION_LABELS = Object.freeze({
  neutral: "平静",
  happy: "开心",
  excited: "兴奋",
  sad: "难过",
  hurt: "受伤",
  anxious: "焦虑",
  angry: "生气",
  tired: "疲惫",
  confused: "困惑",
});

function visibleContextText(visibleState) {
  if (!visibleState || typeof visibleState !== "object") return "";
  const lines = [];
  const profile = visibleState.profile;
  if (typeof profile?.relationship?.label === "string" && profile.relationship.label.trim()) {
    lines.push(`关系阶段：${profile.relationship.label.trim().slice(0, 40)}`);
  }
  const preferences = profileLabels(profile?.preferences, PROFILE_PREFERENCE_LABELS);
  if (preferences.length) {
    lines.push(`稳定偏好：${preferences.join("、")}`);
  }
  const boundaries = profileLabels(profile?.boundaries, PROFILE_BOUNDARY_LABELS);
  if (boundaries.length) {
    lines.push(`已确认边界：${boundaries.join("、")}`);
  }

  const contexts = Array.isArray(visibleState.contexts)
    ? visibleState.contexts.slice(0, 3)
    : visibleState.conversation
      ? [visibleState.conversation]
      : [];
  contexts.forEach((context, index) => {
    if (!context || typeof context !== "object") return;
    const contextLines = [];
    if (typeof context.topic === "string" && context.topic.trim()) {
      contextLines.push(`话题：${context.topic.trim().slice(0, 180)}`);
    }
    const unfinishedItems = unfinishedTexts(context.unfinishedItems);
    if (unfinishedItems.length) {
      contextLines.push(`未完成：${unfinishedItems.join("；")}`);
    } else if (
      typeof context.unfinished === "string" &&
      context.unfinished.trim()
    ) {
      contextLines.push(`未完成：${context.unfinished.trim().slice(0, 160)}`);
    }
    if (typeof context.preference === "string" && context.preference.trim()) {
      contextLines.push(`交流偏好：${context.preference.trim().slice(0, 160)}`);
    }
    const rawUserEmotion =
      typeof context.userEmotion === "string"
        ? context.userEmotion
        : typeof context.userEmotion?.emotion === "string"
          ? context.userEmotion.emotion
          : "";
    const userEmotion = USER_EMOTION_LABELS[rawUserEmotion] ?? rawUserEmotion;
    if (userEmotion && rawUserEmotion !== "neutral") {
      const intensity =
        typeof context.userEmotion?.intensity === "number" &&
        Number.isFinite(context.userEmotion.intensity)
          ? `（约 ${Math.round(
              Math.max(0, Math.min(1, context.userEmotion.intensity)) * 100,
            )}%）`
          : "";
      contextLines.push(
        `用户当前情绪：${userEmotion.trim().slice(0, 40)}${intensity}`,
      );
    }
    const commonMemes = memeTexts(context.commonMemes);
    if (commonMemes.length) {
      contextLines.push(`已确认共同梗：${commonMemes.join("、")}`);
    }
    if (contextLines.length) {
      const scope = context.scope === "group" ? "同账号可见群内上下文" : "私聊上下文";
      lines.push(`${scope} ${index + 1}：\n${contextLines.join("\n")}`);
    }
  });

  if (!lines.length) return "";
  return `跨场景用户可见状态（仅用于自然接续，不要逐项复述）：\n${lines.join(
    "\n",
  )}`;
}

export function buildFollowUpTimeMessages({
  history = [],
  text,
  minMinutes,
  maxMinutes,
  feedback,
  idleCount = 0,
  followupReason = "",
  visibleState = null,
  now = null,
  timeZone = "Asia/Shanghai",
}) {
  const content = [
    `允许的回访范围：${minMinutes}–${maxMinutes} 分钟；followup_minutes 必须是该范围内的整数。`,
    now
      ? `当前时间：${formatLocalTime(now, timeZone)}`
      : "",
    `最近对话：\n${contextText(history, text)}`,
    visibleContextText(visibleState),
    followupReason ? `已有的回访理由：${followupReason}` : "",
    idleCount > 0
      ? `本次是用户连续第 ${idleCount} 次因超时未回复而结束。请根据上下文决定是否延长回访时间；可以适当延长，但不要机械固定。`
      : "",
    feedback ? `上次输出不合法：${feedback}\n请重新按规则选择一个合法整数。` : "",
    "请只输出 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: FOLLOW_UP_TIME_SYSTEM_PROMPT },
    { role: "user", content },
  ];
}

export function parseFollowUpDecision(text) {
  const parsed = extractJson(text);
  if (!parsed) {
    const legacy = String(text ?? "").trim();
    if (/^-?\d+$/u.test(legacy)) {
      return {
        shouldFollowUp: null,
        reason: "",
        minutes: Number(legacy),
      };
    }
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw =
    parsed?.followup_minutes ??
    parsed?.followUpMinutes ??
    parsed?.followupMinutes ??
    parsed?.minutes;
  const numeric = raw === null ? null : Number(raw);
  const minutes = numeric !== null && Number.isInteger(numeric) ? numeric : null;
  const rawShould =
    parsed.should_follow_up ?? parsed.shouldFollowUp ?? parsed.followup_should;
  const shouldFollowUp =
    typeof rawShould === "boolean" ? rawShould : null;
  const rawReason =
    parsed.followup_reason ?? parsed.followUpReason ?? parsed.followupReason;
  const reason =
    typeof rawReason === "string"
      ? rawReason.trim().replace(/\s+/gu, " ").slice(0, 200)
      : "";
  return { shouldFollowUp, reason, minutes };
}

export function parseFollowUpMinutes(text) {
  return parseFollowUpDecision(text)?.minutes ?? null;
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

export function buildFollowUpMessages({
  config,
  history = [],
  entry,
  now,
  timeZone,
  visibleState = null,
}) {
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
    "现在你要主动给对方发一条 QQ 私聊消息。必须接续 user 消息里给出的具体理由、未完成话题或明确事件；理由不足时不要改成空泛问候。可见状态只帮助你选择自然接续，不要逐项复述，也不要把群里的内容带入私聊之外的输出。不要解释为什么现在发，不要提“结束/离开/终止/回访”，不要道歉，不要连续追问。只输出消息正文，不要引号。",
  ].join("\n\n");
  const content = [
    `最近对话：\n${recent || "（无）"}`,
    visibleContextText(visibleState),
    `当前时间：${formatLocalTime(now, timeZone ?? "Asia/Shanghai")}`,
    entry?.followupReason
      ? `本次回访理由：${String(entry.followupReason).slice(0, 200)}`
      : "本次没有额外回访理由，请仅在最近对话确实留下自然由头时接续；不要机械问候。",
    "请只发一条很短、很自然、有上下文承接口的消息。",
  ].join("\n\n");
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content },
  ];
}

export function buildFollowUpCheckMessages({
  config,
  history = [],
  entry,
  now,
  timeZone = "Asia/Shanghai",
  visibleState = null,
}) {
  const terminatedAt = Date.parse(entry?.terminatedAt ?? "");
  const nowAt = Date.parse(now);
  const elapsedMinutes =
    Number.isFinite(terminatedAt) && Number.isFinite(nowAt)
      ? Math.max(0, Math.round((nowAt - terminatedAt) / 60_000))
      : null;
  const content = [
    `当前时间：${formatLocalTime(now, timeZone)}`,
    entry?.terminatedAt
      ? `该会话结束时间：${formatLocalTime(new Date(entry.terminatedAt), timeZone)}`
      : "",
    elapsedMinutes === null ? "" : `距结束已过：${elapsedMinutes} 分钟`,
    entry?.followUpAt
      ? `原计划回访时间：${formatLocalTime(new Date(entry.followUpAt), timeZone)}`
      : "",
    `本次是第 ${Number(entry?.followUpAttempts) || 1} 次发送前检查。`,
    `预定回访理由：${entry?.followupReason || "（未提供）"}`,
    visibleContextText(visibleState),
    `最近对话：\n${contextText(history)}`,
    "请判断此刻是否仍值得联系。只输出 JSON。",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: FOLLOW_UP_CHECK_SYSTEM_PROMPT },
    {
      role: "user",
      content: `${config?.persona?.name ? `人格：${config.persona.name}\n\n` : ""}${content}`,
    },
  ];
}

export function parseFollowUpCheckDecision(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rawShould =
    parsed.should_send_now ?? parsed.shouldSendNow ?? parsed.should_follow_up;
  if (typeof rawShould !== "boolean") return null;
  const reason =
    typeof parsed.reason === "string"
      ? parsed.reason.trim().replace(/\s+/gu, " ").slice(0, 200)
      : "";
  if (rawShould && !reason) return null;
  return { shouldSendNow: rawShould, reason };
}

export class FollowUpScheduler {
  constructor({
    getConfig,
    state,
    store,
    conversationState = null,
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
    if (
      conversationState !== null &&
      typeof conversationState?.visibleContext !== "function" &&
      typeof conversationState?.context !== "function"
    ) {
      throw new TypeError(
        "conversationState.visibleContext/context 必须提供函数或未提供",
      );
    }
    if (onTick !== null && typeof onTick !== "function") {
      throw new TypeError("onTick 必须是函数或 null");
    }
    this.getConfig = getConfig;
    this.state = state;
    this.store = store;
    this.conversationState = conversationState;
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
    let currentVisibleState;
    let feedback = null;
    let attempts = 0;

    while (true) {
      attempts += 1;
      let entry = await this.state.getEntryByKey(key);
      if (!entry) return { key, status: "cancelled", reason: "missing" };
      const expectedTerminatedAt = entry.terminatedAt;
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
          await this.state.markFollowUpSkipped(
            key,
            `history_failed: ${error?.message ?? error}`,
            expectedTerminatedAt,
          );
          return { key, status: "skipped", reason: "history_failed" };
        }
      }

      if (currentVisibleState === undefined) {
        currentVisibleState = await this._visibleContext(
          entry,
          currentConfig,
          this._now(),
        );
      }

      const requestNow = this._now();
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
            followupReason: entry.followupReason,
            visibleState: currentVisibleState,
            now: requestNow,
            timeZone: settings.timezone,
          }),
          timeoutMs: 10_000,
          maxTokens: 200,
          thinking: "disabled",
          fetchImpl: this.fetchImpl,
        });
      } catch (error) {
        await this.state.markFollowUpSkipped(
          key,
          `time_request_failed: ${String(error?.message ?? error).slice(0, 200)}`,
          expectedTerminatedAt,
        );
        return { key, status: "skipped", reason: "time_request_failed" };
      }

      const liveEntry = await this.state.getEntryByKey(key);
      if (
        !liveEntry ||
        liveEntry.terminatedAt !== entry.terminatedAt ||
        !["resolving", "needs_time"].includes(liveEntry.followUpStatus)
      ) {
        return { key, status: "cancelled", reason: "state_changed" };
      }
      const decision = parseFollowUpDecision(reply.content);
      if (decision?.shouldFollowUp === false) {
        await this.state.markFollowUpSkipped(
          key,
          "followup_declined",
          expectedTerminatedAt,
        );
        return { key, status: "skipped", reason: "followup_declined" };
      }
      const minutes = decision?.minutes;
      if (
        decision &&
        Number.isInteger(minutes) &&
        minutes >= settings.minMinutes &&
        minutes <= settings.maxMinutes &&
        (decision.shouldFollowUp !== true || decision.reason)
      ) {
        const dueAt = new Date(
          Date.parse(liveEntry.terminatedAt) + minutes * 60_000,
        ).toISOString();
        await this.state.setFollowUpTime(key, {
          minutes,
          at: dueAt,
          reason: decision.reason || liveEntry.followupReason,
          expectedTerminatedAt,
        });
        return { key, status: "scheduled", minutes };
      }

      if (attempts >= MAX_TIME_RESOLUTION_ATTEMPTS) {
        await this.state.markFollowUpSkipped(
          key,
          "invalid_time_decision_exhausted",
          expectedTerminatedAt,
        );
        return {
          key,
          status: "skipped",
          reason: "invalid_time_decision_exhausted",
        };
      }

      feedback = `should_follow_up=${String(decision?.shouldFollowUp)}，followup_minutes=${minutes ?? "null"}，有效范围 ${settings.minMinutes}–${settings.maxMinutes}；为 true 时还需给出简短 followup_reason`;
      await this.state.markTimeInvalid(
        key,
        `invalid_followup_minutes: ${feedback}`,
        expectedTerminatedAt,
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

  async _visibleContext(entry, config, now) {
    if (
      !this.conversationState ||
      config?.conversationState?.enabled === false
    ) {
      return null;
    }
    const event = {
      channel: entry.channel,
      scope: "private",
      conversationId: entry.conversationId,
      userId: entry.userId,
    };
    try {
      if (typeof this.conversationState.visibleContext === "function") {
        return await this.conversationState.visibleContext(
          event,
          config,
          now.getTime(),
        );
      }
      const context = await this.conversationState.context(
        conversationStateKey(event),
        config,
        now.getTime(),
      );
      return {
        profile: null,
        contexts: context?.conversation ? [context.conversation] : [],
      };
    } catch (error) {
      this._warn("读取回访可见会话状态失败，按历史上下文继续", error);
      return null;
    }
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
      await this.state.markFollowUpSkipped(
        entry.key,
        "unsupported_channel",
        entry.terminatedAt,
      );
      return { key: entry.key, status: "skipped", reason: "unsupported_channel" };
    }
    const allowedUsers = Array.isArray(config.policy?.allowedUsers)
      ? config.policy.allowedUsers
      : [];
    if (allowedUsers.length && !allowedUsers.includes(entry.userId)) {
      await this.state.markFollowUpSkipped(
        entry.key,
        "user_not_allowed",
        entry.terminatedAt,
      );
      return { key: entry.key, status: "skipped", reason: "user_not_allowed" };
    }

    const now = this._now();
    const current = localParts(now, settings.timezone);
    if (isQuietHour(current.hour, settings.quietHours)) {
      const next = nextQuietEnd(now, settings.quietHours, settings.timezone);
      next.setMinutes(next.getMinutes() + Math.floor(this.random() * QUIET_JITTER_MINUTES));
      await this.state.rescheduleFollowUp(
        entry.key,
        next.toISOString(),
        "quiet_hours",
        entry.terminatedAt,
      );
      return { key: entry.key, status: "deferred", reason: "quiet_hours" };
    }

    if (
      config.demo ||
      !config.ai?.apiKey ||
      config.policy?.paused ||
      config.policy?.autoActions === false
    ) {
      await this._retry(
        entry.key,
        now,
        settings,
        "not_ready",
        null,
        entry.terminatedAt,
      );
      return { key: entry.key, status: "deferred", reason: "not_ready" };
    }
    if (!this.isReady(entry)) {
      await this._retry(
        entry.key,
        now,
        settings,
        "onebot_not_ready",
        null,
        entry.terminatedAt,
      );
      return { key: entry.key, status: "deferred", reason: "onebot_not_ready" };
    }

    const claimed = await this.state.claimFollowUp(entry.key, now.toISOString());
    if (!claimed) {
      return { key: entry.key, status: "skipped", reason: "not_due" };
    }
    claimed.key = entry.key;

    let history;
    let visibleState;
    try {
      [history, visibleState] = await Promise.all([
        this.store.history(entry.conversationKey),
        this._visibleContext(entry, config, now),
      ]);
    } catch (error) {
      return this._retryOrSkip(
        claimed,
        now,
        settings,
        "history_failed",
        error,
      );
    }

    let checkReply;
    try {
      checkReply = await this.chat({
        config: {
          ...config.ai,
          model:
            config.chatExit?.judgeModel?.trim?.() || config.ai.model,
          temperature: 0,
        },
        messages: buildFollowUpCheckMessages({
          config,
          history,
          entry: claimed,
          now,
          timeZone: settings.timezone,
          visibleState,
        }),
        timeoutMs: 8_000,
        maxTokens: 80,
        thinking: "disabled",
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      return this._retryOrSkip(
        claimed,
        now,
        settings,
        "followup_check_failed",
        error,
      );
    }

    const check = parseFollowUpCheckDecision(checkReply?.content);
    if (!check) {
      return this._retryOrSkip(
        claimed,
        now,
        settings,
        "invalid_followup_check",
      );
    }
    if (!check.shouldSendNow) {
      await this.state.markFollowUpSkipped(
        entry.key,
        "not_worth_or_stale",
        claimed.terminatedAt,
      );
      return {
        key: entry.key,
        status: "skipped",
        reason: "not_worth_or_stale",
      };
    }

    let live = await this.state.getEntry({
      channel: entry.channel,
      scope: "private",
      conversationId: entry.conversationId,
      userId: entry.userId,
    });
    if (!live || live.followUpStatus !== "sending") {
      return { key: entry.key, status: "cancelled", reason: "state_changed" };
    }
    if (live.terminatedAt !== claimed.terminatedAt) {
      return { key: entry.key, status: "cancelled", reason: "state_changed" };
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
          entry: claimed,
          now,
          timeZone: settings.timezone,
          visibleState,
        }),
        timeoutMs: 30_000,
        maxTokens: 120,
        thinking: "disabled",
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      return this._retryOrSkip(
        claimed,
        now,
        settings,
        "generation_failed",
        error,
      );
    }

    const text = typeof generated?.content === "string" ? generated.content.trim() : "";
    if (!text || text.length > 500) {
      return this._retryOrSkip(
        claimed,
        now,
        settings,
        "invalid_follow_up_text",
      );
    }

    live = await this.state.getEntry({
      channel: entry.channel,
      scope: "private",
      conversationId: entry.conversationId,
      userId: entry.userId,
    });
    if (
      !live ||
      live.followUpStatus !== "sending" ||
      live.terminatedAt !== claimed.terminatedAt
    ) {
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
      return this._retryOrSkip(claimed, now, settings, "send_failed", error);
    }
    if (outcome?.status !== "sent") {
      return this._retryOrSkip(
        claimed,
        now,
        settings,
        outcome?.status ?? "send_failed",
      );
    }

    try {
      await this.store.append(entry.conversationKey, [
        { role: "assistant", content: text },
      ]);
    } catch (error) {
      this._warn("保存主动回访消息失败", error);
    }
    await this.state.markFollowUpSent(
      entry.key,
      now.toISOString(),
      claimed.terminatedAt,
    );
    return { key: entry.key, status: "sent", text };
  }

  async _retryOrSkip(entry, now, settings, reason, error = null) {
    if (entry.followUpAttempts >= MAX_FOLLOW_UP_ATTEMPTS) {
      await this.state.markFollowUpSkipped(
        entry.key,
        `${reason}_retry_exhausted`,
        entry.terminatedAt,
      );
      return {
        key: entry.key,
        status: "skipped",
        reason: `${reason}_retry_exhausted`,
      };
    }
    await this._retry(
      entry.key,
      now,
      settings,
      reason,
      error,
      entry.terminatedAt,
    );
    return { key: entry.key, status: "retry", reason };
  }

  async _retry(
    key,
    now,
    settings,
    reason,
    error,
    expectedTerminatedAt = null,
  ) {
    const next = new Date(
      now.getTime() + Math.max(1, settings.retryDelayMinutes) * 60_000,
    );
    await this.state.rescheduleFollowUp(
      key,
      next.toISOString(),
      error ? `${reason}: ${String(error?.message ?? error).slice(0, 200)}` : reason,
      expectedTerminatedAt,
    );
  }
}
