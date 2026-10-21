import test from "node:test";
import assert from "node:assert/strict";

import {
  BatchCancelledError,
  MessageBatcher,
  calculateInputSilence,
  eventHistoryText,
  isExplicitAcknowledgement,
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

function harness(handler, { now = Date.now } = {}) {
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
    now,
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

test("unfinished input waits slightly longer while explicit questions keep the base delay", () => {
  assert.equal(calculateInputSilence("我跟你说", 2_000), 3_000);
  assert.equal(calculateInputSilence("我跟你说件事", 2_000), 3_000);
  assert.equal(calculateInputSilence("事情是这样的", 2_000), 3_000);
  assert.equal(calculateInputSilence("今天考试……", 2_000), 3_000);
  assert.equal(calculateInputSilence("你吃了吗？", 2_000), 2_000);
  assert.equal(calculateInputSilence("你觉得呢", 2_000), 2_000);
  assert.equal(calculateInputSilence("你觉得呢？", 2_000), 2_000);
  assert.equal(calculateInputSilence("普通一句话", 2_000), 2_000);
  assert.equal(calculateInputSilence("然后", 10_000), 11_000);
});

test("input timing handles image captions and repeated incomplete fragments without AI", () => {
  assert.equal(
    calculateInputSilence("", 2_000, {
      attachments: [{ type: "image", url: "https://example.test/a.png" }],
    }),
    2_500,
  );
  assert.equal(
    calculateInputSilence("这个", 2_000, {
      attachments: [{ type: "image", url: "https://example.test/a.png" }],
      sessionMessages: 3,
    }),
    2_300,
  );
  assert.equal(calculateInputSilence("今天到这里", 2_000, { sessionMessages: 5 }), 2_000);
  assert.equal(calculateInputSilence("然后", 10_000, { sessionMessages: 8 }), 11_300);
});

test("only explicit acknowledgement forms are treated as non-interrupting supplements", () => {
  for (const text of ["嗯", "嗯嗯", "哈哈", "哈哈哈哈", "好", "好的。", "收到！", "OK", "确实"]) {
    assert.equal(isExplicitAcknowledgement(text), true, text);
  }
  for (const text of ["嗯我想想", "好吧但是", "哈哈然后呢", "不知道", "1", ""]) {
    assert.equal(isExplicitAcknowledgement(text), false, text);
  }
  assert.equal(
    isExplicitAcknowledgement("嗯", {
      attachments: [{ type: "image", url: "https://example.test/a.png" }],
    }),
    false,
  );
  assert.equal(eventHistoryText(event({ text: "", attachments: [{ type: "file" }] })), "[file]");
});

test("continuous unfinished messages rebase from the latest input and stay bounded", async () => {
  const calls = [];
  const h = harness(async ({ event: merged, events }) => {
    calls.push({ text: merged.text, count: events.length });
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "open-1", text: "我跟你说" }));
  assert.deepEqual(h.delays(), [3_000]);
  h.batcher.enqueue(event({ id: "open-2", text: "然后" }));
  assert.deepEqual(h.delays(), [3_000]);
  h.batcher.enqueue(event({ id: "question", text: "你吃了吗？" }));
  assert.deepEqual(h.delays(), [2_000]);

  h.fire();
  await tick();
  assert.deepEqual(calls, [
    { text: "我跟你说\n然后\n你吃了吗？", count: 3 },
  ]);
});

test("a hard collection cap prevents endless waiting while messages keep arriving", async () => {
  let now = 1_000;
  const calls = [];
  const h = harness(
    async ({ event: merged }) => {
      calls.push(merged.text);
      return { status: "sent" };
    },
    { now: () => now },
  );

  h.batcher.enqueue(event({ id: "wait-1", text: "我跟你说" }));
  assert.deepEqual(h.delays(), [3_000]);
  now = 3_500;
  h.batcher.enqueue(event({ id: "wait-2", text: "然后" }));
  assert.deepEqual(h.delays(), [3_000]);
  now = 7_200;
  h.batcher.enqueue(event({ id: "wait-3", text: "所以" }));
  assert.deepEqual(h.delays(), [0]);

  h.fire();
  await tick();
  assert.deepEqual(calls, ["我跟你说\n然后\n所以"]);
});

test("bounded in-memory burst habit adds a small wait only for repeated unfinished input", async () => {
  const h = harness(async () => ({ status: "sent" }));

  h.batcher.enqueue(event({ id: "habit-a1", text: "一" }));
  h.batcher.enqueue(event({ id: "habit-a2", text: "二" }));
  h.fire();
  await tick();
  h.batcher.enqueue(event({ id: "habit-b1", text: "三" }));
  h.batcher.enqueue(event({ id: "habit-b2", text: "四" }));
  h.fire();
  await tick();

  h.batcher.enqueue(event({ id: "habit-open", text: "然后" }));
  assert.deepEqual(h.delays(), [3_300]);
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

test("explicit acknowledgements do not abort, and a later real message remixes them in order", async () => {
  let calls = 0;
  let firstSignal;
  const seen = [];
  const h = harness(async ({ signal, event: merged, events }) => {
    calls += 1;
    seen.push({ text: merged.text, events: events.map((item) => item.text) });
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

  h.batcher.enqueue(event({ id: "base", text: "原来的问题" }));
  h.fire();
  await tick();
  assert.equal(firstSignal.aborted, false);
  assert.equal(
    h.batcher.enqueue(event({ id: "ack", text: "嗯嗯" })).status,
    "supplemented",
  );
  assert.equal(firstSignal.aborted, false);
  assert.equal(
    h.batcher.enqueue(event({ id: "replacement", text: "等等，我改成第二个问题" })).status,
    "batched",
  );
  await tick();
  assert.equal(firstSignal.aborted, true);

  h.fire();
  await tick();
  assert.deepEqual(seen, [
    { text: "原来的问题", events: ["原来的问题"] },
    {
      text: "原来的问题\n嗯嗯\n等等，我改成第二个问题",
      events: ["原来的问题", "嗯嗯", "等等，我改成第二个问题"],
    },
  ]);
});

test("acks arriving after an abort stay behind the interrupting message", async () => {
  let calls = 0;
  let firstSignal;
  const seen = [];
  const h = harness(async ({ signal, event: merged }) => {
    calls += 1;
    seen.push(merged.text);
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

  h.batcher.enqueue(event({ id: "race-a", text: "A" }));
  h.fire();
  await tick();
  h.batcher.enqueue(event({ id: "race-b", text: "B 修正" }));
  assert.equal(firstSignal.aborted, true);
  assert.equal(
    h.batcher.enqueue(event({ id: "race-c", text: "嗯嗯" })).status,
    "batched",
  );
  await tick();
  h.fire();
  await tick();
  assert.deepEqual(seen, ["A", "A\nB 修正\n嗯嗯"]);
});

test("an acknowledgement during drafting survives as a history supplement", async () => {
  let release;
  let handlerContext;
  const h = harness(async (context) => {
    handlerContext = context;
    await new Promise((resolve) => {
      release = resolve;
    });
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "draft", text: "原问题" }));
  h.fire();
  await tick();
  assert.equal(h.batcher.enqueue(event({ id: "ack-2", text: "哈哈" })).status, "supplemented");
  assert.deepEqual(
    handlerContext.getSupplements().map((item) => item.text),
    ["哈哈"],
  );
  handlerContext.markSupplementsCommitted();
  release();
  await tick();
  assert.deepEqual(handlerContext.getSupplements(), []);
});

test("uncommitted supplements are cleared instead of leaking into the next batch", async () => {
  let calls = 0;
  let release;
  let nextSupplements = null;
  const h = harness(async ({ getSupplements }) => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { status: "sent" };
    }
    nextSupplements = getSupplements();
    return { status: "sent" };
  });

  h.batcher.enqueue(event({ id: "cleanup-a", text: "原问题" }));
  h.fire();
  await tick();
  h.batcher.enqueue(event({ id: "cleanup-ack", text: "嗯" }));
  release();
  await tick();

  h.batcher.enqueue(event({ id: "cleanup-next", text: "下一轮问题" }));
  h.fire();
  await tick();
  assert.deepEqual(nextSupplements, []);
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
