import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ChatExitManager,
  ChatExitState,
  buildChatExitMessages,
  chatExitKey,
  parseChatExitDecision,
  stickerLooksLikeExit,
} from "../src/chat-exit.js";
import { defaultConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";

const noopLogger = { info() {}, warn() {} };

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-chat-exit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function configured(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "chat-exit-test-key";
  config.demo = false;
  config.policy.allowedUsers = [];
  return {
    ...config,
    ...overrides,
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
    policy: { ...config.policy, ...(overrides.policy ?? {}) },
    chatExit: { ...config.chatExit, ...(overrides.chatExit ?? {}) },
  };
}

function event(overrides = {}) {
  return {
    id: `exit-${Math.random()}`,
    channel: "onebot",
    userId: "10001",
    scope: "private",
    conversationId: "10001",
    text: "好吧",
    timestamp: Date.now(),
    ...overrides,
  };
}

function decision(payload) {
  return {
    content: JSON.stringify(payload),
    reasoningContent: "",
    toolCalls: [],
    rawMessage: { role: "assistant", content: "" },
  };
}

function aiReply(content) {
  return {
    content,
    reasoningContent: "",
    toolCalls: [],
    rawMessage: { role: "assistant", content },
  };
}

test("chat exit state is isolated by private conversation and survives reload", async (t) => {
  const root = await setup(t);
  const state = await new ChatExitState({ root, logger: noopLogger }).init();
  const a = event({ conversationId: "a", userId: "a" });
  const b = event({ conversationId: "b", userId: "b" });
  const group = event({ scope: "group", groupId: "g1", conversationId: "g1" });

  assert.equal(await state.get(a), null);
  assert.equal(chatExitKey(group), null);
  await assert.rejects(state.markTerminated(group), /只能记录私聊/);
  const at = "2026-10-19T14:30:00.000Z";
  const entry = await state.markTerminated(a, at);
  assert.equal(entry.terminatedAt, at);
  assert.equal(entry.followUpStatus, "disabled");
  assert.equal(await state.get(a), at);
  assert.equal(await state.get(b), null);

  const reopened = await new ChatExitState({ root, logger: noopLogger }).init();
  assert.equal(await reopened.get(a), at);
  assert.equal(await reopened.get(b), null);

  assert.equal(await reopened.clear(a), true);
  assert.equal(await reopened.get(a), null);
  assert.equal(await reopened.clear(a), false);

  const saved = JSON.parse(await readFile(path.join(root, "data", "chat-state.json"), "utf8"));
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.conversations, {});
});

test("v1 chat state migrates to v2 without losing termination time", async (t) => {
  const root = await setup(t);
  const file = path.join(root, "data", "chat-state.json");
  await mkdir(path.dirname(file), { recursive: true });
  const key = JSON.stringify(["onebot", "private", "10001"]);
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      terminated: { [key]: { at: "2026-10-19T14:30:00.000Z" } },
    }),
    "utf8",
  );
  const state = await new ChatExitState({ root, logger: noopLogger }).init();
  const target = event();
  assert.equal(await state.get(target), "2026-10-19T14:30:00.000Z");
  const entry = await state.getEntry(target);
  assert.equal(entry.followUpStatus, "disabled");
  assert.equal(entry.followUpAt, null);
  assert.equal(entry.conversationKey, JSON.stringify(["onebot", "private", "10001", "10001"]));
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.version, 2);
  assert.ok(saved.conversations[key]);
  const backups = await readdir(path.join(root, "data", "backups"));
  assert.ok(backups.some((name) => name.startsWith("chat-state-v1-")));
});

test("a corrupt chat state file is quarantined instead of blocking startup", async (t) => {
  const root = await setup(t);
  const file = path.join(root, "data", "chat-state.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{broken", "utf8");
  const state = await new ChatExitState({ root, logger: noopLogger }).init();
  assert.equal(await state.get(event()), null);
  const files = await readdir(path.join(root, "data"));
  assert.ok(files.some((name) => name.startsWith("chat-state.corrupt-")));
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved, { version: 2, conversations: {} });
});

test("chat exit decision parsing and prompt cover closings without false positives", () => {
  assert.deepEqual(parseChatExitDecision('{"end_chat":true,"confidence":0.9}'), {
    endChat: true,
    confidence: 0.9,
    reason: "",
    stickerMood: "",
    shouldFollowUp: null,
    followupReason: "",
    followUpMinutes: null,
  });
  assert.equal(parseChatExitDecision("not json"), null);
  assert.equal(parseChatExitDecision('{"end_chat":true}').confidence, 0);
  assert.equal(parseChatExitDecision('{"end_chat":false,"confidence":0.99}').endChat, false);
  assert.equal(
    parseChatExitDecision(
      '{"end_chat":true,"confidence":0.9,"sticker_mood":"困倦"}',
    ).stickerMood,
    "困倦",
  );
  const declined = parseChatExitDecision(
    '{"end_chat":true,"confidence":0.9,"should_follow_up":false,"followup_reason":"","followup_minutes":null}',
  );
  assert.equal(declined.shouldFollowUp, false);
  assert.equal(declined.followUpMinutes, null);
  assert.equal(
    parseChatExitDecision(
      '{"end_chat":true,"confidence":0.9,"should_follow_up":true,"followup_reason":"等考试结果","followup_minutes":45}',
    ).followupReason,
    "等考试结果",
  );

  const messages = buildChatExitMessages({
    text: "好吧",
    history: [{ role: "assistant", content: "那今天就先这样？" }],
    userId: "10001",
    stickerTags: ["可爱", "困倦", "小情绪"],
  });
  assert.match(messages[0].content, /等下再说/);
  assert.match(messages[0].content, /好累/);
  assert.match(messages[0].content, /不确定/);
  assert.match(messages[0].content, /sticker_mood/);
  assert.match(messages[0].content, /should_follow_up/);
  assert.match(messages[0].content, /followup_reason/);
  assert.match(messages[1].content, /可爱、困倦、小情绪/);
  assert.match(messages[1].content, /最近对话/);
  assert.match(messages[1].content, /当前用户最后一条私聊消息/);
  assert.doesNotMatch(messages[1].content, /10001|说话人 QQ/);

  const manyTags = Array.from({ length: 25 }, (_, index) => `标签${index + 1}`);
  const allTagMessages = buildChatExitMessages({
    text: "晚安",
    userId: "10001",
    stickerTags: manyTags,
  });
  assert.match(allTagMessages[1].content, /标签1、/);
  assert.match(allTagMessages[1].content, /标签25/);

  const longHistory = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `msg-${index}`,
  }));
  const longMessages = buildChatExitMessages({
    text: "晚安",
    history: longHistory,
    userId: "10001",
  });
  assert.match(longMessages[1].content, /msg-24/);
  assert.doesNotMatch(longMessages[1].content, /msg-0/);
});

test("sticker-only goodbye messages terminate without a text judge", async (t) => {
  const root = await setup(t);
  let chatCalls = 0;
  const needsTime = [];
  const manager = await new ChatExitManager({
    root,
    chat: async () => {
      chatCalls += 1;
      return decision({ end_chat: false, confidence: 0 });
    },
    now: () => new Date("2026-10-19T12:00:00.000Z"),
    onNeedsTime: (context) => needsTime.push(context),
    logger: noopLogger,
  }).init();
  const config = configured();
  const target = event({ text: "" });
  const sticker = { summary: "晚安", tags: ["困倦", "可爱"], imageUrl: "" };

  assert.equal(stickerLooksLikeExit(sticker), true);
  assert.equal(stickerLooksLikeExit({ summary: "可爱猫猫", tags: ["可爱"] }), false);

  const messages = buildChatExitMessages({
    text: "",
    userId: "10001",
    sticker,
  });
  assert.match(messages[1].content, /最后一条附带表情包/);
  assert.match(messages[1].content, /摘要：晚安/);
  assert.match(messages[1].content, /困倦/);

  const verdict = await manager.evaluate({
    event: target,
    config,
    sticker,
  });
  assert.equal(verdict.terminate, true);
  assert.equal(verdict.reason, "sticker_goodbye");
  assert.equal(verdict.stickerMood, "困倦");
  assert.equal(verdict.followUpStatus, "needs_time");
  assert.equal(chatCalls, 0);
  assert.equal(needsTime.length, 1);
  assert.equal((await manager.getEntry(target)).followUpStatus, "needs_time");
});

test("chat exit judge records a high-confidence termination", async (t) => {
  const root = await setup(t);
  const calls = [];
  const manager = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async (request) => {
      calls.push(request);
      return decision({
        end_chat: true,
        confidence: 0.92,
        reason: "用户收尾",
        sticker_mood: "小情绪",
      });
    },
  }).init();
  const config = configured({ chatExit: { judgeModel: "judge-model" } });
  const target = event({ text: "先这样吧" });

  const verdict = await manager.evaluate({
    event: target,
    history: [{ role: "assistant", content: "还要继续吗？" }],
    config,
    stickerTags: ["可爱", "小情绪"],
  });
  assert.equal(verdict.terminate, true);
  assert.equal(verdict.confidence, 0.92);
  assert.equal(verdict.stickerMood, "小情绪");
  assert.equal(await manager.getTerminatedAt(target), verdict.terminatedAt);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /可爱、小情绪/);
  assert.equal(calls[0].thinking, "disabled");
  assert.equal(calls[0].maxTokens, 120);
  assert.equal(calls[0].config.temperature, 0);
  assert.equal(calls[0].config.model, "judge-model");
  assert.doesNotMatch(calls[0].messages[1].content, /10001|说话人 QQ/);
});

test("a strict explicit decline cancels follow-up without becoming a time error", async (t) => {
  const root = await setup(t);
  let needsTimeCalls = 0;
  const manager = await new ChatExitManager({
    root,
    logger: noopLogger,
    now: () => new Date("2026-10-19T12:00:00.000Z"),
    onNeedsTime: () => {
      needsTimeCalls += 1;
    },
    chat: async () =>
      decision({
        end_chat: true,
        confidence: 0.95,
        should_follow_up: false,
        followup_reason: "",
        followup_minutes: null,
      }),
  }).init();
  const target = event({ text: "别找我，我想自己待会" });
  const verdict = await manager.evaluate({ event: target, config: configured() });

  assert.equal(verdict.terminate, true);
  assert.equal(verdict.shouldFollowUp, false);
  assert.equal(verdict.followUpStatus, "skipped");
  assert.equal(verdict.needsTime, false);
  assert.equal(needsTimeCalls, 0);
  const entry = await manager.getEntry(target);
  assert.equal(entry.followUpStatus, "skipped");
  assert.equal(entry.followupShouldFollowUp, false);
  assert.equal(entry.lastError, "followup_declined");
});

test("low confidence, false results, failures, groups, and local chats do not terminate", async (t) => {
  const root = await setup(t);
  const calls = [];
  let payload = decision({ end_chat: true, confidence: 0.5, reason: "低置信" });
  const manager = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async () => {
      calls.push(1);
      return payload;
    },
  }).init();
  const config = configured();
  const target = event();

  let verdict = await manager.evaluate({ event: target, config });
  assert.equal(verdict.terminate, false);
  assert.equal(await manager.getTerminatedAt(target), null);

  payload = decision({ end_chat: false, confidence: 1 });
  verdict = await manager.evaluate({ event: target, config });
  assert.equal(verdict.terminate, false);

  payload = "not json";
  verdict = await manager.evaluate({ event: target, config });
  assert.equal(verdict.terminate, false);

  const callsBefore = calls.length;
  verdict = await manager.evaluate({
    event: event({ scope: "group", groupId: "g1", conversationId: "g1" }),
    config,
  });
  assert.equal(verdict.terminate, false);
  assert.equal(calls.length, callsBefore);

  verdict = await manager.evaluate({
    event: event({ channel: "local", conversationId: "local-owner", userId: "local-owner" }),
    config,
  });
  assert.equal(verdict.terminate, false);
  assert.equal(calls.length, callsBefore);

  verdict = await manager.evaluate({
    event: target,
    config: configured({ chatExit: { enabled: false } }),
  });
  assert.equal(verdict.terminate, false);
  assert.equal(calls.length, callsBefore);

  const failing = await new ChatExitManager({
    root: await setup(t),
    logger: noopLogger,
    chat: async () => {
      throw new Error("judge unavailable");
    },
  }).init();
  verdict = await failing.evaluate({ event: target, config });
  assert.equal(verdict.terminate, false);
  assert.equal(await failing.getTerminatedAt(target), null);
});

test("engine suppresses a terminated private reply and resumes on the next message", async (t) => {
  const root = await setup(t);
  const store = await new Store(root).init();
  let exitCalls = 0;
  let mainCalls = 0;
  const config = configured();
  const chatExit = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async () => {
      exitCalls += 1;
      return exitCalls === 1
        ? decision({ end_chat: true, confidence: 0.9, reason: "收尾" })
        : decision({ end_chat: false, confidence: 0.9 });
    },
  }).init();
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chatExit,
      logger: noopLogger,
      chat: async () => {
        mainCalls += 1;
        return aiReply("在。");
      },
    },
  });
  const conversationKey = JSON.stringify(["onebot", "private", "10001", "10001"]);

  const first = await engine.handle(event({ id: "exit-1", text: "好吧" }));
  assert.equal(first.suppressed, true);
  assert.equal(first.text, "");
  assert.equal(mainCalls, 0);
  assert.equal(exitCalls, 1);
  assert.equal((await store.history(conversationKey)).length, 1);
  assert.equal((await store.history(conversationKey))[0].role, "user");
  assert.notEqual(await chatExit.getTerminatedAt(event()), null);

  const second = await engine.handle(event({ id: "exit-2", text: "在吗" }));
  assert.equal(second.text, "在。");
  assert.equal(mainCalls, 1);
  assert.equal(exitCalls, 2);
  assert.equal((await store.history(conversationKey)).length, 3);
  assert.equal(await chatExit.getTerminatedAt(event()), null);
});

test("engine treats a sticker-only goodbye as termination and stores readable history", async (t) => {
  const root = await setup(t);
  const store = await new Store(root).init();
  let judgeCalls = 0;
  let mainCalls = 0;
  const config = configured();
  const chatExit = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async () => {
      judgeCalls += 1;
      return decision({ end_chat: false, confidence: 0 });
    },
  }).init();
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chatExit,
      logger: noopLogger,
      chat: async () => {
        mainCalls += 1;
        return aiReply("晚安。");
      },
    },
  });
  const target = event({
    id: "sticker-goodbye",
    text: "",
    attachments: [
      {
        type: "image",
        summary: "晚安",
        subType: 1,
        url: "https://example.com/goodnight.png",
      },
    ],
  });
  const result = await engine.handle(target);
  assert.equal(result.suppressed, true);
  assert.equal(result.text, "");
  assert.equal(mainCalls, 0);
  assert.equal(judgeCalls, 0);
  assert.notEqual(await chatExit.getTerminatedAt(target), null);
  const history = await store.history(
    JSON.stringify(["onebot", "private", "10001", "10001"]),
  );
  assert.equal(history.at(-1).role, "user");
  assert.equal(history.at(-1).content, "[表情包] 晚安");
});

test("engine sends only a fitting sticker after OneBot termination", async (t) => {
  const root = await setup(t);
  const store = await new Store(root).init();
  let exitCalls = 0;
  let mainCalls = 0;
  let claimed = null;
  const config = configured();
  const chatExit = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async () => {
      exitCalls += 1;
      return decision({
        end_chat: true,
        confidence: 0.95,
        reason: "晚安",
        sticker_mood: "困倦",
      });
    },
  }).init();
  const stickers = {
    catalog: async () => ({ count: 2, tags: ["可爱", "困倦"] }),
    claim: async (args) => {
      claimed = args;
      return {
        ok: true,
        entry: { id: "st_1", summary: "困倦猫猫", tags: ["困倦"] },
        dataUrl: "data:image/png;base64,AAAA",
      };
    },
  };
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chatExit,
      stickers,
      logger: noopLogger,
      chat: async () => {
        mainCalls += 1;
        return aiReply("不应该出现");
      },
    },
  });
  const target = event({ id: "sticker-exit", text: "晚安" });
  const result = await engine.handle(target);

  assert.equal(result.text, "");
  assert.equal(result.suppressed ?? false, false);
  assert.equal(result.stickerOnly, true);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0], "data:image/png;base64,AAAA");
  assert.equal(mainCalls, 0);
  assert.equal(exitCalls, 1);
  assert.equal(claimed.force, true);
  assert.equal(claimed.mood, "困倦");
  assert.equal(claimed.conversationKey, JSON.stringify(["onebot", "private", "10001", "10001"]));
  assert.notEqual(await chatExit.getTerminatedAt(target), null);
  assert.equal((await store.history(JSON.stringify(["onebot", "private", "10001", "10001"]))).length, 1);
});

test("engine keeps official QQ termination silent", async (t) => {
  const root = await setup(t);
  const store = await new Store(root).init();
  let claimCalls = 0;
  let mainCalls = 0;
  const config = configured();
  const chatExit = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async () => decision({ end_chat: true, confidence: 0.95 }),
  }).init();
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chatExit,
      stickers: {
        catalog: async () => ({ count: 1, tags: ["可爱"] }),
        claim: async () => {
          claimCalls += 1;
          return { ok: true, dataUrl: "data:image/png;base64,AAAA" };
        },
      },
      logger: noopLogger,
      chat: async () => {
        mainCalls += 1;
        return aiReply("不应该出现");
      },
    },
  });
  const target = event({ id: "qq-exit", channel: "qq", text: "晚安" });
  const result = await engine.handle(target);
  assert.equal(result.suppressed, true);
  assert.equal(result.text, "");
  assert.equal(result.images.length, 0);
  assert.equal(claimCalls, 0);
  assert.equal(mainCalls, 0);
  assert.notEqual(await chatExit.getTerminatedAt(target), null);
});

test("engine does not judge groups or local chats and clears state on next private message", async (t) => {
  const root = await setup(t);
  const store = await new Store(root).init();
  let exitCalls = 0;
  let mainCalls = 0;
  let terminate = true;
  const config = configured();
  const chatExit = await new ChatExitManager({
    root,
    logger: noopLogger,
    chat: async () => {
      exitCalls += 1;
      return terminate
        ? decision({ end_chat: true, confidence: 0.9 })
        : decision({ end_chat: false, confidence: 0.9 });
    },
  }).init();
  const engine = new Engine({
    getConfig: async () => config,
    store,
    services: {
      chatExit,
      logger: noopLogger,
      chat: async () => {
        mainCalls += 1;
        return aiReply("好");
      },
    },
  });

  await engine.handle(event({ id: "private-exit", text: "晚安" }));
  assert.equal(exitCalls, 1);
  assert.equal(mainCalls, 0);

  const group = event({
    id: "group-exit",
    scope: "group",
    groupId: "g1",
    conversationId: "g1",
    text: "好吧",
  });
  await engine.handle(group);
  assert.equal(exitCalls, 1);
  assert.equal(mainCalls, 1);
  assert.equal(await chatExit.getTerminatedAt(group), null);

  const local = event({
    id: "local-exit",
    channel: "local",
    userId: "local-owner",
    conversationId: "local-owner",
    text: "好吧",
  });
  await engine.handle(local);
  assert.equal(exitCalls, 1);
  assert.equal(mainCalls, 2);

  terminate = false;
  const resumed = await engine.handle(event({ id: "resume", text: "在吗" }));
  assert.equal(resumed.text, "好");
  assert.equal(exitCalls, 2);
  assert.equal(mainCalls, 3);
  assert.equal(await chatExit.getTerminatedAt(event()), null);
});
