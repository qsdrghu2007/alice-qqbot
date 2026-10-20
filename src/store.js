import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { rankMatches } from "./search.js";

const MAX_HISTORY = 80;
const DEFAULT_MAX_MEMORIES = 50;
const DATA_VERSION = 2;
const STORE_FILE = path.join("data", "store.json");
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const MEMORY_TYPES = Object.freeze([
  "personal",
  "preference",
  "event",
  "emotion",
  "fact",
]);
export const MEMORY_SOURCES = Object.freeze(["auto", "tool", "manual"]);

const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
const MEMORY_SOURCE_SET = new Set(MEMORY_SOURCES);

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function emptyData() {
  return {
    version: DATA_VERSION,
    conversations: {},
    memories: {},
  };
}

function normalizeKey(key) {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("会话 key 必须是非空字符串");
  }
  return key;
}

function validateMessage(message) {
  if (!isPlainObject(message)) throw new TypeError("消息必须是对象");
  if (!["system", "user", "assistant", "tool"].includes(message.role)) {
    throw new TypeError("消息 role 无效");
  }
  if (
    "content" in message &&
    typeof message.content !== "string" &&
    message.content !== null
  ) {
    throw new TypeError("消息 content 必须是字符串或 null");
  }
}

function isoTime(value, fallback) {
  if (value === undefined) return fallback;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("记忆时间必须是合法的 ISO 时间");
  }
  return new Date(value).toISOString();
}

function normalizeMemoryRecord(raw, now = new Date().toISOString()) {
  if (!isPlainObject(raw)) throw new TypeError("记忆条目必须是对象");
  if (typeof raw.id !== "string" || !raw.id) {
    throw new TypeError("记忆 id 必须是非空字符串");
  }
  if (typeof raw.text !== "string" || !raw.text.trim()) {
    throw new TypeError("记忆内容必须是非空字符串");
  }
  const type = raw.type ?? "fact";
  if (!MEMORY_TYPE_SET.has(type)) throw new TypeError("记忆类型无效");
  const importance = raw.importance ?? 5;
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw new TypeError("记忆重要度必须是 1..10 的整数");
  }
  const source = raw.source ?? "manual";
  if (!MEMORY_SOURCE_SET.has(source)) throw new TypeError("记忆来源无效");
  const createdAt = isoTime(raw.createdAt, now);
  const updatedAt = isoTime(raw.updatedAt, createdAt);
  const lastAccessedAt = isoTime(raw.lastAccessedAt, updatedAt);
  return {
    id: raw.id,
    text: raw.text.trim().slice(0, 2000),
    type,
    importance,
    source,
    createdAt,
    updatedAt,
    lastAccessedAt,
  };
}

function validateData(data) {
  if (!isPlainObject(data) || ![1, DATA_VERSION].includes(data.version)) {
    throw new TypeError("导入数据版本不受支持");
  }
  if (!isPlainObject(data.conversations) || !isPlainObject(data.memories)) {
    throw new TypeError("导入数据缺少 conversations 或 memories");
  }
  const conversations = {};
  for (const [key, messages] of Object.entries(data.conversations)) {
    normalizeKey(key);
    if (!Array.isArray(messages)) throw new TypeError(`会话 ${key} 的历史格式无效`);
    messages.forEach(validateMessage);
    conversations[key] = clone(messages);
  }
  const memories = {};
  const now = new Date().toISOString();
  for (const [key, list] of Object.entries(data.memories)) {
    normalizeKey(key);
    if (!Array.isArray(list)) throw new TypeError(`记忆 ${key} 的格式无效`);
    try {
      memories[key] = list.map((memory) => normalizeMemoryRecord(memory, now));
    } catch {
      throw new TypeError(`记忆 ${key} 包含无效条目`);
    }
  }
  return {
    version: DATA_VERSION,
    conversations,
    memories,
  };
}

function normalizeMemoryText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

function timeValue(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareMemories(a, b) {
  return (
    b.importance - a.importance ||
    timeValue(b.lastAccessedAt) - timeValue(a.lastAccessedAt) ||
    timeValue(b.createdAt) - timeValue(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function pruneList(list, maxMemories) {
  if (list.length <= maxMemories) return list;
  const remove = new Set(
    [...list]
      .sort(compareMemories)
      .reverse()
      .slice(0, list.length - maxMemories)
      .map((memory) => memory.id),
  );
  return list.filter((memory) => !remove.has(memory.id));
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

export class Store {
  constructor(root) {
    if (typeof root !== "string" || !root.trim()) {
      throw new TypeError("root 必须是非空路径");
    }
    this.root = path.resolve(root);
    this.file = path.join(this.root, STORE_FILE);
    this.backupDir = path.join(this.root, "data", "backups");
    this.data = emptyData();
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

  async init() {
    return this._locked(async () => {
      try {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw);
        const migrated = parsed?.version === 1;
        this.data = validateData(parsed);
        if (migrated) {
          await this._backupDataUnlocked(parsed, "store-v1");
          await atomicWriteJson(this.file, this.data);
        }
      } catch (error) {
        if (error?.code === "ENOENT") {
          this.data = emptyData();
          await atomicWriteJson(this.file, this.data);
          return this;
        }
        if (error instanceof SyntaxError) {
          throw new Error(`数据文件损坏，已停止载入：${this.file}`);
        }
        throw error;
      }
      return this;
    });
  }

  async history(key) {
    return this._locked(async () => clone(this.data.conversations[normalizeKey(key)] ?? []));
  }

  async append(key, messages) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      if (!Array.isArray(messages)) throw new TypeError("messages 必须是数组");
      messages.forEach(validateMessage);
      const next = clone(this.data);
      const current = next.conversations[normalized] ?? [];
      next.conversations[normalized] = [...current, ...clone(messages)].slice(
        -MAX_HISTORY,
      );
      await atomicWriteJson(this.file, next);
      this.data = next;
    });
  }

  async resetHistory(key) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      const next = clone(this.data);
      next.conversations[normalized] = [];
      await atomicWriteJson(this.file, next);
      this.data = next;
    });
  }

  async memories(key, { limit = null, touch = false, touchIntervalMs = TOUCH_INTERVAL_MS } = {}) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
        throw new TypeError("记忆 limit 必须是正整数");
      }
      let sorted = [...(this.data.memories[normalized] ?? [])].sort(compareMemories);
      if (limit !== null) sorted = sorted.slice(0, limit);
      if (!touch) return clone(sorted);

      const now = Date.now();
      const ids = new Set(sorted.map((memory) => memory.id));
      const next = clone(this.data);
      let changed = false;
      for (const memory of next.memories[normalized] ?? []) {
        if (!ids.has(memory.id)) continue;
        if (now - timeValue(memory.lastAccessedAt) < touchIntervalMs) continue;
        memory.lastAccessedAt = new Date(now).toISOString();
        changed = true;
      }
      if (changed) {
        await atomicWriteJson(this.file, next);
        this.data = next;
        const byId = new Map(
          (next.memories[normalized] ?? []).map((memory) => [memory.id, memory]),
        );
        sorted = sorted.map((memory) => byId.get(memory.id) ?? memory);
      }
      return clone(sorted);
    });
  }

  async searchMemories(key, query, { limit = 10 } = {}) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      const matches = rankMatches(this.data.memories[normalized] ?? [], query, {
        limit,
        textOf: (memory) => memory.text,
        compare: compareMemories,
      });
      return clone(matches);
    });
  }

  async searchHistory(key, query, { limit = 10 } = {}) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      const messages = (this.data.conversations[normalized] ?? []).filter(
        (message) =>
          ["user", "assistant"].includes(message.role) &&
          typeof message.content === "string" &&
          message.content.trim(),
      );
      const matches = rankMatches(messages, query, {
        limit,
        textOf: (message) => message.content,
      });
      return clone(matches);
    });
  }

  async memoryScopes() {
    return this._locked(async () => clone(Object.keys(this.data.memories)));
  }

  async remember(
    key,
    text,
    {
      type = "fact",
      importance = 5,
      source = "manual",
      maxMemories = DEFAULT_MAX_MEMORIES,
      now = new Date().toISOString(),
    } = {},
  ) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      if (typeof text !== "string" || !text.trim()) {
        throw new TypeError("记忆内容必须是非空字符串");
      }
      if (!MEMORY_TYPE_SET.has(type)) throw new TypeError("记忆类型无效");
      if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
        throw new TypeError("记忆重要度必须是 1..10 的整数");
      }
      if (!MEMORY_SOURCE_SET.has(source)) throw new TypeError("记忆来源无效");
      if (!Number.isInteger(maxMemories) || maxMemories < 1) {
        throw new TypeError("maxMemories 必须是正整数");
      }
      const timestamp = isoTime(now, new Date().toISOString());
      const content = text.trim().slice(0, 2000);
      const normalizedText = normalizeMemoryText(content);
      const next = clone(this.data);
      const current = next.memories[normalized] ?? [];
      const existingIndex = current.findIndex(
        (memory) => normalizeMemoryText(memory.text) === normalizedText,
      );

      if (existingIndex >= 0) {
        const existing = current[existingIndex];
        const updated = {
          ...existing,
          type: importance >= existing.importance ? type : existing.type,
          importance: Math.max(existing.importance, importance),
          source: source === "auto" ? existing.source : source,
          updatedAt: timestamp,
          lastAccessedAt: timestamp,
        };
        next.memories[normalized] = current.map((memory, index) =>
          index === existingIndex ? updated : memory,
        );
        await atomicWriteJson(this.file, next);
        this.data = next;
        return clone(updated);
      }

      const memory = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text: content,
        type,
        importance,
        source,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAccessedAt: timestamp,
      };
      next.memories[normalized] = pruneList([...current, memory], maxMemories);
      await atomicWriteJson(this.file, next);
      this.data = next;
      return clone(memory);
    });
  }

  async forget(key, id) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      if (typeof id !== "string" || !id) {
        throw new TypeError("记忆 id 必须是非空字符串");
      }
      const current = this.data.memories[normalized] ?? [];
      const next = current.filter((memory) => memory.id !== id);
      if (next.length === current.length) return false;
      const updated = clone(this.data);
      updated.memories[normalized] = next;
      await atomicWriteJson(this.file, updated);
      this.data = updated;
      return true;
    });
  }

  async clearMemories(key) {
    return this._locked(async () => {
      const normalized = normalizeKey(key);
      const current = this.data.memories[normalized] ?? [];
      if (!current.length) return 0;
      const next = clone(this.data);
      next.memories[normalized] = [];
      await atomicWriteJson(this.file, next);
      this.data = next;
      return current.length;
    });
  }

  async exportData() {
    return this._locked(async () => clone(this.data));
  }

  async _backupDataUnlocked(data, prefix = "store") {
    await mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const file = path.join(
      this.backupDir,
      `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return file;
  }

  async _backupUnlocked() {
    return this._backupDataUnlocked(this.data);
  }

  async importData(data) {
    const valid = validateData(data);
    return this._locked(async () => {
      const backupPath = await this._backupUnlocked();
      const previous = clone(this.data);
      try {
        await atomicWriteJson(this.file, valid);
        this.data = clone(valid);
      } catch (error) {
        this.data = previous;
        throw error;
      }
      return { backupPath };
    });
  }

  async backup() {
    return this._locked(() => this._backupUnlocked());
  }
}
