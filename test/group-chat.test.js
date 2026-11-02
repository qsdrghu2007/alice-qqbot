// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import {
  GroupChatManager,
  groupStateKey,
  proactiveWaitMs,
} from "../src/group-chat.js";

const tick = async (rounds = 20) => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    if (index % 5 === 4) await new Promise((resolve) => setImmediate(resolve));
  }
};

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".group-chat-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

class MemoryStore {
  constructor() {
    this.root = process.cwd();
    this.histories = new Map();
    this.memoryLists = new Map();
  }

  async history(key) {
    return [...(this.histories.get(key) ?? [])];
  }

  async append(key, messages) {
    this.histories.set(key, [...(this.histories.get(key) ?? []), ...messages]);
  }

  async memories(key) {
    return [...(this.memoryLists.get(key) ?? [])];
  }
}

function groupConfig(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.demo = false;
  config.ai.apiKey = "test-key";
  config.groupChat = {
    ...config.groupChat,
    quietHours: { start: 10, end: 10 },
    ...(overrides.groupChat ?? {}),
  };
  return {
    ...config,
    ...overrides,
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
    policy: { ...config.policy, paused: false, ...(overrides.policy ?? {}) },
    persona: { ...config.persona, ...(overrides.persona ?? {}) },
    groupChat: config.groupChat,
  };
}

function groupEvent(overrides = {}) {
  return {
    id: `g-${Math.random()}`,
    channel: "onebot",
    scope: "group",
    userId: "10001",
    groupId: "20002",
    conversationId: "20002",
    text: "这个游戏在 Switch 上怎样联机？",
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function fakeTimers() {
  let nextId = 0;
  const values = new Map();
  return {
    setTimeout(callback, ms) {
      nextId += 1;
      values.set(nextId, { callback, ms });
      return nextId;
    },
    clearTimeout(id) {
      values.delete(id);
    },
    runNext() {
      const entry = values.entries().next();
      if (entry.done) return false;
      values.delete(entry.value[0]);
      entry.value[1].callback();
      return true;
    },
    values() {
      return [...values.values()];
    },
  };
}

async function managerFixture(t, {
  config = groupConfig(),
  memberCount = 4,
  relationshipLevel = 0.5,
  deliver = async () => ({ status: "sent", sentSegments: [{ text: "嗯" }] }),
} = {}) {
  const root = await temporaryDirectory(t);
  const store = new MemoryStore();
  const timers = fakeTimers();
  let groupInfoCalls = 0;
  const adapter = {
    async send() {},
    async getGroupInfo() {
      groupInfoCalls += 1;
      if (memberCount instanceof Error) throw memberCount;
      return memberCount;
    },
  };
  const manager = new GroupChatManager({
    root,
    getConfig: () => config,
    adapter,
    store,
    conversationState: {
      async visibleContext() {
        return {
          profile: { relationship: { level: relationshipLevel, label: "有一定熟悉感" } },
          contexts: [],
        };
      },
    },
    deliver,
    timerApi: timers,
    logger: { warn() {}, info() {} },
  });
  await manager.init();
  t.after(() => manager.stop());
  return {
    manager,
    store,
    timers,
    config,
    memberCount,
    getGroupInfoCalls: () => groupInfoCalls,
  };
}

test("proactive wait uses total group members and never substitutes zero", () => {
  assert.equal(proactiveWaitMs(groupConfig(), 1), 31200);
  assert.equal(proactiveWaitMs(groupConfig(), 10), 42000);
  assert.equal(proactiveWaitMs(groupConfig(), 0), null);
  assert.equal(proactiveWaitMs(groupConfig(), undefined), null);
});

test("natural group candidate waits by member count then makes one structured decision", async (t) => {
  const delivered = [];
  const fixture = await managerFixture(t, {
    memberCount: 7,
    deliver: async (event) => {
      delivered.push(event);
      return { status: "sent", sentSegments: [{ text: "这个我知道一点。" }] };
    },
  });
  fixture.config.groupChat.defaultMode = "active";
  const result = await fixture.manager.route(groupEvent());
  assert.equal(result.explicit, false);
  await tick();
  assert.equal(fixture.timers.values()[0].ms, 30000 + 7 * 1200);
  fixture.timers.runNext();
  await fixture.manager.waitForIdle();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].groupDecision.kind, "proactive");
  assert.equal(delivered[0].groupDecision.scene.at(-1).text, "这个游戏在 Switch 上怎样联机?");
  assert.equal(
    fixture.manager.data.groups[groupStateKey("20002")].modelCalls.length,
    1,
  );
});

test("missing member count skips only proactive work and explicit bot-name summons still work", async (t) => {
  const delivered = [];
  const config = groupConfig({ persona: { name: "小夏" } });
  const fixture = await managerFixture(t, {
    config,
    memberCount: new Error("count unavailable"),
    deliver: async (event) => {
      delivered.push(event);
      return { status: "sent", sentSegments: [{ text: "在。" }] };
    },
  });

  const explicit = await fixture.manager.route(
    groupEvent({ id: "summon", text: "小夏，这个在吗？" }),
  );
  assert.equal(explicit.explicit, true);
  assert.equal(explicit.reason, "name");
  assert.equal(fixture.getGroupInfoCalls(), 0);

  await fixture.manager.route(groupEvent({ id: "ambient", userId: "10002" }));
  await tick();
  await fixture.manager.waitForIdle();
  assert.deepEqual(delivered, []);
  assert.equal(
    fixture.manager.data.groups[groupStateKey("20002")]?.modelCalls.length ?? 0,
    0,
  );
});

test("a sent explicit reply arms a no-wait continuation for the addressed user", async (t) => {
  const delivered = [];
  const fixture = await managerFixture(t, {
    deliver: async (event) => {
      delivered.push(event);
      return { status: "suppressed" };
    },
  });
  const explicit = await fixture.manager.route(
    groupEvent({ id: "call", userId: "10001", text: "Alice 你觉得呢" }),
  );
  assert.equal(explicit.explicit, true);

  await fixture.manager.recordDelivery(
    groupEvent({ id: "call", userId: "10001", text: "Alice 你觉得呢" }),
    { status: "sent", sentSegments: [{ text: "我觉得第二个。" }] },
  );
  await fixture.manager.route(
    groupEvent({ id: "same", userId: "10001", text: "那你说详细点" }),
  );
  await fixture.manager.waitForIdle();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].groupDecision.kind, "continuation");
  assert.equal(fixture.getGroupInfoCalls(), 0);
});

test("another member joining after a sent reply diverts the addressed-user continuation", async (t) => {
  const delivered = [];
  const fixture = await managerFixture(t, {
    deliver: async (event) => {
      delivered.push(event);
      return { status: "suppressed" };
    },
  });
  await fixture.manager.route(
    groupEvent({ id: "call", userId: "10001", text: "Alice 你觉得呢" }),
  );
  await fixture.manager.recordDelivery(
    groupEvent({ id: "call", userId: "10001", text: "Alice 你觉得呢" }),
    { status: "sent", sentSegments: [{ text: "我觉得第二个。" }] },
  );
  await fixture.manager.route(
    groupEvent({ id: "other", userId: "10002", text: "我先说，还是选第二个" }),
  );
  await fixture.manager.route(
    groupEvent({ id: "same", userId: "10001", text: "那你说详细点" }),
  );
  await fixture.manager.waitForIdle();
  assert.equal(delivered.length, 0);
});

test("a public group memory can create a candidate without relying on keyword stop lists", async (t) => {
  const fixture = await managerFixture(t, {
    config: groupConfig({ groupChat: { defaultMode: "active" } }),
    memberCount: 5,
  });
  fixture.store.memoryLists.set(
    JSON.stringify(["group-memory", "onebot", "20002"]),
    [
      {
        id: "m1",
        type: "fact",
        importance: 8,
        text: "本群约定周末一起玩深海探险",
      },
    ],
  );
  await fixture.manager.route(
    groupEvent({ id: "memory-anchor", text: "昨天那个深海探险" }),
  );
  await tick();
  assert.equal(fixture.timers.values()[0].ms, 30000 + 5 * 1200);
});

test("generic and human-directed questions do not create proactive candidates", async (t) => {
  const fixture = await managerFixture(t);
  await fixture.manager.route(
    groupEvent({ id: "generic", text: "有人玩过这个吗？" }),
  );
  await fixture.manager.route(
    groupEvent({
      id: "directed",
      userId: "10002",
      text: "这个游戏怎样联机？",
      mentionIds: ["10003"],
    }),
  );
  await fixture.manager.waitForIdle();
  assert.equal(fixture.timers.values().length, 0);
  assert.equal(fixture.getGroupInfoCalls(), 0);
});

test("a standalone substantive question needs topic, memory, interest, or relationship evidence", async (t) => {
  const fixture = await managerFixture(t, {
    config: groupConfig({ groupChat: { defaultMode: "active" } }),
    relationshipLevel: 0,
  });
  await fixture.manager.route(groupEvent({ id: "unsupported-question" }));
  await fixture.manager.waitForIdle();
  assert.equal(fixture.timers.values().length, 0);
  assert.equal(fixture.getGroupInfoCalls(), 0);
});

test("a safe private preference category can support a relevant group question", async (t) => {
  const fixture = await managerFixture(t, {
    config: groupConfig({ groupChat: { defaultMode: "active" } }),
    relationshipLevel: 0,
    memberCount: 5,
  });
  fixture.store.memoryLists.set(
    JSON.stringify(["private-memory", "onebot", "10001"]),
    [
      {
        id: "private-game",
        type: "preference",
        importance: 8,
        text: "喜欢的游戏是赛博朋克2077",
      },
    ],
  );
  await fixture.manager.route(groupEvent({ id: "private-interest" }));
  await tick();
  assert.equal(fixture.timers.values()[0].ms, 30000 + 5 * 1200);
});

test("another member's unrelated messages do not reset Alice's no-response exit timer", async (t) => {
  const fixture = await managerFixture(t, {
    config: groupConfig({
      groupChat: {
        defaultMode: "mention",
        noResponseMinutes: 2,
        cooldownMinutes: 4,
      },
    }),
  });
  await fixture.manager.recordDelivery(
    groupEvent({ id: "alice-reply", userId: "10001" }),
    { status: "sent", sentSegments: [{ text: "嗯" }] },
  );
  assert.equal(fixture.timers.values().length, 1);
  await fixture.manager.route(
    groupEvent({ id: "other-1", userId: "10002", text: "今天食堂人好多" }),
  );
  await fixture.manager.route(
    groupEvent({ id: "other-2", userId: "10003", text: "晚上再看看吧" }),
  );
  assert.equal(fixture.timers.values().length, 1);
  fixture.timers.runNext();
  await tick();
  assert.ok(
    fixture.manager.data.groups[groupStateKey("20002")].cooldownUntil >
      Date.now(),
  );
});

test("same-user continuation before an explicit reply is sent joins the explicit path", async (t) => {
  const delivered = [];
  const fixture = await managerFixture(t, {
    deliver: async (event) => {
      delivered.push(event);
      return { status: "suppressed" };
    },
  });
  const first = await fixture.manager.route(
    groupEvent({ id: "explicit-first", text: "Alice 你怎么看" }),
  );
  const second = await fixture.manager.route(
    groupEvent({ id: "explicit-followup", text: "我想听具体一点" }),
  );
  assert.equal(first.explicit, true);
  assert.equal(second.explicit, true);
  assert.equal(second.reason, "pending_continuation");
  await tick();
  await fixture.manager.waitForIdle();
  assert.equal(delivered.length, 0);
  assert.equal(fixture.timers.values().length, 0);
  assert.equal(fixture.manager._threads.get("20002").explicitPending, true);
});

test("busy group suppresses proactive participation while related replies cancel a stale candidate", async (t) => {
  const busy = await managerFixture(t, {
    config: groupConfig({ groupChat: { defaultMode: "natural" } }),
  });
  for (let index = 0; index < 7; index += 1) {
    await busy.manager.route(
      groupEvent({
        id: `busy-${index}`,
        userId: index % 2 ? "10002" : "10003",
        text: `联机语音频道今天又讨论到第${index + 1}件事`,
      }),
    );
    await tick();
    await busy.manager.waitForIdle();
  }
  await busy.manager.route(
    groupEvent({ id: "busy-question", userId: "10004", text: "这个游戏怎样联机？" }),
  );
  await tick();
  await busy.manager.waitForIdle();
  assert.equal(busy.timers.values().length, 0);

  const cancellation = await managerFixture(t, {
    config: groupConfig({ groupChat: { defaultMode: "active" } }),
  });
  await cancellation.manager.route(groupEvent({ id: "anchor" }));
  await tick();
  assert.ok(cancellation.manager._candidates.has("20002"));
  await cancellation.manager.route(
    groupEvent({ id: "unrelated", userId: "10002", text: "食堂今天换了椅子" }),
  );
  assert.ok(cancellation.manager._candidates.has("20002"));
  await cancellation.manager.route(
    groupEvent({ id: "answered", userId: "10003", text: "联机要先加好友" }),
  );
  assert.equal(cancellation.manager._candidates.has("20002"), false);
});

test("cooldown survives explicit summons and model budget records silent outcomes", async (t) => {
  let modelDeliveries = 0;
  const config = groupConfig({
    groupChat: {
      defaultMode: "active",
      budgetPerHour: 1,
      maxConsecutiveMessages: 3,
      cooldownMinutes: 4,
      noResponseMinutes: 2,
    },
  });
  const fixture = await managerFixture(t, {
    config,
    memberCount: 3,
    deliver: async () => {
      modelDeliveries += 1;
      return { status: "suppressed" };
    },
  });

  await fixture.manager.route(groupEvent({ id: "first" }));
  await tick();
  fixture.timers.runNext();
  await fixture.manager.waitForIdle();
  const state = fixture.manager.data.groups[groupStateKey("20002")];
  assert.equal(modelDeliveries, 1);
  assert.equal(state.modelCalls.length, 1);

  await fixture.manager.route(groupEvent({ id: "second", userId: "10002" }));
  await tick();
  await fixture.manager.waitForIdle();
  assert.equal(modelDeliveries, 1);

  const base = Date.now();
  for (let index = 0; index < 3; index += 1) {
    await fixture.manager.recordDelivery(
      groupEvent({ id: `sent-${index}`, userId: `10${index}` }),
      { status: "sent", sentSegments: [{ text: "嗯" }] },
    );
  }
  const cooldown = state.cooldownUntil;
  assert.ok(cooldown > base);
  await fixture.manager.route(groupEvent({ id: "explicit", text: "Alice 在吗" }));
  assert.equal(state.cooldownUntil, cooldown);
});

test("group decision engine uses one model call and skips review, tools, memory extraction, and history", async (t) => {
  const root = await temporaryDirectory(t);
  const store = new MemoryStore();
  store.memoryLists.set(JSON.stringify(["group-memory", "onebot", "20002"]), [
    {
      id: "public-group-memory",
      type: "fact",
      importance: 8,
      text: "本群公开约定周末一起玩深海探险",
    },
  ]);
  store.memoryLists.set(JSON.stringify(["private-memory", "onebot", "10001"]), [
    {
      id: "private-memory",
      type: "preference",
      importance: 10,
      text: "喜欢的游戏是赛博朋克2077，绝不应进入群的私聊原文",
    },
  ]);
  const config = groupConfig();
  const chatCalls = [];
  let reviewCalls = 0;
  let memoryCalls = 0;
  const engine = new Engine({
    getConfig: () => config,
    store,
    services: {
      async chat(options) {
        chatCalls.push({ ...options, messages: structuredClone(options.messages) });
        return {
          content: JSON.stringify({
            action: "text",
            reply: "这个联机方式挺省事的。",
          }),
          reasoningContent: "",
          toolCalls: [],
          rawMessage: { role: "assistant", content: "{}" },
        };
      },
      async reviewChat() {
        reviewCalls += 1;
        return { content: "{}", toolCalls: [], rawMessage: {} };
      },
      memory: {
        async afterTurn() {
          memoryCalls += 1;
        },
      },
      conversationState: {
        async visibleContext() {
          return { profile: null, contexts: [], currentConversationKey: "x" };
        },
        async context() {
          return { conversation: null, global: null };
        },
        async updateTurn() {},
      },
      stickers: {
        async catalog() {
          return { count: 0, tags: [] };
        },
        async lastStickerAt() {
          return null;
        },
      },
    },
  });

  const event = groupEvent({
    id: "engine-single",
    groupDecision: {
      kind: "proactive",
      score: 0.6,
      familiarity: 0.3,
      mode: "natural",
      scene: [
        { speaker: "成员1", text: "Switch 上的联机怎么设置？", quoteSpeaker: "" },
      ],
      anchorId: "anchor",
    },
  });
  const result = await engine.handle(event);

  assert.equal(result.text, "这个联机方式挺省事的。");
  assert.equal(result.transient, true);
  assert.equal(chatCalls.length, 1);
  assert.equal(reviewCalls, 0);
  assert.equal(memoryCalls, 0);
  assert.deepEqual(chatCalls[0].tools, []);
  assert.equal(chatCalls[0].responseFormat.type, "json_object");
  assert.equal(chatCalls[0].thinking, "disabled");
  assert.match(chatCalls[0].messages.at(-1).content, /本群短期现场/u);
  assert.match(chatCalls[0].messages.at(-1).content, /本群公开约定周末一起玩深海探险/u);
  assert.match(chatCalls[0].messages.at(-1).content, /非敏感兴趣类别.*游戏/u);
  assert.doesNotMatch(chatCalls[0].messages.at(-1).content, /赛博朋克2077/u);
  assert.doesNotMatch(chatCalls[0].messages.at(-1).content, /绝不应进入群的私聊原文/u);
  assert.doesNotMatch(chatCalls[0].messages.at(-1).content, /私聊原文|绝不应进入群/u);
  assert.equal(
    (
      await store.history(
        JSON.stringify(["onebot", "group", "20002", "20002"]),
      )
    ).length,
    0,
  );
});
