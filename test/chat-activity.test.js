import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ChatActivityTracker, IdleExitScheduler } from "../src/chat-activity.js";
import { ChatExitManager } from "../src/chat-exit.js";
import { defaultConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const logger = { info() {}, warn() {}, debug() {}, error() {} };

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-chat-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function event(overrides = {}) {
  return {
    id: `activity-${Math.random()}`,
    channel: "onebot",
    userId: "10001",
    scope: "private",
    conversationId: "10001",
    text: "在吗",
    timestamp: "2026-10-19T12:00:00.000Z",
    ...overrides,
  };
}

function configured(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "activity-test-key";
  config.demo = false;
  config.policy.paused = false;
  config.policy.allowedUsers = [];
  return {
    ...config,
    ...overrides,
    chatExit: { ...config.chatExit, ...(overrides.chatExit ?? {}) },
    followUp: { ...config.followUp, ...(overrides.followUp ?? {}) },
  };
}

test("tracks user and bot activity, idle deadlines, and repeated idle counts", async (t) => {
  const root = await setup(t);
  const tracker = await new ChatActivityTracker({ root, logger }).init();
  const target = event();

  await tracker.noteBot(target, {
    at: "2026-10-19T12:00:00.000Z",
    idleMinutes: 10,
  });
  assert.equal((await tracker.due("2026-10-19T12:09:59.000Z")).length, 0);
  assert.equal((await tracker.due("2026-10-19T12:10:00.000Z")).length, 1);

  await tracker.noteUser(target, "2026-10-19T12:05:00.000Z");
  assert.equal((await tracker.due("2026-10-19T12:20:00.000Z")).length, 0);
  assert.equal((await tracker.snapshot()).conversations[Object.keys((await tracker.snapshot()).conversations)[0]].idleCount, 0);

  await tracker.noteBot(target, {
    at: "2026-10-19T12:06:00.000Z",
    idleMinutes: 10,
  });
  const completed = await tracker.completeIdle(
    Object.keys((await tracker.snapshot()).conversations)[0],
    "2026-10-19T12:16:00.000Z",
  );
  assert.equal(completed.idleCount, 1);
  assert.equal(completed.idleDeadline, null);
  assert.equal(completed.lastIdleTerminatedAt, "2026-10-19T12:16:00.000Z");

  const reloaded = await new ChatActivityTracker({ root, logger }).init();
  assert.equal((await reloaded.snapshot()).conversations[completed.key].idleCount, 1);

  await reloaded.clear(target);
  assert.deepEqual((await reloaded.snapshot()).conversations, {});
});

test("idle termination marks chat state and asks AI for a follow-up time", async (t) => {
  const root = await setup(t);
  const store = await new Store(root).init();
  const chatExit = await new ChatExitManager({ root, logger }).init();
  const activity = await new ChatActivityTracker({ root, logger }).init();
  const target = event();
  const config = configured();
  const needsTime = [];
  const scheduler = new IdleExitScheduler({
    getConfig: async () => config,
    store,
    chatExit,
    activity,
    onNeedsTime: async (context) => needsTime.push(context),
    logger,
    now: () => new Date("2026-10-19T12:10:30.000Z"),
  });

  await activity.noteBot(target, {
    at: "2026-10-19T12:00:00.000Z",
    idleMinutes: 10,
  });
  const first = await scheduler.tick();
  assert.equal(first.processed, 1);
  assert.equal(needsTime.length, 1);
  assert.equal(needsTime[0].idleCount, 1);
  assert.equal(needsTime[0].key, JSON.stringify(["onebot", "private", "10001"]));
  let entry = await chatExit.getEntry(target);
  assert.equal(entry.followUpStatus, "needs_time");
  assert.equal(entry.lastError, "idle_timeout");
  assert.equal(entry.terminatedAt, "2026-10-19T12:10:30.000Z");

  await chatExit.state.markFollowUpSent(
    needsTime[0].key,
    "2026-10-19T12:15:00.000Z",
  );
  await activity.noteBot(target, {
    at: "2026-10-19T12:15:00.000Z",
    idleMinutes: 10,
  });
  const secondScheduler = new IdleExitScheduler({
    getConfig: async () => config,
    store,
    chatExit,
    activity,
    onNeedsTime: async (context) => needsTime.push(context),
    logger,
    now: () => new Date("2026-10-19T12:25:31.000Z"),
  });
  const second = await secondScheduler.tick();
  assert.equal(second.processed, 1);
  assert.equal(needsTime.length, 2);
  assert.equal(needsTime[1].idleCount, 2);
  entry = await chatExit.getEntry(target);
  assert.equal(entry.followUpStatus, "needs_time");

  await activity.noteUser(target, "2026-10-19T12:21:00.000Z");
  const snapshot = await activity.snapshot();
  assert.equal(snapshot.conversations[needsTime[0].key].idleCount, 0);
});
