import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ChatExitManager, ChatExitState } from "../src/chat-exit.js";
import { defaultConfig } from "../src/config.js";
import {
  FollowUpScheduler,
  buildFollowUpMessages,
  buildFollowUpTimeMessages,
} from "../src/follow-up.js";
import { Store } from "../src/store.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-follow-up-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await new ChatExitState({ root, logger: noopLogger }).init();
  const store = await new Store(root).init();
  return { root, state, store };
}

function configured(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "follow-up-test-key";
  config.demo = false;
  config.policy.allowedUsers = [];
  return {
    ...config,
    ...overrides,
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
    policy: { ...config.policy, ...(overrides.policy ?? {}) },
    followUp: {
      ...config.followUp,
      ...(overrides.followUp ?? {}),
      quietHours: {
        ...config.followUp.quietHours,
        ...(overrides.followUp?.quietHours ?? {}),
      },
    },
  };
}

function event(overrides = {}) {
  return {
    id: `follow-up-${Math.random()}`,
    channel: "onebot",
    userId: "10001",
    scope: "private",
    conversationId: "10001",
    text: "晚安",
    timestamp: Date.now(),
    ...overrides,
  };
}

function decision(minutes) {
  return {
    content: JSON.stringify({
      end_chat: true,
      confidence: 0.95,
      reason: "用户晚安",
      sticker_mood: "困倦",
      ...(minutes === undefined ? {} : { followup_minutes: minutes }),
    }),
    reasoningContent: "",
    toolCalls: [],
    rawMessage: { role: "assistant", content: "" },
  };
}

async function scheduledEntry({ state, store, at, dueAt, channel = "onebot" }) {
  const target = event({ channel });
  await state.markTerminated(target, {
    at,
    followUpAt: dueAt,
    followUpMinutes: 90,
  });
  const key = JSON.stringify([channel, "private", "10001", "10001"]);
  await store.append(key, [{ role: "user", content: "晚安" }]);
  return target;
}

test("chat exit schedules valid times and marks invalid times for retry", async (t) => {
  const { root, state } = await setup(t);
  let minutes = 5;
  const needsTime = [];
  const now = () => new Date("2026-10-19T12:00:00.000Z");
  const manager = await new ChatExitManager({
    root,
    state,
    logger: noopLogger,
    now,
    onNeedsTime: (context) => needsTime.push(context),
    chat: async () => decision(minutes),
  }).init();
  const config = configured();

  const minimum = await manager.evaluate({
    event: event({ conversationId: "minimum", userId: "minimum" }),
    config,
  });
  assert.equal(minimum.followUpMinutes, 5);
  assert.equal(minimum.followUpAt, "2026-10-19T12:05:00.000Z");
  assert.equal(minimum.followUpStatus, "scheduled");

  minutes = 4;
  const tooSmall = await manager.evaluate({
    event: event({ conversationId: "small", userId: "small" }),
    config,
  });
  assert.equal(tooSmall.followUpMinutes, null);
  assert.equal(tooSmall.needsTime, true);
  assert.equal(
    (await state.getEntry(event({ conversationId: "small", userId: "small" })))
      .followUpStatus,
    "needs_time",
  );
  assert.equal(needsTime.length, 1);

  minutes = 9999;
  const tooLarge = await manager.evaluate({
    event: event({ conversationId: "large", userId: "large" }),
    config,
  });
  assert.equal(tooLarge.needsTime, true);

  minutes = undefined;
  const missing = await manager.evaluate({
    event: event({ conversationId: "missing", userId: "missing" }),
    config,
  });
  assert.equal(missing.needsTime, true);
  assert.equal(needsTime.length, 3);

  minutes = 100;
  const normal = await manager.evaluate({
    event: event({ conversationId: "normal", userId: "normal" }),
    config,
  });
  const entry = await state.getEntry(
    event({ conversationId: "normal", userId: "normal" }),
  );
  assert.equal(normal.followUpMinutes, 100);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.followUpAt, normal.followUpAt);

  const official = await manager.evaluate({
    event: event({ channel: "qq", conversationId: "official", userId: "official" }),
    config,
  });
  assert.equal(official.followUpMinutes, null);
  assert.equal(
    (await state.getEntry(
      event({ channel: "qq", conversationId: "official", userId: "official" }),
    )).followUpStatus,
    "disabled",
  );
});

test("invalid times are re-asked immediately with 20-message context until valid", async (t) => {
  const { state, store } = await setup(t);
  const target = event();
  await state.markTerminated(target, {
    at: "2026-10-19T12:00:00.000Z",
    followUpStatus: "needs_time",
    lastError: "invalid_followup_minutes: missing",
  });
  const config = configured();
  const history = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `msg-${index}`,
  }));
  const calls = [];
  const scheduler = new FollowUpScheduler({
    getConfig: async () => config,
    state,
    store,
    now: () => new Date("2026-10-19T12:01:00.000Z"),
    logger: noopLogger,
    chat: async (request) => {
      calls.push(request);
      return calls.length === 1
        ? { content: '{"followup_minutes":2}', reasoningContent: "", toolCalls: [], rawMessage: {} }
        : { content: '{"followup_minutes":30}', reasoningContent: "", toolCalls: [], rawMessage: {} };
    },
    deliver: async () => ({ status: "sent" }),
  });

  const result = await scheduler.resolvePendingTimes({
    key: JSON.stringify(["onebot", "private", "10001"]),
    history,
    text: "晚安",
    config,
  });
  assert.equal(result.status, "scheduled");
  assert.equal(result.minutes, 30);
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[1].content, /msg-24/);
  assert.doesNotMatch(calls[0].messages[1].content, /msg-0/);
  assert.match(calls[1].messages[1].content, /上次输出不合法/);
  assert.match(calls[1].messages[1].content, /2/);
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.followUpMinutes, 30);
  assert.equal(entry.followUpAt, "2026-10-19T12:30:00.000Z");
});

test("a failed time-resolution request skips this follow-up", async (t) => {
  const { state, store } = await setup(t);
  const target = event();
  await state.markTerminated(target, {
    at: "2026-10-19T12:00:00.000Z",
    followUpStatus: "needs_time",
  });
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T12:01:00.000Z"),
    logger: noopLogger,
    chat: async () => {
      throw new Error("network down");
    },
    deliver: async () => ({ status: "sent" }),
  });
  const result = await scheduler.resolvePendingTimes({
    key: JSON.stringify(["onebot", "private", "10001"]),
    history: [{ role: "user", content: "晚安" }],
    config: configured(),
  });
  assert.equal(result.status, "skipped");
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "skipped");
  assert.match(entry.lastError, /time_request_failed/);
});

test("startup resolution resumes pending needs_time entries from stored history", async (t) => {
  const { state, store } = await setup(t);
  const target = event();
  const key = JSON.stringify(["onebot", "private", "10001", "10001"]);
  await store.append(key, [{ role: "user", content: "晚安" }]);
  await state.markTerminated(target, {
    at: "2026-10-19T12:00:00.000Z",
    followUpStatus: "needs_time",
    lastError: "invalid_followup_minutes: missing",
  });
  let calls = 0;
  let delivered = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T12:01:00.000Z"),
    logger: noopLogger,
    chat: async () => {
      calls += 1;
      return {
        content: '{"followup_minutes":45}',
        reasoningContent: "",
        toolCalls: [],
        rawMessage: { role: "assistant", content: "" },
      };
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });
  await scheduler.resolvePendingTimes();
  assert.equal(calls, 1);
  assert.equal(delivered, 0);
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.followUpMinutes, 45);
  assert.equal(entry.followUpAt, "2026-10-19T12:45:00.000Z");
});

test("follow-up scheduler generates, delivers once, and writes assistant history", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T12:00:00.000Z",
    dueAt: "2026-10-19T13:30:00.000Z",
  });
  const config = configured();
  const calls = [];
  const delivered = [];
  const scheduler = new FollowUpScheduler({
    getConfig: async () => config,
    state,
    store,
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    random: () => 0,
    logger: noopLogger,
    chat: async (request) => {
      calls.push(request);
      return {
        content: "早呀，昨晚睡得好吗？",
        reasoningContent: "",
        toolCalls: [],
        rawMessage: { role: "assistant", content: "" },
      };
    },
    deliver: async (deliveryEvent, reply) => {
      delivered.push({ event: deliveryEvent, reply });
      return { status: "sent" };
    },
  });

  const first = await scheduler.tick();
  assert.equal(first.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.userId, "10001");
  assert.equal(delivered[0].event.conversationId, "10001");
  assert.equal(delivered[0].reply.text, "早呀，昨晚睡得好吗？");
  assert.equal(calls[0].thinking, "disabled");
  assert.equal(calls[0].maxTokens, 120);
  assert.match(calls[0].messages[1].content, /晚安/);
  assert.match(calls[0].messages[1].content, /当前时间/);

  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "sent");
  assert.ok(entry.sentAt);
  const history = await store.history(entry.conversationKey);
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(history.at(-1).content, "早呀，昨晚睡得好吗？");

  const second = await scheduler.tick();
  assert.equal(second.processed, 0);
  assert.equal(delivered.length, 1);
});

test("a user message before the due time cancels the scheduled follow-up", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T12:00:00.000Z",
    dueAt: "2026-10-19T13:30:00.000Z",
  });
  let delivered = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    logger: noopLogger,
    chat: async () => {
      throw new Error("should not generate");
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });

  await state.clear(target);
  const result = await scheduler.tick();
  assert.equal(result.processed, 0);
  assert.equal(delivered, 0);
  assert.equal(await state.getEntry(target), null);
});

test("quiet hours defer the follow-up to the end of the quiet window", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T20:00:00.000Z",
    dueAt: "2026-10-19T20:00:00.000Z",
  });
  let delivered = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () =>
      configured({ followUp: { quietHours: { start: 23, end: 8 } } }),
    state,
    store,
    now: () => new Date("2026-10-19T20:00:00.000Z"),
    random: () => 0,
    logger: noopLogger,
    chat: async () => {
      throw new Error("should not generate during quiet hours");
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });

  const result = await scheduler.tick();
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].reason, "quiet_hours");
  assert.equal(delivered, 0);
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.nextAttemptAt, "2026-10-20T00:00:00.000Z");
});

test("paused or offline follow-ups keep retrying and eventually send", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T12:00:00.000Z",
    dueAt: "2026-10-19T13:30:00.000Z",
  });
  let paused = true;
  let ready = false;
  let current = new Date("2026-10-19T13:31:00.000Z");
  const delivered = [];
  const config = configured();
  const scheduler = new FollowUpScheduler({
    getConfig: async () => ({ ...config, policy: { ...config.policy, paused } }),
    state,
    store,
    now: () => current,
    logger: noopLogger,
    isReady: () => ready,
    chat: async () => ({
      content: "忙完了吗？",
      reasoningContent: "",
      toolCalls: [],
      rawMessage: { role: "assistant", content: "" },
    }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
      return { status: "sent" };
    },
  });

  await scheduler.tick();
  assert.equal(delivered.length, 0);
  let entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.lastError, "not_ready");

  paused = false;
  current = new Date("2026-10-19T13:36:00.000Z");
  await scheduler.tick();
  assert.equal(delivered.length, 0);
  entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.lastError, "onebot_not_ready");

  ready = true;
  current = new Date("2026-10-19T13:41:00.000Z");
  await scheduler.tick();
  assert.deepEqual(delivered, ["忙完了吗？"]);
  entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "sent");
});

test("follow-up time prompt lets AI extend after repeated idle terminations", () => {
  const messages = buildFollowUpTimeMessages({
    history: [
      { role: "user", content: "晚安" },
      { role: "assistant", content: "晚安呀" },
    ],
    minMinutes: 5,
    maxMinutes: 1440,
    idleCount: 3,
  });
  assert.match(messages[0].content, /连续多次未回复/);
  assert.match(messages[0].content, /不要机械固定/);
  assert.match(messages[1].content, /连续第 3 次/);
  assert.match(messages[1].content, /适当延长/);
});

test("follow-up prompt includes recent context and ignores unsupported channels", async (t) => {
  const { state, store } = await setup(t);
  const config = configured();
  const messages = buildFollowUpMessages({
    config,
    history: [
      { role: "user", content: "今天考试考完了" },
      { role: "assistant", content: "感觉怎么样？" },
      { role: "user", content: "晚安" },
    ],
    entry: { userId: "10001", terminatedAt: "2026-10-19T12:00:00.000Z" },
    now: new Date("2026-10-19T20:00:00.000Z"),
    timeZone: "Asia/Shanghai",
  });
  assert.match(messages[1].content, /今天考试考完了/);
  assert.match(messages[1].content, /晚安/);
  assert.match(messages[1].content, /2026/);

  const official = await state.markTerminated(
    event({ channel: "qq", conversationId: "qq-user", userId: "qq-user" }),
    {
      at: "2026-10-19T12:00:00.000Z",
      followUpAt: "2026-10-19T13:30:00.000Z",
      followUpMinutes: 90,
    },
  );
  let delivered = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => config,
    state,
    store,
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    logger: noopLogger,
    chat: async () => {
      throw new Error("should not generate");
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });
  const result = await scheduler.tick();
  assert.equal(delivered, 0);
  assert.equal(result.results[0].reason, "unsupported_channel");
  assert.equal((await state.getEntry(event({ channel: "qq", conversationId: "qq-user", userId: "qq-user" })))?.followUpStatus, "skipped");
  assert.ok(official.followUpAt);
});

test("follow-up tick also triggers maintenance without failing the follow-up loop", async (t) => {
  const { state, store } = await setup(t);
  let maintenanceTicks = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T12:00:00.000Z"),
    logger: noopLogger,
    deliver: async () => ({ status: "sent" }),
    chat: async () => {
      throw new Error("should not generate");
    },
    onTick: async () => {
      maintenanceTicks += 1;
      throw new Error("qzone maintenance failed");
    },
  });
  const result = await scheduler.tick();
  assert.equal(maintenanceTicks, 1);
  assert.deepEqual(result, { processed: 0, results: [] });
  await scheduler.stop();
});
