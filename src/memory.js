import { chat as defaultChat } from "./ai.js";
import { memoryDefaults } from "./config.js";
import { MEMORY_TYPES } from "./store.js";

const REMEMBER_PATTERN =
  /(?:帮我|请|麻烦|给我)?\s*(?:记住|记一下|记下来|别忘了|备注(?:一下)?|存一下)/u;
const FORGET_PATTERN =
  /(?:别记住|不用记|不要记|别记了|不用记住|不要记住|忘掉|忘记|删除.{0,8}记忆|清除.{0,8}记忆)/u;
const EXPLICIT_PREFIX = /^[\s:：,，。.!！?？、-]+/u;

export const MEMORY_JUDGE_SYSTEM_PROMPT = `你是一个严格的长期记忆筛选器，为角色 Alice 判断用户消息是否包含值得长期记住的信息。

核心原则：长期记忆只保存稳定、持久、未来对话可以复用的信息。临时情绪、一次性抱怨、日常寒暄、重复内容一律不保存。

用户明确要求记忆（最高优先级）：
- 当消息包含“记住”、“记一下”、“记下来”、“帮我记住”、“别忘了”、“备注”、“存一下”等表达时，说明用户明确希望保存。
- 此时应当保存核心信息，重要度设为 9；除非同时出现“别记住”、“不用记”、“忘掉”等否定表达。
- content 要提炼用户要求记住的核心信息，使用第三人称简洁陈述。

值得保存的信息：
- 个人信息：姓名、年龄、生日、学校、工作、家庭构成等稳定信息。
- 稳定偏好：长期喜欢的食物、颜色、音乐、电影、游戏、品牌、兴趣等。
- 重要事件：具体日期、计划、约定、纪念日、考试、出行安排等。
- 重大情感：持续的心理状态、重大人生事件带来的长期情绪、长期压力源。
- 重要事实：过敏、疾病、预算、设备型号等会影响后续交流的信息。

不值得保存的信息：
- 日常问候、寒暄、道别、纯粹的语气词或表情。
- 一次性请求、临时任务、无意义闲聊。
- 一次性的情绪抱怨、短暂身体不适、临时状态。
- 已经存在于“已保存的长期记忆”中的重复信息。
- 密码、令牌、验证码、银行卡、身份证号等敏感凭证；地址和联系方式只在用户明确要求时保存。

群聊规则：
- 当前可能是群聊，记忆会被群内成员共享。
- 可以把稳定的群内信息、共同约定、成员公开提到的稳定偏好保存下来。
- 涉及具体成员时，用“群成员<QQ号>”指代，避免把不同成员的信息混在一起。
- 不要保存成员明确表示不要公开的隐私。

重要性评分：
- 1-3：临时、琐碎、一次性，不应保存。
- 4-6：有一点参考价值，但通常不保存。
- 7-8：重要，未来对话有持续参考价值。
- 9-10：非常重要，核心个人信息、重大事件或用户明确要求。

输出要求：只输出合法 JSON，不要 Markdown，不要额外解释。格式：
{
  "should_remember": true,
  "memory_type": "personal/preference/event/emotion/fact/none",
  "content": "第三人称简洁陈述",
  "importance": 1,
  "reason": "简短说明"
}`;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function balancedJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // Continue with extraction below.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Try the balanced object next.
    }
  }

  const candidate = balancedJson(trimmed);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function explicitMemoryDirective(text) {
  const value = String(text ?? "").trim();
  if (!value || FORGET_PATTERN.test(value)) {
    return { kind: "forget", content: "" };
  }
  const match = REMEMBER_PATTERN.exec(value);
  if (!match) return { kind: null, content: "" };
  const content = value
    .slice((match.index ?? 0) + match[0].length)
    .replace(EXPLICIT_PREFIX, "")
    .trim()
    .slice(0, 500);
  return { kind: "remember", content };
}

export function parseMemoryDecision(text) {
  const parsed = extractJson(text);
  if (!parsed) return null;
  const shouldRemember =
    parsed.should_remember === true ||
    parsed.shouldRemember === true ||
    parsed.should_memory === true;
  const rawType = parsed.memory_type ?? parsed.memoryType ?? parsed.type;
  const type = MEMORY_TYPES.includes(rawType) ? rawType : "fact";
  const numericImportance = Number(parsed.importance);
  const importance = Number.isFinite(numericImportance)
    ? Math.min(10, Math.max(1, Math.round(numericImportance)))
    : 5;
  const content = typeof parsed.content === "string" ? parsed.content.trim().slice(0, 500) : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 300) : "";
  return {
    shouldRemember,
    type,
    content,
    importance,
    reason,
  };
}

export function buildJudgeMessages({
  text,
  history = [],
  existing = [],
  scope = "private",
  groupId,
  userId,
}) {
  const recent = history
    .slice(-6)
    .map((message) => {
      const role = message.role === "user" ? "用户" : "Alice";
      return `${role}：${truncate(message.content, 300)}`;
    })
    .join("\n");
  const saved = existing
    .slice(0, 20)
    .map((memory, index) => `${index + 1}. [${memory.type}] ${truncate(memory.text, 200)}`)
    .join("\n");
  const context = [
    scope === "group"
      ? `当前场景：群聊（群号 ${groupId || "未知"}）`
      : "当前场景：私聊",
    `说话人 QQ：${userId || "未知"}`,
    `最近对话：\n${recent || "（无）"}`,
    `已保存的长期记忆（不要重复保存）：\n${saved || "（无）"}`,
    `当前用户消息：\n${text}`,
    "请判断是否要保存。只输出 JSON，不要其他内容。",
  ].join("\n\n");
  return [
    { role: "system", content: MEMORY_JUDGE_SYSTEM_PROMPT },
    { role: "user", content: context },
  ];
}

export class MemoryManager {
  constructor({ getConfig, store, chat = defaultChat, logger = console, fetchImpl } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (!store) throw new TypeError("store 不能为空");
    this.getConfig = getConfig;
    this.store = store;
    this.chat = chat;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this._queues = new Map();
    this._pending = new Set();
  }

  _enqueue(key, operation) {
    const previous = this._queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this._queues.set(key, settled);
    settled.finally(() => {
      if (this._queues.get(key) === settled) this._queues.delete(key);
    });
    return current;
  }

  afterTurn({ event, memoryKey, history = [], config }) {
    const operation = this._enqueue(memoryKey, () =>
      this._processTurn({ event, memoryKey, history, config }),
    ).catch((error) => {
      try {
        this.logger?.warn?.(
          "Long-term memory extraction failed",
          String(error?.message ?? error).slice(0, 300),
        );
      } catch {
        // Logging must not affect replies.
      }
      return null;
    });
    this._pending.add(operation);
    operation.finally(() => this._pending.delete(operation));
    return operation;
  }

  async _processTurn({ event, memoryKey, history, config }) {
    const memory = { ...memoryDefaults, ...(config.memory ?? {}) };
    if (!memory.enabled || !memory.autoExtract) return null;
    if (config.demo || !config.ai?.apiKey) return null;

    const text = String(event.text ?? "").trim();
    if (!text) return null;
    const explicit = explicitMemoryDirective(text);
    if (explicit.kind === "forget") return null;

    let decision;
    if (explicit.kind === "remember") {
      if (!explicit.content) return null;
      decision = {
        shouldRemember: true,
        type: "fact",
        content: explicit.content,
        importance: 9,
        reason: "用户明确要求记住",
      };
    } else {
      const plain = text.replace(/[\s\p{P}\p{S}]/gu, "");
      if (plain.length < 2) return null;
      const existing = await this.store.memories(memoryKey, { limit: 20 });
      const messages = buildJudgeMessages({
        text,
        history,
        existing,
        scope: event.scope,
        groupId: event.groupId,
        userId: event.userId,
      });
      const reply = await this.chat({
        config: {
          ...config.ai,
          model: memory.judgeModel?.trim() || config.ai.model,
          temperature: 0.1,
        },
        messages,
        timeoutMs: memory.judgeTimeoutMs,
        maxTokens: 300,
        thinking: "disabled",
        fetchImpl: this.fetchImpl,
      });
      decision = parseMemoryDecision(reply.content);
    }

    if (!decision?.shouldRemember || !decision.content) return null;
    if (explicit.kind !== "remember" && decision.importance < memory.minImportance) {
      return null;
    }

    const saved = await this.store.remember(memoryKey, decision.content, {
      type: decision.type,
      importance: decision.importance,
      source: "auto",
      maxMemories: memory.maxPerKey,
    });
    try {
      this.logger?.info?.(
        `Long-term memory saved [${decision.type}, ${decision.importance}]: ${truncate(
          decision.content,
          60,
        )}`,
      );
    } catch {
      // Logging must not affect replies.
    }
    return saved;
  }

  pendingCount() {
    return this._pending.size;
  }

  async flush({ timeoutMs = 5000 } = {}) {
    const pending = [...this._pending];
    if (!pending.length) return true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(100, timeoutMs));
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        timeout,
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
