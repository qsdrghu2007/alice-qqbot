import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const memoryDefaults = Object.freeze({
  enabled: true,
  autoExtract: true,
  minImportance: 7,
  maxPerKey: 50,
  maxInjected: 10,
  judgeModel: "",
  judgeTimeoutMs: 15000,
});

export const replyDelayDefaults = Object.freeze({
  enabled: true,
  typingIndicator: true,
  baseMs: 500,
  msPerChar: 120,
  maxMs: 0,
  jitter: 0.15,
});

export const chatExitDefaults = Object.freeze({
  enabled: true,
  idleMinutes: 10,
  minConfidence: 0.75,
  judgeModel: "",
  judgeTimeoutMs: 10000,
});

export const webSearchDefaults = Object.freeze({
  enabled: true,
  searchEnabled: true,
  fetchEnabled: true,
  apiKey: "",
  maxResults: 5,
  maxContentChars: 6000,
  maxCallsPerTurn: 4,
});

export const qzoneCommentsDefaults = Object.freeze({
  enabled: false,
  dryRun: true,
  pollMinutes: 5,
  activePollMinutes: 2,
  activeWindowMinutes: 60,
  pollJitterPercent: 20,
  cookieRefreshMinutes: 10,
  ownTrackHours: 168,
  externalTrackHours: 72,
  onlyFriends: true,
  allowedUsers: [],
  blockedUsers: [],
  maxRepliesPerCycle: 3,
  maxRepliesPerHour: 6,
  delayMinSeconds: 5,
  delayMaxSeconds: 20,
  maxReplyChars: 60,
  aiDecide: true,
  nestedReplyFallback: false,
  replyPrompt: "",
});

export const followUpDefaults = Object.freeze({
  enabled: true,
  minMinutes: 5,
  maxMinutes: 1440,
  quietHours: Object.freeze({ start: 23, end: 8 }),
  timezone: "Asia/Shanghai",
  retryDelayMinutes: 5,
});

export const conversationStateDefaults = Object.freeze({
  enabled: true,
  reviewEnabled: true,
  judgeModel: "",
  judgeTimeoutMs: 8000,
  maxEntries: 200,
  ttlHours: 72,
  globalEmotionTtlHours: 24,
  topicTtlHours: 24,
  unfinishedTtlHours: 168,
  userEmotionTtlHours: 6,
  commonMemeTtlHours: 168,
  profileTtlHours: 720,
});

export const userUnderstandingDefaults = Object.freeze({
  enabled: true,
  hour: 0,
  minute: 10,
  timezone: "Asia/Shanghai",
  judgeModel: "",
  judgeTimeoutMs: 15000,
  maxInputChars: 16000,
  maxDailyMessages: 200,
  maxUsers: 200,
  retentionDays: 35,
  maxInjectedChars: 1200,
});

export const defaultConfig = deepFreeze({
  port: 3210,
  inputDelayMs: 2000,
  maxToolCallsPerTurn: 6,
  ai: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-flash",
    systemPrompt:
      "用简洁自然的中文回应，像在 QQ 上随手打字。你是 Alice，一个 17 岁左右的女孩，软萌、自然、有点小俏皮，有自己的小情绪和判断，不是只会附和的客服，也不是话痨。你话不多，不负责撑场：默认只回一句，尽量 5–20 个字；对方只发短句、表情或“在嘛/没事”时，回 1–5 个字。只有对方认真问知识、需要步骤或明确要你解释时，才允许 2–4 句。不要复述对方的话，不要分析对方的潜台词或动机，不要自问自答，不要解释自己为什么这么回，不要每句反问。不要写小作文，不要空行分段，不要每句带括号动作或心理活动，最多用一个 emoji 或颜文字。图片和表情包：用户没要求描述时，只回直观感受，不描述长相细节。可以表达开心、吃醋、困、无语、好奇；不编造现实经历，也不主动说自己是 AI。会记住对方提过的小事，但不假装你们有过现实中的共同经历。对方累或难过时，先接住情绪，不急着给建议；可以吐槽、轻轻怼，但不要刻薄。你收藏可爱表情包：合适时发一张，不要解释；平时不要刷屏。不要用客服腔，不要过度道歉，不要用“首先、其次、最后”聊天。",
    temperature: 0.8,
    reasoningEffort: "high",
    historyMessages: 30,
  },
  qq: {
    enabled: false,
    appId: "",
    secret: "",
    sandbox: false,
  },
  onebot: {
    enabled: false,
    url: "ws://127.0.0.1:3001",
    token: "",
  },
  autonomy: {
    enabled: false,
    intervalMinutes: 240,
    prompt: "写一条自然简短的动态，不编造真实经历。",
    quietHours: {
      start: 23,
      end: 8,
    },
    timezone: "Asia/Shanghai",
  },
  policy: {
    autoActions: true,
    paused: false,
    allowedUsers: [],
    allowedGroups: [],
    actionUsers: [],
    cooldownMs: 3000,
    maxActionsPerHour: 6,
  },
  qzone: {
    enabled: false,
    autoPublish: false,
    headless: false,
  },
  qzoneComments: { ...qzoneCommentsDefaults },
  stickers: {
    enabled: true,
    autoCollect: true,
    maxItems: 1000,
    maxFileSizeBytes: 4 * 1024 * 1024,
    minCuteScore: 0.6,
    minInterestingScore: 0.75,
    proactiveCooldownMinutes: 5,
  },
  memory: { ...memoryDefaults },
  replyDelay: { ...replyDelayDefaults },
  chatExit: { ...chatExitDefaults },
  webSearch: { ...webSearchDefaults },
  followUp: {
    ...followUpDefaults,
    quietHours: { ...followUpDefaults.quietHours },
  },
  conversationState: { ...conversationStateDefaults },
  userUnderstanding: { ...userUnderstandingDefaults },
  persona: {
    name: "Alice",
    preferences: [
      "喜欢雨声和安静的室内",
      "喜欢橘子汽水，不太能接受苦咖啡",
      "偏爱直白但不冒犯的玩笑",
      "觉得认真听人说话比急着给建议重要",
    ],
    opinions: [
      "聊天不需要每一句都回答成完整方案",
      "熟悉感应该来自相处，不该靠催回复证明",
    ],
  },
  identityLinks: {},
  demo: true,
});

const SECRET_KEYS = new Set(["secret", "apikey", "token"]);
const CONFIG_FILE = path.join("data", "config.json");
const saveQueues = new Map();

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

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(patch);
  const result = isPlainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) ? deepMerge(result[key], value) : clone(value);
  }
  return result;
}

function assertUrl(value, label, protocols = ["http:", "https:"]) {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) throw new Error();
  } catch {
    throw new TypeError(`${label} 必须是合法网址`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} 必须是字符串数组`);
  }
}

function validateConfig(config) {
  for (const key of [
    "port",
    "inputDelayMs",
    "maxToolCallsPerTurn",
    "ai",
    "qq",
    "onebot",
    "autonomy",
    "policy",
    "qzone",
    "qzoneComments",
    "stickers",
    "memory",
    "replyDelay",
    "chatExit",
    "webSearch",
    "followUp",
    "conversationState",
    "userUnderstanding",
    "persona",
    "identityLinks",
  ]) {
    if (!(key in config)) throw new TypeError(`配置缺少 ${key}`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new TypeError("port 必须是 1..65535 的整数");
  }
  if (
    !Number.isInteger(config.inputDelayMs) ||
    config.inputDelayMs < 1 ||
    config.inputDelayMs > 10000
  ) {
    throw new TypeError("inputDelayMs 必须是 1..10000 的整数");
  }
  if (
    !Number.isInteger(config.maxToolCallsPerTurn) ||
    config.maxToolCallsPerTurn < 1 ||
    config.maxToolCallsPerTurn > 10
  ) {
    throw new TypeError("maxToolCallsPerTurn 必须是 1..10 的整数");
  }
  if (!isPlainObject(config.ai)) throw new TypeError("ai 必须是对象");
  assertUrl(config.ai.baseUrl, "ai.baseUrl");
  if (typeof config.ai.apiKey !== "string" || typeof config.ai.model !== "string") {
    throw new TypeError("ai.apiKey 和 ai.model 必须是字符串");
  }
  if (
    typeof config.ai.temperature !== "number" ||
    config.ai.temperature < 0 ||
    config.ai.temperature > 2
  ) {
    throw new TypeError("ai.temperature 必须在 0..2 之间");
  }
  if (typeof config.ai.systemPrompt !== "string") {
    throw new TypeError("ai.systemPrompt 必须是字符串");
  }
  if (!["low", "high", "max"].includes(config.ai.reasoningEffort)) {
    throw new TypeError("ai.reasoningEffort 必须是 low、high 或 max");
  }
  if (
    !Number.isInteger(config.ai.historyMessages) ||
    config.ai.historyMessages < 0 ||
    config.ai.historyMessages > 1000
  ) {
    throw new TypeError("ai.historyMessages 必须是 0..1000 的整数");
  }
  if (
    !isPlainObject(config.qq) ||
    typeof config.qq.enabled !== "boolean" ||
    typeof config.qq.sandbox !== "boolean"
  ) {
    throw new TypeError("qq 配置格式不正确");
  }
  if (typeof config.qq.appId !== "string" || typeof config.qq.secret !== "string") {
    throw new TypeError("qq.appId 和 qq.secret 必须是字符串");
  }
  if (!isPlainObject(config.onebot)) throw new TypeError("onebot 必须是对象");
  assertUrl(config.onebot.url, "onebot.url", ["ws:", "wss:"]);
  if (typeof config.onebot.enabled !== "boolean" || typeof config.onebot.token !== "string") {
    throw new TypeError("onebot 配置格式不正确");
  }
  if (!isPlainObject(config.autonomy)) throw new TypeError("autonomy 必须是对象");
  if (typeof config.autonomy.enabled !== "boolean") {
    throw new TypeError("autonomy.enabled 必须是布尔值");
  }
  if (
    !Number.isFinite(config.autonomy.intervalMinutes) ||
    config.autonomy.intervalMinutes < 60
  ) {
    throw new TypeError("autonomy.intervalMinutes 必须不小于 60");
  }
  if (typeof config.autonomy.prompt !== "string") {
    throw new TypeError("autonomy.prompt 必须是字符串");
  }
  if (
    !isPlainObject(config.autonomy.quietHours) ||
    !Number.isInteger(config.autonomy.quietHours.start) ||
    config.autonomy.quietHours.start < 0 ||
    config.autonomy.quietHours.start > 23 ||
    !Number.isInteger(config.autonomy.quietHours.end) ||
    config.autonomy.quietHours.end < 0 ||
    config.autonomy.quietHours.end > 23
  ) {
    throw new TypeError("autonomy.quietHours 的 start 和 end 必须是 0..23 的整数");
  }
  if (
    typeof config.autonomy.timezone !== "string" ||
    !config.autonomy.timezone.trim()
  ) {
    throw new TypeError("autonomy.timezone 必须是非空字符串");
  }
  if (!isPlainObject(config.policy)) throw new TypeError("policy 必须是对象");
  const policy = config.policy;
  if (typeof policy.autoActions !== "boolean" || typeof policy.paused !== "boolean") {
    throw new TypeError("policy 开关必须是布尔值");
  }
  assertStringArray(policy.allowedUsers, "policy.allowedUsers");
  assertStringArray(policy.allowedGroups, "policy.allowedGroups");
  assertStringArray(policy.actionUsers, "policy.actionUsers");
  if (!Number.isFinite(policy.cooldownMs) || policy.cooldownMs < 0) {
    throw new TypeError("policy.cooldownMs 必须是非负数字");
  }
  if (!Number.isInteger(policy.maxActionsPerHour) || policy.maxActionsPerHour < 0) {
    throw new TypeError("policy.maxActionsPerHour 必须是非负整数");
  }
  if (!isPlainObject(config.qzone)) throw new TypeError("qzone 必须是对象");
  for (const key of ["enabled", "autoPublish", "headless"]) {
    if (typeof config.qzone[key] !== "boolean") {
      throw new TypeError(`qzone.${key} 必须是布尔值`);
    }
  }
  if (!isPlainObject(config.qzoneComments)) throw new TypeError("qzoneComments 必须是对象");
  const qzoneComments = config.qzoneComments;
  for (const key of ["enabled", "dryRun", "onlyFriends", "aiDecide", "nestedReplyFallback"]) {
    if (typeof qzoneComments[key] !== "boolean") {
      throw new TypeError(`qzoneComments.${key} 必须是布尔值`);
    }
  }
  for (const [key, min, max] of [
    ["pollMinutes", 2, 60],
    ["activePollMinutes", 1, 30],
    ["activeWindowMinutes", 5, 1440],
    ["pollJitterPercent", 0, 50],
    ["cookieRefreshMinutes", 5, 60],
    ["ownTrackHours", 0, 168],
    ["externalTrackHours", 0, 168],
    ["maxRepliesPerCycle", 0, 10],
    ["maxRepliesPerHour", 0, 30],
    ["delayMinSeconds", 0, 120],
    ["delayMaxSeconds", 0, 120],
    ["maxReplyChars", 10, 200],
  ]) {
    if (!Number.isInteger(qzoneComments[key]) || qzoneComments[key] < min || qzoneComments[key] > max) {
      throw new TypeError(`qzoneComments.${key} 必须在 ${min}..${max} 之间`);
    }
  }
  if (qzoneComments.activePollMinutes > qzoneComments.pollMinutes) {
    throw new TypeError("qzoneComments.activePollMinutes 不能大于 pollMinutes");
  }
  if (qzoneComments.delayMaxSeconds < qzoneComments.delayMinSeconds) {
    throw new TypeError("qzoneComments.delayMaxSeconds 不能小于 delayMinSeconds");
  }
  assertStringArray(qzoneComments.allowedUsers, "qzoneComments.allowedUsers");
  assertStringArray(qzoneComments.blockedUsers, "qzoneComments.blockedUsers");
  if (typeof qzoneComments.replyPrompt !== "string" || qzoneComments.replyPrompt.length > 2000) {
    throw new TypeError("qzoneComments.replyPrompt 必须是 0..2000 字符");
  }
  if (!isPlainObject(config.stickers)) throw new TypeError("stickers 必须是对象");
  const stickers = config.stickers;
  for (const key of ["enabled", "autoCollect"]) {
    if (typeof stickers[key] !== "boolean") {
      throw new TypeError(`stickers.${key} 必须是布尔值`);
    }
  }
  for (const key of ["maxItems", "maxFileSizeBytes"]) {
    if (!Number.isInteger(stickers[key]) || stickers[key] < 0) {
      throw new TypeError(`stickers.${key} 必须是非负整数`);
    }
  }
  if (stickers.maxItems < 1) throw new TypeError("stickers.maxItems 必须至少为 1");
  if (stickers.maxFileSizeBytes < 1024 || stickers.maxFileSizeBytes > 8 * 1024 * 1024) {
    throw new TypeError("stickers.maxFileSizeBytes 必须在 1024 到 8388608 之间");
  }
  for (const key of ["minCuteScore", "minInterestingScore"]) {
    if (typeof stickers[key] !== "number" || stickers[key] < 0 || stickers[key] > 1) {
      throw new TypeError(`stickers.${key} 必须在 0..1 之间`);
    }
  }
  if (
    !Number.isInteger(stickers.proactiveCooldownMinutes) ||
    stickers.proactiveCooldownMinutes < 0 ||
    stickers.proactiveCooldownMinutes > 1440
  ) {
    throw new TypeError("stickers.proactiveCooldownMinutes 必须在 0..1440 之间");
  }
  if (!isPlainObject(config.memory)) throw new TypeError("memory 必须是对象");
  const memory = config.memory;
  for (const key of ["enabled", "autoExtract"]) {
    if (typeof memory[key] !== "boolean") {
      throw new TypeError(`memory.${key} 必须是布尔值`);
    }
  }
  if (!Number.isInteger(memory.minImportance) || memory.minImportance < 1 || memory.minImportance > 10) {
    throw new TypeError("memory.minImportance 必须是 1..10 的整数");
  }
  if (!Number.isInteger(memory.maxPerKey) || memory.maxPerKey < 1 || memory.maxPerKey > 500) {
    throw new TypeError("memory.maxPerKey 必须是 1..500 的整数");
  }
  if (!Number.isInteger(memory.maxInjected) || memory.maxInjected < 0 || memory.maxInjected > 50) {
    throw new TypeError("memory.maxInjected 必须是 0..50 的整数");
  }
  if (typeof memory.judgeModel !== "string") {
    throw new TypeError("memory.judgeModel 必须是字符串");
  }
  if (
    !Number.isInteger(memory.judgeTimeoutMs) ||
    memory.judgeTimeoutMs < 1000 ||
    memory.judgeTimeoutMs > 60000
  ) {
    throw new TypeError("memory.judgeTimeoutMs 必须是 1000..60000 的整数");
  }
  if (!isPlainObject(config.replyDelay)) throw new TypeError("replyDelay 必须是对象");
  const replyDelay = config.replyDelay;
  if (typeof replyDelay.enabled !== "boolean") {
    throw new TypeError("replyDelay.enabled 必须是布尔值");
  }
  if (typeof replyDelay.typingIndicator !== "boolean") {
    throw new TypeError("replyDelay.typingIndicator 必须是布尔值");
  }
  for (const [key, min, max] of [
    ["baseMs", 0, 10000],
    ["msPerChar", 0, 1000],
    ["maxMs", 0, 60000],
  ]) {
    if (
      typeof replyDelay[key] !== "number" ||
      !Number.isFinite(replyDelay[key]) ||
      replyDelay[key] < min ||
      replyDelay[key] > max
    ) {
      throw new TypeError(`replyDelay.${key} 必须在 ${min}..${max} 之间`);
    }
  }
  if (
    typeof replyDelay.jitter !== "number" ||
    !Number.isFinite(replyDelay.jitter) ||
    replyDelay.jitter < 0 ||
    replyDelay.jitter > 0.5
  ) {
    throw new TypeError("replyDelay.jitter 必须在 0..0.5 之间");
  }
  if (!isPlainObject(config.chatExit)) throw new TypeError("chatExit 必须是对象");
  const chatExit = config.chatExit;
  if (typeof chatExit.enabled !== "boolean") {
    throw new TypeError("chatExit.enabled 必须是布尔值");
  }
  if (
    !Number.isInteger(chatExit.idleMinutes) ||
    chatExit.idleMinutes < 1 ||
    chatExit.idleMinutes > 1440
  ) {
    throw new TypeError("chatExit.idleMinutes 必须在 1..1440 之间");
  }
  if (
    typeof chatExit.minConfidence !== "number" ||
    !Number.isFinite(chatExit.minConfidence) ||
    chatExit.minConfidence < 0 ||
    chatExit.minConfidence > 1
  ) {
    throw new TypeError("chatExit.minConfidence 必须在 0..1 之间");
  }
  if (typeof chatExit.judgeModel !== "string") {
    throw new TypeError("chatExit.judgeModel 必须是字符串");
  }
  if (
    !Number.isInteger(chatExit.judgeTimeoutMs) ||
    chatExit.judgeTimeoutMs < 1000 ||
    chatExit.judgeTimeoutMs > 60000
  ) {
    throw new TypeError("chatExit.judgeTimeoutMs 必须是 1000..60000 的整数");
  }
  if (!isPlainObject(config.webSearch)) throw new TypeError("webSearch 必须是对象");
  const webSearch = config.webSearch;
  if (typeof webSearch.enabled !== "boolean") {
    throw new TypeError("webSearch.enabled 必须是布尔值");
  }
  if (typeof webSearch.searchEnabled !== "boolean") {
    throw new TypeError("webSearch.searchEnabled 必须是布尔值");
  }
  if (typeof webSearch.fetchEnabled !== "boolean") {
    throw new TypeError("webSearch.fetchEnabled 必须是布尔值");
  }
  if (typeof webSearch.apiKey !== "string") {
    throw new TypeError("webSearch.apiKey 必须是字符串");
  }
  if (
    !Number.isInteger(webSearch.maxCallsPerTurn) ||
    webSearch.maxCallsPerTurn < 1 ||
    webSearch.maxCallsPerTurn > 10
  ) {
    throw new TypeError("webSearch.maxCallsPerTurn 必须是 1..10 的整数");
  }
  if (!Number.isInteger(webSearch.maxResults) || webSearch.maxResults < 1 || webSearch.maxResults > 10) {
    throw new TypeError("webSearch.maxResults 必须是 1..10 的整数");
  }
  if (
    !Number.isInteger(webSearch.maxContentChars) ||
    webSearch.maxContentChars < 1000 ||
    webSearch.maxContentChars > 20000
  ) {
    throw new TypeError("webSearch.maxContentChars 必须是 1000..20000 的整数");
  }
  if (!isPlainObject(config.followUp)) throw new TypeError("followUp 必须是对象");
  const followUp = config.followUp;
  if (typeof followUp.enabled !== "boolean") {
    throw new TypeError("followUp.enabled 必须是布尔值");
  }
  for (const key of ["minMinutes", "maxMinutes"]) {
    if (!Number.isInteger(followUp[key]) || followUp[key] < 1 || followUp[key] > 10080) {
      throw new TypeError(`followUp.${key} 必须是 1..10080 的整数`);
    }
  }
  if (followUp.minMinutes < 5) {
    throw new TypeError("followUp.minMinutes 不能小于 5");
  }
  if (followUp.minMinutes > followUp.maxMinutes) {
    throw new TypeError("followUp.minMinutes 不能大于 maxMinutes");
  }
  if (
    !isPlainObject(followUp.quietHours) ||
    !Number.isInteger(followUp.quietHours.start) ||
    followUp.quietHours.start < 0 ||
    followUp.quietHours.start > 23 ||
    !Number.isInteger(followUp.quietHours.end) ||
    followUp.quietHours.end < 0 ||
    followUp.quietHours.end > 23
  ) {
    throw new TypeError("followUp.quietHours 的 start 和 end 必须是 0..23 的整数");
  }
  if (typeof followUp.timezone !== "string" || !followUp.timezone.trim()) {
    throw new TypeError("followUp.timezone 必须是非空字符串");
  }
  if (
    !Number.isInteger(followUp.retryDelayMinutes) ||
    followUp.retryDelayMinutes < 1 ||
    followUp.retryDelayMinutes > 60
  ) {
    throw new TypeError("followUp.retryDelayMinutes 必须是 1..60 的整数");
  }
  if (!isPlainObject(config.conversationState)) {
    throw new TypeError("conversationState 必须是对象");
  }
  const conversationState = config.conversationState;
  for (const key of ["enabled", "reviewEnabled"]) {
    if (typeof conversationState[key] !== "boolean") {
      throw new TypeError(`conversationState.${key} 必须是布尔值`);
    }
  }
  if (typeof conversationState.judgeModel !== "string") {
    throw new TypeError("conversationState.judgeModel 必须是字符串");
  }
  if (
    !Number.isInteger(conversationState.judgeTimeoutMs) ||
    conversationState.judgeTimeoutMs < 1000 ||
    conversationState.judgeTimeoutMs > 60000
  ) {
    throw new TypeError("conversationState.judgeTimeoutMs 必须是 1000..60000 的整数");
  }
  if (
    !Number.isInteger(conversationState.maxEntries) ||
    conversationState.maxEntries < 20 ||
    conversationState.maxEntries > 2000
  ) {
    throw new TypeError("conversationState.maxEntries 必须是 20..2000 的整数");
  }
  if (
    !Number.isFinite(conversationState.ttlHours) ||
    conversationState.ttlHours < 1 ||
    conversationState.ttlHours > 720
  ) {
    throw new TypeError("conversationState.ttlHours 必须在 1..720 之间");
  }
  if (
    !Number.isFinite(conversationState.globalEmotionTtlHours) ||
    conversationState.globalEmotionTtlHours < 1 ||
    conversationState.globalEmotionTtlHours > 168
  ) {
    throw new TypeError("conversationState.globalEmotionTtlHours 必须在 1..168 之间");
  }
  for (const [key, min, max] of [
    ["topicTtlHours", 1, 168],
    ["unfinishedTtlHours", 1, 720],
    ["userEmotionTtlHours", 1, 72],
    ["commonMemeTtlHours", 1, 720],
    ["profileTtlHours", 24, 8760],
  ]) {
    if (
      !Number.isFinite(conversationState[key]) ||
      conversationState[key] < min ||
      conversationState[key] > max
    ) {
      throw new TypeError(`conversationState.${key} 必须在 ${min}..${max} 之间`);
    }
  }
  if (!isPlainObject(config.userUnderstanding)) {
    throw new TypeError("userUnderstanding 必须是对象");
  }
  const userUnderstanding = config.userUnderstanding;
  if (typeof userUnderstanding.enabled !== "boolean") {
    throw new TypeError("userUnderstanding.enabled 必须是布尔值");
  }
  for (const [key, min, max] of [
    ["hour", 0, 23],
    ["minute", 0, 59],
    ["judgeTimeoutMs", 1000, 60000],
    ["maxInputChars", 1000, 100000],
    ["maxDailyMessages", 10, 1000],
    ["maxUsers", 1, 5000],
    ["retentionDays", 7, 3650],
    ["maxInjectedChars", 200, 4000],
  ]) {
    if (
      !Number.isInteger(userUnderstanding[key]) ||
      userUnderstanding[key] < min ||
      userUnderstanding[key] > max
    ) {
      throw new TypeError(`userUnderstanding.${key} 必须是 ${min}..${max} 的整数`);
    }
  }
  if (
    typeof userUnderstanding.timezone !== "string" ||
    !userUnderstanding.timezone.trim() ||
    userUnderstanding.timezone.length > 100
  ) {
    throw new TypeError("userUnderstanding.timezone 必须是 IANA 时区");
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: userUnderstanding.timezone,
    }).format();
  } catch {
    throw new TypeError("userUnderstanding.timezone 必须是 IANA 时区");
  }
  if (
    typeof userUnderstanding.judgeModel !== "string" ||
    userUnderstanding.judgeModel.length > 200
  ) {
    throw new TypeError("userUnderstanding.judgeModel 必须是字符串");
  }
  if (
    !isPlainObject(config.persona) ||
    typeof config.persona.name !== "string" ||
    !config.persona.name.trim()
  ) {
    throw new TypeError("persona.name 必须是非空字符串");
  }
  for (const key of ["preferences", "opinions"]) {
    if (
      !Array.isArray(config.persona[key]) ||
      config.persona[key].length > 8 ||
      config.persona[key].some(
        (item) => typeof item !== "string" || !item.trim() || item.length > 120,
      )
    ) {
      throw new TypeError(`persona.${key} 必须是最多 8 条、每条 1..120 字符的字符串数组`);
    }
  }
  if (!isPlainObject(config.identityLinks)) {
    throw new TypeError("identityLinks 必须是对象");
  }
  if (typeof config.demo !== "boolean") {
    throw new TypeError("demo 必须是布尔值");
  }
  return config;
}

function preserveBlankSecrets(next, previous) {
  if (!next.ai.apiKey.trim()) next.ai.apiKey = previous.ai.apiKey;
  if (!next.qq.secret.trim()) next.qq.secret = previous.qq.secret;
  if (!next.onebot.token.trim()) next.onebot.token = previous.onebot.token;
  if (!next.webSearch.apiKey.trim()) {
    next.webSearch.apiKey = previous.webSearch?.apiKey ?? "";
  }
  return next;
}

function configPath(root) {
  return path.join(root, CONFIG_FILE);
}

async function readConfig(root) {
  const file = configPath(root);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new TypeError("配置文件必须是 JSON 对象");
    return validateConfig(preserveBlankSecrets(deepMerge(defaultConfig, parsed), defaultConfig));
  } catch (error) {
    if (error?.code === "ENOENT") return clone(defaultConfig);
    if (error instanceof SyntaxError) throw new Error(`配置文件损坏：${file}`);
    throw error;
  }
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temp = `${file}.${suffix}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function loadConfig(root) {
  return readConfig(path.resolve(root));
}

export async function saveConfig(root, patch) {
  if (!isPlainObject(patch)) throw new TypeError("配置更新必须是对象");
  const resolvedRoot = path.resolve(root);
  const operation = async () => {
    const previous = await readConfig(resolvedRoot);
    const next = validateConfig(
      preserveBlankSecrets(deepMerge(previous, patch), previous),
    );
    await atomicWrite(configPath(resolvedRoot), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };
  const previousSave = saveQueues.get(resolvedRoot) ?? Promise.resolve();
  const save = previousSave.then(operation, operation);
  const settled = save.then(
    () => undefined,
    () => undefined,
  );
  saveQueues.set(resolvedRoot, settled);
  try {
    return await save;
  } finally {
    if (saveQueues.get(resolvedRoot) === settled) saveQueues.delete(resolvedRoot);
  }
}

export function publicConfig(config) {
  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (!isPlainObject(value)) return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      result[key] = scrub(item);
    }
    return result;
  }
  return scrub(config);
}
