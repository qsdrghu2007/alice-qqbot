import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  USER_UNDERSTANDING_DEFAULTS,
  USER_UNDERSTANDING_GUARDRAIL,
  UserUnderstanding,
} from "../src/user-understanding.js";

function config(overrides = {}) {
  return {
    demo: overrides.demo ?? false,
    policy: { paused: false, ...(overrides.policy ?? {}) },
    ai: {
      baseUrl: "https://ai.invalid",
      apiKey: "fake-key",
      model: "fake-model",
      temperature: 0.8,
      ...(overrides.ai ?? {}),
    },
    identityLinks: overrides.identityLinks ?? {},
    userUnderstanding: {
      ...USER_UNDERSTANDING_DEFAULTS,
      ...(overrides.userUnderstanding ?? {}),
    },
  };
}

function profile(summary = "交流表达直接，内容较简洁", confidence = 0.8) {
  return {
    content: JSON.stringify({
      summary,
      traits: [
        { dimension: "communication", value: "direct", confidence },
        { dimension: "communication", value: "concise", confidence },
      ],
    }),
  };
}

function privateEvent(userId = "10001", channel = "onebot") {
  return {
    channel,
    scope: "private",
    userId,
    conversationId: userId,
  };
}

function groupEvent(userId = "10001", channel = "onebot") {
  return {
    channel,
    scope: "group",
    userId,
    conversationId: "90001",
    groupId: "90001",
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "alice-understanding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = options.now ?? Date.parse("2026-01-01T12:00:00+08:00");
  let runtimeConfig = config(options.config);
  const calls = [];
  const logger = {
    warnings: [],
    warn(message) {
      this.warnings.push(message);
    },
  };
  const chat =
    options.chat ??
    (async () => profile());
  const manager = new UserUnderstanding({
    root,
    getConfig: () => runtimeConfig,
    chat: async (request) => {
      calls.push(request);
      return chat(request);
    },
    logger,
    now: () => time,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  await manager.init();
  return {
    root,
    calls,
    logger,
    manager,
    getConfig: () => runtimeConfig,
    setConfig(value) {
      runtimeConfig = value;
    },
    setTime(value) {
      time = typeof value === "number" ? value : Date.parse(value);
    },
  };
}

test("uses a complete local day and respects the configured close time", async (t) => {
  const state = await fixture(t);
  const accepted = await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T23:59:30+08:00",
    messages: [{ role: "user", content: "我说话比较直，简短一点就好" }],
  });
  assert.equal(accepted, true);

  state.setTime("2026-01-02T00:09:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 0);

  state.setTime("2026-01-02T00:10:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 1);
  const context = await state.manager.context(privateEvent());
  assert.ok(context.startsWith(USER_UNDERSTANDING_GUARDRAIL));
  assert.match(context, /暂时印象/u);
  assert.match(context, /依据 1 个有聊天日/u);
  assert.match(context, /communication: direct/u);
});

test("never analyzes a day containing only Alice messages", async (t) => {
  const state = await fixture(t);
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T12:00:00+08:00",
    messages: [{ role: "assistant", content: "只有 Alice 在说话" }],
  });
  state.setTime("2026-01-02T01:00:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 0);
  assert.equal(await state.manager.context(privateEvent()), "");
});

test("shares only safe traits for the current user across private and group", async (t) => {
  const state = await fixture(t);
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T10:00:00+08:00",
    messages: [{ role: "user", content: "这是绝不应进入群聊的私聊原文" }],
  });
  state.setTime("2026-01-02T02:00:00+08:00");
  await state.manager.tick();

  const privateContext = await state.manager.context(privateEvent());
  const groupContext = await state.manager.context(groupEvent("10001"));
  assert.equal(groupContext, privateContext);
  assert.doesNotMatch(groupContext, /绝不应进入群聊/u);
  assert.doesNotMatch(groupContext, /summary|摘要/u);
  assert.equal(await state.manager.context(groupEvent("20002")), "");

  const skipped = await state.manager.recordTurn({
    event: groupEvent(),
    at: "2026-01-02T02:00:00+08:00",
    messages: [{ role: "user", content: "群消息不能单独成为画像依据" }],
  });
  assert.equal(skipped, false);
});

test("accepts bounded nonnumeric QQ official OpenIDs without exposing them", async (t) => {
  const state = await fixture(t);
  const openId = "OPENID_alpha-Unit_123";
  assert.equal(
    await state.manager.recordTurn({
      event: { channel: "qq", scope: "private", userId: openId },
      at: "2026-01-01T10:00:00+08:00",
      messages: [{ role: "user", content: "用简短自然的方式聊天" }],
    }),
    true,
  );
  state.setTime("2026-01-02T02:00:00+08:00");
  await state.manager.tick();
  const context = await state.manager.context({
    channel: "qq",
    scope: "group",
    userId: openId,
  });
  assert.match(context, /communication: concise/u);
  assert.doesNotMatch(context, /OPENID/u);
  assert.doesNotMatch(state.calls[0].messages[1].content, /OPENID/u);
});

test("weekly input contains only that window's daily summaries and is idempotent", async (t) => {
  let dailyCalls = 0;
  const state = await fixture(t, {
    chat: async (request) => {
      if (request.messages[0].content.includes("七天窗口")) {
        return profile("七天内的交流方式较稳定", 0.9);
      }
      dailyCalls += 1;
      return profile(
        dailyCalls === 1 ? "第一天的安全摘要" : "第二天的安全摘要",
      );
    },
  });
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T10:00:00+08:00",
    messages: [{ role: "user", content: "RAW_PRIVATE_ONE" }],
  });
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-02T10:00:00+08:00",
    messages: [{ role: "user", content: "RAW_PRIVATE_TWO" }],
  });
  state.setTime("2026-01-08T03:00:00+08:00");
  await state.manager.tick();

  assert.equal(state.calls.length, 3);
  const weekly = state.calls[2];
  assert.match(weekly.messages[0].content, /七天窗口/u);
  assert.doesNotMatch(weekly.messages[1].content, /RAW_PRIVATE/u);
  assert.match(weekly.messages[1].content, /第一天的安全摘要/u);
  assert.match(weekly.messages[1].content, /第二天的安全摘要/u);
  assert.match(weekly.messages[1].content, /"evidenceDays":2/u);

  await state.manager.tick();
  assert.equal(state.calls.length, 3);
  const context = await state.manager.context(privateEvent());
  assert.match(context, /暂时印象/u);
  assert.match(context, /依据 2 个有聊天日/u);
  assert.match(context, /55%/u);
});

test("failed daily AI keeps raw text, backs off, then succeeds once", async (t) => {
  let attempt = 0;
  const state = await fixture(t, {
    chat: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("fake network");
      return profile();
    },
  });
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T08:00:00+08:00",
    messages: [{ role: "user", content: "需要重试的原始消息" }],
  });
  state.setTime("2026-01-02T00:15:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 1);

  const disk = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  const user = Object.values(disk.users)[0];
  const day = user.days["2026-01-01"];
  assert.equal(day.failure.count, 1);
  assert.match(day.rawMessages[0].content, /需要重试/u);

  await state.manager.tick();
  assert.equal(state.calls.length, 1);
  state.setTime("2026-01-02T00:20:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 2);

  const after = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  const saved = Object.values(after.users)[0].days["2026-01-01"];
  assert.ok(saved.daily);
  assert.deepEqual(saved.rawMessages, []);
  assert.equal(saved.failure, null);
});

test("concurrent turns are serialized without losing messages", async (t) => {
  const state = await fixture(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      state.manager.recordTurn({
        event: privateEvent("30003"),
        at: "2026-01-01T09:00:00+08:00",
        messages: [{ role: "user", content: `并发消息-${index}` }],
      }),
    ),
  );
  state.setTime("2026-01-02T01:00:00+08:00");
  await state.manager.tick();
  const payload = JSON.parse(state.calls[0].messages[1].content);
  assert.equal(payload.coverage.seenMessages, 20);
  assert.equal(payload.messages.length, 20);
  assert.equal(
    payload.messages.filter((item) => item.text.startsWith("并发消息-")).length,
    20,
  );
});

test("clearUser invalidates an in-flight profile before it can commit", async (t) => {
  let release;
  let notified;
  const started = new Promise((resolve) => {
    notified = resolve;
  });
  const state = await fixture(t, {
    chat: () =>
      new Promise((resolve) => {
        release = resolve;
        notified();
      }),
  });
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T11:00:00+08:00",
    messages: [{ role: "user", content: "clear 时正在分析的原文" }],
  });
  state.setTime("2026-01-02T01:00:00+08:00");
  const ticking = state.manager.tick();
  await started;
  assert.equal(await state.manager.clearUser(privateEvent()), true);
  release(profile());
  await ticking;
  assert.equal(await state.manager.context(privateEvent()), "");
  const disk = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  assert.deepEqual(disk.users, {});
});

test("clearUser throws a fixed error and preserves data when persistence fails", async (t) => {
  const state = await fixture(t);
  await state.manager.recordTurn({
    event: privateEvent("81001"),
    at: "2026-01-01T11:00:00+08:00",
    messages: [{ role: "user", content: "must remain after failed clear" }],
  });
  state.manager._mutate = async () => {
    throw new Error("private persistence cause");
  };

  await assert.rejects(
    () => state.manager.clearUser(privateEvent("81001")),
    (error) => {
      assert.equal(error.name, "UserUnderstandingError");
      assert.equal(error.code, "USER_UNDERSTANDING_CLEAR_FAILED");
      assert.equal(error.message, "User understanding clear failed");
      assert.doesNotMatch(error.message, /private persistence cause|81001/u);
      return true;
    },
  );
  const disk = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  assert.equal(Object.keys(disk.users).length, 1);
  assert.equal(
    state.calls.length,
    0,
    "clear failure reporting should not invoke AI",
  );
});

test("resetAll throws a fixed error and preserves data when persistence fails", async (t) => {
  const state = await fixture(t);
  await state.manager.recordTurn({
    event: privateEvent("82002"),
    at: "2026-01-01T11:00:00+08:00",
    messages: [{ role: "user", content: "must remain after failed reset" }],
  });
  state.manager._mutate = async () => {
    throw new Error("private reset cause");
  };

  await assert.rejects(
    () => state.manager.resetAll(),
    (error) => {
      assert.equal(error.name, "UserUnderstandingError");
      assert.equal(error.code, "USER_UNDERSTANDING_RESET_FAILED");
      assert.equal(error.message, "User understanding reset failed");
      assert.doesNotMatch(error.message, /private reset cause|82002/u);
      return true;
    },
  );
  const disk = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  assert.equal(Object.keys(disk.users).length, 1);
});

test("caps input fairly, reports truncation, and redacts credentials", async (t) => {
  const state = await fixture(t, {
    config: {
      userUnderstanding: {
        maxInputChars: 1000,
        maxDailyMessages: 10,
      },
    },
  });
  const messages = [
    { role: "assistant", content: "A".repeat(4000) },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user",
      content:
        index === 0
          ? "密码：should-not-leak 验证码 123456 QQ号：123456789 " + "sk-" + "abcdefghijklmnopqrstuvwx" + " 我更喜欢直接交流"
          : `用户消息 ${index}`,
    })),
  ];
  await state.manager.recordTurn({
    event: privateEvent(),
    at: "2026-01-01T09:00:00+08:00",
    messages,
  });
  state.setTime("2026-01-02T02:00:00+08:00");
  await state.manager.tick();
  const request = state.calls[0].messages[1].content;
  const payload = JSON.parse(request);
  assert.equal(payload.coverage.truncated, true);
  assert.doesNotMatch(request, /should-not-leak/u);
  assert.doesNotMatch(request, /123456/u);
  assert.doesNotMatch(request, /123456789/u);
  assert.doesNotMatch(request, new RegExp("sk-" + "abcdefgh", "u"));
  assert.ok(
    payload.messages.some((item) => item.text.includes("我更喜欢直接交流")),
  );
});

test("waiting daily retries keep the weekly window incomplete", async (t) => {
  let dailyAttempt = 0;
  const state = await fixture(t, {
    chat: async (request) => {
      if (request.messages[0].content.includes("七天窗口")) {
        return profile("不应在第一轮出现", 0.9);
      }
      dailyAttempt += 1;
      if (dailyAttempt === 2) throw new Error("daily failed");
      return profile("安全摘要");
    },
  });
  for (const day of ["2026-01-01", "2026-01-02"]) {
    await state.manager.recordTurn({
      event: privateEvent(),
      at: `${day}T10:00:00+08:00`,
      messages: [{ role: "user", content: `原始-${day}` }],
    });
  }
  state.setTime("2026-01-08T03:00:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 2);
  assert.equal(
    state.calls.filter((call) =>
      call.messages[0].content.includes("七天窗口"),
    ).length,
    0,
  );

  state.setTime("2026-01-08T03:05:00+08:00");
  await state.manager.tick();
  assert.equal(
    state.calls.filter((call) =>
      call.messages[0].content.includes("七天窗口"),
    ).length,
    1,
  );
});

test("stop prevents subsequent queued AI calls from starting", async (t) => {
  let release;
  let notify;
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  const state = await fixture(t, {
    chat: () =>
      new Promise((resolve) => {
        release = resolve;
        notify();
      }),
  });
  await state.manager.recordTurn({
    event: privateEvent("40004"),
    at: "2026-01-01T10:00:00+08:00",
    messages: [{ role: "user", content: "第一个用户" }],
  });
  await state.manager.recordTurn({
    event: privateEvent("50005"),
    at: "2026-01-01T10:00:00+08:00",
    messages: [{ role: "user", content: "第二个用户" }],
  });
  state.setTime("2026-01-02T03:00:00+08:00");
  const ticking = state.manager.tick();
  await started;
  await state.manager.stop();
  release(profile());
  await ticking;
  assert.equal(state.calls.length, 1);
});

test("prunes expired data when disabled and enforces maxUsers after insert", async (t) => {
  const state = await fixture(t, {
    config: { userUnderstanding: { maxUsers: 1, retentionDays: 7 } },
  });
  await state.manager.recordTurn({
    event: privateEvent("60006"),
    at: "2026-01-01T10:00:00+08:00",
    messages: [{ role: "user", content: "old user" }],
  });
  await state.manager.recordTurn({
    event: privateEvent("70007"),
    at: "2026-01-01T11:00:00+08:00",
    messages: [{ role: "user", content: "new user" }],
  });
  let disk = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  assert.equal(Object.keys(disk.users).length, 1);

  state.setConfig({
    ...config({ userUnderstanding: { retentionDays: 7 } }),
    userUnderstanding: {
      ...USER_UNDERSTANDING_DEFAULTS,
      enabled: false,
      retentionDays: 7,
    },
  });
  state.setTime("2026-01-10T03:00:00+08:00");
  await state.manager.tick();
  disk = JSON.parse(
    await readFile(path.join(state.root, "data", "user-understanding.json"), "utf8"),
  );
  assert.deepEqual(disk.users, {});
  assert.equal(state.calls.length, 0);
});

test("demo mode disables collection and malformed state is isolated", async (t) => {
  const state = await fixture(t, { config: { demo: true } });
  assert.equal(
    await state.manager.recordTurn({
      event: privateEvent(),
      at: "2026-01-01T09:00:00+08:00",
      messages: [{ role: "user", content: "demo 不分析" }],
    }),
    false,
  );
  state.setTime("2026-01-02T09:00:00+08:00");
  await state.manager.tick();
  assert.equal(state.calls.length, 0);

  const brokenRoot = await mkdtemp(
    path.join(os.tmpdir(), "alice-understanding-broken-"),
  );
  t.after(() => rm(brokenRoot, { recursive: true, force: true }));
  const directory = path.join(brokenRoot, "data");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "user-understanding.json"), "{broken");
  const warnings = [];
  const recovered = new UserUnderstanding({
    root: brokenRoot,
    getConfig: () => config(),
    chat: async () => profile(),
    logger: { warn: (message) => warnings.push(message) },
    now: () => Date.parse("2026-01-02T09:00:00+08:00"),
  });
  await recovered.init();
  assert.deepEqual(warnings, ["User understanding error [STATE_LOAD_FAILED]"]);
  assert.equal(await recovered.context(privateEvent()), "");
});
