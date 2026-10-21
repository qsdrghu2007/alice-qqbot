import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationDeliveryQueue,
  calculateReplyDelay,
  calculateSegmentGap,
  canSegmentReply,
  conversationDeliveryKey,
  deliverPlannedReply,
  planReplySegments,
  segmentReply,
  visibleCharacterCount,
} from "../src/delivery.js";

const noJitter = {
  enabled: true,
  baseMs: 500,
  msPerChar: 70,
  maxMs: 6000,
  jitter: 0,
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("reply delay follows visible character count, cap, and sticker rules", () => {
  assert.equal(visibleCharacterCount(" 你 好 "), 2);
  assert.equal(visibleCharacterCount("好🙂"), 2);
  assert.equal(visibleCharacterCount(""), 0);

  assert.equal(calculateReplyDelay({ text: "在。" }, noJitter), 544);
  assert.equal(calculateReplyDelay({ text: "今天好累" }, noJitter), 663);
  assert.equal(calculateReplyDelay({ text: "啊".repeat(10) }, noJitter), 1020);
  assert.equal(calculateReplyDelay({ text: "啊".repeat(30) }, noJitter), 2600);
  assert.equal(calculateReplyDelay({ text: "啊".repeat(1000) }, noJitter), 6000);
  assert.equal(
    calculateReplyDelay({ text: "啊".repeat(1000) }, { ...noJitter, maxMs: 0 }),
    70500,
  );
  assert.equal(
    calculateReplyDelay(
      { text: "啊".repeat(1000) },
      { ...noJitter, baseMs: 500, msPerChar: 120, maxMs: 0 },
    ),
    120500,
  );
  assert.equal(
    calculateReplyDelay(
      { text: "啊".repeat(10) },
      { ...noJitter, baseMs: 500, msPerChar: 120, maxMs: 0 },
    ),
    1445,
  );
  assert.equal(calculateReplyDelay({ text: "" }, noJitter), 0);
  assert.equal(calculateReplyDelay({ text: "   " }, noJitter), 0);
  assert.equal(calculateReplyDelay({ text: "好呀", stickerOnly: true }, noJitter), 0);
  assert.equal(calculateReplyDelay({ text: "好呀", stickerOnly: false }, noJitter), 544);
  assert.equal(calculateReplyDelay({ text: "好呀" }, { ...noJitter, enabled: false }), 0);
  assert.equal(
    calculateReplyDelay(
      { text: "今天好累" },
      { ...noJitter, jitter: 0.15 },
      { random: () => 0.5 },
    ),
    663,
  );
  assert.equal(
    calculateReplyDelay(
      { text: "今天好累" },
      { ...noJitter, maxMs: 100 },
    ),
    100,
  );
  assert.equal(
    calculateReplyDelay(
      { text: "啊".repeat(1000) },
      { ...noJitter, jitter: 0.15 },
      { random: () => 1 },
    ),
    6000,
  );
});

test("simple replies are faster while tool, web, recall, and serious pacing is slower", () => {
  const simple = calculateReplyDelay({ text: "好呀" }, noJitter);
  const normal = calculateReplyDelay({ text: "这件事我知道了" }, noJitter);
  const slow = calculateReplyDelay(
    { text: "这件事我知道了", needsSlowPacing: true },
    noJitter,
  );
  assert.ok(simple < calculateReplyDelay({ text: "这件事我知道了呀" }, noJitter));
  assert.ok(slow > normal);
  assert.equal(
    calculateReplyDelay({ text: "查到了。", pacingHints: { web: true } }, noJitter),
    calculateReplyDelay({ text: "查到了。", needsSlowPacing: true }, noJitter),
  );
});

test("reply planning creates at most two natural sentences and preserves the text", () => {
  const oneBot = {
    channel: "onebot",
    scope: "private",
    conversationId: "10001",
  };
  const reply = { text: "先等一下。我已经看完了，结果比预想的好！", faces: [], images: [] };
  assert.equal(canSegmentReply(reply, { event: oneBot }), true);
  const plan = planReplySegments(reply, { event: oneBot, random: () => 0 });
  assert.equal(plan.length, 2);
  assert.equal(plan.map((segment) => segment.text).join(""), reply.text);
  assert.deepEqual(
    plan.map((segment) => segmentReply(reply, segment).text),
    plan.map((segment) => segment.text),
  );
  assert.equal(segmentReply(reply, plan[0]).images.length, 0);

  for (const unsafe of [
    { text: "第一句。看 https://example.test/a 第二句。" },
    { text: "```js\n第一段。\n第二段。\n```" },
    { text: "已发布。发布结果不确定，请在 QQ 空间检查。" },
    {
      text: "已经处理好了。你可以放心。",
      actionExecuted: true,
      pacingHints: { tool: true },
    },
    { text: `${"这是一段很长的说明。".repeat(20)}${"最后一句。".repeat(20)}` },
    { text: "第一句。第二句。", images: ["data:image/png;base64,abc"] },
  ]) {
    assert.equal(canSegmentReply(unsafe, { event: oneBot }), false);
  }
  assert.equal(
    canSegmentReply(reply, {
      event: { ...oneBot, channel: "local" },
    }),
    false,
  );
  assert.equal(
    canSegmentReply(reply, { event: oneBot, settings: { enabled: false } }),
    false,
  );
  assert.equal(planReplySegments(reply, { event: oneBot, random: () => 0.99 }).length, 1);
  assert.ok(calculateSegmentGap(reply, { random: () => 1 }) <= 1_200);
});

test("conversation delivery keys separate private chats and groups", () => {
  const base = {
    channel: "onebot",
    scope: "private",
    conversationId: "10001",
  };
  assert.notEqual(
    conversationDeliveryKey(base),
    conversationDeliveryKey({ ...base, conversationId: "10002" }),
  );
  assert.notEqual(
    conversationDeliveryKey(base),
    conversationDeliveryKey({ ...base, scope: "group", conversationId: "g1" }),
  );
  assert.notEqual(
    conversationDeliveryKey(base),
    conversationDeliveryKey({ ...base, channel: "qq" }),
  );
});

test("different conversations wait independently", async () => {
  const sleepCalls = [];
  const sent = [];
  const queue = new ConversationDeliveryQueue({
    sleep: (ms) =>
      new Promise((resolve) => {
        sleepCalls.push({ ms, resolve, done: false });
      }),
  });

  const short = queue.enqueue("private-a", {
    delayMs: 100,
    run: () => {
      sent.push("A");
      return "A";
    },
  });
  const long = queue.enqueue("private-b", {
    delayMs: 300,
    run: () => {
      sent.push("B");
      return "B";
    },
  });

  await tick();
  await tick();
  assert.equal(sleepCalls.length, 2);

  sleepCalls.find((call) => call.ms === 300).resolve();
  await long;
  assert.deepEqual(sent, ["B"]);
  assert.equal(sleepCalls.find((call) => call.ms === 100).done, false);

  sleepCalls.find((call) => call.ms === 100).resolve();
  await short;
  assert.deepEqual(sent, ["B", "A"]);
});

test("the same conversation keeps strict send order", async () => {
  const sleepCalls = [];
  const sent = [];
  const queue = new ConversationDeliveryQueue({
    sleep: (ms) =>
      new Promise((resolve) => {
        sleepCalls.push({ ms, resolve });
      }),
  });

  const first = queue.enqueue("group-a", {
    delayMs: 100,
    run: () => sent.push("first"),
  });
  const second = queue.enqueue("group-a", {
    delayMs: 50,
    run: () => sent.push("second"),
  });

  await tick();
  await tick();
  assert.equal(sleepCalls.length, 1);
  assert.equal(sleepCalls[0].ms, 100);

  sleepCalls[0].resolve();
  await first;
  await tick();
  assert.deepEqual(sent, ["first"]);
  assert.equal(sleepCalls.length, 2);
  assert.equal(sleepCalls[1].ms, 50);

  sleepCalls[1].resolve();
  await second;
  assert.deepEqual(sent, ["first", "second"]);
});

test("planned delivery commits only successful segments and preserves partial failure", async () => {
  const sent = [];
  const committed = [];
  const queue = new ConversationDeliveryQueue({ sleep: async () => {} });
  const segments = [
    { index: 0, total: 2, text: "第一段。" },
    { index: 1, total: 2, text: "第二段。" },
  ];
  const outcome = await deliverPlannedReply({
    queue,
    key: "onebot:private:one",
    event: { channel: "onebot", conversationId: "one" },
    reply: { text: "第一段。第二段。" },
    segments,
    send: async (_event, reply) => {
      sent.push(reply.text);
      if (reply.deliverySegment.index === 1) throw new Error("second failed");
    },
    afterSegmentSent: async (segment, flags) => {
      committed.push({ text: segment.text, final: flags.last });
    },
  });
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedAtSegment, 1);
  assert.deepEqual(outcome.sentSegments.map((segment) => segment.text), ["第一段。"]);
  assert.deepEqual(sent, ["第一段。", "第二段。"]);
  assert.deepEqual(committed, [{ text: "第一段。", final: false }]);
});

test("queue delay and previous work are cancelled before the send boundary", async () => {
  let delaySignal;
  const queue = new ConversationDeliveryQueue({
    sleep: (_ms, signal) =>
      new Promise((resolve, reject) => {
        delaySignal = signal;
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
        const onAbort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  });
  const controller = new AbortController();
  let sent = 0;
  const pending = deliverPlannedReply({
    queue,
    key: "onebot:private:delay",
    event: { channel: "onebot", conversationId: "delay" },
    reply: { text: "稍等。" },
    segments: [{ index: 0, total: 1, text: "稍等。" }],
    delayMs: 5_000,
    signal: controller.signal,
    send: async () => {
      sent += 1;
    },
  });
  await tick();
  assert.equal(delaySignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  assert.equal(sent, 0);

  let release;
  const previous = queue.enqueue("onebot:private:previous", {
    run: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const controller2 = new AbortController();
  const waiting = deliverPlannedReply({
    queue,
    key: "onebot:private:previous",
    event: { channel: "onebot", conversationId: "previous" },
    reply: { text: "下一轮。" },
    segments: [{ index: 0, total: 1, text: "下一轮。" }],
    signal: controller2.signal,
    send: async () => {
      sent += 1;
    },
  });
  await tick();
  controller2.abort();
  await assert.rejects(waiting, (error) => error.code === "CANCELLED");
  assert.equal(sent, 0);
  release();
  await previous;
});

test("cancelled queued work returns immediately without letting later work bypass the active head", async () => {
  const queue = new ConversationDeliveryQueue();
  const runs = [];
  let releaseA;

  const a = queue.enqueue("onebot:private:ordered", {
    run: () => {
      runs.push("A:start");
      return new Promise((resolve) => {
        releaseA = () => {
          runs.push("A:end");
          resolve("A");
        };
      });
    },
  });
  await tick();
  assert.deepEqual(runs, ["A:start"]);

  const controllerB = new AbortController();
  let bRan = false;
  const b = queue.enqueue("onebot:private:ordered", {
    signal: controllerB.signal,
    run: () => {
      bRan = true;
      runs.push("B");
    },
  });
  await tick();
  controllerB.abort();
  await assert.rejects(b, (error) => error.code === "CANCELLED");
  assert.equal(bRan, false);

  const c = queue.enqueue("onebot:private:ordered", {
    run: () => {
      runs.push("C");
      return "C";
    },
  });
  await tick();
  assert.deepEqual(runs, ["A:start"]);

  releaseA();
  await a;
  assert.equal(await c, "C");
  assert.deepEqual(runs, ["A:start", "A:end", "C"]);
  assert.equal(bRan, false);
});

test("zero delay skips sleep and a failed send does not block the queue", async () => {
  let sleeps = 0;
  const queue = new ConversationDeliveryQueue({
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(await queue.enqueue("private-a", { delayMs: 0, run: () => "ok" }), "ok");
  assert.equal(sleeps, 0);

  await assert.rejects(
    queue.enqueue("private-a", {
      delayMs: 0,
      run: () => {
        throw new Error("send failed");
      },
    }),
    /send failed/,
  );
  assert.equal(
    await queue.enqueue("private-a", { delayMs: 0, run: () => "after failure" }),
    "after failure",
  );
});
