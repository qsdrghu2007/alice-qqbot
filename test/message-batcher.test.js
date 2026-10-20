import test from "node:test";
import assert from "node:assert/strict";

import {
  BatchCancelledError,
  MessageBatcher,
  mergeEvents,
  sleepWithSignal,
} from "../src/message-batcher.js";

const tick = async (rounds = 20) => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
};

function event(overrides = {}) {
  return {
    id: `event-${Math.random()}`,
    channel: "onebot",
    scope: "private",
    userId: "10001",
    conversationId: "10001",
    text: "你好",
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function harness(handler) {
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
  const batcher = new MessageBatcher({
    handler,
    timers: timerApi,
    silentMs: 2_000,
  });
  return {
    batcher,
    timers,
    delays: () => [...timers.values()].map((timer) => timer.ms),
    fire() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

test("mergeEvents joins text and attachments in order", () => {
  const merged = mergeEvents([
    event({ id: "first", text: " 第一句 ", attachments: [{ type: "image", url: "https://a" }] }),
    event({ id: "second", text: "", attachments: [{ type: "image", url: "https://b" }] }),
    event({ id: "last", text: "第三句" }),
  ]);

  assert.equal(merged.text, "第一句\n第三句");
  assert.deepEqual(merged.attachments, [
    { type: "image", url: "https://a" },
    { type: "image", url: "https://b" },
  ]);
  assert.equal(merged.mergedCount, 3);
  assert.equal(merged.id, "last");
});

test("merged events without a message id get a synthetic id", () => {
  const merged = mergeEvents([event({ id: "", text: "无 ID" })]);
  assert.match(merged.id, /^merged-/);
});

test("sleepWithSignal rejects when the batch is aborted", async () => {
  const controller = new AbortController();
  const pending = sleepWithSignal(5_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, BatchCancelledError);
});

test("a single message waits two seconds before the handler runs", async () => {
  const calls = [];
  const h = harness(async ({ event: merged, events }) => {
    calls.push({ text: merged.text, count: events.length });
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "one", text: "单条" }));
  assert.deepEqual(h.delays(), [2_000]);
  assert.equal(calls.length, 0);

  h.fire();
  await tick();
  assert.deepEqual(calls, [{ text: "单条", count: 1 }]);
});

test("rapid messages merge and reset the silent timer", async () => {
  const calls = [];
  const h = harness(async ({ event: merged, events }) => {
    calls.push({ text: merged.text, count: events.length });
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "a", text: "第一句" }));
  h.batcher.enqueue(event({ id: "b", text: "第二句" }));
  h.batcher.enqueue(event({ id: "c", text: "第三句" }));
  assert.deepEqual(h.delays(), [2_000]);

  h.fire();
  await tick();
  assert.deepEqual(calls, [{ text: "第一句\n第二句\n第三句", count: 3 }]);
});

test("duplicate event ids are ignored and empty ids remain distinct", async () => {
  const calls = [];
  const h = harness(async ({ events }) => {
    calls.push(events.map((item) => item.text));
    return { status: "sent" };
  });

  assert.equal(h.batcher.enqueue(event({ id: "same", text: "一" })).status, "batched");
  assert.equal(h.batcher.enqueue(event({ id: "same", text: "一" })).status, "duplicate");
  h.batcher.enqueue(event({ id: "", text: "二" }));
  h.batcher.enqueue(event({ id: "", text: "三" }));

  h.fire();
  await tick();
  assert.deepEqual(calls, [["一", "二", "三"]]);
});

test("a new message aborts generation and re-merges uncommitted messages", async () => {
  let calls = 0;
  const seen = [];
  let firstSignal;
  const h = harness(async ({ signal, event: merged, events }) => {
    calls += 1;
    seen.push({ text: merged.text, count: events.length });
    if (calls === 1) {
      firstSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new BatchCancelledError()),
          { once: true },
        );
      });
    }
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "first", text: "第一句" }));
  h.fire();
  await tick();
  assert.equal(calls, 1);
  assert.equal(firstSignal.aborted, false);

  h.batcher.enqueue(event({ id: "second", text: "第二句" }));
  await tick();
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(h.delays(), [2_000]);

  h.fire();
  await tick();
  assert.deepEqual(seen, [
    { text: "第一句", count: 1 },
    { text: "第一句\n第二句", count: 2 },
  ]);
});

test("messages arriving after send starts form the next batch", async () => {
  let calls = 0;
  let sendSignal;
  const h = harness(async ({ signal, onBeforeSend }) => {
    calls += 1;
    if (calls === 1) {
      sendSignal = signal;
      onBeforeSend();
      h.batcher.enqueue(event({ id: "next", text: "下一批" }));
      assert.equal(signal.aborted, false);
    }
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "send", text: "第一批" }));
  h.fire();
  await tick();
  assert.equal(calls, 1);
  assert.equal(sendSignal.aborted, false);
  assert.deepEqual(h.delays(), [2_000]);

  h.fire();
  await tick();
  assert.equal(calls, 2);
});

test("different group users are batched separately", async () => {
  const calls = [];
  const h = harness(async ({ event: merged }) => {
    calls.push({ user: merged.userId, text: merged.text });
    return { status: "sent" };
  });

  h.batcher.enqueue(
    event({
      id: "group-a",
      scope: "group",
      conversationId: "20002",
      groupId: "20002",
      userId: "10001",
      text: "A",
    }),
  );
  h.batcher.enqueue(
    event({
      id: "group-b",
      scope: "group",
      conversationId: "20002",
      groupId: "20002",
      userId: "10002",
      text: "B",
    }),
  );
  assert.deepEqual(h.delays(), [2_000, 2_000]);

  h.fire();
  await tick();
  assert.deepEqual(
    calls.sort((left, right) => left.user.localeCompare(right.user)),
    [
      { user: "10001", text: "A" },
      { user: "10002", text: "B" },
    ],
  );
});

test("stop clears timers and prevents later handlers", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "stop" }));
  h.batcher.stop();
  h.fire();
  await tick();
  assert.equal(calls, 0);
  assert.equal(h.batcher.size(), 0);
});
