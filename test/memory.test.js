import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import {
  MEMORY_JUDGE_SYSTEM_PROMPT,
  MemoryManager,
  buildJudgeMessages,
  explicitMemoryDirective,
  extractJson,
  parseMemoryDecision,
} from "../src/memory.js";
import { Store } from "../src/store.js";

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await new Store(root).init() };
}

function configured(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "memory-test-key";
  config.demo = false;
  return {
    ...config,
    ...overrides,
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
    memory: { ...config.memory, ...(overrides.memory ?? {}) },
  };
}

function event(overrides = {}) {
  return {
    id: `memory-${Math.random()}`,
    channel: "onebot",
    userId: "10001",
    scope: "private",
    conversationId: "10001",
    text: "你好",
    timestamp: Date.now(),
    ...overrides,
  };
}

function reply(payload) {
  return {
    content: typeof payload === "string" ? payload : JSON.stringify(payload),
    reasoningContent: "",
    toolCalls: [],
    rawMessage: { role: "assistant", content: "" },
  };
}

const noopLogger = { info() {}, warn() {} };

test("memory JSON extraction and decision parsing tolerate common model formats", () => {
  const payload = {
    should_remember: true,
    memory_type: "preference",
    content: "用户喜欢无糖奶茶",
    importance: 8,
    reason: "稳定偏好",
  };
  assert.deepEqual(extractJson(JSON.stringify(payload)), payload);
  assert.deepEqual(extractJson(`说明\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``), payload);
  assert.deepEqual(extractJson(`前缀 {"a":{"b":1}} 后缀`), { a: { b: 1 } });
  assert.equal(extractJson("不是 JSON"), null);
  assert.equal(parseMemoryDecision("不是 JSON"), null);
  assert.deepEqual(parseMemoryDecision(JSON.stringify(payload)), {
    shouldRemember: true,
    type: "preference",
    content: "用户喜欢无糖奶茶",
    importance: 8,
    reason: "稳定偏好",
  });
  assert.equal(
    parseMemoryDecision(
      JSON.stringify({
        should_remember: true,
        memory_type: "unknown",
        content: "用户怕冷",
        importance: 99,
      }),
    ).importance,
    10,
  );
});

test("explicit memory directives separate remember, forget, and ordinary chat", () => {
  assert.deepEqual(explicitMemoryDirective("帮我记住：我下周三考试"), {
    kind: "remember",
    content: "我下周三考试",
  });
  assert.deepEqual(explicitMemoryDirective("请记一下 我喜欢猫"), {
    kind: "remember",
    content: "我喜欢猫",
  });
  assert.equal(explicitMemoryDirective("别记住这件事").kind, "forget");
  assert.equal(explicitMemoryDirective("我忘记带钥匙了").kind, "forget");
  assert.equal(explicitMemoryDirective("我记得你说过这句话").kind, null);
});

test("memory judge saves important private memories with low-cost AI options", async (t) => {
  const { store } = await setup(t);
  const calls = [];
  const config = configured({ memory: { judgeModel: "memory-model", minImportance: 7 } });
  const manager = new MemoryManager({
    getConfig: async () => config,
    store,
    logger: noopLogger,
    chat: async (request) => {
      calls.push(request);
      return reply({
        should_remember: true,
        memory_type: "preference",
        content: "用户喜欢无糖奶茶",
        importance: 8,
        reason: "稳定偏好",
      });
    },
  });
  const key = JSON.stringify(["private-memory", "onebot", "10001"]);

  await manager.afterTurn({
    event: event({ text: "我平时都喝无糖奶茶" }),
    memoryKey: key,
    history: [{ role: "user", content: "晚上好" }],
    config,
  });

  const memories = await store.memories(key);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].text, "用户喜欢无糖奶茶");
  assert.equal(memories[0].type, "preference");
  assert.equal(memories[0].importance, 8);
  assert.equal(memories[0].source, "auto");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].thinking, "disabled");
  assert.equal(calls[0].maxTokens, 300);
  assert.equal(calls[0].config.temperature, 0.1);
  assert.equal(calls[0].config.model, "memory-model");
});

test("memory prompt covers incidental stable disclosures without changing cache shape", async (t) => {
  const { store } = await setup(t);
  const text = "我住在松涛市，平时骑一辆星环摩托通勤，昨天自己把牌照办好了";
  const judge = buildJudgeMessages({
    text,
    history: [{ role: "user", content: "最近出门方便吗" }],
    scope: "private",
    userId: "10001",
  });

  assert.equal(judge.length, 2);
  assert.equal(judge[0].role, "system");
  assert.equal(judge[0].content, MEMORY_JUDGE_SYSTEM_PROMPT);
  assert.match(judge[0].content, /用户没有要求记忆/u);
  assert.match(judge[0].content, /闲聊里无意透露/u);
  assert.match(judge[0].content, /城市级粗粒度/u);
  assert.match(judge[0].content, /Alice 的猜测或提问/u);
  assert.match(judge[0].content, /区分“目前在 X”和“常住 X”/u);
  assert.match(judge[0].content, /车牌号/u);
  assert.match(judge[0].content, /具体日期、计划、约定、纪念日、考试、出行安排/u);
  assert.match(judge[0].content, /content 必须保留“计划\/待办\/未完成”语义/u);
  assert.match(judge[0].content, /仍然只输出一个 JSON 对象/u);
  assert.match(judge[0].content, /7-8：用户无意披露/u);
  assert.doesNotMatch(judge[0].content, /松涛市|星环摩托/u);
  assert.match(judge[1].content, /当前用户消息：\n我住在松涛市/u);

  const requests = [];
  const config = configured({ memory: { minImportance: 7 } });
  const manager = new MemoryManager({
    getConfig: async () => config,
    store,
    logger: noopLogger,
    chat: async (request) => {
      requests.push(request);
      return reply({
        should_remember: true,
        memory_type: "fact",
        content: "用户居住在松涛市，拥有已上牌的星环摩托并习惯骑它通勤",
        importance: 8,
        reason: "闲聊中稳定且可复用的披露",
      });
    },
  });
  const key = JSON.stringify(["private-memory", "onebot", "10001"]);

  await manager.afterTurn({ event: event({ text }), memoryKey: key, config });

  const memories = await store.memories(key);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.length, 2);
  assert.equal(requests[0].messages[0].content, MEMORY_JUDGE_SYSTEM_PROMPT);
  assert.doesNotMatch(requests[0].messages[0].content, /松涛市|星环摩托/u);
  assert.match(requests[0].messages[1].content, /松涛市/u);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].text, "用户居住在松涛市，拥有已上牌的星环摩托并习惯骑它通勤");
  assert.equal(memories[0].importance, 8);
});

test("explicit remember requests bypass the importance threshold and AI judge", async (t) => {
  const { store } = await setup(t);
  let calls = 0;
  const config = configured({ memory: { minImportance: 10 } });
  const manager = new MemoryManager({
    getConfig: async () => config,
    store,
    logger: noopLogger,
    chat: async () => {
      calls += 1;
      return reply("{}");
    },
  });
  const key = JSON.stringify(["private-memory", "onebot", "10001"]);

  await manager.afterTurn({
    event: event({ text: "帮我记住：我的生日是 5 月 1 日" }),
    memoryKey: key,
    config,
  });

  const memories = await store.memories(key);
  assert.equal(calls, 0);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].text, "我的生日是 5 月 1 日");
  assert.equal(memories[0].importance, 9);
  assert.equal(memories[0].source, "auto");
});

test("forget directives, low importance, invalid JSON, and disabled modes never save", async (t) => {
  const { store } = await setup(t);
  const key = JSON.stringify(["private-memory", "onebot", "10001"]);
  let calls = 0;
  let payload = {
    should_remember: true,
    memory_type: "fact",
    content: "用户明天要考试",
    importance: 5,
  };
  const config = configured();
  const manager = new MemoryManager({
    getConfig: async () => config,
    store,
    logger: noopLogger,
    chat: async () => {
      calls += 1;
      return reply(payload);
    },
  });

  await manager.afterTurn({ event: event({ text: "别记住这件事" }), memoryKey: key, config });
  assert.equal(calls, 0);

  await manager.afterTurn({ event: event({ text: "我明天要考试" }), memoryKey: key, config });
  assert.equal(calls, 1);
  assert.equal((await store.memories(key)).length, 0);

  payload = "不是 JSON";
  await manager.afterTurn({ event: event({ text: "我今天有点累" }), memoryKey: key, config });
  assert.equal(calls, 2);
  assert.equal((await store.memories(key)).length, 0);

  const disabled = configured({ memory: { autoExtract: false } });
  await manager.afterTurn({
    event: event({ text: "我喜欢猫" }),
    memoryKey: key,
    config: disabled,
  });
  assert.equal(calls, 2);
  assert.equal((await store.memories(key)).length, 0);

  const demo = configured({ demo: true });
  await manager.afterTurn({ event: event({ text: "我喜欢猫" }), memoryKey: key, config: demo });
  assert.equal(calls, 2);
});

test("group memory is saved into the shared group scope with group context", async (t) => {
  const { store } = await setup(t);
  let request;
  const config = configured({ memory: { minImportance: 5 } });
  const manager = new MemoryManager({
    getConfig: async () => config,
    store,
    logger: noopLogger,
    chat: async (value) => {
      request = value;
      return reply({
        should_remember: true,
        memory_type: "preference",
        content: "群成员10001喜欢猫咪",
        importance: 7,
      });
    },
  });
  const key = JSON.stringify(["group-memory", "onebot", "group-1"]);

  await manager.afterTurn({
    event: event({
      scope: "group",
      groupId: "group-1",
      conversationId: "group-1",
      text: "我们群里都喜欢猫",
    }),
    memoryKey: key,
    config,
  });

  const memories = await store.memories(key);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].text, "群成员10001喜欢猫咪");
  const prompt = buildJudgeMessages({
    text: "我们群里都喜欢猫",
    scope: "group",
    groupId: "group-1",
    userId: "10001",
  });
  assert.match(prompt[1].content, /当前场景：群聊/);
  assert.match(prompt[1].content, /群号 group-1/);
  assert.match(request.messages[0].content, /群内成员共享/);
  assert.equal((await store.memories(JSON.stringify(["private-memory", "onebot", "10001"]))).length, 0);
});

test("flush waits for queued memory extraction", async (t) => {
  const { store } = await setup(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const config = configured();
  const manager = new MemoryManager({
    getConfig: async () => config,
    store,
    logger: noopLogger,
    chat: async () => {
      await gate;
      return reply({
        should_remember: true,
        memory_type: "fact",
        content: "用户喜欢热茶",
        importance: 8,
      });
    },
  });
  const key = JSON.stringify(["private-memory", "onebot", "10001"]);
  manager.afterTurn({ event: event({ text: "我喜欢热茶" }), memoryKey: key, config });
  assert.equal(manager.pendingCount(), 1);
  setTimeout(release, 10);
  assert.equal(await manager.flush({ timeoutMs: 1000 }), true);
  assert.equal((await store.memories(key)).length, 1);
});
