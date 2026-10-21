import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { chat as defaultChat } from "./ai.js";
import { chatExitDefaults, followUpDefaults } from "./config.js";
import { extractJson } from "./memory.js";

const STATE_VERSION = 2;
const STATE_FILE = path.join("data", "chat-state.json");
const FOLLOW_UP_STATUSES = new Set([
  "scheduled",
  "needs_time",
  "resolving",
  "sending",
  "sent",
  "skipped",
  "disabled",
]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function emptyState() {
  return {
    version: STATE_VERSION,
    conversations: {},
  };
}

function normalizeTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("终止时间必须是合法的 ISO 时间");
  }
  return new Date(value).toISOString();
}

function optionalTime(value) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeTime(value);
}

function parseKeyParts(key) {
  if (typeof key !== "string" || !key) return null;
  let parsed;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 3 ||
    parsed[1] !== "private" ||
    typeof parsed[0] !== "string" ||
    !parsed[0] ||
    typeof parsed[2] !== "string" ||
    !parsed[2]
  ) {
    return null;
  }
  return {
    channel: parsed[0],
    scope: parsed[1],
    conversationId: parsed[2],
  };
}

function normalizeEntry(key, raw) {
  const parts = parseKeyParts(key);
  if (!parts || !isPlainObject(raw)) {
    throw new TypeError("聊天状态包含无效条目");
  }
  const terminatedAt = normalizeTime(raw.terminatedAt ?? raw.at);
  const followUpAt = optionalTime(raw.followUpAt);
  const followUpMinutes =
    Number.isInteger(raw.followUpMinutes) && raw.followUpMinutes >= 0
      ? raw.followUpMinutes
      : null;
  let followUpStatus = FOLLOW_UP_STATUSES.has(raw.followUpStatus)
    ? raw.followUpStatus
    : followUpAt
      ? "scheduled"
      : "disabled";
  if (followUpStatus === "sending") followUpStatus = "scheduled";
  if (followUpStatus === "resolving") followUpStatus = "needs_time";
  const channel = typeof raw.channel === "string" && raw.channel ? raw.channel : parts.channel;
  const conversationId =
    typeof raw.conversationId === "string" && raw.conversationId
      ? raw.conversationId
      : parts.conversationId;
  const userId =
    typeof raw.userId === "string" && raw.userId ? raw.userId : conversationId;
  const conversationKey =
    typeof raw.conversationKey === "string" && raw.conversationKey
      ? raw.conversationKey
      : JSON.stringify([channel, "private", conversationId, userId]);
  const followupReason =
    typeof raw.followupReason === "string"
      ? raw.followupReason.trim().slice(0, 200)
      : "";
  const followupShouldFollowUp =
    typeof raw.followupShouldFollowUp === "boolean"
      ? raw.followupShouldFollowUp
      : null;
  return {
    terminatedAt,
    conversationKey,
    channel,
    scope: "private",
    userId,
    conversationId,
    followUpAt,
    followUpMinutes,
    followUpStatus,
    followupReason,
    followupShouldFollowUp,
    followUpAttempts:
      Number.isInteger(raw.followUpAttempts) && raw.followUpAttempts >= 0
        ? raw.followUpAttempts
        : 0,
    lastAttemptAt: optionalTime(raw.lastAttemptAt),
    nextAttemptAt: optionalTime(raw.nextAttemptAt),
    sentAt: optionalTime(raw.sentAt),
    lastError:
      typeof raw.lastError === "string" ? raw.lastError.slice(0, 300) : null,
  };
}

function validateState(data) {
  if (!isPlainObject(data)) throw new TypeError("聊天状态必须是对象");
  if (data.version === 1 && isPlainObject(data.terminated)) {
    const conversations = {};
    for (const [key, value] of Object.entries(data.terminated)) {
      if (!isPlainObject(value)) throw new TypeError("聊天状态包含无效条目");
      conversations[key] = normalizeEntry(key, { at: value.at });
    }
    return { version: STATE_VERSION, conversations };
  }
  if (data.version === STATE_VERSION && isPlainObject(data.conversations)) {
    const conversations = {};
    for (const [key, value] of Object.entries(data.conversations)) {
      conversations[key] = normalizeEntry(key, value);
    }
    return { version: STATE_VERSION, conversations };
  }
  throw new TypeError("聊天状态版本不受支持");
}

async function atomicWriteJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temp = `${file}.${suffix}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function chatExitKey(event) {
  if (
    !event ||
    event.scope !== "private" ||
    typeof event.channel !== "string" ||
    !event.channel ||
    typeof event.conversationId !== "string" ||
    !event.conversationId
  ) {
    return null;
  }
  return JSON.stringify([event.channel, event.scope, event.conversationId]);
}

export class ChatExitState {
  constructor({ root, logger = console } = {}) {
    if (typeof root !== "string" || !root.trim()) {
      throw new TypeError("root 必须是非空路径");
    }
    this.root = path.resolve(root);
    this.file = path.join(this.root, STATE_FILE);
    this.logger = logger;
    this.data = emptyState();
    this._queue = Promise.resolve();
  }

  _locked(operation) {
    const result = this._queue.then(operation, operation);
    this._queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  _warn(message, error) {
    try {
      this.logger?.warn?.(message, String(error?.message ?? error).slice(0, 300));
    } catch {
      // Logging must not affect chat handling.
    }
  }

  async _backupRaw(raw) {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const file = path.join(
      this.root,
      "data",
      "backups",
      `chat-state-v1-${stamp}.json`,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  async _quarantine() {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const target = path.join(this.root, "data", `chat-state.corrupt-${stamp}.json`);
    await rename(this.file, target).catch(() => {});
    this._warn("聊天状态文件损坏，已保留并重新开始", target);
  }

  async _write() {
    await atomicWriteJson(this.file, this.data);
  }

  async init() {
    return this._locked(async () => {
      try {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw);
        const migrated = parsed?.version === 1;
        this.data = validateState(parsed);
        if (migrated) await this._backupRaw(raw);
        await this._write();
      } catch (error) {
        if (error?.code === "ENOENT") {
          this.data = emptyState();
          await this._write();
          return this;
        }
        if (error instanceof SyntaxError || error instanceof TypeError) {
          await this._quarantine();
          this.data = emptyState();
          await this._write();
          return this;
        }
        throw error;
      }
      return this;
    });
  }

  async get(event) {
    return this._locked(async () => {
      const key = chatExitKey(event);
      if (!key) return null;
      return this.data.conversations[key]?.terminatedAt ?? null;
    });
  }

  async getEntry(event) {
    return this._locked(async () => {
      const key = chatExitKey(event);
      if (!key) return null;
      return this.data.conversations[key]
        ? structuredClone(this.data.conversations[key])
        : null;
    });
  }

  async getEntryByKey(key) {
    return this._locked(async () => {
      if (typeof key !== "string" || !key) return null;
      return this.data.conversations[key]
        ? structuredClone(this.data.conversations[key])
        : null;
    });
  }

  async needsTimeFollowUps() {
    return this._locked(async () =>
      Object.entries(this.data.conversations)
        .filter(([, entry]) => entry.followUpStatus === "needs_time")
        .map(([key, entry]) => ({ key, ...structuredClone(entry) })),
    );
  }

  async markTerminated(event, options = {}) {
    return this._locked(async () => {
      const key = chatExitKey(event);
      if (!key) throw new TypeError("只能记录私聊终止时间");
      const settings = typeof options === "string" ? { at: options } : options;
      const at = normalizeTime(settings.at ?? new Date().toISOString());
      const followUpAt = optionalTime(settings.followUpAt);
      const followUpMinutes =
        Number.isInteger(settings.followUpMinutes) && settings.followUpMinutes >= 0
          ? settings.followUpMinutes
          : null;
      const requestedStatus = FOLLOW_UP_STATUSES.has(settings.followUpStatus)
        ? settings.followUpStatus
        : followUpAt
          ? "scheduled"
          : "disabled";
      const followUpStatus =
        requestedStatus === "needs_time" || requestedStatus === "resolving"
          ? "needs_time"
          : requestedStatus;
      const next = structuredClone(this.data);
      next.conversations[key] = {
        terminatedAt: at,
        conversationKey: JSON.stringify([
          event.channel,
          "private",
          event.conversationId,
          event.userId,
        ]),
        channel: event.channel,
        scope: "private",
        userId: String(event.userId),
        conversationId: String(event.conversationId),
        followUpAt: followUpStatus === "scheduled" ? followUpAt : null,
        followUpMinutes,
        followUpStatus,
        followupReason:
          typeof settings.followupReason === "string"
            ? settings.followupReason.trim().slice(0, 200)
            : "",
        followupShouldFollowUp:
          typeof settings.followupShouldFollowUp === "boolean"
            ? settings.followupShouldFollowUp
            : null,
        followUpAttempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        sentAt: null,
        lastError:
          typeof settings.lastError === "string"
            ? settings.lastError.slice(0, 300)
            : null,
      };
      this.data = next;
      await this._write();
      return structuredClone(this.data.conversations[key]);
    });
  }

  async claimTimeResolution(key, at = new Date().toISOString()) {
    return this._locked(async () => {
      const timestamp = normalizeTime(at);
      const entry = this.data.conversations[key];
      if (!entry || entry.followUpStatus !== "needs_time") return null;
      const next = structuredClone(this.data);
      next.conversations[key] = {
        ...entry,
        followUpStatus: "resolving",
        lastAttemptAt: timestamp,
      };
      this.data = next;
      await this._write();
      return structuredClone(this.data.conversations[key]);
    });
  }

  async setFollowUpTime(
    key,
    { minutes, at, reason = null, expectedTerminatedAt = null },
  ) {
    return this._locked(async () => {
      const entry = this.data.conversations[key];
      if (!entry) return null;
      if (
        expectedTerminatedAt &&
        entry.terminatedAt !== normalizeTime(expectedTerminatedAt)
      ) {
        return null;
      }
      if (!Number.isInteger(minutes) || minutes < 0) {
        throw new TypeError("回访分钟数必须是非负整数");
      }
      const followUpAt = normalizeTime(at);
      const next = structuredClone(this.data);
      next.conversations[key] = {
        ...entry,
        followUpAt,
        followUpMinutes: minutes,
        followUpStatus: "scheduled",
        followupReason:
          typeof reason === "string"
            ? reason.trim().slice(0, 200)
            : entry.followupReason || "",
        followupShouldFollowUp: true,
        nextAttemptAt: null,
        lastError: null,
      };
      this.data = next;
      await this._write();
      return structuredClone(this.data.conversations[key]);
    });
  }

  async markTimeInvalid(key, message, expectedTerminatedAt = null) {
    return this._locked(async () => {
      const entry = this.data.conversations[key];
      if (!entry) return null;
      if (
        expectedTerminatedAt &&
        entry.terminatedAt !== normalizeTime(expectedTerminatedAt)
      ) {
        return null;
      }
      const next = structuredClone(this.data);
      next.conversations[key] = {
        ...entry,
        followUpAt: null,
        followUpMinutes: null,
        followUpStatus: "needs_time",
        followupShouldFollowUp: null,
        nextAttemptAt: null,
        lastError: typeof message === "string" ? message.slice(0, 300) : null,
      };
      this.data = next;
      await this._write();
      return structuredClone(this.data.conversations[key]);
    });
  }

  async clear(event) {
    return this._locked(async () => {
      const key = chatExitKey(event);
      if (!key || !(key in this.data.conversations)) return false;
      const next = structuredClone(this.data);
      delete next.conversations[key];
      this.data = next;
      await this._write();
      return true;
    });
  }

  async dueFollowUps(now = new Date()) {
    return this._locked(async () => {
      const current = now instanceof Date ? now.getTime() : Date.parse(now);
      if (!Number.isFinite(current)) return [];
      const due = [];
      for (const [key, entry] of Object.entries(this.data.conversations)) {
        if (entry.followUpStatus !== "scheduled") continue;
        const dueAt = entry.nextAttemptAt ?? entry.followUpAt;
        const time = Date.parse(dueAt ?? "");
        if (Number.isFinite(time) && time <= current) {
          due.push({ key, ...structuredClone(entry) });
        }
      }
      due.sort((a, b) => {
        const aTime = Date.parse(a.nextAttemptAt ?? a.followUpAt ?? "");
        const bTime = Date.parse(b.nextAttemptAt ?? b.followUpAt ?? "");
        return aTime - bTime;
      });
      return due;
    });
  }

  async claimFollowUp(key, at = new Date().toISOString()) {
    return this._locked(async () => {
      const timestamp = normalizeTime(at);
      const entry = this.data.conversations[key];
      if (!entry || entry.followUpStatus !== "scheduled") return null;
      const dueAt = entry.nextAttemptAt ?? entry.followUpAt;
      const time = Date.parse(dueAt ?? "");
      if (!Number.isFinite(time) || time > Date.parse(timestamp)) return null;
      const next = structuredClone(this.data);
      next.conversations[key] = {
        ...entry,
        followUpStatus: "sending",
        followUpAttempts: entry.followUpAttempts + 1,
        lastAttemptAt: timestamp,
      };
      this.data = next;
      await this._write();
      return structuredClone(this.data.conversations[key]);
    });
  }

  async completeFollowUp(key, patch = {}, expectedTerminatedAt = null) {
    return this._locked(async () => {
      const entry = this.data.conversations[key];
      if (!entry) return null;
      if (
        expectedTerminatedAt &&
        entry.terminatedAt !== normalizeTime(expectedTerminatedAt)
      ) {
        return null;
      }
      const status = FOLLOW_UP_STATUSES.has(patch.status)
        ? patch.status
        : "scheduled";
      const next = structuredClone(this.data);
      const hasFollowUpReason = Object.hasOwn(patch, "followupReason");
      const hasShouldFollowUp = Object.hasOwn(patch, "followupShouldFollowUp");
      next.conversations[key] = {
        ...entry,
        followUpStatus: status,
        nextAttemptAt: optionalTime(patch.nextAttemptAt),
        sentAt: optionalTime(patch.sentAt),
        ...(hasFollowUpReason
          ? {
              followupReason:
                typeof patch.followupReason === "string"
                  ? patch.followupReason.trim().slice(0, 200)
                  : "",
            }
          : {}),
        ...(hasShouldFollowUp
          ? {
              followupShouldFollowUp:
                typeof patch.followupShouldFollowUp === "boolean"
                  ? patch.followupShouldFollowUp
                  : null,
            }
          : {}),
        lastError:
          typeof patch.lastError === "string" ? patch.lastError.slice(0, 300) : null,
      };
      this.data = next;
      await this._write();
      return structuredClone(this.data.conversations[key]);
    });
  }

  async rescheduleFollowUp(
    key,
    nextAttemptAt,
    lastError = null,
    expectedTerminatedAt = null,
  ) {
    return this.completeFollowUp(key, {
      status: "scheduled",
      nextAttemptAt,
      lastError,
    }, expectedTerminatedAt);
  }

  async markFollowUpSent(
    key,
    sentAt = new Date().toISOString(),
    expectedTerminatedAt = null,
  ) {
    return this.completeFollowUp(key, {
      status: "sent",
      sentAt,
      nextAttemptAt: null,
      lastError: null,
    }, expectedTerminatedAt);
  }

  async markFollowUpSkipped(
    key,
    lastError = null,
    expectedTerminatedAt = null,
  ) {
    return this.completeFollowUp(key, {
      status: "skipped",
      nextAttemptAt: null,
      lastError,
    }, expectedTerminatedAt);
  }

  async snapshot() {
    return this._locked(async () => structuredClone(this.data));
  }
}

export const CHAT_EXIT_SYSTEM_PROMPT = `你是 Alice 的私聊结束判断器。判断用户最后一条消息是否表示“这次先聊到这里、要离开、暂时不想继续”，并先判断之后是否真的有合适理由主动回访，再决定多久回访。

只根据聊天内容判断，不要因为消息短就判结束，也不要因为出现“好/嗯/哦”就判结束。必须结合最近上下文，确认用户没有继续话题、没有提问、也没有要求 Alice 做事。

判断为 true：
- 明确告别：拜拜、再见、晚安、先走了、我下了、回聊、下次聊、明天聊、改天聊、有空再聊、挂了、撤了、睡了、去睡了。
- 结束当前话题：先这样、就这样吧、先不聊了、不说了、到此为止、先到这、先停一下、以后再说、回头再说、改天再说、等下再说、晚点聊、晚点说、我待会再找你。
- 去忙或离开：我去吃饭了、我去洗澡了、我去忙了、我出门了、我要上课/上班/写作业了、我先去干活了、先不看了、先下了。
- 收尾确认：好吧、行吧、那行、行、ok、okay、嗯、嗯嗯、哦、哦哦、知道了、了解了、收到、可以、没问题、好嘞、好的、就这样、先这样吧。
- 明确不想继续：不想聊了、没意思、算了、随便你、你忙吧、别说了、不说了、让我静静、想一个人待会、烦、懒得说。
- 冷淡短回复：哦、嗯、行、随你、呵呵；只有结合上下文确实像收尾时才判 true。

判断为 false：
- 有后续问题或行动：好，那明天几点？、行，然后呢？、等下再说，具体几点？、ok，帮我查一下、好，发给我。
- 话题还在继续：好可爱、好累、好烦、我今天……、嗯我觉得……。
- 问候、撒娇、玩笑、普通表情包、图片：在吗、想你了、抱抱、哈哈、？。表情包本身不等于结束，只有明确表达晚安、告别、离开、去睡等结束含义时才判 true。
- 只是同意但仍要 Alice 做事：好，继续说、可以，你决定。
- 情绪宣泄但没有明确离开：烦死了、随便吧（可能只是生气）。
- 任何不确定、模棱两可、可能只是短暂停顿的情况，一律 false。

规则：
- 只有明确收尾或明显不想继续才返回 true。不要猜测用户“可能”要离开。
- 如果用户最后一条是没有文字的表情包，但表情摘要或标签明确表示晚安、再见、去睡、离开等结束含义，可以判 true；普通可爱、搞笑、打招呼表情仍然判 false。
- 如果判断结束，sticker_mood 要从当前可用表情标签中选一个最贴合收尾气氛的短标签；没有合适的就写“可爱”。不结束时填空字符串。
- 晚安/去睡了优先“困倦”，好吧/收到优先“可爱”或“呆萌”，不想聊了/算了优先“小情绪”。
- 先判断 should_follow_up。只有上下文里有未完成话题、明确的后续事件、用户状态变化，或确实自然的关心理由时才为 true；没有理由、对方明确不想联系、连续多次未回复时可以为 false。
- should_follow_up 为 true 时，followup_reason 写一句简短的自然语言依据，说明要接续什么话题或事件；不要复述敏感信息，不要写成“主动问候”这种机械理由。
- 如果判断结束且应该回访，还要估算多久后适合主动找对方，输出 followup_minutes（必须是 5-1440 的整数分钟）：
  晚安/去睡了约 360-600；去吃饭/洗澡/忙一会儿约 20-90；等下再说/晚点聊约 10-60；
  好吧/收到/知道了约 120-480；不想聊了/让我静静/烦约 480-1440；拜拜/下次聊约 360-1440。
- should_follow_up 为 false 时，followup_reason 写空字符串，followup_minutes 输出 null。
- should_follow_up 为 true 时必须给出合法整数分钟，不能输出 0、负数或超过 1440。

只输出合法 JSON，不要 Markdown，不要额外解释：
{"end_chat": true, "confidence": 0.0, "reason": "简短理由", "sticker_mood": "可爱", "should_follow_up": true, "followup_reason": "接续的具体话题或事件", "followup_minutes": 120}`;

const STICKER_EXIT_PATTERN =
  /晚安|睡了|去睡|睡觉|拜拜|再见|告辞|我走了|先走了|下线|溜了|回聊|下次聊|明天聊|good\s*night|\bbye\b|see\s*you/iu;

export function normalizeStickerInfo(sticker) {
  if (!isPlainObject(sticker)) return null;
  const summary =
    typeof sticker.summary === "string" ? sticker.summary.trim().slice(0, 200) : "";
  const tags = Array.isArray(sticker.tags)
    ? sticker.tags
        .filter((tag) => typeof tag === "string" && tag.trim())
        .map((tag) => tag.trim().slice(0, 30))
        .slice(0, 8)
    : [];
  const imageUrl =
    typeof sticker.imageUrl === "string" && /^https:\/\//iu.test(sticker.imageUrl)
      ? sticker.imageUrl
      : "";
  if (!summary && !tags.length && !imageUrl) return null;
  return { summary, tags, imageUrl };
}

export function stickerLooksLikeExit(sticker) {
  const info = normalizeStickerInfo(sticker);
  if (!info) return false;
  return STICKER_EXIT_PATTERN.test([info.summary, ...info.tags].join(" "));
}

function stickerLabel(sticker) {
  const info = normalizeStickerInfo(sticker);
  if (!info) return "";
  return [info.summary, ...info.tags].filter(Boolean).join(" ").slice(0, 200);
}

export function buildChatExitMessages({
  text,
  history = [],
  stickerTags = [],
  sticker = null,
}) {
  const recent = history
    .slice(-19)
    .map((message) => {
      const role = message.role === "user" ? "用户" : "Alice";
      return `${role}：${String(message.content ?? "").slice(0, 300)}`;
    })
    .join("\n");
  const tags = Array.isArray(stickerTags)
    ? stickerTags.filter((tag) => typeof tag === "string" && tag.trim())
    : [];
  const info = normalizeStickerInfo(sticker);
  const lastMessage = [`当前用户最后一条私聊消息：\n${String(text ?? "").slice(0, 1000) || "（无文字）"}`];
  if (info) {
    lastMessage.push(
      `最后一条附带表情包：\n摘要：${info.summary || "未知"}\n标签：${
        info.tags.length ? info.tags.join("、") : "无"
      }`,
    );
  }
  const content = [
    `当前可用表情标签：${tags.length ? tags.join("、") : "可爱、无语、开心"}`,
    `最近对话：\n${recent || "（无）"}`,
    ...lastMessage,
    "请判断是否结束聊天。只输出 JSON。",
  ].join("\n\n");
  return [
    { role: "system", content: CHAT_EXIT_SYSTEM_PROMPT },
    { role: "user", content },
  ];
}

export function parseChatExitDecision(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rawEnd = parsed.end_chat ?? parsed.endChat ?? parsed.leave;
  const endChat = rawEnd === true || rawEnd === "true";
  const numeric = Number(parsed.confidence);
  const confidence = Number.isFinite(numeric)
    ? Math.min(1, Math.max(0, numeric))
    : 0;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 200) : "";
  const rawMood = parsed.sticker_mood ?? parsed.stickerMood ?? parsed.mood;
  const stickerMood =
    typeof rawMood === "string" ? rawMood.trim().replace(/\s+/gu, " ").slice(0, 30) : "";
  const rawFollowUp =
    parsed.followup_minutes ?? parsed.followUpMinutes ?? parsed.followupMinutes;
  const followUpNumber = rawFollowUp === null ? null : Number(rawFollowUp);
  const followUpMinutes =
    followUpNumber !== null &&
    Number.isInteger(followUpNumber) &&
    followUpNumber >= 0
      ? followUpNumber
      : null;
  const rawShouldFollowUp =
    parsed.should_follow_up ?? parsed.shouldFollowUp ?? parsed.followup_should;
  const shouldFollowUp =
    typeof rawShouldFollowUp === "boolean" ? rawShouldFollowUp : null;
  const rawFollowUpReason =
    parsed.followup_reason ?? parsed.followUpReason ?? parsed.followupReason;
  const followupReason =
    typeof rawFollowUpReason === "string"
      ? rawFollowUpReason.trim().replace(/\s+/gu, " ").slice(0, 200)
      : "";
  return {
    endChat,
    confidence,
    reason,
    stickerMood,
    shouldFollowUp,
    followupReason,
    followUpMinutes,
  };
}

export class ChatExitManager {
  constructor({
    root,
    state,
    chat = defaultChat,
    logger = console,
    fetchImpl,
    now = () => new Date(),
    onNeedsTime = null,
  } = {}) {
    this.state = state ?? new ChatExitState({ root, logger });
    this.chat = chat;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onNeedsTime = onNeedsTime;
  }

  async init() {
    await this.state.init();
    return this;
  }

  async getTerminatedAt(event) {
    return this.state.get(event);
  }

  async getEntry(event) {
    return this.state.getEntry(event);
  }

  async clear(event) {
    try {
      return await this.state.clear(event);
    } catch (error) {
      this._warn("清除聊天终止状态失败", error);
      return false;
    }
  }

  _warn(message, error) {
    try {
      this.logger?.warn?.(message, String(error?.message ?? error).slice(0, 300));
    } catch {
      // Logging must not affect chat handling.
    }
  }

  async evaluate({ event, history = [], config, stickerTags = [], sticker = null, signal = null }) {
    const settings = { ...chatExitDefaults, ...(config?.chatExit ?? {}) };
    if (!settings.enabled) return { terminate: false, skipped: "disabled" };
    if (event?.scope !== "private" || !["onebot", "qq"].includes(event.channel)) {
      return { terminate: false, skipped: "scope" };
    }
    const text = String(event.text ?? "").trim();
    const info = normalizeStickerInfo(sticker);
    if (!text && !info) return { terminate: false, skipped: "empty" };
    if (config?.demo || !config?.ai?.apiKey) {
      return { terminate: false, skipped: "ai_unavailable" };
    }

    if (!text && info && stickerLooksLikeExit(info)) {
      return this.#commitTermination({
        event,
        history,
        config,
        decision: {
          endChat: true,
          confidence: 1,
          reason: "sticker_goodbye",
          stickerMood: info.tags[0] ?? "",
          followUpMinutes: null,
        },
        text: `[表情包] ${stickerLabel(info) || "表情包"}`,
      });
    }

    const request = {
      config: {
        ...config.ai,
        model: settings.judgeModel?.trim() || config.ai.model,
        temperature: 0,
      },
      messages: buildChatExitMessages({
        text,
        history,
        stickerTags,
        sticker: info,
      }),
      timeoutMs: settings.judgeTimeoutMs,
      maxTokens: 120,
      thinking: "disabled",
      fetchImpl: this.fetchImpl,
      signal,
    };
    const imageUrls = !text && info?.imageUrl ? [info.imageUrl] : [];
    let reply;
    try {
      reply = await this.chat({ ...request, imageUrls });
    } catch (error) {
      if (signal?.aborted || error?.code === "CANCELLED") throw error;
      if (imageUrls.length) {
        try {
          reply = await this.chat({ ...request, imageUrls: [] });
        } catch (retryError) {
          if (signal?.aborted || retryError?.code === "CANCELLED") throw retryError;
          this._warn("聊天结束判断失败，按继续聊天处理", retryError);
          return {
            terminate: false,
            error: String(retryError?.message ?? retryError).slice(0, 300),
          };
        }
      } else {
        this._warn("聊天结束判断失败，按继续聊天处理", error);
        return { terminate: false, error: String(error?.message ?? error).slice(0, 300) };
      }
    }

    if (signal?.aborted) throw new Error("chat exit judge cancelled");
    const decision = parseChatExitDecision(reply.content);
    if (!decision) {
      this._warn("聊天结束判断返回了无效 JSON", String(reply.content ?? "").slice(0, 200));
      return { terminate: false, invalid: true };
    }
    if (!decision.endChat || decision.confidence < settings.minConfidence) {
      return { terminate: false, ...decision };
    }

    return this.#commitTermination({
      event,
      history,
      config,
      decision,
      text: text || (info ? `[表情包] ${stickerLabel(info) || "表情包"}` : ""),
    });
  }

  async #commitTermination({ event, history, config, decision, text }) {
    const followUp = {
      ...followUpDefaults,
      ...(config.followUp ?? {}),
      quietHours: {
        ...followUpDefaults.quietHours,
        ...(config.followUp?.quietHours ?? {}),
      },
    };
    const at = this.now().toISOString();
    let followUpStatus = "disabled";
    let followUpMinutes = null;
    let followUpAt = null;
    let lastError = null;
    const declined = decision.shouldFollowUp === false;
    if (followUp.enabled && event.channel === "onebot") {
      const requested = decision.followUpMinutes;
      const valid =
        Number.isInteger(requested) &&
        requested >= followUp.minMinutes &&
        requested <= followUp.maxMinutes;
      if (declined) {
        followUpStatus = "skipped";
        lastError = "followup_declined";
      } else if (valid && decision.shouldFollowUp !== true) {
        // Missing should_follow_up is the legacy time-only contract.
        followUpStatus = "scheduled";
        followUpMinutes = requested;
        followUpAt = new Date(Date.parse(at) + requested * 60_000).toISOString();
      } else if (valid && decision.followupReason) {
        followUpStatus = "scheduled";
        followUpMinutes = requested;
        followUpAt = new Date(Date.parse(at) + requested * 60_000).toISOString();
      } else {
        followUpStatus = "needs_time";
        lastError = `invalid_followup_minutes: ${
          requested === null ? "missing" : requested
        }`;
      }
    }

    let entry = null;
    try {
      entry = await this.state.markTerminated(event, {
        at,
        followUpAt,
        followUpMinutes,
        followUpStatus,
        followupReason: decision.followupReason,
        followupShouldFollowUp: declined ? false : decision.shouldFollowUp,
        lastError,
      });
    } catch (error) {
      this._warn("记录聊天终止时间失败", error);
    }
    if (entry && followUpStatus === "needs_time") {
      try {
        this.onNeedsTime?.({
          event,
          history,
          text,
          config,
          key: chatExitKey(event),
        });
      } catch (error) {
        this._warn("触发回访时间解析失败", error);
      }
    }
    return {
      terminate: true,
      ...decision,
      terminatedAt: entry?.terminatedAt ?? at,
      followUpAt,
      followUpMinutes,
      followUpStatus,
      followupReason: decision.followupReason,
      shouldFollowUp: decision.shouldFollowUp,
      needsTime: Boolean(entry && followUpStatus === "needs_time"),
    };
  }
}
