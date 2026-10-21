import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AIRequestError, chat as aiChat } from "../src/ai.js";
import {
  defaultConfig,
  loadConfig,
  publicConfig,
  saveConfig,
  userUnderstandingDefaults,
} from "../src/config.js";
import {
  ConversationState,
  conversationStateKey,
} from "../src/conversation-state.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function configured(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "test-key";
  config.policy.cooldownMs = 0;
  config.qzone.enabled = true;
  config.demo = false;
  return {
    ...config,
    ...overrides,
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
    policy: { ...config.policy, ...(overrides.policy ?? {}) },
    qzone: { ...config.qzone, ...(overrides.qzone ?? {}) },
    stickers: { ...config.stickers, ...(overrides.stickers ?? {}) },
    webSearch: { ...config.webSearch, ...(overrides.webSearch ?? {}) },
    qzoneComments: { ...config.qzoneComments, ...(overrides.qzoneComments ?? {}) },
    memory: { ...config.memory, ...(overrides.memory ?? {}) },
    conversationState: {
      ...config.conversationState,
      ...(overrides.conversationState ?? {}),
    },
    userUnderstanding: {
      ...config.userUnderstanding,
      ...(overrides.userUnderstanding ?? {}),
    },
  };
}

function event(overrides = {}) {
  return {
    id: `event-${Math.random()}`,
    channel: "local",
    userId: "owner",
    scope: "private",
    conversationId: "local-owner",
    text: "你好",
    timestamp: Date.now(),
    ...overrides,
  };
}

function aiReply(content, toolCalls = []) {
  return {
    content,
    reasoningContent: "",
    toolCalls: toolCalls.map((call, index) => ({
      id: call.id ?? `call-${index}`,
      name: call.name,
      arguments: call.arguments,
    })),
    rawMessage: {
      role: "assistant",
      content,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((call, index) => ({
              id: call.id ?? `call-${index}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
    },
  };
}

function reviewObject(overrides = {}) {
  return {
    reply: "嗯，先歇会儿。",
    silence: false,
    topic: "今天有点累",
    unfinished: "",
    preference: "不喜欢被追问",
    emotion: "concerned",
    emotionIntensity: 0.6,
    globalEmotion: {
      action: "warm",
      happiness: 0.02,
      energy: 0,
      interest: 0.01,
      calm: 0.03,
    },
    ...overrides,
  };
}

async function setupStore(t) {
  const root = await temporaryDirectory(t);
  const store = await new Store(root).init();
  return { root, store };
}

test("config deep merge, validation, secret preservation, and public scrubbing", async (t) => {
  const root = await temporaryDirectory(t);
  assert.deepEqual(defaultConfig.autonomy, {
    enabled: false,
    intervalMinutes: 240,
    prompt: "写一条自然简短的动态，不编造真实经历。",
    quietHours: { start: 23, end: 8 },
    timezone: "Asia/Shanghai",
  });
  assert.equal(defaultConfig.ai.reasoningEffort, "high");
  assert.equal(defaultConfig.ai.historyMessages, 30);
  assert.ok(defaultConfig.persona.preferences.length >= 3);
  assert.ok(defaultConfig.persona.opinions.length >= 2);
  assert.equal(defaultConfig.inputDelayMs, 2000);
  assert.match(defaultConfig.ai.systemPrompt, /默认只回一句/);
  assert.doesNotMatch(defaultConfig.ai.systemPrompt, /声称自己有意识/);
  assert.deepEqual(defaultConfig.memory, {
    enabled: true,
    autoExtract: true,
    minImportance: 7,
    maxPerKey: 50,
    maxInjected: 10,
    judgeModel: "",
    judgeTimeoutMs: 15000,
  });
  assert.deepEqual(defaultConfig.replyDelay, {
    enabled: true,
    typingIndicator: true,
    baseMs: 500,
    msPerChar: 120,
    maxMs: 0,
    jitter: 0.15,
  });
  assert.deepEqual(defaultConfig.chatExit, {
    enabled: true,
    idleMinutes: 10,
    minConfidence: 0.75,
    judgeModel: "",
    judgeTimeoutMs: 10000,
  });
  assert.deepEqual(defaultConfig.webSearch, {
    enabled: true,
    searchEnabled: true,
    fetchEnabled: true,
    apiKey: "",
    maxResults: 5,
    maxContentChars: 6000,
    maxCallsPerTurn: 4,
  });
  assert.equal(defaultConfig.maxToolCallsPerTurn, 6);
  assert.deepEqual(defaultConfig.qzoneComments, {
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
  assert.deepEqual(defaultConfig.followUp, {
    enabled: true,
    minMinutes: 5,
    maxMinutes: 1440,
    quietHours: { start: 23, end: 8 },
    timezone: "Asia/Shanghai",
    retryDelayMinutes: 5,
  });
  assert.deepEqual(defaultConfig.conversationState, {
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
  assert.deepEqual(defaultConfig.userUnderstanding, {
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
  assert.deepEqual(defaultConfig.userUnderstanding, userUnderstandingDefaults);
  const saved = await saveConfig(root, {
    port: 4321,
    ai: { apiKey: "secret-ai", temperature: 0.6 },
    qq: { secret: "secret-qq" },
    onebot: { token: "secret-ob" },
    policy: { actionUsers: ["owner"] },
  });
  assert.equal(saved.port, 4321);
  assert.equal(saved.ai.model, defaultConfig.ai.model);
  assert.deepEqual(saved.policy.actionUsers, ["owner"]);
  const memorySaved = await saveConfig(root, {
    memory: { minImportance: 8, maxInjected: 5, judgeModel: "deepseek-flash" },
  });
  assert.equal(memorySaved.memory.minImportance, 8);
  assert.equal(memorySaved.memory.maxInjected, 5);
  assert.equal(memorySaved.memory.maxPerKey, 50);
  assert.equal(memorySaved.memory.judgeModel, "deepseek-flash");
  const delaySaved = await saveConfig(root, {
    replyDelay: { baseMs: 600, msPerChar: 80 },
  });
  assert.equal(delaySaved.replyDelay.baseMs, 600);
  assert.equal(delaySaved.replyDelay.msPerChar, 80);
  assert.equal(delaySaved.replyDelay.maxMs, 0);
  assert.equal(delaySaved.replyDelay.jitter, 0.15);
  assert.equal(delaySaved.replyDelay.typingIndicator, true);
  const inputDelaySaved = await saveConfig(root, { inputDelayMs: 3500 });
  assert.equal(inputDelaySaved.inputDelayMs, 3500);
  assert.equal(inputDelaySaved.replyDelay.baseMs, 600);
  const stickerSaved = await saveConfig(root, {
    stickers: {
      maxItems: 1200,
      minCuteScore: 0.65,
      minInterestingScore: 0.8,
      proactiveCooldownMinutes: 7,
    },
  });
  assert.equal(stickerSaved.stickers.maxItems, 1200);
  assert.equal(stickerSaved.stickers.minCuteScore, 0.65);
  assert.equal(stickerSaved.stickers.minInterestingScore, 0.8);
  assert.equal(stickerSaved.stickers.proactiveCooldownMinutes, 7);
  const exitSaved = await saveConfig(root, {
    chatExit: { idleMinutes: 12, minConfidence: 0.8, judgeModel: "deepseek-flash" },
  });
  assert.equal(exitSaved.chatExit.idleMinutes, 12);
  assert.equal(exitSaved.chatExit.minConfidence, 0.8);
  assert.equal(exitSaved.chatExit.judgeModel, "deepseek-flash");
  assert.equal(exitSaved.chatExit.judgeTimeoutMs, 10000);
  const webSearchSaved = await saveConfig(root, {
    maxToolCallsPerTurn: 7,
    webSearch: {
      maxResults: 4,
      maxContentChars: 8000,
      searchEnabled: false,
      fetchEnabled: false,
      maxCallsPerTurn: 3,
      apiKey: "web-search-key",
    },
  });
  assert.equal(webSearchSaved.webSearch.maxResults, 4);
  assert.equal(webSearchSaved.webSearch.maxContentChars, 8000);
  assert.equal(webSearchSaved.webSearch.enabled, true);
  assert.equal(webSearchSaved.webSearch.searchEnabled, false);
  assert.equal(webSearchSaved.webSearch.fetchEnabled, false);
  assert.equal(webSearchSaved.webSearch.maxCallsPerTurn, 3);
  assert.equal(webSearchSaved.webSearch.apiKey, "web-search-key");
  assert.equal(webSearchSaved.maxToolCallsPerTurn, 7);
  const blankWebKey = await saveConfig(root, { webSearch: { apiKey: "" } });
  assert.equal(blankWebKey.webSearch.apiKey, "web-search-key");
  const qzoneCommentsSaved = await saveConfig(root, {
    qzoneComments: {
      enabled: true,
      pollMinutes: 10,
      activePollMinutes: 1,
      activeWindowMinutes: 30,
      pollJitterPercent: 0,
      ownTrackHours: 0,
      externalTrackHours: 0,
      maxRepliesPerCycle: 0,
      maxRepliesPerHour: 0,
      nestedReplyFallback: true,
      allowedUsers: ["222"],
    },
  });
  assert.equal(qzoneCommentsSaved.qzoneComments.enabled, true);
  assert.equal(qzoneCommentsSaved.qzoneComments.pollMinutes, 10);
  assert.equal(qzoneCommentsSaved.qzoneComments.activePollMinutes, 1);
  assert.equal(qzoneCommentsSaved.qzoneComments.activeWindowMinutes, 30);
  assert.equal(qzoneCommentsSaved.qzoneComments.pollJitterPercent, 0);
  assert.equal(qzoneCommentsSaved.qzoneComments.ownTrackHours, 0);
  assert.equal(qzoneCommentsSaved.qzoneComments.externalTrackHours, 0);
  assert.equal(qzoneCommentsSaved.qzoneComments.maxRepliesPerCycle, 0);
  assert.equal(qzoneCommentsSaved.qzoneComments.maxRepliesPerHour, 0);
  assert.equal(qzoneCommentsSaved.qzoneComments.nestedReplyFallback, true);
  assert.deepEqual(qzoneCommentsSaved.qzoneComments.allowedUsers, ["222"]);
  assert.equal(qzoneCommentsSaved.qzoneComments.dryRun, true);
  const followUpSaved = await saveConfig(root, {
    followUp: {
      minMinutes: 5,
      maxMinutes: 720,
      quietHours: { start: 22, end: 9 },
      retryDelayMinutes: 3,
    },
  });
  assert.equal(followUpSaved.followUp.minMinutes, 5);
  assert.equal(followUpSaved.followUp.maxMinutes, 720);
  assert.equal(followUpSaved.followUp.retryDelayMinutes, 3);
  assert.deepEqual(followUpSaved.followUp.quietHours, { start: 22, end: 9 });
  assert.equal(followUpSaved.followUp.timezone, "Asia/Shanghai");
  const stateSaved = await saveConfig(root, {
    conversationState: {
      judgeModel: "deepseek-flash",
      judgeTimeoutMs: 6000,
      maxEntries: 300,
      ttlHours: 48,
      globalEmotionTtlHours: 12,
    },
  });
  assert.equal(stateSaved.conversationState.judgeModel, "deepseek-flash");
  assert.equal(stateSaved.conversationState.judgeTimeoutMs, 6000);
  assert.equal(stateSaved.conversationState.maxEntries, 300);
  assert.equal(stateSaved.conversationState.ttlHours, 48);
  assert.equal(stateSaved.conversationState.globalEmotionTtlHours, 12);
  const stateTtlSaved = await saveConfig(root, {
    conversationState: {
      topicTtlHours: 30,
      unfinishedTtlHours: 96,
      userEmotionTtlHours: 4,
      commonMemeTtlHours: 120,
      profileTtlHours: 480,
    },
  });
  assert.equal(stateTtlSaved.conversationState.topicTtlHours, 30);
  assert.equal(stateTtlSaved.conversationState.unfinishedTtlHours, 96);
  assert.equal(stateTtlSaved.conversationState.userEmotionTtlHours, 4);
  assert.equal(stateTtlSaved.conversationState.commonMemeTtlHours, 120);
  assert.equal(stateTtlSaved.conversationState.profileTtlHours, 480);
  const understandingSaved = await saveConfig(root, {
    userUnderstanding: {
      hour: 3,
      minute: 25,
      timezone: "Asia/Tokyo",
      judgeModel: "deepseek-flash",
      judgeTimeoutMs: 12000,
      maxInputChars: 12000,
      maxDailyMessages: 120,
      maxUsers: 80,
      retentionDays: 28,
      maxInjectedChars: 900,
    },
  });
  assert.equal(understandingSaved.userUnderstanding.hour, 3);
  assert.equal(understandingSaved.userUnderstanding.minute, 25);
  assert.equal(understandingSaved.userUnderstanding.timezone, "Asia/Tokyo");
  assert.equal(understandingSaved.userUnderstanding.judgeModel, "deepseek-flash");
  assert.equal(understandingSaved.userUnderstanding.judgeTimeoutMs, 12000);
  assert.equal(understandingSaved.userUnderstanding.maxInputChars, 12000);
  assert.equal(understandingSaved.userUnderstanding.maxDailyMessages, 120);
  assert.equal(understandingSaved.userUnderstanding.maxUsers, 80);
  assert.equal(understandingSaved.userUnderstanding.retentionDays, 28);
  assert.equal(understandingSaved.userUnderstanding.maxInjectedChars, 900);

  const retained = await saveConfig(root, {
    ai: { apiKey: "   " },
    qq: { secret: "" },
    onebot: { token: "" },
  });
  assert.equal(retained.ai.apiKey, "secret-ai");
  assert.equal(retained.qq.secret, "secret-qq");
  assert.equal(retained.onebot.token, "secret-ob");

  const loaded = await loadConfig(root);
  assert.equal(loaded.policy.cooldownMs, defaultConfig.policy.cooldownMs);
  const exposed = publicConfig(loaded);
  assert.equal("apiKey" in exposed.ai, false);
  assert.equal("secret" in exposed.qq, false);
  assert.equal("token" in exposed.onebot, false);
  assert.equal(exposed.userUnderstanding.maxInjectedChars, 900);
  assert.equal("apiKey" in exposed.userUnderstanding, false);

  await assert.rejects(saveConfig(root, { port: 0 }), /port/);
  await assert.rejects(saveConfig(root, { ai: { baseUrl: "ftp://bad" } }), /ai.baseUrl/);
  await assert.rejects(
    saveConfig(root, { ai: { reasoningEffort: "turbo" } }),
    /reasoningEffort/,
  );
  await assert.rejects(
    saveConfig(root, { ai: { historyMessages: -1 } }),
    /historyMessages/,
  );
  await assert.rejects(
    saveConfig(root, { ai: { historyMessages: 1.5 } }),
    /historyMessages/,
  );
  await assert.rejects(
    saveConfig(root, { autonomy: { intervalMinutes: 59 } }),
    /intervalMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { autonomy: { quietHours: { start: 24 } } }),
    /quietHours/,
  );
  await assert.rejects(
    saveConfig(root, { stickers: { proactiveCooldownMinutes: -1 } }),
    /proactiveCooldownMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { chatExit: { idleMinutes: 0 } }),
    /idleMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { webSearch: { maxResults: 0 } }),
    /webSearch.maxResults/,
  );
  await assert.rejects(
    saveConfig(root, { webSearch: { maxContentChars: 999 } }),
    /webSearch.maxContentChars/,
  );
  await assert.rejects(
    saveConfig(root, { webSearch: { maxCallsPerTurn: 0 } }),
    /webSearch.maxCallsPerTurn/,
  );
  await assert.rejects(
    saveConfig(root, { webSearch: { searchEnabled: "yes" } }),
    /webSearch.searchEnabled/,
  );
  await assert.rejects(
    saveConfig(root, { webSearch: { fetchEnabled: "yes" } }),
    /webSearch.fetchEnabled/,
  );
  await assert.rejects(
    saveConfig(root, { webSearch: { apiKey: 123 } }),
    /webSearch.apiKey/,
  );
  await assert.rejects(
    saveConfig(root, { maxToolCallsPerTurn: 0 }),
    /maxToolCallsPerTurn/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { pollMinutes: 1 } }),
    /qzoneComments.pollMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { pollMinutes: 5, activePollMinutes: 6 } }),
    /qzoneComments.activePollMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { activeWindowMinutes: 4 } }),
    /qzoneComments.activeWindowMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { pollJitterPercent: 51 } }),
    /qzoneComments.pollJitterPercent/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { ownTrackHours: -1 } }),
    /qzoneComments.ownTrackHours/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { delayMaxSeconds: 4, delayMinSeconds: 5 } }),
    /delayMaxSeconds/,
  );
  await assert.rejects(
    saveConfig(root, { qzoneComments: { enabled: "yes" } }),
    /qzoneComments.enabled/,
  );
  await assert.rejects(
    saveConfig(root, { autonomy: { timezone: "  " } }),
    /timezone/,
  );
  await assert.rejects(
    saveConfig(root, { memory: { minImportance: 0 } }),
    /minImportance/,
  );
  await assert.rejects(
    saveConfig(root, { memory: { maxPerKey: 0 } }),
    /maxPerKey/,
  );
  await assert.rejects(
    saveConfig(root, { memory: { maxInjected: 51 } }),
    /maxInjected/,
  );
  await assert.rejects(
    saveConfig(root, { memory: { judgeTimeoutMs: 500 } }),
    /judgeTimeoutMs/,
  );
  await assert.rejects(
    saveConfig(root, { inputDelayMs: 0 }),
    /inputDelayMs/,
  );
  await assert.rejects(
    saveConfig(root, { inputDelayMs: 10001 }),
    /inputDelayMs/,
  );
  await assert.rejects(
    saveConfig(root, { inputDelayMs: "2000" }),
    /inputDelayMs/,
  );
  await assert.rejects(
    saveConfig(root, { replyDelay: { baseMs: -1 } }),
    /replyDelay.baseMs/,
  );
  await assert.rejects(
    saveConfig(root, { replyDelay: { msPerChar: 1001 } }),
    /replyDelay.msPerChar/,
  );
  await assert.rejects(
    saveConfig(root, { replyDelay: { maxMs: -1 } }),
    /replyDelay.maxMs/,
  );
  await assert.rejects(
    saveConfig(root, { replyDelay: { jitter: 0.6 } }),
    /replyDelay.jitter/,
  );
  await assert.rejects(
    saveConfig(root, { replyDelay: { typingIndicator: "yes" } }),
    /replyDelay.typingIndicator/,
  );
  await assert.rejects(
    saveConfig(root, { chatExit: { minConfidence: 1.1 } }),
    /chatExit.minConfidence/,
  );
  await assert.rejects(
    saveConfig(root, { chatExit: { judgeTimeoutMs: 500 } }),
    /chatExit.judgeTimeoutMs/,
  );
  await assert.rejects(
    saveConfig(root, { followUp: { minMinutes: 800, maxMinutes: 700 } }),
    /minMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { followUp: { minMinutes: 4 } }),
    /minMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { followUp: { quietHours: { start: 24 } } }),
    /followUp.quietHours/,
  );
  await assert.rejects(
    saveConfig(root, { followUp: { retryDelayMinutes: 0 } }),
    /retryDelayMinutes/,
  );
  await assert.rejects(
    saveConfig(root, { conversationState: { judgeTimeoutMs: 500 } }),
    /conversationState.judgeTimeoutMs/,
  );
  await assert.rejects(
    saveConfig(root, { conversationState: { maxEntries: 19 } }),
    /conversationState.maxEntries/,
  );
  await assert.rejects(
    saveConfig(root, { conversationState: { ttlHours: 0 } }),
    /conversationState.ttlHours/,
  );
  await assert.rejects(
    saveConfig(root, { conversationState: { globalEmotionTtlHours: 169 } }),
    /conversationState.globalEmotionTtlHours/,
  );
  await assert.rejects(
    saveConfig(root, { conversationState: { topicTtlHours: 0 } }),
    /conversationState.topicTtlHours/,
  );
  await assert.rejects(
    saveConfig(root, { conversationState: { profileTtlHours: 23 } }),
    /conversationState.profileTtlHours/,
  );
  await assert.rejects(
    saveConfig(root, { userUnderstanding: { hour: 24 } }),
    /userUnderstanding.hour/,
  );
  await assert.rejects(
    saveConfig(root, { userUnderstanding: { minute: 60 } }),
    /userUnderstanding.minute/,
  );
  await assert.rejects(
    saveConfig(root, { userUnderstanding: { timezone: "Not/AZone" } }),
    /userUnderstanding.timezone/,
  );
  await assert.rejects(
    saveConfig(root, { userUnderstanding: { maxDailyMessages: 9 } }),
    /userUnderstanding.maxDailyMessages/,
  );
  await assert.rejects(
    saveConfig(root, { userUnderstanding: { maxInjectedChars: 4001 } }),
    /userUnderstanding.maxInjectedChars/,
  );
  await assert.rejects(
    saveConfig(root, { persona: { preferences: ["x", 1] } }),
    /persona.preferences/,
  );
});

test("old config files gain user-understanding defaults without losing unknown keys", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(
    path.join(root, "data", "config.json"),
    JSON.stringify({ port: 4322, futureSection: { keep: true } }),
    "utf8",
  );

  const loaded = await loadConfig(root);
  assert.deepEqual(loaded.userUnderstanding, userUnderstandingDefaults);
  assert.deepEqual(loaded.futureSection, { keep: true });

  const saved = await saveConfig(root, { userUnderstanding: { hour: 4 } });
  assert.equal(saved.userUnderstanding.hour, 4);
  assert.equal(saved.userUnderstanding.minute, 10);
  assert.deepEqual(saved.futureSection, { keep: true });
});

test("damaged config is reported and never overwritten", async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, "data", "config.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{broken", "utf8");
  await assert.rejects(loadConfig(root), /配置.*损坏/);
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("store persists bounded conversations and isolated memories", async (t) => {
  const { root, store } = await setupStore(t);
  await Promise.all([
    store.append("private-a", [{ role: "user", content: "A1" }]),
    store.append("private-a", [{ role: "assistant", content: "A2" }]),
    store.append("group-g", [{ role: "user", content: "G1" }]),
  ]);
  assert.deepEqual(
    (await store.history("private-a")).map((item) => item.content),
    ["A1", "A2"],
  );
  assert.deepEqual(
    (await store.history("group-g")).map((item) => item.content),
    ["G1"],
  );

  const memory = await store.remember("private-a", "只属于 A 的偏好");
  await store.remember("group-g", "群内共享信息");
  assert.equal((await store.memories("private-a")).length, 1);
  assert.equal((await store.memories("group-g"))[0].text, "群内共享信息");
  assert.equal(await store.forget("private-a", memory.id), true);
  assert.equal((await store.memories("private-a")).length, 0);

  const reopened = await new Store(root).init();
  assert.equal((await reopened.history("group-g"))[0].content, "G1");
  assert.equal((await reopened.memories("group-g"))[0].text, "群内共享信息");
});

test("store migrates v1 memories to v2 with a backup", async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, "data", "store.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      conversations: {
        owner: [{ role: "user", content: "旧消息" }],
      },
      memories: {
        owner: [{ id: "old-1", text: "旧记忆", createdAt: "2026-01-01T00:00:00.000Z" }],
      },
    }),
    "utf8",
  );

  const store = await new Store(root).init();
  const memories = await store.memories("owner");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].type, "fact");
  assert.equal(memories[0].importance, 5);
  assert.equal(memories[0].source, "manual");
  assert.equal(memories[0].updatedAt, memories[0].createdAt);
  assert.equal(memories[0].lastAccessedAt, memories[0].createdAt);

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.version, 2);
  const backups = await readdir(path.join(root, "data", "backups"));
  assert.ok(backups.some((name) => name.startsWith("store-v1-")));
  assert.equal((await store.history("owner"))[0].content, "旧消息");
});

test("store deduplicates, prunes, touches, and clears memories by scope", async (t) => {
  const { store } = await setupStore(t);
  const key = JSON.stringify(["private-memory", "onebot", "10001"]);
  await store.remember(key, "用户喜欢猫", {
    type: "fact",
    importance: 5,
    source: "auto",
  });
  const updated = await store.remember(key, "  用户喜欢猫  ", {
    type: "preference",
    importance: 8,
    source: "manual",
  });
  assert.equal((await store.memories(key)).length, 1);
  assert.equal(updated.type, "preference");
  assert.equal(updated.importance, 8);
  assert.equal(updated.source, "manual");

  await store.remember(key, "临时 A", { importance: 2, maxMemories: 2 });
  await store.remember(key, "临时 B", { importance: 3, maxMemories: 2 });
  await store.remember(key, "重要 C", { importance: 9, maxMemories: 2 });
  const pruned = await store.memories(key);
  assert.equal(pruned.length, 2);
  assert.deepEqual(
    pruned.map((memory) => memory.text),
    ["重要 C", "用户喜欢猫"],
  );
  assert.deepEqual(await store.memoryScopes(), [key]);

  const touched = await store.memories(key, { limit: 1, touch: true, touchIntervalMs: 0 });
  assert.equal(touched.length, 1);
  assert.equal(touched[0].text, "重要 C");

  assert.equal(await store.clearMemories(key), 2);
  assert.equal((await store.memories(key)).length, 0);
  assert.ok((await store.memoryScopes()).includes(key));
});

test("store searches memories and history inside the current scope only", async (t) => {
  const { store } = await setupStore(t);
  const memoryKey = JSON.stringify(["private-memory", "onebot", "10001"]);
  const otherMemoryKey = JSON.stringify(["private-memory", "onebot", "10002"]);
  await store.remember(memoryKey, "用户养的猫叫咪咪", { importance: 6 });
  await store.remember(memoryKey, "用户喜欢狗", { importance: 9 });
  await store.remember(otherMemoryKey, "另一个用户的猫叫花花", { importance: 10 });

  const memories = await store.searchMemories(memoryKey, "猫 咪咪");
  assert.deepEqual(
    memories.map((memory) => memory.text),
    ["用户养的猫叫咪咪"],
  );
  assert.deepEqual(
    (await store.searchMemories(otherMemoryKey, "花花")).map((memory) => memory.text),
    ["另一个用户的猫叫花花"],
  );
  assert.deepEqual(await store.searchMemories(memoryKey, "不存在的词"), []);

  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  const otherConversationKey = JSON.stringify(["onebot", "private", "10002", "10002"]);
  await store.append(conversationKey, [
    { role: "user", content: "我家猫叫咪咪" },
    { role: "assistant", content: "记住了" },
  ]);
  await store.append(otherConversationKey, [
    { role: "user", content: "我家猫叫花花" },
  ]);
  const history = await store.searchHistory(conversationKey, "猫 咪咪");
  assert.deepEqual(
    history.map((message) => message.content),
    ["我家猫叫咪咪"],
  );
  assert.deepEqual(
    (await store.searchHistory(otherConversationKey, "花花")).map(
      (message) => message.content,
    ),
    ["我家猫叫花花"],
  );
  assert.deepEqual(await store.searchHistory(conversationKey, "花花"), []);
});

test("store import validates before writing, backs up, and detects corrupt files", async (t) => {
  const { root, store } = await setupStore(t);
  await store.remember("owner", "旧记忆");
  const replacement = {
    version: 1,
    conversations: {
      owner: [{ role: "user", content: "新历史" }],
    },
    memories: {},
  };
  const { backupPath } = await store.importData(replacement);
  assert.match(backupPath, /data[\\/]backups/);
  assert.equal((await store.history("owner"))[0].content, "新历史");
  await assert.rejects(
    store.importData({
      version: 1,
      conversations: {},
      memories: { owner: [{ id: 9 }] },
    }),
    /无效条目/,
  );
  assert.equal((await store.history("owner"))[0].content, "新历史");

  const brokenRoot = await temporaryDirectory(t);
  const brokenFile = path.join(brokenRoot, "data", "store.json");
  await mkdir(path.dirname(brokenFile), { recursive: true });
  await writeFile(brokenFile, "{bad", "utf8");
  await assert.rejects(new Store(brokenRoot).init(), /数据文件损坏/);
  assert.equal(await readFile(brokenFile, "utf8"), "{bad");
});

test("local commands manage only short history and scoped memories", async (t) => {
  const { root, store } = await setupStore(t);
  let config = await loadConfig(root);
  const engine = new Engine({ getConfig: async () => config, store });

  let result = await engine.handle(event({ id: "remember", text: "/remember 喜欢热茶" }));
  const id = result.text.match(/ID：([^）]+)/)[1];
  assert.match(result.text, /已记住/);
  result = await engine.handle(event({ id: "memories", text: "/memories" }));
  assert.match(result.text, /喜欢热茶/);

  await store.append(
    JSON.stringify(["local", "private", "local-owner", "owner"]),
    [{ role: "user", content: "短期内容" }],
  );
  result = await engine.handle(event({ id: "reset", text: "/reset" }));
  assert.match(result.text, /短期历史/);
  assert.equal(
    (
      await store.history(
        JSON.stringify(["local", "private", "local-owner", "owner"]),
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await store.memories(JSON.stringify(["private-memory", "local", "owner"]))
    ).length,
    1,
  );

  result = await engine.handle(event({ id: "forget", text: `/forget ${id}` }));
  assert.match(result.text, /已删除/);
  config = await saveConfig(root, {});
});

test("remote profile reset respects the conversation allowlist", async (t) => {
  const { store } = await setupStore(t);
  const cleared = [];
  const engine = new Engine({
    getConfig: async () => configured({ policy: { allowedUsers: ["10001"] } }),
    store,
    services: {
      userUnderstanding: {
        async clearUser(input) {
          cleared.push({ scope: input.scope, userId: input.userId });
        },
      },
    },
  });

  const blocked = await engine.handle(
    event({
      id: "profile-blocked",
      channel: "onebot",
      userId: "10002",
      conversationId: "10002",
      text: "/profile reset",
    }),
  );
  assert.equal(blocked.suppressed, true);
  assert.deepEqual(cleared, []);

  const allowed = await engine.handle(
    event({
      id: "profile-allowed",
      channel: "onebot",
      scope: "group",
      userId: "10001",
      conversationId: "group-chat",
      groupId: "20002",
      text: "/profile reset",
    }),
  );
  assert.match(allowed.text, /已清除你的画像/);
  assert.deepEqual(cleared, [{ scope: "group", userId: "10001" }]);
});

test("local privacy commands report partial success when profile clearing throws", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify([
    "local",
    "private",
    "local-owner",
    "owner",
  ]);
  const memoryKey = JSON.stringify(["private-memory", "local", "owner"]);
  await store.append(conversationKey, [{ role: "user", content: "待清空历史" }]);
  await store.remember(memoryKey, "待清空记忆");
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      userUnderstanding: {
        async clearUser() {
          throw new Error("User understanding clear failed");
        },
      },
    },
  });

  const reset = await engine.handle(event({ id: "reset-profile-failed", text: "/reset" }));
  assert.match(reset.text, /已清除当前会话的短期历史/);
  assert.match(reset.text, /用户画像及待汇总材料清除失败/);
  assert.match(reset.text, /\/profile reset/);
  assert.doesNotMatch(reset.text, /已清除当前会话的短期历史和当前用户画像/);
  assert.deepEqual(await store.history(conversationKey), []);
  assert.equal((await store.memories(memoryKey)).length, 1);

  const forget = await engine.handle(
    event({ id: "forget-all-profile-failed", text: "/forget all" }),
  );
  assert.match(forget.text, /已删除当前范围的 1 条长期记忆/);
  assert.match(forget.text, /用户画像及待汇总材料清除失败/);
  assert.match(forget.text, /\/profile reset/);
  assert.doesNotMatch(forget.text, /1 条长期记忆和当前用户画像/);
  assert.equal((await store.memories(memoryKey)).length, 0);
});

test("demo mode is explicit and never calls AI or external services", async (t) => {
  const { store } = await setupStore(t);
  let chatCalls = 0;
  let actionCalls = 0;
  const engine = new Engine({
    getConfig: async () => structuredClone(defaultConfig),
    store,
    services: {
      chat: async () => {
        chatCalls += 1;
        return aiReply("真实回复");
      },
      like: async () => {
        actionCalls += 1;
      },
      publishQzone: async () => {
        actionCalls += 1;
      },
    },
  });
  const result = await engine.handle(event({ id: "demo", text: "发空间" }));
  assert.match(result.text, /演示模式/);
  assert.equal(chatCalls, 0);
  assert.equal(actionCalls, 0);
});

test("demo mode blocks AI and model-driven external actions even when a key exists", async (t) => {
  const { store } = await setupStore(t);
  let calls = 0;
  let published = 0;
  const config = configured({
    demo: true,
    policy: { actionUsers: ["owner"], cooldownMs: 0 },
    qzone: { autoPublish: true },
  });
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async () => {
        calls += 1;
        return calls === 1
          ? aiReply("", [
              { name: "publish_qzone", arguments: { text: "不应外发" } },
            ])
          : aiReply("演示模式下未外发");
      },
      publishQzone: async () => {
        published += 1;
      },
    },
  });
  const result = await engine.handle(
    event({ id: "demo-key", channel: "qq", text: "自动发个空间" }),
  );
  assert.match(result.text, /演示模式/);
  assert.equal(calls, 0);
  assert.equal(published, 0);
});

test("AI failure is retried for the same event id", async (t) => {
  const { store } = await setupStore(t);
  let calls = 0;
  const config = configured();
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("temporary");
          error.code = "NETWORK_ERROR";
          throw error;
        }
        return aiReply("第二次成功");
      },
    },
  });
  const first = await engine.handle(event({ id: "same", channel: "qq" }));
  assert.match(first.text, /出现错误/);
  const second = await engine.handle(event({ id: "same", channel: "qq" }));
  assert.equal(second.text, "第二次成功");
  assert.equal(calls, 2);
});

test("successful duplicate events are deduplicated", async (t) => {
  const { store } = await setupStore(t);
  let calls = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        calls += 1;
        return aiReply("只回复一次");
      },
    },
  });
  const input = event({ id: "duplicate", channel: "qq" });
  const [first, second] = await Promise.all([engine.handle(input), engine.handle(input)]);
  assert.equal(first.text, "只回复一次");
  assert.equal(second.text, "只回复一次");
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
});

test("deferred commit writes history only after the reply is committed", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => aiReply("合并后的回复"),
    },
  });
  const input = event({
    id: "deferred-commit",
    channel: "onebot",
    userId: "10001",
    conversationId: "10001",
    text: "第一条\n第二条",
  });

  const reply = await engine.handle(input, { deferCommit: true });
  assert.ok(reply.turn);
  assert.deepEqual(await store.history(conversationKey), []);

  assert.equal(await engine.commitTurn(reply), true);
  assert.equal(await engine.commitTurn(reply), false);
  const duplicate = await engine.handle(input, { deferCommit: true });
  assert.equal(duplicate.duplicate, true);
  assert.equal(await engine.commitTurn(duplicate), false);
  assert.deepEqual(
    (await store.history(conversationKey)).map((message) => message.content),
    ["第一条\n第二条", "合并后的回复"],
  );
});

test("user-understanding context stays after static system and before history", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  await store.append(conversationKey, [
    { role: "user", content: "很早的一条消息" },
    { role: "assistant", content: "较早的回复" },
  ]);
  const contextEvents = [];
  const recorded = [];
  let sentMessages = null;
  const engine = new Engine({
    getConfig: async () =>
      configured({ conversationState: { enabled: false, reviewEnabled: false } }),
    store,
    services: {
      chat: async ({ messages }) => {
        sentMessages = messages;
        return aiReply("画像后的回复");
      },
      userUnderstanding: {
        async context(event) {
          contextEvents.push({
            channel: event.channel,
            scope: event.scope,
            userId: event.userId,
          });
          return event.userId === "10001"
            ? "【理解这位用户】\n偏好直接一点；只用于了解，不要迎合。"
            : "";
        },
        async recordTurn(payload) {
          recorded.push(payload);
        },
      },
    },
  });

  await engine.handle(
    event({
      id: "understanding-private",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "今天有点累",
    }),
  );
  assert.equal(sentMessages[0].role, "system");
  assert.match(sentMessages[0].content, /不要据此迎合、附和或模仿/);
  assert.deepEqual(sentMessages[1], {
    role: "system",
    content: "【理解这位用户】\n偏好直接一点；只用于了解，不要迎合。",
  });
  assert.deepEqual(sentMessages.slice(2, 4), [
    { role: "user", content: "很早的一条消息" },
    { role: "assistant", content: "较早的回复" },
  ]);
  assert.equal(sentMessages[4].role, "user");
  assert.deepEqual(contextEvents[0], {
    channel: "onebot",
    scope: "private",
    userId: "10001",
  });
  assert.deepEqual(recorded[0].messages, [
    { role: "user", content: "今天有点累" },
    { role: "assistant", content: "画像后的回复" },
  ]);
});

test("group understanding uses only the current sender's profile event", async (t) => {
  const { store } = await setupStore(t);
  const contextEvents = [];
  let sentMessages = null;
  const engine = new Engine({
    getConfig: async () =>
      configured({ conversationState: { enabled: false, reviewEnabled: false } }),
    store,
    services: {
      chat: async ({ messages }) => {
        sentMessages = messages;
        return aiReply("群里的回复");
      },
      userUnderstanding: {
        async context(event) {
          contextEvents.push({ scope: event.scope, userId: event.userId });
          return event.userId === "10001" ? "只包含当前用户的安全性格枚举" : "";
        },
        async recordTurn() {},
      },
    },
  });

  await engine.handle(
    event({
      id: "understanding-group-shared",
      channel: "onebot",
      scope: "group",
      userId: "10001",
      conversationId: "group-chat",
      groupId: "20002",
      text: "在群里聊",
    }),
  );
  assert.deepEqual(contextEvents[0], { scope: "group", userId: "10001" });
  assert.equal(sentMessages[1].role, "system");
  assert.match(sentMessages[1].content, /当前用户/);

  await engine.handle(
    event({
      id: "understanding-group-other",
      channel: "onebot",
      scope: "group",
      userId: "10002",
      conversationId: "group-chat",
      groupId: "20002",
      text: "另一个人发言",
    }),
  );
  assert.deepEqual(contextEvents[1], { scope: "group", userId: "10002" });
  assert.equal(sentMessages[1].role, "user");
});

test("understanding records each successfully committed history segment once", async (t) => {
  const { store } = await setupStore(t);
  const recorded = [];
  const engine = new Engine({
    getConfig: async () =>
      configured({ conversationState: { enabled: false, reviewEnabled: false } }),
    store,
    services: {
      chat: async () => aiReply("第一段。第二段。"),
      userUnderstanding: {
        async context() {
          return "";
        },
        async recordTurn(payload) {
          recorded.push(structuredClone(payload.messages));
        },
      },
    },
  });
  const reply = await engine.handle(
    event({
      id: "understanding-segments",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "原始消息",
    }),
    { deferCommit: true },
  );
  assert.deepEqual(recorded, []);

  await engine.commitDeliveredTurn(reply, { assistantText: "第一段。" });
  await engine.commitDeliveredTurn(reply, {
    assistantText: "第二段。",
    userTexts: ["中途补充"],
    final: true,
  });
  await engine.commitDeliveredTurn(reply, { final: true });
  assert.deepEqual(recorded, [
    [
      { role: "user", content: "原始消息" },
      { role: "assistant", content: "第一段。" },
    ],
    [
      { role: "user", content: "中途补充" },
      { role: "assistant", content: "第二段。" },
    ],
  ]);

  const cancelled = await engine.handle(
    event({
      id: "understanding-cancelled",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "没有发出去",
    }),
    { deferCommit: true },
  );
  assert.ok(cancelled.turn);
  assert.equal(recorded.length, 2);
});

test("partial delivery commits only sent segments in order and finalizes state once", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  let memoryCalls = 0;
  const engine = new Engine({
    getConfig: async () =>
      configured({ conversationState: { enabled: true, reviewEnabled: false } }),
    store,
    services: {
      chat: async () => aiReply("第一段。第二段。"),
      memory: {
        afterTurn() {
          memoryCalls += 1;
          return Promise.resolve();
        },
      },
    },
  });
  const input = event({
    id: "partial-delivery",
    channel: "onebot",
    userId: "10001",
    conversationId: "10001",
    text: "原始合并消息",
  });
  const reply = await engine.handle(input, { deferCommit: true });
  assert.deepEqual(await store.history(conversationKey), []);

  assert.equal(
    await engine.commitDeliveredTurn(reply, { assistantText: "第一段。" }),
    true,
  );
  assert.deepEqual(
    (await store.history(conversationKey)).map((message) => message.content),
    ["原始合并消息", "第一段。"],
  );
  assert.equal(memoryCalls, 0);

  assert.equal(
    await engine.commitDeliveredTurn(reply, {
      assistantText: "第二段。",
      userTexts: ["生成期间补充的消息"],
    }),
    true,
  );
  assert.deepEqual(
    (await store.history(conversationKey)).map((message) => message.content),
    ["原始合并消息", "第一段。", "生成期间补充的消息", "第二段。"],
  );
  assert.equal(memoryCalls, 0);

  assert.equal(
    await engine.commitDeliveredTurn(reply, {
      userTexts: ["未参与本轮生成的补充"],
      final: true,
    }),
    true,
  );
  assert.deepEqual(
    (await store.history(conversationKey)).map((message) => message.content),
    [
      "原始合并消息",
      "第一段。",
      "生成期间补充的消息",
      "第二段。",
      "未参与本轮生成的补充",
    ],
  );
  assert.equal(memoryCalls, 1);
  assert.equal(await engine.commitTurn(reply), false);
  assert.equal(await engine.commitDeliveredTurn(reply, { final: true }), false);
  assert.equal(
    (await store.history(conversationKey)).length,
    5,
  );
});

test("partial delivery with no successful segment writes only the original user message", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify(["onebot", "private", "10003", "10003"]);
  const engine = new Engine({
    getConfig: async () => configured({ conversationState: { reviewEnabled: false } }),
    store,
    services: { chat: async () => aiReply("没有真正发出去") },
  });
  const reply = await engine.handle(
    event({
      id: "partial-user-only",
      channel: "onebot",
      userId: "10003",
      conversationId: "10003",
      text: "首段发送失败",
    }),
    { deferCommit: true },
  );
  assert.equal(
    await engine.commitDeliveredTurn(reply, {
      assistantText: null,
      userTexts: [],
      final: true,
    }),
    true,
  );
  assert.deepEqual(await store.history(conversationKey), [
    { role: "user", content: "首段发送失败" },
  ]);
});

test("aborted deferred generation never writes history", async (t) => {
  const { store } = await setupStore(t);
  let signalSeenResolve;
  const signalSeen = new Promise((resolve) => {
    signalSeenResolve = resolve;
  });
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  let seenSignal;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ signal }) => {
        seenSignal = signal;
        signalSeenResolve();
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("AI 请求已取消");
              error.code = "CANCELLED";
              reject(error);
            },
            { once: true },
          );
        });
      },
    },
  });
  const controller = new AbortController();
  const promise = engine.handle(
    event({
      id: "deferred-abort",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "会被打断的消息",
    }),
    { signal: controller.signal, deferCommit: true },
  );
  let signalTimeout;
  try {
    await Promise.race([
      signalSeen,
      new Promise((_, reject) => {
        signalTimeout = setTimeout(
          () => reject(new Error("主模型未收到取消信号")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(signalTimeout);
  }
  assert.ok(seenSignal);
  controller.abort();
  await assert.rejects(promise, /取消/);
  assert.deepEqual(await store.history(conversationKey), []);
});

test("review updates state only in commitTurn and keeps dynamic state at the final user message", async (t) => {
  const { store } = await setupStore(t);
  const input = event({
    id: "review-commit",
    channel: "onebot",
    userId: "10001",
    conversationId: "10001",
    text: "晚安",
  });
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  let mainPrompt;
  let reviewArgs;
  let reviewCalls = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ messages }) => {
        mainPrompt = structuredClone(messages);
        return aiReply("晚安啦，明天见。");
      },
      reviewChat: async (args) => {
        reviewCalls += 1;
        reviewArgs = args;
        return aiReply(JSON.stringify(reviewObject({ reply: "晚安。", silence: true })));
      },
    },
  });
  const stateKey = conversationStateKey(input);
  await engine.conversationState.updateTurn({
    conversationKey: stateKey,
    config: configured(),
    review: {
      ...reviewObject(),
      topic: "只放在动态 user 的状态",
    },
    now: Date.now() - 1000,
  });

  const reply = await engine.handle(input, { deferCommit: true });
  assert.equal(mainPrompt[0].content.includes("只放在动态 user 的状态"), false);
  assert.match(mainPrompt.at(-1).content, /只放在动态 user 的状态/);
  assert.equal(reply.suppressed, true);
  assert.equal(reply.silent, true);
  assert.equal(reply.turn.assistantText, null);
  assert.equal(reply.chatEnded, undefined);
  assert.deepEqual(await store.history(conversationKey), []);

  const reviewPayload = JSON.parse(reviewArgs.messages.at(-1).content);
  assert.deepEqual(Object.keys(reviewPayload).sort(), [
    "current_user",
    "draft_reply",
    "style_flags",
  ]);
  assert.equal(reviewPayload.style_flags.silence_allowed, true);
  assert.equal(reviewPayload.current_user, "晚安");
  assert.equal(reviewArgs.thinking, "disabled");
  assert.equal(reviewArgs.maxTokens, 1000);
  assert.equal(reviewCalls, 1);

  assert.equal(await engine.commitTurn(reply), true);
  assert.deepEqual(
    (await store.history(conversationKey)).map((message) => message.role),
    ["user"],
  );
  const saved = await engine.conversationState.context(stateKey, configured());
  assert.equal(saved.conversation.topic, "今天有点累");
  assert.ok(saved.global);
});

test("review never rewrites tool rounds or asks for a second rewrite", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let reviewCalls = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        round += 1;
        return round === 1
          ? aiReply("", [{ name: "send_face", arguments: { faceId: 14 } }])
          : aiReply("工具结果保持不变。");
      },
      reviewChat: async () => {
        reviewCalls += 1;
        return aiReply(JSON.stringify(reviewObject({ reply: "不应采用" })));
      },
    },
  });
  const result = await engine.handle(
    event({ id: "review-tool", channel: "onebot" }),
  );
  assert.equal(result.text, "工具结果保持不变。");
  assert.deepEqual(result.faces, [14]);
  assert.equal(reviewCalls, 0);
  assert.equal(round, 2);
});

test("review receives only current text, draft, and aggregate style flags", async (t) => {
  const { store } = await setupStore(t);
  const input = event({
    id: "review-private-payload",
    channel: "onebot",
    userId: "10008",
    conversationId: "10008",
    text: "今天继续说这个",
  });
  const conversationKey = JSON.stringify(["onebot", "private", "10008", "10008"]);
  await store.append(conversationKey, [
    { role: "user", content: "历史用户秘密Z" },
    { role: "assistant", content: "重复卡点回答甲？" },
    { role: "assistant", content: "重复卡点回答乙？" },
  ]);
  let reviewArgs;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => aiReply("重复卡点回答丙，换个说法。"),
      reviewChat: async (args) => {
        reviewArgs = args;
        return aiReply(
          JSON.stringify(
            reviewObject({
              reply: "换个说法接住你。",
            }),
          ),
        );
      },
    },
  });
  await engine.handle(input);
  const payload = JSON.parse(reviewArgs.messages.at(-1).content);
  assert.deepEqual(Object.keys(payload).sort(), [
    "current_user",
    "draft_reply",
    "style_flags",
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /历史用户秘密Z/);
  assert.equal(payload.style_flags.consecutive_questions, 2);
  assert.equal(payload.style_flags.repeated_opening, true);
  assert.ok(payload.style_flags.draft_similarity > 0.3);
  for (const value of Object.values(payload.style_flags)) {
    assert.ok(typeof value === "number" || typeof value === "boolean");
  }
  assert.equal(reviewArgs.thinking, "disabled");
});

test("strict review parsing and review failure fall back to the original reply", async (t) => {
  const { store } = await setupStore(t);
  let malformedCalls = 0;
  const malformed = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => aiReply("正常原稿。"),
      reviewChat: async () => {
        malformedCalls += 1;
        return aiReply("{}");
      },
    },
  });
  const malformedResult = await malformed.handle(
    event({ id: "review-malformed", text: "你好" }),
  );
  assert.equal(malformedResult.text, "正常原稿。");
  assert.equal(malformedCalls, 1);

  let errorCalls = 0;
  const failed = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => aiReply("失败时仍用原稿。"),
      reviewChat: async () => {
        errorCalls += 1;
        throw new Error("review unavailable");
      },
    },
  });
  const failedResult = await failed.handle(
    event({ id: "review-failed", text: "你好" }),
  );
  assert.equal(failedResult.text, "失败时仍用原稿。");
  assert.equal(errorCalls, 1);
});

test("silence is limited to explicit acknowledgements and rejects unsafe text", async (t) => {
  const { store } = await setupStore(t);
  const run = async (text, attachments = []) => {
    const engine = new Engine({
      getConfig: async () => configured(),
      store,
      services: {
        chat: async () => aiReply("原稿"),
        reviewChat: async () =>
          aiReply(JSON.stringify(reviewObject({ reply: "", silence: true }))),
      },
    });
    return engine.handle(
      event({
        id: `silence-${Math.random()}`,
        channel: "onebot",
        userId: `user-${Math.random()}`,
        conversationId: `conversation-${Math.random()}`,
        text,
        attachments,
      }),
    );
  };

  const safeAck = await run("好的");
  assert.equal(safeAck.suppressed, true);
  assert.equal(safeAck.silent, true);
  for (const text of ["我想死了", "救命", "帮帮我？", "今天好累"]) {
    const result = await run(text);
    assert.equal(result.suppressed, undefined);
    assert.equal(result.text, "原稿");
  }
  const attachment = await run("好的", [
    { type: "image", url: "https://example.com/image.png" },
  ]);
  assert.equal(attachment.suppressed, undefined);
  assert.equal(attachment.text, "原稿");
});

test("cancellation during review is checked before committing history", async (t) => {
  const { store } = await setupStore(t);
  let reviewStarted;
  let releaseReview;
  const started = new Promise((resolve) => {
    reviewStarted = resolve;
  });
  const reviewGate = new Promise((resolve) => {
    releaseReview = resolve;
  });
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => aiReply("原稿"),
      reviewChat: async () => {
        reviewStarted();
        await reviewGate;
        return aiReply(JSON.stringify(reviewObject()));
      },
    },
  });
  const controller = new AbortController();
  const input = event({
    id: "review-cancel",
    channel: "onebot",
    userId: "10001",
    conversationId: "10001",
    text: "你好",
  });
  const pending = engine.handle(input, {
    signal: controller.signal,
    deferCommit: true,
  });
  await started;
  controller.abort();
  releaseReview();
  await assert.rejects(pending, /取消/);
  assert.deepEqual(
    await store.history(JSON.stringify(["onebot", "private", "10001", "10001"])),
    [],
  );
});

test("face tool validates integer 0..5000 on local and OneBot only", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        round += 1;
        if (round === 1) {
          return aiReply("", [{ name: "send_face", arguments: { faceId: 14 } }]);
        }
        return aiReply("表情已发送");
      },
    },
  });
  const result = await engine.handle(event({ id: "face", channel: "onebot" }));
  assert.deepEqual(result.faces, [14]);

  round = 0;
  const invalidEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        round += 1;
        if (round === 1) {
          return aiReply("", [{ name: "send_face", arguments: { faceId: 5001 } }]);
        }
        return aiReply("表情编号无效");
      },
    },
  });
  const invalid = await invalidEngine.handle(event({ id: "face-bad", channel: "qq" }));
  assert.deepEqual(invalid.faces, []);
});

test("QQ official channel neither advertises nor applies the face tool", async (t) => {
  const { store } = await setupStore(t);
  let receivedTools;
  let round = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ tools }) => {
        receivedTools = tools.map((tool) => tool.function.name);
        round += 1;
        return round === 1
          ? aiReply("", [{ name: "send_face", arguments: { faceId: 14 } }])
          : aiReply("当前通道不能发送这个表情");
      },
    },
  });
  const result = await engine.handle(event({ id: "qq-face", channel: "qq" }));
  assert.equal(receivedTools.includes("send_face"), false);
  assert.deepEqual(result.faces, []);
});

test("QQ official channel does not advertise QZone publishing or likes", async (t) => {
  const { store } = await setupStore(t);
  let receivedTools = [];
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ tools }) => {
        receivedTools = tools.map((tool) => tool.function.name);
        return aiReply("好");
      },
    },
  });
  await engine.handle(event({ id: "qq-tools", channel: "qq" }));
  assert.equal(receivedTools.includes("publish_qzone"), false);
  assert.equal(receivedTools.includes("like"), false);
});

test("OneBot can add up to four images to the reply and duplicates keep them", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let advertised = false;
  let lastToolResult;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ tools, messages }) => {
        advertised = tools.some((tool) => tool.function.name === "send_image");
        round += 1;
        if (round === 1) {
          return aiReply("", [
            {
              name: "send_image",
              arguments: { url: "https://example.com/one.png" },
            },
            {
              name: "send_image",
              arguments: { url: "https://example.com/two.png" },
            },
          ]);
        }
        lastToolResult = messages.at(-1).content;
        return aiReply("图片已加入回复");
      },
    },
  });
  const input = event({ id: "send-image", channel: "onebot" });
  const result = await engine.handle(input);
  assert.equal(advertised, true);
  assert.deepEqual(result.images, [
    "https://example.com/one.png",
    "https://example.com/two.png",
  ]);
  assert.match(lastToolResult, /appliedToReply/);
  const duplicate = await engine.handle(input);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.images, result.images);
});

test("send_image is hidden on QQ official and capped at four per reply", async (t) => {
  const { store } = await setupStore(t);
  let qqRound = 0;
  let qqTools;
  const qqEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ tools }) => {
        qqTools = tools.map((tool) => tool.function.name);
        qqRound += 1;
        return qqRound === 1
          ? aiReply("", [
              {
                name: "send_image",
                arguments: { url: "https://example.com/qq.png" },
              },
            ])
          : aiReply("当前官方通道不能发送图片");
      },
    },
  });
  const qqResult = await qqEngine.handle(
    event({ id: "qq-image", channel: "qq" }),
  );
  assert.equal(qqTools.includes("send_image"), false);
  assert.deepEqual(qqResult.images, []);

  let oneBotRound = 0;
  const oneBotEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        oneBotRound += 1;
        return oneBotRound === 1
          ? aiReply(
              "",
              Array.from({ length: 5 }, (_, index) => ({
                name: "send_image",
                arguments: { url: `https://example.com/${index + 1}.png` },
              })),
            )
          : aiReply("图片已处理");
      },
    },
  });
  const capped = await oneBotEngine.handle(
    event({ id: "image-cap", channel: "onebot" }),
  );
  assert.equal(capped.images.length, 4);
});

test("send_sticker uses the local library and nudges sticker replies", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let seenTools;
  let seenPrompt;
  let seenLast;
  let claimed;
  const stickers = {
    noteIncoming() {},
    isStickerEvent: () => true,
    catalog: async () => ({ count: 1, tags: ["可爱"], samples: [] }),
    claim: async (args) => {
      claimed = args;
      return {
        ok: true,
        entry: { id: "st_1", summary: "可爱猫猫", tags: ["可爱"] },
        dataUrl: "data:image/png;base64,AAAA",
      };
    },
  };
  const engine = new Engine({
    getConfig: async () => configured({ stickers: { enabled: true } }),
    store,
    services: {
      stickers,
      chat: async ({ tools, messages }) => {
        seenTools = tools.map((tool) => tool.function.name);
        seenPrompt = messages[0].content;
        if (round === 0) seenLast = messages.at(-1).content;
        round += 1;
        if (round === 1) {
          return aiReply("", [
            { name: "send_sticker", arguments: { mood: "可爱" } },
          ]);
        }
        return aiReply("好呀");
      },
    },
  });
  const result = await engine.handle(
    event({
      id: "sticker-tool",
      channel: "onebot",
      text: "",
      attachments: [
        {
          type: "image",
          url: "https://example.com/s.png",
          file: `${"a".repeat(32)}.png`,
          summary: "[动画表情]",
          subType: 1,
        },
      ],
    }),
  );
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0], "data:image/png;base64,AAAA");
  assert.equal(seenTools.includes("send_sticker"), true);
  assert.equal(seenTools.includes("sticker_catalog"), true);
  assert.doesNotMatch(seenPrompt, /对方刚发来表情包/);
  assert.match(seenLast, /当前消息带表情：是/);
  assert.match(seenLast, /不受主动发表情间隔限制/);
  assert.doesNotMatch(seenLast, /可用表情标签/);
  assert.match(seenLast, /需要主动发表情时，先调用 sticker_catalog/);
  assert.equal(claimed.mood, "可爱");
  assert.match(result.text, /好呀/);
  assert.equal(result.stickerOnly, false);
});

test("sticker-only replies are marked for delay exemption", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  const stickers = {
    noteIncoming() {},
    isStickerEvent: () => false,
    catalog: async () => ({ count: 1, tags: ["可爱"], samples: [] }),
    claim: async () => ({
      ok: true,
      entry: { id: "st_1", summary: "可爱猫猫", tags: ["可爱"] },
      dataUrl: "data:image/png;base64,AAAA",
    }),
  };
  const engine = new Engine({
    getConfig: async () => configured({ stickers: { enabled: true } }),
    store,
    services: {
      stickers,
      chat: async () => {
        round += 1;
        return round === 1
          ? aiReply("", [{ name: "send_sticker", arguments: { mood: "可爱" } }])
          : aiReply("");
      },
    },
  });
  const result = await engine.handle(
    event({ id: "sticker-only", channel: "onebot", text: "发个表情包" }),
  );
  assert.equal(result.images.length, 1);
  assert.equal(result.stickerOnly, true);
});

test("explicit sticker requests are passed to the library and prompt", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let claimed;
  let seenPrompt;
  let seenLast;
  const stickers = {
    noteIncoming() {},
    isStickerEvent: () => false,
    catalog: async () => ({ count: 1, tags: ["可爱"], samples: [] }),
    claim: async (args) => {
      claimed = args;
      return {
        ok: true,
        entry: { id: "st_1", summary: "可爱猫猫", tags: ["可爱"] },
        dataUrl: "data:image/png;base64,AAAA",
      };
    },
  };
  const engine = new Engine({
    getConfig: async () => configured({ stickers: { enabled: true } }),
    store,
    services: {
      stickers,
      chat: async ({ messages }) => {
        seenPrompt = messages[0].content;
        if (round === 0) seenLast = messages.at(-1).content;
        round += 1;
        if (round === 1) {
          return aiReply("", [
            { name: "send_sticker", arguments: { mood: "可爱" } },
          ]);
        }
        return aiReply("发好了");
      },
    },
  });
  const result = await engine.handle(
    event({ id: "explicit-sticker", channel: "onebot", text: "发个表情包" }),
  );
  assert.equal(claimed.explicit, true);
  assert.match(seenPrompt, /用户明确要表情包或对方发来表情包时/);
  assert.match(seenLast, /可直接调用 send_sticker/);
  assert.match(seenLast, /约 5 分钟/);
  assert.equal(result.images.length, 1);
});

test("proactive stickers load the full catalog before sending", async (t) => {
  const { store } = await setupStore(t);
  const fullTags = Array.from({ length: 30 }, (_, index) => `标签${index + 1}`);
  let round = 0;
  let claimed;
  let seenLast;
  let catalogResult;
  const stickers = {
    noteIncoming() {},
    isStickerEvent: () => false,
    catalog: async () => ({ count: 1, tags: ["可爱"], samples: [] }),
    allTags: async () => ({ count: 1, tags: fullTags }),
    claim: async (args) => {
      claimed = args;
      return {
        ok: true,
        entry: { id: "st_1", summary: "开心猫猫", tags: [args.mood] },
        dataUrl: "data:image/png;base64,AAAA",
      };
    },
  };
  const engine = new Engine({
    getConfig: async () => configured({ stickers: { enabled: true } }),
    store,
    services: {
      stickers,
      chat: async ({ messages }) => {
        if (round === 0) {
          seenLast = messages.at(-1).content;
        } else if (round === 1) {
          catalogResult = messages.at(-1).content;
        }
        round += 1;
        if (round === 1) {
          return aiReply("", [{ name: "sticker_catalog", arguments: {} }]);
        }
        if (round === 2) {
          return aiReply("", [
            { name: "send_sticker", arguments: { mood: "标签30" } },
          ]);
        }
        return aiReply("好耶");
      },
    },
  });
  const result = await engine.handle(
    event({ id: "sticker-lazy", channel: "onebot", text: "今天有点开心" }),
  );
  assert.doesNotMatch(seenLast, /可用表情标签/);
  assert.match(seenLast, /先调用 sticker_catalog/);
  assert.match(catalogResult, /标签30/);
  assert.match(catalogResult, /标签1/);
  assert.equal(claimed.mood, "标签30");
  assert.equal(result.images.length, 1);
  assert.equal(result.stickerOnly, false);
});

test("proactive send_sticker returns the catalog before sending", async (t) => {
  const { store } = await setupStore(t);
  const fullTags = Array.from({ length: 25 }, (_, index) => `心情${index + 1}`);
  let round = 0;
  let claims = 0;
  let firstToolResult;
  const stickers = {
    noteIncoming() {},
    isStickerEvent: () => false,
    catalog: async () => ({ count: 1, tags: ["可爱"], samples: [] }),
    allTags: async () => ({ count: 1, tags: fullTags }),
    claim: async (args) => {
      claims += 1;
      return {
        ok: true,
        entry: { id: "st_1", summary: "开心猫猫", tags: [args.mood] },
        dataUrl: "data:image/png;base64,AAAA",
      };
    },
  };
  const engine = new Engine({
    getConfig: async () => configured({ stickers: { enabled: true } }),
    store,
    services: {
      stickers,
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply("", [
            { name: "send_sticker", arguments: { mood: "开心" } },
          ]);
        }
        if (round === 2) {
          firstToolResult = messages.at(-1).content;
          return aiReply("", [
            { name: "send_sticker", arguments: { mood: "心情25" } },
          ]);
        }
        return aiReply("好耶");
      },
    },
  });
  const result = await engine.handle(
    event({ id: "sticker-needs-catalog", channel: "onebot", text: "有点开心" }),
  );
  assert.match(firstToolResult, /need_catalog/);
  assert.match(firstToolResult, /心情25/);
  assert.equal(claims, 1);
  assert.equal(result.images.length, 1);
});

test("images already added to a reply survive a later AI failure", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        round += 1;
        if (round === 1) {
          return aiReply("", [
            {
              name: "send_image",
              arguments: { url: "https://example.com/kept.png" },
            },
          ]);
        }
        throw new Error("later model round failed");
      },
    },
  });
  const result = await engine.handle(
    event({ id: "image-error", channel: "onebot" }),
  );
  assert.deepEqual(result.images, ["https://example.com/kept.png"]);
  assert.match(result.text, /出现错误/);
});

test("like requires onebot and explicit actionUsers authorization", async (t) => {
  const { store } = await setupStore(t);
  let chats = 0;
  let likes = 0;
  const makeEngine = (config, channel, userId = "member") =>
    new Engine({
      getConfig: async () => config,
      store,
      services: {
        chat: async () => {
          chats += 1;
          return chats % 2 === 1
            ? aiReply("", [
                { name: "like", arguments: { userId: "123456", times: 1 } },
              ])
            : aiReply("点赞请求已处理");
        },
        like: async () => {
          likes += 1;
          return { ok: true };
        },
      },
      });
  let input = event({
    id: "qq-like",
    channel: "qq",
    scope: "group",
    conversationId: "qq-group",
    groupId: "group-1",
    userId: "owner",
  });
  await makeEngine(
    configured({ policy: { actionUsers: ["owner"] } }),
    "qq",
    "owner",
  ).handle(input);
  assert.equal(likes, 0);

  input = { ...input, id: "onebot-unauthorized", channel: "onebot", userId: "member" };
  await makeEngine(configured(), "onebot", "member").handle(input);
  assert.equal(likes, 0);

  input = { ...input, id: "onebot-authorized", userId: "owner" };
  await makeEngine(
    configured({ policy: { actionUsers: ["owner"] } }),
    "onebot",
    "owner",
  ).handle(input);
  assert.equal(likes, 1);
});

test("like rejects counts above the OneBot adapter limit", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let likes = 0;
  const engine = new Engine({
    getConfig: async () =>
      configured({ policy: { actionUsers: ["owner"] } }),
    store,
    services: {
      chat: async () => {
        round += 1;
        return round === 1
          ? aiReply("", [
              {
                name: "like",
                arguments: { userId: "123456", times: 11 },
              },
            ])
          : aiReply("点赞次数无效");
      },
      like: async () => {
        likes += 1;
      },
    },
  });
  await engine.handle(
    event({
      id: "like-too-many",
      channel: "onebot",
      userId: "owner",
      scope: "group",
      groupId: "group-1",
      conversationId: "onebot-group",
    }),
  );
  assert.equal(likes, 0);
});

test("like targets must be numeric and obey a non-empty allowedUsers list", async (t) => {
  const { store } = await setupStore(t);
  let config = configured({
    policy: {
      actionUsers: ["owner"],
      allowedUsers: ["owner", "654321"],
    },
  });
  const rounds = new Map();
  let likes = 0;
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async ({ messages }) => {
        const userText = messages
          .filter((message) => message.role === "user")
          .at(-1).content;
        const round = (rounds.get(userText) ?? 0) + 1;
        rounds.set(userText, round);
        if (round === 1) {
          const target = userText === "nonnumeric" ? "not-a-number" : "123456";
          return aiReply("", [
            {
              name: "like",
              arguments: { userId: target, times: 1 },
            },
          ]);
        }
        return aiReply("点赞请求已处理");
      },
      like: async () => {
        likes += 1;
      },
    },
  });
  const base = {
    channel: "onebot",
    userId: "owner",
    scope: "group",
    groupId: "group-1",
    conversationId: "onebot-group",
  };
  await engine.handle(
    event({ ...base, id: "like-nonnumeric", text: "nonnumeric" }),
  );
  assert.equal(likes, 0);
  await engine.handle(
    event({ ...base, id: "like-outside-list", text: "outside" }),
  );
  assert.equal(likes, 0);
  config = {
    ...config,
    policy: {
      ...config.policy,
      allowedUsers: ["owner", "123456"],
    },
  };
  await engine.handle(
    event({ ...base, id: "like-inside-list", text: "inside" }),
  );
  assert.equal(likes, 1);
});

test("ordinary group members cannot publish; local owner can publish via service", async (t) => {
  const { store } = await setupStore(t);
  const published = [];
  let memberRound = 0;
  const memberEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        memberRound += 1;
        return memberRound === 1
          ? aiReply("", [
              {
                name: "publish_qzone",
                arguments: { text: "普通成员不应发布" },
              },
            ])
          : aiReply("没有外部操作权限");
      },
      publishQzone: async (text) => published.push(text),
    },
  });
  await memberEngine.handle(
    event({
      id: "group-publish",
      channel: "onebot",
      scope: "group",
      conversationId: "onebot-group",
      groupId: "group-1",
      userId: "member",
    }),
  );
  assert.deepEqual(published, []);

  let ownerRound = 0;
  const ownerEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        ownerRound += 1;
        return ownerRound === 1
          ? aiReply("", [
              {
                name: "publish_qzone",
                arguments: { text: "来自本地控制台" },
              },
            ])
          : aiReply("空间动态已提交");
      },
      publishQzone: async (text) => published.push(text),
    },
  });
  await ownerEngine.handle(event({ id: "local-publish", text: "帮我发一条空间动态" }));
  assert.deepEqual(published, ["来自本地控制台"]);
});

test("publish tool needs an explicit request unless automatic publishing is enabled", async (t) => {
  const { store } = await setupStore(t);
  let published = 0;
  let round = 0;
  const config = configured({
    policy: { actionUsers: ["owner"] },
    qzone: { autoPublish: false },
  });
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async () => {
        round += 1;
        return round === 1
          ? aiReply("", [
              { name: "publish_qzone", arguments: { text: "模型擅自想发的内容" } },
            ])
          : aiReply("没有发布");
      },
      publishQzone: async () => {
        published += 1;
      },
    },
  });
  await engine.handle(event({ id: "implicit-publish", channel: "onebot", text: "你好" }));
  assert.equal(published, 0);
});

test("publish tool forwards up to four HTTPS images and rejects invalid URLs", async (t) => {
  const { store } = await setupStore(t);
  const calls = [];
  let round = 0;
  const engine = new Engine({
    getConfig: async () =>
      configured({
        policy: { actionUsers: ["owner"] },
        qzone: { autoPublish: true },
      }),
    store,
    services: {
      chat: async () => {
        round += 1;
        return round === 1
          ? aiReply("", [
              {
                name: "publish_qzone",
                arguments: {
                  text: "带图动态",
                  images: [
                    "https://example.com/1.png",
                    "https://example.com/2.jpg",
                  ],
                },
              },
            ])
          : aiReply("空间动态已提交");
      },
      publishQzone: async (text, options) => {
        calls.push({ text, options });
      },
    },
  });
  await engine.handle(event({ id: "publish-images", channel: "onebot" }));
  assert.deepEqual(calls, [
    {
      text: "带图动态",
      options: {
        images: ["https://example.com/1.png", "https://example.com/2.jpg"],
      },
    },
  ]);

  round = 0;
  let invalidCalls = 0;
  let invalidRound = 0;
  const invalidEngine = new Engine({
    getConfig: async () =>
      configured({
        policy: { actionUsers: ["owner"] },
        qzone: { autoPublish: true },
      }),
    store,
    services: {
      chat: async () => {
        invalidRound += 1;
        return invalidRound === 1
          ? aiReply("", [
              {
                name: "publish_qzone",
                arguments: {
                  text: "非法图片",
                  images: ["http://example.com/a.png"],
                },
              },
            ])
          : aiReply("未发布");
      },
      publishQzone: async () => {
        invalidCalls += 1;
      },
    },
  });
  await invalidEngine.handle(event({ id: "publish-invalid", channel: "onebot" }));
  assert.equal(invalidCalls, 0);
});

test("denied conversations are suppressed without a reply payload", async (t) => {
  const { store } = await setupStore(t);
  const engine = new Engine({
    getConfig: async () =>
      configured({ policy: { allowedUsers: ["allowed-user"] } }),
    store,
    services: { chat: async () => aiReply("不应生成") },
  });
  const result = await engine.handle(
    event({ id: "denied", channel: "qq", userId: "stranger" }),
  );
  assert.deepEqual(result, {
    text: "",
    faces: [],
    images: [],
    suppressed: true,
  });
});

test("successful or uncertain external actions are never replayed after a later AI failure", async (t) => {
  for (const mode of ["success", "unknown"]) {
    const { store } = await setupStore(t);
    let chatCalls = 0;
    let publishCalls = 0;
    const config = configured({
      policy: { actionUsers: ["owner"] },
      qzone: { autoPublish: true },
    });
    const engine = new Engine({
      getConfig: async () => config,
      store,
      services: {
        chat: async () => {
          chatCalls += 1;
          if (chatCalls === 1) {
            return aiReply("", [
              {
                name: "publish_qzone",
                arguments: { text: "只发布一次" },
              },
            ]);
          }
          throw new Error("second AI round failed");
        },
        publishQzone: async () => {
          publishCalls += 1;
          if (mode === "unknown") throw new Error("network result unknown");
        },
      },
    });
    const input = event({
      id: `side-effect-${mode}`,
      channel: "onebot",
      text: "自动发空间",
    });
    const first = await engine.handle(input);
    assert.match(first.text, mode === "success" ? /已经执行/ : /结果不确定/);
    const retried = await engine.handle(input);
    assert.equal(retried.duplicate, true);
    assert.equal(chatCalls, 2);
    assert.equal(publishCalls, 1);
  }
});

test("external actions re-read policy immediately before dispatch", async (t) => {
  const { store } = await setupStore(t);
  let config = configured({
    policy: { actionUsers: ["owner"] },
    qzone: { autoPublish: true },
  });
  let round = 0;
  let published = 0;
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async () => {
        round += 1;
        if (round === 1) {
          config = {
            ...config,
            policy: { ...config.policy, paused: true },
          };
          return aiReply("", [
            {
              name: "publish_qzone",
              arguments: { text: "暂停后不应发布" },
            },
          ]);
        }
        return aiReply("操作已因暂停取消");
      },
      publishQzone: async () => {
        published += 1;
      },
    },
  });
  await engine.handle(event({ id: "pause-race", channel: "onebot" }));
  assert.equal(published, 0);
});

test("a non-sent qzone status is reported as failure, not success", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  const toolResults = [];
  const engine = new Engine({
    getConfig: async () =>
      configured({
        policy: { actionUsers: ["owner"] },
        qzone: { autoPublish: true },
      }),
    store,
    services: {
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply("", [
            {
              name: "publish_qzone",
              arguments: { text: "被拦截的动态" },
            },
          ]);
        }
        toolResults.push(messages.at(-1).content);
        return aiReply("空间发布被拦截");
      },
      publishQzone: async () => ({
        status: "blocked",
        message: "需要重新登录",
      }),
    },
  });
  await engine.handle(
    event({ id: "publish-blocked", channel: "onebot", text: "发空间" }),
  );
  assert.match(toolResults[0], /blocked/);
  assert.match(toolResults[0], /ok.*false/);
});

test("paused and hourly action limits remain enforced", async (t) => {
  const { store } = await setupStore(t);
  const calls = [];
  let round = 0;
  const chat = async () => {
    round += 1;
    return round % 2 === 1
      ? aiReply("", [
          {
            name: "publish_qzone",
            arguments: { text: "动态" },
          },
        ])
      : aiReply("操作结束");
  };
  let config = configured({ policy: { paused: true, actionUsers: ["owner"] } });
  let engine = new Engine({
    getConfig: async () => config,
    store,
    services: { chat, publishQzone: async (text) => calls.push(text) },
  });
  await engine.handle(event({ id: "paused", text: "帮我发空间" }));
  assert.deepEqual(calls, []);

  config = configured({
    policy: { paused: false, maxActionsPerHour: 1, actionUsers: ["owner"] },
  });
  engine = new Engine({
    getConfig: async () => config,
    store,
    services: { chat, publishQzone: async (text) => calls.push(text) },
  });
  await engine.handle(event({ id: "limit-1", text: "帮我发空间" }));
  await engine.handle(event({ id: "limit-2", text: "帮我发空间" }));
  assert.deepEqual(calls, ["动态"]);
});

test("AI history and memory never cross groups, private chats, or linked identities", async (t) => {
  const { store } = await setupStore(t);
  await store.remember(
    JSON.stringify(["private-memory", "onebot", "private-user"]),
    "私聊用户秘密",
  );
  await store.remember(
    JSON.stringify(["group-memory", "onebot", "group-b"]),
    "B群秘密",
  );
  const prompts = [];
  let config = configured();
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async ({ messages }) => {
        prompts.push(messages.map((item) => item.content).join("\n"));
        return aiReply("看到了");
      },
    },
  });
  await engine.handle(
    event({
      id: "private",
      channel: "onebot",
      userId: "private-user",
      conversationId: "private",
    }),
  );
  await engine.handle(
    event({
      id: "group-a",
      channel: "onebot",
      scope: "group",
      userId: "private-user",
      conversationId: "group-a-chat",
      groupId: "group-a",
    }),
  );
  assert.match(prompts[0], /私聊用户秘密/);
  assert.doesNotMatch(prompts[1], /B群秘密/);
  assert.doesNotMatch(prompts[1], /私聊用户秘密/);

  config = configured({
    identityLinks: { "qq:alice": "shared-alice" },
  });
  await store.remember(
    JSON.stringify(["identity-memory", "shared-alice"]),
    "显式绑定后的共享信息",
  );
  const linkedEngine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chat: async ({ messages }) => {
        prompts.push(messages.map((item) => item.content).join("\n"));
        return aiReply("绑定记忆可见");
      },
    },
  });
  await linkedEngine.handle(
    event({
      id: "linked",
      channel: "qq",
      userId: "alice",
      conversationId: "qq-private",
    }),
  );
  assert.match(prompts.at(-1), /显式绑定后的共享信息/);
});

test("engine injects the highest-importance memories within the configured limit", async (t) => {
  const { store } = await setupStore(t);
  const key = JSON.stringify(["private-memory", "onebot", "remember-user"]);
  await store.remember(key, "用户喜欢低优先级的事", {
    type: "fact",
    importance: 3,
  });
  await store.remember(key, "用户喜欢无糖奶茶", {
    type: "preference",
    importance: 9,
  });
  await store.remember(key, "用户习惯早起", {
    type: "fact",
    importance: 7,
  });
  let prompt = "";
  const engine = new Engine({
    getConfig: async () => configured({ memory: { maxInjected: 2 } }),
    store,
    services: {
      chat: async ({ messages }) => {
        prompt = messages.at(-1).content;
        return aiReply("好");
      },
    },
  });
  await engine.handle(
    event({
      id: "inject",
      channel: "onebot",
      userId: "remember-user",
      conversationId: "remember-user",
    }),
  );
  assert.match(prompt, /用户喜欢无糖奶茶/);
  assert.match(prompt, /偏好\|9/);
  assert.match(prompt, /用户习惯早起/);
  assert.ok(prompt.indexOf("用户喜欢无糖奶茶") < prompt.indexOf("用户习惯早起"));
  assert.doesNotMatch(prompt, /用户喜欢低优先级的事/);
});

test("engine queues automatic memory extraction after a successful reply", async (t) => {
  const { store } = await setupStore(t);
  const calls = [];
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => aiReply("好呀"),
      memory: {
        afterTurn(args) {
          calls.push(args);
          return Promise.resolve();
        },
        async flush() {
          return true;
        },
      },
    },
  });
  await engine.handle(
    event({
      id: "auto-memory",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "我喜欢热茶",
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].memoryKey, JSON.stringify(["private-memory", "onebot", "10001"]));
  assert.ok(calls[0].history.every((message) => message.content !== "我喜欢热茶"));
  assert.equal(await engine.flushMemory(), true);
});

test("engine appends the short-reply style contract after other prompt sections", async (t) => {
  const { store } = await setupStore(t);
  let prompt = "";
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ messages }) => {
        prompt = messages[0].content;
        return aiReply("在");
      },
    },
  });
  await engine.handle(event({ id: "style", text: "在嘛" }));
  const styleAt = prompt.indexOf("【聊天方式，优先级最高】");
  const toolAt = prompt.indexOf("只能使用已提供的工具");
  assert.ok(styleAt > toolAt);
  assert.match(prompt, /默认只回一句/);
  assert.match(prompt, /不要模仿它们的长度和语气/);
});

test("engine skips automatic extraction when memory is disabled or already saved by tool", async (t) => {
  const { store } = await setupStore(t);
  let memoryCalls = 0;
  let round = 0;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async () => {
        round += 1;
        return round === 1
          ? aiReply("", [
              { name: "remember", arguments: { text: "用户下周三考试" } },
            ])
          : aiReply("记住啦");
      },
      memory: {
        afterTurn() {
          memoryCalls += 1;
          return Promise.resolve();
        },
      },
    },
  });
  const rememberedResult = await engine.handle(
    event({
      id: "tool-memory",
      channel: "onebot",
      userId: "10002",
      conversationId: "10002",
      text: "记住我下周三考试",
    }),
  );
  assert.equal(memoryCalls, 0);
  assert.equal(rememberedResult.actionExecuted, true);
  assert.equal(
    (await store.memories(JSON.stringify(["private-memory", "onebot", "10002"]))).length,
    1,
  );

  const disabled = new Engine({
    getConfig: async () => configured({ memory: { autoExtract: false } }),
    store,
    services: {
      chat: async () => aiReply("好"),
      memory: {
        afterTurn() {
          memoryCalls += 1;
          return Promise.resolve();
        },
      },
    },
  });
  await disabled.handle(
    event({
      id: "disabled-memory",
      channel: "onebot",
      userId: "10003",
      conversationId: "10003",
    }),
  );
  assert.equal(memoryCalls, 0);
});

test("only valid https image URLs are sent to the vision model", async (t) => {
  const { store } = await setupStore(t);
  let receivedImages;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ imageUrls }) => {
        receivedImages = imageUrls;
        return aiReply("图片已查看");
      },
    },
  });
  await engine.handle(
    event({
      id: "images",
      channel: "qq",
      attachments: [
        { type: "image", url: "https://example.com/a.png" },
        { type: "image", url: "http://example.com/b.png" },
        { type: "file", url: "file:///etc/passwd" },
      ],
    }),
  );
  assert.deepEqual(receivedImages, ["https://example.com/a.png"]);
});

test("ai chat uses a stable OpenAI-compatible endpoint and parses tools", async () => {
  let request;
  const result = await aiChat({
    config: {
      baseUrl: "https://api.example.com/v1/",
      apiKey: "top-secret",
      model: "vision-model",
      temperature: 0.4,
      reasoningEffort: "max",
    },
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "看图" },
    ],
    imageUrls: ["https://example.com/image.png"],
    tools: [{ type: "function", function: { name: "remember" } }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "好",
                  reasoning_content: "internal thought",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "remember",
                        arguments: "{\"text\":\"记住这件事\"}",
                      },
                    },
                  ],
                },
              },
            ],
          };
        },
      };
    },
  });
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer top-secret");
  const body = JSON.parse(request.options.body);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.reasoning_effort, "max");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(result.rawMessage.reasoning_content, "internal thought");
  assert.deepEqual(body.messages.at(-1).content, [
    { type: "text", text: "看图" },
    { type: "image_url", image_url: { url: "https://example.com/image.png" } },
  ]);
  assert.deepEqual(result.toolCalls[0].arguments, { text: "记住这件事" });
});

test("ai chat forwards external cancellation signals", async () => {
  const controller = new AbortController();
  const pending = aiChat({
    config: {
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      model: "deepseek-flash",
      temperature: 0.8,
      reasoningEffort: "high",
    },
    messages: [{ role: "user", content: "你好" }],
    signal: controller.signal,
    fetchImpl: async (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error instanceof AIRequestError, true);
    assert.equal(error.code, "CANCELLED");
    return true;
  });
});

test("ai chat supports low-cost memory judge overrides", async () => {
  let body;
  const result = await aiChat({
    config: {
      baseUrl: "https://api.example.com",
      apiKey: "top-secret",
      model: "main-model",
      temperature: 0.8,
      reasoningEffort: "high",
    },
    messages: [{ role: "user", content: "判断" }],
    maxTokens: 300,
    temperature: 0.1,
    thinking: "disabled",
    reasoningEffort: "low",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "{}" } }] };
        },
      };
    },
  });
  assert.equal(body.temperature, 0.1);
  assert.equal(body.max_tokens, 300);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in body, false);
  assert.equal(result.content, "{}");
});

test("ai HTTP failures do not expose the API key", async () => {
  const error = await aiChat({
    config: {
      baseUrl: "https://api.example.com",
      apiKey: "never-print-this",
      model: "model",
      temperature: 0.8,
    },
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }).catch((caught) => caught);
  assert.ok(error instanceof AIRequestError);
  assert.equal(error.code, "HTTP_ERROR");
  assert.doesNotMatch(error.message, /never-print-this/);
});

test("recall searches full memory first and skips history on a hit", async (t) => {
  const { store } = await setupStore(t);
  const memoryKey = JSON.stringify(["private-memory", "onebot", "10001"]);
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  await store.remember(memoryKey, "用户养的猫叫咪咪", { importance: 8 });
  await store.append(conversationKey, [
    { role: "user", content: "我家猫叫咪咪" },
  ]);
  let round = 0;
  let fetched = 0;
  let toolResult;
  let prompt = "";
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          prompt = messages[0].content;
          return aiReply("", [
            { name: "recall", arguments: { query: "猫 咪咪" } },
          ]);
        }
        toolResult = JSON.parse(messages.at(-1).content);
        return aiReply("你养的猫叫咪咪。");
      },
      fetchHistory: async () => {
        fetched += 1;
        return [];
      },
    },
  });
  const result = await engine.handle(
    event({
      id: "recall-memory",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "我以前养的猫叫什么？",
    }),
  );
  assert.match(prompt, /先调用 recall/);
  assert.equal(toolResult.found, true);
  assert.equal(toolResult.source, "memory");
  assert.equal(toolResult.results[0].text, "用户养的猫叫咪咪");
  assert.equal(fetched, 0);
  assert.equal(result.needsSlowPacing, true);
  assert.equal(result.pacingHints.recall, true);
  assert.equal(result.actionExecuted, undefined);
});

test("recall falls back to local history before OneBot history", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  await store.append(conversationKey, [
    { role: "user", content: "我家猫叫咪咪" },
  ]);
  let round = 0;
  let fetched = 0;
  let toolResult;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply("", [
            { name: "recall", arguments: { query: "猫 咪咪" } },
          ]);
        }
        toolResult = JSON.parse(messages.at(-1).content);
        return aiReply("叫咪咪。");
      },
      fetchHistory: async () => {
        fetched += 1;
        return [];
      },
    },
  });
  await engine.handle(
    event({
      id: "recall-local-history",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "你还记得我的猫吗？",
    }),
  );
  assert.equal(toolResult.found, true);
  assert.equal(toolResult.source, "history");
  assert.equal(toolResult.origin, "local");
  assert.equal(fetched, 0);
});

test("recall fetches OneBot history only after memory and local misses", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let fetched = 0;
  let toolResult;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply("", [
            { name: "recall", arguments: { query: "猫 咪咪" } },
          ]);
        }
        toolResult = JSON.parse(messages.at(-1).content);
        return aiReply("翻了翻记录，叫咪咪。");
      },
      fetchHistory: async () => {
        fetched += 1;
        return [
          { role: "user", text: "以前的猫叫咪咪", time: Date.now() },
          { role: "assistant", text: "记住了", time: Date.now() - 1 },
        ];
      },
    },
  });
  await engine.handle(
    event({
      id: "recall-remote-history",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "我以前养的猫叫什么？",
    }),
  );
  assert.equal(fetched, 1);
  assert.equal(toolResult.found, true);
  assert.equal(toolResult.source, "history");
  assert.equal(toolResult.origin, "napcat");
});

test("recall tells the model to admit forgetting when everything misses", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let toolResult;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply("", [
            { name: "recall", arguments: { query: "完全不存在的细节" } },
          ]);
        }
        toolResult = JSON.parse(messages.at(-1).content);
        return aiReply("忘了。");
      },
      fetchHistory: async () => [],
    },
  });
  await engine.handle(
    event({
      id: "recall-none",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "你还记得那件事吗？",
    }),
  );
  assert.equal(toolResult.found, false);
  assert.equal(toolResult.source, "none");
  assert.match(toolResult.hint, /忘记了|没听说过/);
});

test("web search runs after the model decides and never sends progress text", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let seenTools;
  let seenSearch;
  let toolResult;
  const webSearch = {
    async search(args) {
      seenSearch = args;
      return {
        ok: true,
        found: true,
        query: args.query,
        results: [
          {
            title: "DeepSeek Search",
            url: "https://example.com/search",
            site: "Example",
            date: null,
            score: 2,
            authority: 3,
            summary: "DeepSeek 提供网页搜索与抓取接口。",
          },
        ],
      };
    },
    async fetch() {
      throw new Error("unexpected fetch");
    },
  };
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      webSearch,
      chat: async ({ tools, messages }) => {
        if (round === 0) {
          round = 1;
          seenTools = tools.map((tool) => tool.function.name);
          return aiReply("好的，我现在来搜索", [
            {
              name: "web_search",
              arguments: { query: "DeepSeek 搜索", count: 3 },
            },
          ]);
        }
        toolResult = JSON.parse(messages.at(-1).content);
        return aiReply("DeepSeek 有联网搜索接口。");
      },
    },
  });

  const result = await engine.handle(
    event({ id: "web-search-ok", text: "DeepSeek 搜索是什么" }),
  );

  assert.equal(seenTools.includes("web_search"), true);
  assert.equal(seenTools.includes("web_fetch"), true);
  assert.equal(seenSearch.query, "DeepSeek 搜索");
  assert.equal(seenSearch.count, 3);
  assert.equal(toolResult.found, true);
  assert.equal(result.text, "DeepSeek 有联网搜索接口。");
  assert.doesNotMatch(result.text, /搜索一下|现在来搜索/);
});

test("engine triggers an external QZone comment for a group mention with a link", async (t) => {
  const { store } = await setupStore(t);
  let mentioned = null;
  let seenLast = "";
  const qzoneComments = {
    async handleMention({ event, links }) {
      mentioned = { event, links };
      return { ok: true, text: "好呀" };
    },
  };
  const engine = new Engine({
    getConfig: async () => configured({ qzoneComments: { enabled: true } }),
    store,
    services: {
      qzoneComments,
      chat: async ({ messages }) => {
        seenLast = messages.at(-1).content;
        return aiReply("评好了");
      },
    },
  });

  await engine.handle(
    event({
      id: "qzone-mention",
      channel: "onebot",
      scope: "group",
      userId: "10001",
      conversationId: "20002",
      groupId: "20002",
      mentionedSelf: true,
      text: "帮我评一下",
      links: ["https://user.qzone.qq.com/333333/mood/post-1"],
    }),
  );

  assert.ok(mentioned);
  assert.equal(mentioned.links.length, 1);
  assert.match(seenLast, /本轮空间评论：已评论：好呀/);
});

test("web search tools are omitted when disabled", async (t) => {
  const { store } = await setupStore(t);
  let seenTools;
  const engine = new Engine({
    getConfig: async () => configured({ webSearch: { enabled: false } }),
    store,
    services: {
      webSearch: {
        async search() {
          throw new Error("should not search");
        },
      },
      chat: async ({ tools }) => {
        seenTools = tools.map((tool) => tool.function.name);
        return aiReply("在的。");
      },
    },
  });

  await engine.handle(event({ id: "web-search-disabled" }));

  assert.equal(seenTools.includes("web_search"), false);
  assert.equal(seenTools.includes("web_fetch"), false);
});

test("search and fetch switches are independent", async (t) => {
  const { store } = await setupStore(t);
  const names = async (webSearch) => {
    let seenTools;
    const engine = new Engine({
      getConfig: async () => configured({ webSearch }),
      store,
      services: {
        webSearch: {
          async search() {
            return { ok: true, found: true, query: "test", results: [] };
          },
          async fetch() {
            return { ok: true, found: true, content: "test" };
          },
        },
        chat: async ({ tools }) => {
          seenTools = tools.map((tool) => tool.function.name);
          return aiReply("在的。");
        },
      },
    });
    await engine.handle(event({ id: `web-switch-${Math.random()}` }));
    return seenTools;
  };
  const searchOnly = await names({ searchEnabled: true, fetchEnabled: false });
  assert.equal(searchOnly.includes("web_search"), true);
  assert.equal(searchOnly.includes("web_fetch"), false);
  const fetchOnly = await names({ searchEnabled: false, fetchEnabled: true });
  assert.equal(fetchOnly.includes("web_search"), false);
  assert.equal(fetchOnly.includes("web_fetch"), true);
});

test("web search defaults to four calls per turn", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let searchCalls = 0;
  let lastToolResult;
  const engine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      webSearch: {
        async search() {
          searchCalls += 1;
          return { ok: true, found: true, query: "test", results: [] };
        },
      },
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply(
            "",
            Array.from({ length: 5 }, () => ({
              name: "web_search",
              arguments: { query: "test" },
            })),
          );
        }
        lastToolResult = JSON.parse(messages.at(-1).content);
        return aiReply("查完了。");
      },
    },
  });
  const result = await engine.handle(event({ id: "web-call-limit" }));
  assert.equal(searchCalls, 4);
  assert.match(lastToolResult.error, /联网调用次数已达上限（4）/);
  assert.equal(result.text, "查完了。");
});

test("tool call limit is configurable", async (t) => {
  const { store } = await setupStore(t);
  let round = 0;
  let lastToolResult;
  const engine = new Engine({
    getConfig: async () => configured({ maxToolCallsPerTurn: 2 }),
    store,
    services: {
      chat: async ({ messages }) => {
        round += 1;
        if (round === 1) {
          return aiReply(
            "",
            [1, 2, 3].map((faceId) => ({
              name: "send_face",
              arguments: { faceId },
            })),
          );
        }
        lastToolResult = JSON.parse(messages.at(-1).content);
        return aiReply("好了。");
      },
    },
  });
  const result = await engine.handle(event({ id: "tool-call-limit" }));
  assert.deepEqual(result.faces, [1, 2]);
  assert.match(lastToolResult.error, /工具调用次数已达上限（2）/);
  assert.equal(result.text, "好了。");
});

test("group chats only search after an explicit request", async (t) => {
  const { store } = await setupStore(t);
  let blockedRound = 0;
  let blockedResult;
  const blockedEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      webSearch: {
        async search() {
          throw new Error("should not search");
        },
      },
      chat: async ({ messages }) => {
        blockedRound += 1;
        if (blockedRound === 1) {
          return aiReply("", [
            { name: "web_search", arguments: { query: "今天的新闻" } },
          ]);
        }
        blockedResult = JSON.parse(messages.at(-1).content);
        return aiReply("我不太清楚。");
      },
    },
  });

  await blockedEngine.handle(
    event({
      id: "group-web-blocked",
      channel: "onebot",
      scope: "group",
      userId: "10001",
      conversationId: "20002",
      groupId: "20002",
      text: "群里有人知道今天的新闻吗",
    }),
  );
  assert.equal(blockedResult.ok, false);
  assert.match(blockedResult.error, /明确要求搜索/);

  let allowedRound = 0;
  let searchCalls = 0;
  const allowedEngine = new Engine({
    getConfig: async () => configured(),
    store,
    services: {
      webSearch: {
        async search() {
          searchCalls += 1;
          return { ok: true, found: true, query: "新闻", results: [] };
        },
      },
      chat: async () => {
        allowedRound += 1;
        return allowedRound === 1
          ? aiReply("", [{ name: "web_search", arguments: { query: "新闻" } }])
          : aiReply("我去看了，没有新的。");
      },
    },
  });

  await allowedEngine.handle(
    event({
      id: "group-web-allowed",
      channel: "onebot",
      scope: "group",
      userId: "10001",
      conversationId: "20002",
      groupId: "20002",
      text: "帮我搜一下今天的新闻",
    }),
  );
  assert.equal(searchCalls, 1);
});

test("ai.historyMessages controls direct context and 0 injects all retained history", async (t) => {
  const { store } = await setupStore(t);
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `消息-${index}`,
  }));
  await store.append(conversationKey, messages);

  let captured = [];
  const twoEngine = new Engine({
    getConfig: async () => configured({ ai: { historyMessages: 2 } }),
    store,
    services: {
      chat: async ({ messages: promptMessages }) => {
        captured = promptMessages.map((message) => message.content);
        return aiReply("好");
      },
    },
  });
  await twoEngine.handle(
    event({
      id: "history-two",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "现在",
    }),
  );
  assert.deepEqual(captured.slice(1, -1), ["消息-4", "消息-5"]);
  assert.match(captured.at(-1), /【用户消息】\n现在/);
  assert.match(captured.at(-1), /【当前时间】/);

  await store.resetHistory(conversationKey);
  await store.append(conversationKey, messages);
  const allEngine = new Engine({
    getConfig: async () => configured({ ai: { historyMessages: 0 } }),
    store,
    services: {
      chat: async ({ messages: promptMessages }) => {
        captured = promptMessages.map((message) => message.content);
        return aiReply("好");
      },
    },
  });
  await allEngine.handle(
    event({
      id: "history-all",
      channel: "onebot",
      userId: "10001",
      conversationId: "10001",
      text: "现在",
    }),
  );
  assert.deepEqual(
    captured.slice(1, -1),
    messages.map((message) => message.content),
  );
  assert.match(captured.at(-1), /【用户消息】\n现在/);
  assert.match(captured.at(-1), /【当前时间】/);
});
