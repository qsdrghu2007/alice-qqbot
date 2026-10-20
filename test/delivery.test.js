import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationDeliveryQueue,
  calculateReplyDelay,
  conversationDeliveryKey,
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

  assert.equal(calculateReplyDelay({ text: "在。" }, noJitter), 640);
  assert.equal(calculateReplyDelay({ text: "今天好累" }, noJitter), 780);
  assert.equal(calculateReplyDelay({ text: "啊".repeat(10) }, noJitter), 1200);
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
    1700,
  );
  assert.equal(calculateReplyDelay({ text: "" }, noJitter), 0);
  assert.equal(calculateReplyDelay({ text: "   " }, noJitter), 0);
  assert.equal(calculateReplyDelay({ text: "好呀", stickerOnly: true }, noJitter), 0);
  assert.equal(calculateReplyDelay({ text: "好呀", stickerOnly: false }, noJitter), 640);
  assert.equal(calculateReplyDelay({ text: "好呀" }, { ...noJitter, enabled: false }), 0);
  assert.equal(
    calculateReplyDelay(
      { text: "今天好累" },
      { ...noJitter, jitter: 0.15 },
      { random: () => 0.5 },
    ),
    780,
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
