import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { chatExitDefaults, followUpDefaults } from "./config.js";
import { chatExitKey } from "./chat-exit.js";

const VERSION = 1;
const ACTIVITY_FILE = path.join("data", "chat-activity.json");

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function emptyState() {
  return { version: VERSION, conversations: {} };
}

function isoTime(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function conversationKeyFor(event) {
  return JSON.stringify([
    event.channel,
    "private",
    event.conversationId,
    String(event.userId),
  ]);
}

function parseKey(key) {
  if (typeof key !== "string" || !key) return null;
  try {
    const parsed = JSON.parse(key);
    if (
      !Array.isArray(parsed) ||
      parsed.length < 3 ||
      !["onebot", "qq"].includes(parsed[0]) ||
      parsed[1] !== "private" ||
      typeof parsed[2] !== "string" ||
      !parsed[2]
    ) {
      return null;
    }
    return { channel: parsed[0], scope: "private", conversationId: parsed[2] };
  } catch {
    return null;
  }
}

function normalizeEntry(key, raw) {
  const parts = parseKey(key);
  if (!parts || !isPlainObject(raw)) return null;
  const userId =
    typeof raw.userId === "string" && raw.userId
      ? raw.userId
      : parts.conversationId;
  const conversationKey =
    typeof raw.conversationKey === "string" && raw.conversationKey
      ? raw.conversationKey
      : JSON.stringify([
          parts.channel,
          "private",
          parts.conversationId,
          userId,
        ]);
  return {
    key,
    channel: parts.channel,
    scope: "private",
    userId,
    conversationId: parts.conversationId,
    conversationKey,
    lastUserAt: isoTime(raw.lastUserAt),
    lastBotAt: isoTime(raw.lastBotAt),
    idleDeadline: isoTime(raw.idleDeadline),
    idleCount:
      Number.isInteger(raw.idleCount) && raw.idleCount >= 0 ? raw.idleCount : 0,
    lastIdleTerminatedAt: isoTime(raw.lastIdleTerminatedAt),
    updatedAt: isoTime(raw.updatedAt),
  };
}

function validateState(data) {
  if (!isPlainObject(data) || data.version !== VERSION || !isPlainObject(data.conversations)) {
    throw new TypeError("聊天活动状态格式无效");
  }
  const conversations = {};
  for (const [key, value] of Object.entries(data.conversations)) {
    const entry = normalizeEntry(key, value);
    if (entry) conversations[key] = entry;
  }
  return { version: VERSION, conversations };
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

export class ChatActivityTracker {
  constructor({ root, logger = console, now = () => new Date() } = {}) {
    if (typeof root !== "string" || !path.isAbsolute(root)) {
      throw new TypeError("ChatActivityTracker root 必须是绝对路径");
    }
    this.root = root;
    this.file = path.join(root, ACTIVITY_FILE);
    this.logger = logger;
    this.now = now;
    this.data = emptyState();
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  _locked(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
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

  async _write() {
    await atomicWriteJson(this.file, this.data);
  }

  async init() {
    if (this.initialized) return this;
    return this._locked(async () => {
      try {
        const raw = await readFile(this.file, "utf8");
        this.data = validateState(JSON.parse(raw));
      } catch (error) {
        if (error?.code === "ENOENT") {
          this.data = emptyState();
          await this._write();
        } else if (error instanceof SyntaxError || error instanceof TypeError) {
          const stamp = new Date().toISOString().replaceAll(":", "-");
          await rename(
            this.file,
            path.join(this.root, "data", `chat-activity.corrupt-${stamp}.json`),
          ).catch(() => {});
          this._warn("聊天活动状态损坏，已重新开始");
          this.data = emptyState();
          await this._write();
        } else {
          throw error;
        }
      }
      this.initialized = true;
      return this;
    });
  }

  _key(event) {
    if (!event || !["onebot", "qq"].includes(event.channel)) return null;
    if (event.scope !== "private") return null;
    return chatExitKey(event);
  }

  _baseEntry(event, key) {
    return {
      key,
      channel: event.channel,
      scope: "private",
      userId: String(event.userId),
      conversationId: String(event.conversationId),
      conversationKey: conversationKeyFor(event),
      lastUserAt: null,
      lastBotAt: null,
      idleDeadline: null,
      idleCount: 0,
      lastIdleTerminatedAt: null,
      updatedAt: null,
    };
  }

  async noteUser(event, at = this.now()) {
    await this.init();
    const key = this._key(event);
    if (!key) return null;
    const stamp = isoTime(at);
    if (!stamp) return null;
    return this._locked(async () => {
      const entry = this.data.conversations[key] ?? this._baseEntry(event, key);
      const next = {
        ...entry,
        lastUserAt: stamp,
        idleDeadline: null,
        idleCount: 0,
        updatedAt: stamp,
      };
      this.data.conversations[key] = next;
      await this._write();
      return structuredClone(next);
    });
  }

  async noteBot(event, { at = this.now(), idleMinutes = 10, chatEnded = false } = {}) {
    await this.init();
    const key = this._key(event);
    if (!key) return null;
    if (chatEnded) return this.clear(event);
    const stamp = isoTime(at);
    const minutes = Number.isInteger(idleMinutes) && idleMinutes > 0 ? idleMinutes : 10;
    if (!stamp) return null;
    return this._locked(async () => {
      const entry = this.data.conversations[key] ?? this._baseEntry(event, key);
      const next = {
        ...entry,
        lastBotAt: stamp,
        idleDeadline: new Date(Date.parse(stamp) + minutes * 60_000).toISOString(),
        updatedAt: stamp,
      };
      this.data.conversations[key] = next;
      await this._write();
      return structuredClone(next);
    });
  }

  async clear(event) {
    await this.init();
    const key = this._key(event);
    if (!key) return false;
    return this._locked(async () => {
      if (!(key in this.data.conversations)) return false;
      const next = structuredClone(this.data);
      delete next.conversations[key];
      this.data = next;
      await this._write();
      return true;
    });
  }

  async due(now = this.now()) {
    await this.init();
    const current = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(current)) return [];
    return this._locked(async () => {
      const entries = [];
      for (const entry of Object.values(this.data.conversations)) {
        const deadline = Date.parse(entry.idleDeadline ?? "");
        if (Number.isFinite(deadline) && deadline <= current) {
          entries.push(structuredClone(entry));
        }
      }
      return entries.sort(
        (a, b) => Date.parse(a.idleDeadline) - Date.parse(b.idleDeadline),
      );
    });
  }

  async completeIdle(key, at = this.now()) {
    await this.init();
    if (typeof key !== "string" || !key) return null;
    const stamp = isoTime(at);
    if (!stamp) return null;
    return this._locked(async () => {
      const entry = this.data.conversations[key];
      if (!entry) return null;
      const next = {
        ...entry,
        idleDeadline: null,
        idleCount: entry.idleCount + 1,
        lastIdleTerminatedAt: stamp,
        updatedAt: stamp,
      };
      this.data.conversations[key] = next;
      await this._write();
      return structuredClone(next);
    });
  }

  async snapshot() {
    await this.init();
    return this._locked(async () => structuredClone(this.data));
  }
}

export class IdleExitScheduler {
  constructor({
    getConfig,
    store,
    chatExit,
    activity,
    onNeedsTime = null,
    logger = console,
    now = () => new Date(),
  } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (!store || typeof store.history !== "function") {
      throw new TypeError("store 必须提供 history");
    }
    if (!chatExit?.state) throw new TypeError("chatExit 必须提供 state");
    if (!activity || typeof activity.due !== "function") {
      throw new TypeError("activity 必须是 ChatActivityTracker");
    }
    if (onNeedsTime !== null && typeof onNeedsTime !== "function") {
      throw new TypeError("onNeedsTime 必须是函数或 null");
    }
    this.getConfig = getConfig;
    this.store = store;
    this.chatExit = chatExit;
    this.activity = activity;
    this.onNeedsTime = onNeedsTime;
    this.logger = logger;
    this.now = now;
    this.inflight = null;
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
    if (!Number.isFinite(date.getTime())) {
      throw new TypeError("now() 返回了无效时间");
    }
    return date;
  }

  async tick() {
    if (this.inflight) return this.inflight;
    this.inflight = this._tickNow();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async _tickNow() {
    const config = await this.getConfig();
    const settings = { ...chatExitDefaults, ...(config?.chatExit ?? {}) };
    if (!settings.enabled) return { processed: 0, skipped: "disabled" };
    if (!Number.isInteger(settings.idleMinutes) || settings.idleMinutes < 1) {
      return { processed: 0, skipped: "idle_disabled" };
    }
    if (config?.demo || config?.policy?.paused) {
      return { processed: 0, skipped: "not_ready" };
    }
    const followUp = {
      ...followUpDefaults,
      ...(config.followUp ?? {}),
      quietHours: {
        ...followUpDefaults.quietHours,
        ...(config.followUp?.quietHours ?? {}),
      },
    };
    if (followUp.enabled && !config?.ai?.apiKey) {
      return { processed: 0, skipped: "ai_unavailable" };
    }

    const due = await this.activity.due(this._now());
    const results = [];
    for (const entry of due) {
      const allowedUsers = Array.isArray(config.policy?.allowedUsers)
        ? config.policy.allowedUsers
        : [];
      if (allowedUsers.length && !allowedUsers.includes(entry.userId)) {
        await this.activity.clear(entry);
        continue;
      }

      const at = this._now().toISOString();
      const event = {
        id: `idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        channel: entry.channel,
        scope: "private",
        userId: entry.userId,
        conversationId: entry.conversationId,
        text: "",
        timestamp: at,
      };
      const existing = await this.chatExit.getEntry?.(event);
      if (
        existing &&
        ["scheduled", "needs_time", "resolving", "sending"].includes(
          existing.followUpStatus,
        )
      ) {
        await this.activity.clear(entry);
        continue;
      }
      const canFollowUp = followUp.enabled && entry.channel === "onebot";
      try {
        await this.chatExit.state.markTerminated(event, {
          at,
          followUpStatus: canFollowUp ? "needs_time" : "disabled",
          lastError: canFollowUp ? "idle_timeout" : null,
        });
      } catch (error) {
        this._warn("记录空闲终止失败", error);
        continue;
      }

      const updated = await this.activity.completeIdle(entry.key, at);
      const idleCount = updated?.idleCount ?? entry.idleCount + 1;
      if (canFollowUp && this.onNeedsTime) {
        let history = [];
        try {
          history = await this.store.history(entry.conversationKey);
        } catch (error) {
          this._warn("读取空闲终止历史失败", error);
        }
        try {
          await this.onNeedsTime({
            key: entry.key,
            event,
            history,
            text: "",
            config,
            idleCount,
            idleTerminatedAt: at,
          });
        } catch (error) {
          this._warn("触发空闲回访时间解析失败", error);
        }
      }
      results.push({
        key: entry.key,
        idleCount,
        status: canFollowUp ? "scheduled" : "disabled",
      });
    }
    return { processed: results.length, results };
  }
}
