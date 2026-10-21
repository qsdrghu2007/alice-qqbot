import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ChatExitManager, ChatExitState } from "../src/chat-exit.js";
import { defaultConfig } from "../src/config.js";
import { conversationStateKey } from "../src/conversation-state.js";
import {
  FollowUpScheduler,
  buildFollowUpCheckMessages,
  buildFollowUpMessages,
  buildFollowUpTimeMessages,
  parseFollowUpCheckDecision,
  parseFollowUpDecision,
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
    followupReason: "等考试结果",
    followupShouldFollowUp: true,
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
  const visibleEvents = [];
  const scheduler = new FollowUpScheduler({
    getConfig: async () => config,
    state,
    store,
    conversationState: {
      async visibleContext(caller) {
        visibleEvents.push(caller);
        return {
          profile: {
            relationship: { label: "逐渐熟悉" },
            preferences: ["short_replies"],
            boundaries: ["topic"],
          },
          contexts: [
            {
              scope: "private",
              topic: "结构化考试话题",
              unfinished: "等待最终成绩",
              unfinishedItems: [
                { text: "等待最终成绩", status: "open" },
                { text: "已经完成的旧事项", status: "done" },
              ],
              preference: "别连续追问",
              userEmotion: { emotion: "anxious", intensity: 0.6 },
              commonMemes: [{ text: "考前别问" }],
            },
          ],
          global: { emotion: "hurt", marker: "GLOBAL-MARKER" },
        };
      },
    },
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
  assert.deepEqual(visibleEvents, [
    {
      channel: "onebot",
      scope: "private",
      conversationId: "10001",
      userId: "10001",
    },
  ]);
  assert.match(calls[0].messages[1].content, /msg-24/);
  assert.doesNotMatch(calls[0].messages[1].content, /msg-0/);
  assert.match(calls[0].messages[1].content, /结构化考试话题/);
  assert.match(calls[0].messages[1].content, /等待最终成绩/);
  assert.match(calls[0].messages[1].content, /逐渐熟悉/);
  assert.match(calls[0].messages[1].content, /考前别问/);
  assert.match(calls[0].messages[1].content, /焦虑/);
  assert.doesNotMatch(calls[0].messages[1].content, /已经完成的旧事项/);
  assert.doesNotMatch(calls[0].messages[1].content, /GLOBAL-MARKER/);
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

test("follow-up decision parser preserves legacy minutes and only cancels on explicit false", () => {
  assert.deepEqual(parseFollowUpDecision('{"followup_minutes":30}'), {
    shouldFollowUp: null,
    reason: "",
    minutes: 30,
  });
  assert.deepEqual(
    parseFollowUpDecision(
      '{"should_follow_up":false,"followup_reason":"","followup_minutes":null}',
    ),
    { shouldFollowUp: false, reason: "", minutes: null },
  );
  assert.equal(parseFollowUpDecision("早呀，在干嘛？"), null);
  assert.equal(parseFollowUpDecision("45").minutes, 45);
  assert.equal(
    parseFollowUpCheckDecision('{"should_send_now":true,"reason":""}'),
    null,
  );
});

test("time resolver can explicitly cancel and a user message cancels a late time result", async (t) => {
  const { state, store } = await setup(t);
  const target = event();
  await state.markTerminated(target, {
    at: "2026-10-19T12:00:00.000Z",
    followUpStatus: "needs_time",
  });
  const config = configured();
  const declinedScheduler = new FollowUpScheduler({
    getConfig: async () => config,
    state,
    store,
    logger: noopLogger,
    now: () => new Date("2026-10-19T12:01:00.000Z"),
    chat: async () => ({
      content:
        '{"should_follow_up":false,"followup_reason":"","followup_minutes":null}',
      reasoningContent: "",
      toolCalls: [],
      rawMessage: {},
    }),
    deliver: async () => ({ status: "sent" }),
  });
  const declined = await declinedScheduler.resolvePendingTimes({
    key: JSON.stringify(["onebot", "private", "10001"]),
    history: [{ role: "user", content: "别找我" }],
    config,
  });
  assert.equal(declined.status, "skipped");
  assert.equal((await state.getEntry(target)).lastError, "followup_declined");

  const secondTarget = event({ conversationId: "late", userId: "late" });
  await state.markTerminated(secondTarget, {
    at: "2026-10-19T12:00:00.000Z",
    followUpStatus: "needs_time",
  });
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const responsePromise = new Promise((resolve) => {
    release = resolve;
  });
  const lateScheduler = new FollowUpScheduler({
    getConfig: async () => config,
    state,
    store,
    logger: noopLogger,
    now: () => new Date("2026-10-19T12:01:00.000Z"),
    chat: async () => {
      started();
      return responsePromise;
    },
    deliver: async () => ({ status: "sent" }),
  });
  const pending = lateScheduler.resolvePendingTimes({
    key: JSON.stringify(["onebot", "private", "late"]),
    history: [{ role: "user", content: "晚点告诉你结果" }],
    config,
  });
  await startedPromise;
  await state.clear(secondTarget);
  await state.markTerminated(secondTarget, {
    at: "2026-10-19T12:05:00.000Z",
    followUpAt: "2026-10-19T13:05:00.000Z",
    followUpMinutes: 60,
    followupReason: "新的结束",
    followupShouldFollowUp: true,
  });
  release({
    content:
      '{"should_follow_up":true,"followup_reason":"旧话题","followup_minutes":30}',
    reasoningContent: "",
    toolCalls: [],
    rawMessage: {},
  });
  const late = await pending;
  assert.equal(late.status, "cancelled");
  const current = await state.getEntry(secondTarget);
  assert.equal(current.terminatedAt, "2026-10-19T12:05:00.000Z");
  assert.equal(current.followUpAt, "2026-10-19T13:05:00.000Z");
  assert.equal(current.followupReason, "新的结束");
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
        content:
          calls.length === 1
            ? '{"should_send_now":true,"reason":"对方要等考试结果"}'
            : "考试结果出来了吗？",
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
  assert.equal(delivered[0].reply.text, "考试结果出来了吗？");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].thinking, "disabled");
  assert.equal(calls[0].maxTokens, 80);
  assert.match(calls[0].messages[1].content, /距结束已过/);
  assert.match(calls[0].messages[1].content, /等考试结果/);
  assert.equal(calls[1].thinking, "disabled");
  assert.equal(calls[1].maxTokens, 120);
  assert.match(calls[1].messages[1].content, /晚安/);
  assert.match(calls[1].messages[1].content, /当前时间/);
  assert.match(calls[1].messages[1].content, /等考试结果/);

  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "sent");
  assert.ok(entry.sentAt);
  const history = await store.history(entry.conversationKey);
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(history.at(-1).content, "考试结果出来了吗？");

  const second = await scheduler.tick();
  assert.equal(second.processed, 0);
  assert.equal(delivered.length, 1);
});

test("due follow-up is skipped when the independent check says it is stale", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T12:00:00.000Z",
    dueAt: "2026-10-19T13:30:00.000Z",
  });
  let delivered = 0;
  const calls = [];
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    logger: noopLogger,
    chat: async (request) => {
      calls.push(request);
      return {
        content: '{"should_send_now":false,"reason":"考试结果早已告诉他"}',
        reasoningContent: "",
        toolCalls: [],
        rawMessage: {},
      };
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });

  const result = await scheduler.tick();
  assert.equal(result.results[0].reason, "not_worth_or_stale");
  assert.equal(delivered, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].thinking, "disabled");
  assert.equal(calls[0].maxTokens, 80);
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "skipped");
  assert.equal(entry.lastError, "not_worth_or_stale");
});

test("follow-up checks and generation stay inside each private conversation", async (t) => {
  const { state, store } = await setup(t);
  const a = event({ conversationId: "session-a", userId: "session-a" });
  const b = event({ conversationId: "session-b", userId: "session-b" });
  for (const target of [a, b]) {
    await state.markTerminated(target, {
      at: "2026-10-19T12:00:00.000Z",
      followUpAt: "2026-10-19T13:30:00.000Z",
      followUpMinutes: 90,
      followupReason: target.userId === "session-a" ? "A 的考试结果" : "B 的到家情况",
      followupShouldFollowUp: true,
    });
  }
  await store.append(JSON.stringify(["onebot", "private", "session-a", "session-a"]), [
    { role: "user", content: "A 专属未完成话题" },
  ]);
  await store.append(JSON.stringify(["onebot", "private", "session-b", "session-b"]), [
    { role: "user", content: "B 专属未完成话题" },
  ]);
  const delivered = [];
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    logger: noopLogger,
    chat: async (request) => {
      const content = request.messages[1].content;
      const isA = content.includes("A 专属未完成话题");
      assert.equal(content.includes("B 专属未完成话题"), !isA);
      return {
        content: request.messages[0].content.includes("独立检查器")
          ? `{"should_send_now":true,"reason":"${isA ? "A 的话题" : "B 的话题"}"}`
          : isA
            ? "A 的结果怎样了？"
            : "你到家了吗？",
        reasoningContent: "",
        toolCalls: [],
        rawMessage: {},
      };
    },
    deliver: async (deliveryEvent) => {
      delivered.push(deliveryEvent.conversationId);
      return { status: "sent" };
    },
  });

  await scheduler.tick();
  assert.deepEqual(delivered, ["session-a", "session-b"]);
});

test("follow-up reads only the target conversation's structured short state", async (t) => {
  const { state, store } = await setup(t);
  const a = event({ conversationId: "structured-a", userId: "structured-a" });
  const b = event({ conversationId: "structured-b", userId: "structured-b" });
  for (const target of [a, b]) {
    await state.markTerminated(target, {
      at: "2026-10-19T12:00:00.000Z",
      followUpAt: "2026-10-19T13:30:00.000Z",
      followUpMinutes: 90,
      followupReason: "接续各自未完成事项",
      followupShouldFollowUp: true,
    });
    await store.append(
      JSON.stringify([
        "onebot",
        "private",
        target.conversationId,
        target.userId,
      ]),
      [{ role: "user", content: `${target.conversationId} 历史` }],
    );
  }

  const structured = new Map([
    [
      conversationStateKey(a),
      {
        topic: "A 的结构化话题",
        unfinished: "A 的未完成事项",
        unfinishedItems: [{ text: "A 的未完成事项", status: "open" }],
        preference: "A 的交流偏好",
        userEmotion: { emotion: "anxious", intensity: 0.7 },
        commonMemes: [{ text: "A 的共同梗" }],
      },
    ],
    [
      conversationStateKey(b),
      {
        topic: "B 的结构化话题",
        unfinished: "B 的未完成事项",
        unfinishedItems: [{ text: "B 的未完成事项", status: "open" }],
        preference: "B 的交流偏好",
        userEmotion: { emotion: "happy", intensity: 0.4 },
        commonMemes: [{ text: "B 的共同梗" }],
      },
    ],
  ]);
  const visibleEvents = [];
  const delivered = [];
  let chatCalls = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    conversationState: {
      async visibleContext(caller) {
        visibleEvents.push(caller);
        const context = structured.get(conversationStateKey(caller));
        return {
          profile: {
            relationship: {
              label: caller.userId === "structured-a" ? "熟悉" : "刚认识",
            },
            preferences: ["short_replies"],
            boundaries:
              caller.userId === "structured-a" ? ["topic"] : [],
          },
          contexts: context ? [{ ...context, scope: "private" }] : [],
          global: { emotion: "hurt", marker: "GLOBAL-MARKER" },
        };
      },
    },
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    logger: noopLogger,
    chat: async (request) => {
      chatCalls += 1;
      const content = request.messages[1].content;
      const isA = content.includes("structured-a");
      assert.equal(content.includes("structured-b"), !isA);
      assert.equal(content.includes("A 的结构化话题"), isA);
      assert.equal(content.includes("B 的结构化话题"), !isA);
      assert.equal(content.includes("A 的未完成事项"), isA);
      assert.equal(content.includes("B 的未完成事项"), !isA);
      assert.equal(content.includes("A 的共同梗"), isA);
      assert.equal(content.includes("B 的共同梗"), !isA);
      assert.match(content, /喜欢短句/);
      assert.equal(content.includes("不要追问他明确避开的话题"), isA);
      assert.doesNotMatch(content, /GLOBAL-MARKER/);
      return {
        content: request.messages[0].content.includes("独立检查器")
          ? `{"should_send_now":true,"reason":"${isA ? "A 的事项" : "B 的事项"}"}`
          : isA
            ? "A 的事项后来怎样了？"
            : "B 那边有结果了吗？",
        reasoningContent: "",
        toolCalls: [],
        rawMessage: {},
      };
    },
    deliver: async (deliveryEvent) => {
      delivered.push(deliveryEvent.conversationId);
      return { status: "sent" };
    },
  });

  await scheduler.tick();
  assert.equal(chatCalls, 4);
  assert.deepEqual(delivered, ["structured-a", "structured-b"]);
  assert.equal(visibleEvents.length, 2);
  assert.deepEqual(
    visibleEvents.map((caller) => caller.userId).sort(),
    ["structured-a", "structured-b"],
  );
});

test("plain text from a check is retried rather than interpreted as cancellation", async (t) => {
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
    chat: async () => ({
      content: "现在不太确定，要不要联系呢？",
      reasoningContent: "",
      toolCalls: [],
      rawMessage: {},
    }),
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });

  await scheduler.tick();
  assert.equal(delivered, 0);
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "scheduled");
  assert.equal(entry.lastError, "invalid_followup_check");
  assert.equal(entry.followUpAttempts, 1);
});

test("late check results are discarded after the user returns", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T12:00:00.000Z",
    dueAt: "2026-10-19T13:30:00.000Z",
  });
  let started;
  let release;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const responsePromise = new Promise((resolve) => {
    release = resolve;
  });
  let delivered = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => new Date("2026-10-19T13:31:00.000Z"),
    logger: noopLogger,
    chat: async () => {
      started();
      return responsePromise;
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });

  const pending = scheduler.tick();
  await startedPromise;
  await state.clear(target);
  release({
    content: '{"should_send_now":true,"reason":"接续考试结果"}',
    reasoningContent: "",
    toolCalls: [],
    rawMessage: {},
  });
  const result = await pending;
  assert.equal(result.results[0].status, "cancelled");
  assert.equal(delivered, 0);
  assert.equal(await state.getEntry(target), null);
});

test("consecutive check failures are bounded and end as skipped", async (t) => {
  const { state, store } = await setup(t);
  const target = await scheduledEntry({
    state,
    store,
    at: "2026-10-19T12:00:00.000Z",
    dueAt: "2026-10-19T13:30:00.000Z",
  });
  let current = new Date("2026-10-19T13:31:00.000Z");
  let calls = 0;
  let delivered = 0;
  const scheduler = new FollowUpScheduler({
    getConfig: async () => configured(),
    state,
    store,
    now: () => current,
    logger: noopLogger,
    chat: async () => {
      calls += 1;
      throw new Error("judge unavailable");
    },
    deliver: async () => {
      delivered += 1;
      return { status: "sent" };
    },
  });

  await scheduler.tick();
  current = new Date("2026-10-19T13:36:00.000Z");
  await scheduler.tick();
  current = new Date("2026-10-19T13:41:00.000Z");
  await scheduler.tick();

  assert.equal(calls, 3);
  assert.equal(delivered, 0);
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "skipped");
  assert.match(entry.lastError, /followup_check_failed_retry_exhausted/);
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
  let chatCalls = 0;
  const config = configured();
  const scheduler = new FollowUpScheduler({
    getConfig: async () => ({ ...config, policy: { ...config.policy, paused } }),
    state,
    store,
    now: () => current,
    logger: noopLogger,
    isReady: () => ready,
    chat: async () => {
      chatCalls += 1;
      return {
        content:
          chatCalls === 1
            ? '{"should_send_now":true,"reason":"询问忙完后的事情"}'
            : "忙完了吗？",
        reasoningContent: "",
        toolCalls: [],
        rawMessage: { role: "assistant", content: "" },
      };
    },
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
  assert.match(messages[0].content, /不能机械固定/);
  assert.doesNotMatch(messages[0].content, /5–1440|5-1440/);
  assert.match(messages[1].content, /5–1440|5-1440/);
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
