import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationDeliveryQueue,
} from "../src/delivery.js";
import { MessageBatcher } from "../src/message-batcher.js";
import { createReplyFlow } from "../src/index.js";

const tick = async (rounds = 40) => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    if (index % 10 === 9) await new Promise((resolve) => setImmediate(resolve));
  }
};

function event(overrides = {}) {
  return {
    id: `event-${Math.random()}`,
    channel: "onebot",
    scope: "private",
    userId: "10001",
    conversationId: "10001",
    text: "原问题",
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function fakeBatcher(handler) {
  let nextId = 0;
  const timers = new Map();
  const timerApi = {
    setTimeout(callback, ms) {
      nextId += 1;
      timers.set(nextId, { callback, ms });
      return nextId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    batcher: new MessageBatcher({
      handler,
      timers: timerApi,
      silentMs: 1,
    }),
    fire() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
    delays() {
      return [...timers.values()].map((timer) => timer.ms);
    },
  };
}

function config(replyDelay = {}, replyPacing = {}) {
  return {
    policy: { paused: false, allowedUsers: [], allowedGroups: [] },
    chatExit: { idleMinutes: 10 },
    replyDelay: {
      enabled: true,
      baseMs: 0,
      msPerChar: 0,
      maxMs: 0,
      jitter: 0,
      ...replyDelay,
    },
    replyPacing,
  };
}

function flowFor({ getConfig, engine, delivery, sleep, random }) {
  return createReplyFlow({
    getConfig,
    engine,
    delivery,
    sleep,
    random,
    typing: { start: () => () => {} },
    activity: {
      noteBot: async () => {},
      clear: async () => {},
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
}

async function runSegmentedFlow({
  firstText,
  secondText,
  replyDelay,
  random,
}) {
  const events = [];
  const delivery = new ConversationDeliveryQueue({
    sleep: async (ms) => {
      events.push({ type: "queue-delay", ms });
    },
  });
  const flow = flowFor({
    getConfig: () => config(replyDelay, { probability: 1 }),
    engine: {
      async handle() {
        return {
          text: `${firstText}${secondText}`,
          faces: [],
          images: [],
          needsSlowPacing: true,
        };
      },
      async commitTurn() {},
    },
    delivery,
    sleep: async (ms) => {
      events.push({ type: "segment-delay", ms });
    },
    random,
  });
  await flow.processEvent(
    {
      send: async (_event, reply) => {
        events.push({ type: "send", text: reply.text });
      },
    },
    event(),
  );
  return events;
}

test("production batcher cancels the queue delay immediately and regenerates the merged turn", async () => {
  let sleepSignal = null;
  let sleepCount = 0;
  const delivery = new ConversationDeliveryQueue({
    sleep: (_ms, signal) => {
      sleepCount += 1;
      if (sleepCount > 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        sleepSignal = signal;
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void resolve;
      });
    },
  });
  const handles = [];
  const sent = [];
  const commits = [];
  const engine = {
    async handle(current) {
      handles.push(current.text);
      return {
        text: `回复：${current.text}`,
        faces: [],
        images: [],
        turn: { assistantText: `回复：${current.text}` },
      };
    },
    async commitDeliveredTurn(reply, payload) {
      commits.push({ replyText: reply.text, ...payload });
    },
  };
  const flow = flowFor({
    getConfig: () =>
      config({ baseMs: 5_000, maxMs: 5_000 }),
    engine,
    delivery,
  });
  const h = fakeBatcher((context) =>
    flow.processEvent(
      {
        send: async (_event, reply) => {
          sent.push(reply.text);
        },
      },
      context.event,
      {
        signal: context.signal,
        deferCommit: true,
        onBeforeSend: context.onBeforeSend,
        getSupplements: context.getSupplements,
        markSupplementsCommitted: context.markSupplementsCommitted,
      },
    ),
  );

  h.batcher.enqueue(event({ id: "first", text: "原问题" }));
  h.fire();
  await tick();
  assert.deepEqual(handles, ["原问题"]);
  assert.equal(sleepSignal?.aborted, false);
  assert.deepEqual(sent, []);

  h.batcher.enqueue(event({ id: "new", text: "新问题" }));
  await tick();
  assert.equal(sleepSignal?.aborted, true);
  assert.deepEqual(sent, []);
  assert.equal(h.delays().length, 1);

  h.fire();
  await tick();
  assert.deepEqual(handles, ["原问题", "原问题\n新问题"]);
  assert.deepEqual(sent, ["回复：原问题\n新问题"]);
  assert.deepEqual(commits, [
    {
      replyText: "回复：原问题\n新问题",
      assistantText: "回复：原问题\n新问题",
      userTexts: [],
      final: true,
    },
  ]);
});

test("segmented sends keep the first delivered segment, reuse the passive id, and commit the failure boundary", async () => {
  const delivery = new ConversationDeliveryQueue();
  const sent = [];
  const commits = [];
  let markedSupplements = 0;
  let beforeSendCalls = 0;
  const engine = {
    async handle() {
      return {
        text: "我先确认一下。结果已经处理好了！",
        faces: [],
        images: [],
        needsSlowPacing: true,
        pacingHints: { web: true },
        turn: { assistantText: "我先确认一下。结果已经处理好了！" },
      };
    },
    async commitDeliveredTurn(_reply, payload) {
      commits.push(payload);
    },
  };
  const flow = flowFor({
    getConfig: () =>
      config(
        { baseMs: 0, msPerChar: 0, maxMs: 0 },
        { probability: 1, gapMinMs: 0, gapMaxMs: 0 },
      ),
    engine,
    delivery,
  });
  const outcome = await flow.processEvent(
    {
      send: async (current, reply) => {
        sent.push({ id: current.id, text: reply.text });
        if (reply.deliverySegment?.index === 1) {
          throw new Error("second segment failed");
        }
      },
    },
    event({ id: "passive-id", channel: "qq", scope: "private" }),
    {
      deferCommit: true,
      onBeforeSend: () => {
        beforeSendCalls += 1;
      },
      getSupplements: () => [event({ id: "ack", text: "嗯" })],
      markSupplementsCommitted: () => {
        markedSupplements += 1;
      },
    },
  );

  assert.equal(outcome.status, "partial");
  assert.equal(beforeSendCalls, 1);
  assert.deepEqual(sent, [
    { id: "passive-id", text: "我先确认一下。" },
    { id: "passive-id", text: "结果已经处理好了！" },
  ]);
  assert.deepEqual(commits, [
    {
      assistantText: "我先确认一下。",
      userTexts: ["嗯"],
      final: false,
    },
    {
      assistantText: null,
      userTexts: [],
      final: true,
    },
  ]);
  assert.equal(markedSupplements, 1);
});

test("a failed first send keeps the user turn but never commits an unsent assistant reply", async () => {
  const commits = [];
  const engine = {
    async handle() {
      return {
        text: "没有送出去。",
        faces: [],
        images: [],
        turn: { assistantText: "没有送出去。" },
      };
    },
    async commitDeliveredTurn(_reply, payload) {
      commits.push(payload);
    },
  };
  const flow = flowFor({
    getConfig: () => config(),
    engine,
    delivery: new ConversationDeliveryQueue(),
  });
  const outcome = await flow.processEvent(
    {
      send: async () => {
        throw new Error("transport failed");
      },
    },
    event({ id: "failed-first" }),
    {
      deferCommit: true,
      onBeforeSend: () => {},
      getSupplements: () => [event({ id: "failed-ack", text: "嗯" })],
    },
  );
  assert.equal(outcome.status, "failed");
  assert.deepEqual(commits, [
    {
      assistantText: null,
      userTexts: ["嗯"],
      final: true,
    },
  ]);
});

test("disabled reply delay disables segmentation and inter-segment waiting", async () => {
  let sleepCalls = 0;
  const sent = [];
  const delivery = new ConversationDeliveryQueue({
    sleep: async () => {
      sleepCalls += 1;
    },
  });
  const reply = "我先确认一下。结果已经处理好了！";
  const engine = {
    async handle() {
      return { text: reply, faces: [], images: [], turn: { assistantText: reply } };
    },
    async commitDeliveredTurn() {},
  };
  const flow = flowFor({
    getConfig: () => config({ enabled: false }, { probability: 1, gapMinMs: 500, gapMaxMs: 800 }),
    engine,
    delivery,
  });
  await flow.processEvent(
    {
      send: async (_event, value) => {
        sent.push(value.text);
      },
    },
    event({ id: "delay-off" }),
    { deferCommit: true, onBeforeSend: () => {} },
  );
  assert.deepEqual(sent, [reply]);
  assert.equal(sleepCalls, 0);
});

test("each segment waits by its own text with shared jitter, cap, and slow pacing", async () => {
  const replyDelay = {
    enabled: true,
    baseMs: 500,
    msPerChar: 120,
    maxMs: 2_500,
    jitter: 0.15,
  };
  const sharedSecond = "后面这句话保持固定。";

  const shortFirst = await runSegmentedFlow({
    firstText: "好呀。",
    secondText: sharedSecond,
    replyDelay,
    random: () => 1,
  });
  const longFirst = await runSegmentedFlow({
    firstText: "这开头确实很长。",
    secondText: sharedSecond,
    replyDelay,
    random: () => 1,
  });
  const longSecond = await runSegmentedFlow({
    firstText: "这开头确实很长。",
    secondText: "后面这句话明显更长一些。",
    replyDelay,
    random: () => 1,
  });

  assert.deepEqual(shortFirst, [
    { type: "queue-delay", ms: 1_236 },
    { type: "send", text: "好呀。" },
    { type: "segment-delay", ms: 2_444 },
    { type: "send", text: sharedSecond },
  ]);
  assert.equal(longFirst[0].ms, 2_099);
  assert.deepEqual(longFirst.slice(2), shortFirst.slice(2));
  assert.deepEqual(longSecond.slice(0, 3), [
    { type: "queue-delay", ms: 2_099 },
    { type: "send", text: "这开头确实很长。" },
    { type: "segment-delay", ms: 2_500 },
  ]);
  assert.equal(longSecond[3].text, "后面这句话明显更长一些。");
});

test("explicit first delay override leaves later segments on their own text delay", async () => {
  const events = [];
  const delivery = new ConversationDeliveryQueue({
    sleep: async (ms) => {
      events.push({ type: "queue-delay", ms });
    },
  });
  const flow = flowFor({
    getConfig: () =>
      config(
        { baseMs: 500, msPerChar: 120, maxMs: 0, jitter: 0 },
        { probability: 1 },
      ),
    engine: {
      async handle() {
        return {
          text: "第一段内容。第二段内容明显更长。",
          faces: [],
          images: [],
          turn: { assistantText: "第一段内容。第二段内容明显更长。" },
        };
      },
      async commitTurn() {},
    },
    delivery,
    sleep: async (ms) => {
      events.push({ type: "segment-delay", ms });
    },
  });

  await flow.deliverReply(
    {
      send: async (_event, reply) => {
        events.push({ type: "send", text: reply.text });
      },
    },
    event(),
    {
      text: "第一段内容。第二段内容明显更长。",
      faces: [],
      images: [],
    },
    { delayMs: 37 },
  );

  assert.deepEqual(events, [
    { type: "queue-delay", ms: 37 },
    { type: "send", text: "第一段内容。" },
    { type: "segment-delay", ms: 1_445 },
    { type: "send", text: "第二段内容明显更长。" },
  ]);
});
