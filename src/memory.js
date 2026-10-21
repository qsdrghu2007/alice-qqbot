import { chat as defaultChat } from "./ai.js";
import { memoryDefaults } from "./config.js";
import { MEMORY_TYPES } from "./store.js";

const REMEMBER_PATTERN =
  /(?:帮我|请|麻烦|给我)?\s*(?:记住|记一下|记下来|别忘了|备注(?:一下)?|存一下)/u;
const FORGET_PATTERN =
  /(?:别记住|不用记|不要记|别记了|不用记住|不要记住|忘掉|忘记|删除.{0,8}记忆|清除.{0,8}记忆)/u;
const EXPLICIT_PREFIX = /^[\s:：,，。.!！?？、-]+/u;

export const MEMORY_JUDGE_SYSTEM_PROMPT = `你是一个严格的长期记忆筛选器，为角色 Alice 判断用户消息是否包含值得长期记住的信息。

核心原则：长期记忆只保存稳定、持久、未来对话可以复用的信息。临时情绪、一次性抱怨、日常寒暄、重复内容一律不保存；但用户没有要求记忆，不代表本轮信息不值得保存。

闲聊中的隐含披露：
- 即使用户没有说“记住”、没有正式自我介绍，也要主动识别闲聊里无意透露且稳定、未来可复用的信息。
- 可保存：当前所在城市（仅城市级粗粒度）、本人拥有或长期使用的车辆、设备或其他个人资产、持续兴趣，以及已经明确完成并可能影响后续交流的事件。
- 可以结合最近对话补全省略的主语，但事实必须来自当前用户本人的明确陈述。Alice 的猜测或提问、用户只询问某地天气或某物情况、转述他人的内容、群成员资料，都不是用户本人事实。
- 区分“目前在 X”和“常住 X”，不得把短期到访或计划前往推断成居住地；只提到本人车辆/设备或“已上牌/已购买”时，不得补写车牌号、具体型号、住址等未明确信息。
- 否定和反事实不要记成用户已经具备、拥有或做过；计划、约定、待办或未完成事项若稳定且值得保存，content 必须保留“计划/待办/未完成”语义，不能改写成已发生、已拥有或已完成；他人的信息不要归给用户。

用户明确要求记忆（最高优先级）：
- 当消息包含“记住”、“记一下”、“记下来”、“帮我记住”、“别忘了”、“备注”、“存一下”等表达时，说明用户明确希望保存。
- 此时应当保存核心信息，重要度设为 9；除非同时出现“别记住”、“不用记”、“忘掉”等否定表达。
- content 要提炼用户要求记住的核心信息，使用第三人称简洁陈述。

值得保存的信息：
- 个人信息：姓名、年龄、生日、学校、工作、家庭构成等稳定信息。
- 稳定偏好：长期喜欢的食物、颜色、音乐、电影、游戏、品牌、兴趣等。
- 稳定事实：长期所在城市（粗粒度）、个人拥有或长期使用的车辆、设备、兴趣等会影响后续交流的信息。
- 重要事件：具体日期、计划、约定、纪念日、考试、出行安排等。
- 重大情感：持续的心理状态、重大人生事件带来的长期情绪、长期压力源。
- 重要事实：过敏、疾病、预算、设备型号等会影响后续交流的信息。

不值得保存的信息：
- 日常问候、寒暄、道别、纯粹的语气词或表情。
- 一次性请求、临时任务、无意义闲聊。
- 一次性的情绪抱怨、短暂身体不适、临时状态。
- 已经存在于“已保存的长期记忆”中的重复信息。
- 密码、令牌、验证码、银行卡、身份证号等凭证和敏感标识一律不保存；精确住址、联系方式、车牌号或设备序列号等可识别信息只在用户明确要求时保存。

群聊规则：
- 当前可能是群聊，记忆会被群内成员共享。
- 可以把稳定的群内信息、共同约定、成员公开提到的稳定偏好保存下来。
- 涉及具体成员时，用“群成员<QQ号>”指代，避免把不同成员的信息混在一起。
- 不要保存成员明确表示不要公开的隐私。
- 只可归因于当前说话人本人的明确陈述，其他成员资料不得混入当前用户事实。

重要性评分：
- 1-3：临时、琐碎、一次性，不应保存。
- 4-6：有一点参考价值，但通常不保存。
- 7-8：用户无意披露、稳定且未来可复用的个人信息或事实，例如粗粒度所在地、个人资产/设备、持续兴趣、明确完成的事件；这类信息通常应保存。
- 9-10：非常重要，核心个人信息、重大事件或用户明确要求。

输出要求：
- 同一消息包含多个相关且可确认的稳定事实时，可以合并成一条简洁 content；仍然只输出一个 JSON 对象，不要输出数组或多个对象。
- 只输出合法 JSON，不要 Markdown，不要额外解释。格式：
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
