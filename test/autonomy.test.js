import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { Autonomy } from "../src/autonomy.js";

const START = new Date("2026-10-19T04:00:00.000Z");

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-autonomy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeConfig(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.demo = false;
  config.ai.apiKey = "test-key";
  config.qzone.enabled = true;
  config.qzone.autoPublish = true;
  config.policy.autoActions = true;
  config.policy.paused = false;
  config.autonomy.enabled = true;
  config.autonomy.intervalMinutes = 60;
  config.autonomy.timezone = "Asia/Shanghai";
  config.autonomy.quietHours = { start: 23, end: 8 };
  return {
    ...config,
    ...overrides,
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
    qzone: { ...config.qzone, ...(overrides.qzone ?? {}) },
    policy: { ...config.policy, ...(overrides.policy ?? {}) },
    autonomy: { ...config.autonomy, ...(overrides.autonomy ?? {}) },
  };
}

async function writeSchedule(root, nextAt, intervalMinutes = 60) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(
    path.join(root, "data", "autonomy.json"),
    `${JSON.stringify(
      {
        version: 1,
        intervalMinutes,
        nextAt,
        quietDeferred: false,
        lastRunAt: null,
        lastAttemptAt: null,
        lastStatus: "scheduled",
        lastError: null,
        lastResult: null,
      },
      null,
      2,
    )}\n`,
  );
}

async function dueScheduler(t, configOverrides = {}, dependencies = {}) {
  const root = await temporaryRoot(t);
  let clock = new Date(START);
  await writeSchedule(root, new Date(START.getTime() + 60 * 60_000).toISOString());
  const config = makeConfig(configOverrides);
  let chatCalls = 0;
  let publishCalls = 0;
  const autonomy = new Autonomy({
    root,
    getConfig: () => config,
    qzone: {
      async publish(text, options) {
        publishCalls += 1;
        return dependencies.publish
          ? dependencies.publish(text, options)
          : { status: "sent", providerId: "tid-1" };
      },
    },
    chat: async (request) => {
      chatCalls += 1;
      return dependencies.chat
        ? dependencies.chat(request)
        : { content: "今天窗外很安静。", toolCalls: [] };
    },
    weather: dependencies.weather ?? (async () => ({
      description: "多云",
      temperature: 20,
      apparentTemperature: 19,
      humidity: 60,
      windSpeed: 5,
    })),
    now: () => new Date(clock),
    logger: { error() {}, debug() {} },
  });
  await autonomy.init();
  return {
    root,
    autonomy,
    config,
    advanceToDue() {
      clock = new Date(START.getTime() + 60 * 60_000);
    },
    setClock(date) {
      clock = new Date(date);
    },
    chatCalls: () => chatCalls,
    publishCalls: () => publishCalls,
  };
}

test("an overdue startup deadline posts one catch-up immediately and records the next time", async (t) => {
  const root = await temporaryRoot(t);
  const clock = new Date("2026-10-19T15:30:00.000Z");
  const stale = new Date(clock.getTime() - 5 * 60 * 60_000).toISOString();
  await writeSchedule(root, stale);
  let chatCalls = 0;
  let publishCalls = 0;
  let chatRequest;
  const autonomy = new Autonomy({
    root,
    getConfig: () => makeConfig(),
    qzone: {
      async publish() {
        publishCalls += 1;
        return { status: "sent" };
      },
    },
    chat: async (request) => {
      chatCalls += 1;
      chatRequest = request;
      return { content: "补一条。" };
    },
    weather: async () => ({
      description: "多云",
      temperature: 20,
      apparentTemperature: 19,
      humidity: 60,
      windSpeed: 5,
    }),
    now: () => new Date(clock),
    logger: { error() {}, debug() {} },
  });
  await autonomy.init();
  assert.equal(autonomy.status().catchUp, true);
  await autonomy.start();
  await autonomy.tick();
  assert.equal(chatCalls, 1);
  assert.equal(publishCalls, 1);
  assert.ok(new Date(autonomy.status().nextAt).getTime() > clock.getTime());
  assert.equal(autonomy.status().quietDeferred, false);
  assert.match(chatRequest.messages[0].content, /南京当前天气：多云/);
  await autonomy.stop();
});

test("normal quiet-hour due defers across restart and only posts after quiet ends", async (t) => {
  const root = await temporaryRoot(t);
  let clock = new Date("2026-10-19T15:29:00.000Z");
  await writeSchedule(root, "2026-10-19T15:30:00.000Z");
  let chatCalls = 0;
  let publishCalls = 0;
  const dependencies = {
    qzone: {
      async publish() {
        publishCalls += 1;
        return { status: "sent" };
      },
    },
    chat: async () => {
      chatCalls += 1;
      return { content: "早上好。" };
    },
    weather: async () => ({
      description: "晴",
      temperature: 16,
      apparentTemperature: 15,
      humidity: 50,
      windSpeed: 3,
    }),
  };
  const autonomy = new Autonomy({
    root,
    getConfig: () => makeConfig(),
    ...dependencies,
    now: () => new Date(clock),
    logger: { error() {}, debug() {} },
  });
  await autonomy.init();
  assert.equal(autonomy.status().catchUp, false);
  await autonomy.start();
  clock = new Date("2026-10-19T15:30:00.000Z");
  await autonomy.tick();
  assert.equal(autonomy.status().quietDeferred, true);
  assert.equal(chatCalls, 0);
  assert.equal(publishCalls, 0);
  await autonomy.stop();

  clock = new Date("2026-10-19T15:45:00.000Z");
  const restarted = new Autonomy({
    root,
    getConfig: () => makeConfig(),
    ...dependencies,
    now: () => new Date(clock),
    logger: { error() {}, debug() {} },
  });
  await restarted.init();
  assert.equal(restarted.status().catchUp, false);
  await restarted.start();
  await restarted.tick();
  assert.equal(chatCalls, 0);
  assert.equal(publishCalls, 0);

  clock = new Date("2026-10-20T00:00:00.000Z");
  await restarted.tick();
  assert.equal(chatCalls, 1);
  assert.equal(publishCalls, 1);
  await restarted.stop();
});

test("disabled, paused, missing key, and quiet-hour states do not call AI", async (t) => {
  const cases = [
    [{ autonomy: { enabled: false } }, "disabled"],
    [{ policy: { paused: true } }, "paused"],
    [{ ai: { apiKey: "" } }, "ai_key_missing"],
    [{ demo: true }, "demo_mode"],
  ];
  for (const [overrides, reason] of cases) {
    const fixture = await dueScheduler(t, overrides);
    await fixture.autonomy.start();
    fixture.advanceToDue();
    assert.deepEqual(await fixture.autonomy.tick(), { skipped: true, reason });
    assert.equal(fixture.chatCalls(), 0);
    await fixture.autonomy.stop();
  }

  const quiet = await dueScheduler(t, {
    autonomy: { quietHours: { start: 23, end: 8 } },
  });
  await quiet.autonomy.start();
  quiet.setClock(new Date("2026-10-19T15:00:00.000Z"));
  assert.deepEqual(await quiet.autonomy.tick(), { skipped: true, reason: "quiet_hours" });
  assert.equal(quiet.chatCalls(), 0);
  await quiet.autonomy.stop();
});

test("due schedule persists the next slot before text-only generation", async (t) => {
  let persistedBeforeChat;
  let stateRoot;
  let chatRequest;
  const fixture = await dueScheduler(t, {}, {
    chat: async (request) => {
      chatRequest = request;
      const state = JSON.parse(
        await readFile(path.join(stateRoot, "data", "autonomy.json"), "utf8"),
      );
      persistedBeforeChat = state.nextAt;
      return { content: "一条自然、简短的动态。", toolCalls: [{ name: "ignored" }] };
    },
  });
  stateRoot = fixture.root;
  await fixture.autonomy.start();
  fixture.advanceToDue();
  const result = await fixture.autonomy.tick();
  assert.equal(result.attempted, true);
  assert.equal(fixture.chatCalls(), 1);
  assert.equal(fixture.publishCalls(), 1);
  assert.ok(new Date(persistedBeforeChat).getTime() > START.getTime() + 60 * 60_000);
  assert.equal(chatRequest.messages[0].role, "system");
  assert.match(chatRequest.messages[0].content, /你的名字是Alice/);
  assert.match(chatRequest.messages[0].content, /当前时间：2026-10-19 13:00/);
  assert.match(chatRequest.messages[0].content, /南京当前天气：多云，气温 20°C/);
  assert.match(chatRequest.messages[0].content, /不要机械复述/);
  assert.equal(chatRequest.messages[1].role, "user");
  assert.equal(chatRequest.tools, undefined);
  assert.equal(fixture.autonomy.status().lastStatus, "sent");
  await fixture.autonomy.stop();
});

test("weather failure still publishes with time context and no invented weather", async (t) => {
  let chatRequest;
  const fixture = await dueScheduler(
    t,
    {},
    {
      weather: async () => {
        throw new Error("weather offline");
      },
      chat: async (request) => {
        chatRequest = request;
        return { content: "中午啦，记得吃饭。" };
      },
    },
  );
  await fixture.autonomy.start();
  fixture.advanceToDue();
  const result = await fixture.autonomy.tick();
  assert.equal(result.attempted, true);
  assert.equal(fixture.publishCalls(), 1);
  assert.match(chatRequest.messages[0].content, /当前时间：2026-10-19 13:00/);
  assert.match(chatRequest.messages[0].content, /南京当前天气：暂时获取失败/);
  assert.match(chatRequest.messages[0].content, /不要编造/);
  await fixture.autonomy.stop();
});

test("disabling autonomy while AI is generating prevents publishing", async (t) => {
  let releaseChat;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const fixture = await dueScheduler(t, {}, {
    chat: async () => {
      signalStarted();
      return new Promise((resolve) => {
        releaseChat = resolve;
      });
    },
  });
  await fixture.autonomy.start();
  fixture.advanceToDue();
  const running = fixture.autonomy.tick();
  await started;
  fixture.config.autonomy.enabled = false;
  releaseChat({ content: "不应该发布" });
  const result = await running;
  assert.deepEqual(result, { skipped: true, reason: "disabled" });
  assert.equal(fixture.publishCalls(), 0);
  assert.equal(fixture.autonomy.status().lastStatus, "cancelled");
  await fixture.autonomy.stop();
});

test("stop after AI generation prevents publishing", async (t) => {
  let releaseChat;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const fixture = await dueScheduler(t, {}, {
    chat: async () => {
      signalStarted();
      return new Promise((resolve) => {
        releaseChat = resolve;
      });
    },
  });
  await fixture.autonomy.start();
  fixture.advanceToDue();
  const running = fixture.autonomy.tick();
  await started;
  const stopping = fixture.autonomy.stop();
  releaseChat({ content: "不应被发布" });
  await running;
  await stopping;
  assert.equal(fixture.publishCalls(), 0);
  assert.equal(fixture.autonomy.status().lastStatus, "stopped");
});

test("failed or unknown publishing waits for the persisted interval", async (t) => {
  for (const status of ["failed", "unknown"]) {
    const fixture = await dueScheduler(t, {}, {
      publish: async () => ({
        status,
        reason: status === "unknown" ? "timeout" : "offline",
        message: "未确认",
      }),
    });
    await fixture.autonomy.start();
    fixture.advanceToDue();
    await fixture.autonomy.tick();
    await fixture.autonomy.tick();
    assert.equal(fixture.chatCalls(), 1);
    assert.equal(fixture.publishCalls(), 1);
    assert.equal(fixture.autonomy.status().lastStatus, status);
    assert.match(fixture.autonomy.status().lastError, /未确认/);
    await fixture.autonomy.stop();
  }
});
