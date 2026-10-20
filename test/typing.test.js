import assert from "node:assert/strict";
import test from "node:test";

import { TypingIndicator, typingEligible } from "../src/typing.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function privateEvent(userId = "10001") {
  return {
    channel: "onebot",
    scope: "private",
    userId,
    conversationId: userId,
  };
}

function typingConfig(overrides = {}) {
  return {
    policy: { paused: false },
    replyDelay: { typingIndicator: true },
    ...overrides,
  };
}

function harness({ fail = false, backoffMs = 60_000 } = {}) {
  let now = 0;
  let nextTimer = 1;
  const calls = [];
  const intervals = new Map();
  let config = typingConfig();
  const adapter = {
    async setInputStatus(event) {
      calls.push({ ...event });
      if (fail) throw new Error("unsupported");
      return { status: "ok" };
    },
  };
  const timers = {
    setInterval(fn, ms) {
      const timer = { id: nextTimer++, fn, ms };
      intervals.set(timer.id, timer);
      return timer;
    },
    clearInterval(timer) {
      intervals.delete(timer.id);
    },
  };
  const typing = new TypingIndicator({
    getConfig: () => config,
    adapter,
    timers,
    backoffMs,
    now: () => now,
    logger: { debug() {} },
  });
  return {
    typing,
    calls,
    intervals,
    setConfig(next) {
      config = next;
    },
    advance(ms) {
      now += ms;
    },
    fireIntervals() {
      for (const timer of [...intervals.values()]) timer.fn();
    },
  };
}

test("typing eligibility is limited to enabled OneBot private chats", () => {
  assert.equal(typingEligible(privateEvent(), typingConfig()), true);
  assert.equal(
    typingEligible(privateEvent(), typingConfig({ replyDelay: { typingIndicator: false } })),
    false,
  );
  assert.equal(
    typingEligible(
      { ...privateEvent(), channel: "qq" },
      typingConfig(),
    ),
    false,
  );
  assert.equal(
    typingEligible(
      { ...privateEvent(), scope: "group", groupId: "20002", conversationId: "20002" },
      typingConfig(),
    ),
    false,
  );
  assert.equal(
    typingEligible({ ...privateEvent(), channel: "local" }, typingConfig()),
    false,
  );
});

test("starts once, refreshes, and stops per conversation", async () => {
  const h = harness();
  const stop = h.typing.start(privateEvent());
  await tick();
  assert.deepEqual(h.calls, [privateEvent()]);
  assert.equal(h.typing.size(), 1);
  assert.equal([...h.intervals.values()][0].ms, 3000);

  h.fireIntervals();
  await tick();
  assert.equal(h.calls.length, 2);

  stop();
  assert.equal(h.typing.size(), 0);
  assert.equal(h.intervals.size, 0);
  stop();
  assert.equal(h.typing.size(), 0);
});

test("skips groups, official QQ, local chat, pause, and disabled config", async () => {
  const h = harness();
  const stopGroup = h.typing.start({
    channel: "onebot",
    scope: "group",
    userId: "10001",
    groupId: "20002",
    conversationId: "20002",
  });
  const stopQq = h.typing.start({ ...privateEvent(), channel: "qq" });
  const stopLocal = h.typing.start({ ...privateEvent(), channel: "local" });
  h.setConfig(typingConfig({ policy: { paused: true } }));
  const stopPaused = h.typing.start(privateEvent());
  h.setConfig(typingConfig({ replyDelay: { typingIndicator: false } }));
  const stopDisabled = h.typing.start(privateEvent());
  await tick();

  assert.equal(h.calls.length, 0);
  assert.equal(h.typing.size(), 0);
  for (const stop of [stopGroup, stopQq, stopLocal, stopPaused, stopDisabled]) stop();
});

test("different users keep independent indicators and timers", async () => {
  const h = harness();
  const stopA = h.typing.start(privateEvent("10001"));
  const stopB = h.typing.start(privateEvent("10002"));
  await tick();

  assert.deepEqual(
    h.calls.map((event) => event.userId).sort(),
    ["10001", "10002"],
  );
  assert.equal(h.typing.size(), 2);
  assert.equal(h.intervals.size, 2);

  stopA();
  assert.equal(h.typing.size(), 1);
  assert.equal(h.intervals.size, 1);
  h.fireIntervals();
  await tick();
  assert.deepEqual(
    h.calls.map((event) => event.userId),
    ["10001", "10002", "10002"],
  );

  stopB();
  assert.equal(h.typing.size(), 0);
  assert.equal(h.intervals.size, 0);
});

test("overlapping messages from one user share one indicator", async () => {
  const h = harness();
  const stopFirst = h.typing.start(privateEvent());
  const stopSecond = h.typing.start(privateEvent());
  await tick();

  assert.equal(h.calls.length, 1);
  assert.equal(h.typing.size(), 1);
  assert.equal(h.intervals.size, 1);

  stopFirst();
  assert.equal(h.typing.size(), 1);
  assert.equal(h.intervals.size, 1);

  stopSecond();
  assert.equal(h.typing.size(), 0);
  assert.equal(h.intervals.size, 0);
});

test("refresh stops when the switch or pause changes", async () => {
  const h = harness();
  const stop = h.typing.start(privateEvent());
  await tick();
  assert.equal(h.calls.length, 1);

  h.setConfig(typingConfig({ replyDelay: { typingIndicator: false } }));
  h.fireIntervals();
  await tick();
  assert.equal(h.calls.length, 1);

  h.setConfig(typingConfig({ policy: { paused: true } }));
  h.fireIntervals();
  await tick();
  assert.equal(h.calls.length, 1);
  stop();
});

test("adapter failures are best-effort and back off", async () => {
  const h = harness({ fail: true, backoffMs: 1000 });
  const stop = h.typing.start(privateEvent());
  await tick();
  assert.equal(h.calls.length, 1);

  h.fireIntervals();
  await tick();
  assert.equal(h.calls.length, 1);

  h.advance(1001);
  h.fireIntervals();
  await tick();
  assert.equal(h.calls.length, 2);
  stop();
});

test("stopAll clears every conversation", async () => {
  const h = harness();
  h.typing.start(privateEvent("10001"));
  h.typing.start(privateEvent("10002"));
  await tick();
  assert.equal(h.typing.size(), 2);

  h.typing.stopAll();
  assert.equal(h.typing.size(), 0);
  assert.equal(h.intervals.size, 0);
  h.fireIntervals();
  await tick();
  assert.equal(h.calls.length, 2);
});
