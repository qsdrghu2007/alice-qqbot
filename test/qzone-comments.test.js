import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { QzoneCommentsManager } from "../src/qzone-comments.js";

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), "alice-qzone-comments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function jsonp(payload) {
  return `_preloadCallback(${JSON.stringify(payload)})`;
}

function httpResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

function recordingTimers() {
  const timeouts = new Map();
  const intervals = new Map();
  let id = 0;
  return {
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      id += 1;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(timer) {
      timeouts.delete(timer);
    },
    setInterval(fn, ms) {
      id += 1;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(timer) {
      intervals.delete(timer);
    },
  };
}

async function fixture(
  t,
  {
    overrides = {},
    reply = "[回复] 好呀",
    now,
    state,
    directReplyCode = 0,
    isReady,
    timers,
    onebotCall,
  } = {},
) {
  const root = await temporaryDirectory(t);
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "test-key";
  config.demo = false;
  config.policy.paused = false;
  config.policy.autoActions = true;
  config.qzone.enabled = true;
  config.qzoneComments = {
    ...config.qzoneComments,
    enabled: true,
    dryRun: false,
    onlyFriends: true,
    aiDecide: true,
    delayMinSeconds: 0,
    delayMaxSeconds: 0,
    maxRepliesPerCycle: 3,
    maxRepliesPerHour: 6,
    pollJitterPercent: 0,
    ...overrides,
  };
  const moods = { 123456: [], 333333: [] };
  const requests = [];
  let chatCalls = 0;
  const onebot = {
    async call(action, params) {
      if (typeof onebotCall === "function") {
        const custom = await onebotCall(action, params);
        if (custom !== undefined) return custom;
      }
      if (action === "get_cookies") {
        return { cookies: "uin=o0123456; skey=skey; p_skey=pskey" };
      }
      if (action === "get_friend_list") {
        return [{ user_id: "222" }];
      }
      return null;
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("emotion_cgi_msglist_v6")) {
      const parsed = new URL(target);
      const owner = parsed.searchParams.get("uin");
      return httpResponse(
        jsonp({ code: 0, msglist: moods[owner] ?? [] }),
      );
    }
    if (target.includes("emotion_cgi_re_feeds")) {
      requests.push({ kind: "direct_reply", body: String(options.body ?? "") });
      return httpResponse(
        jsonp({ code: Number(directReplyCode), commentid: "direct-1" }),
      );
    }
    if (target.includes("addcomment_ugc")) {
      requests.push({ kind: "comment", body: String(options.body ?? "") });
      return httpResponse('{"code":0,"commentid":"root-1"}');
    }
    if (target.includes("addreply_ugc")) {
      requests.push({ kind: "reply", body: String(options.body ?? "") });
      return httpResponse('{"code":0,"commentid":"reply-1"}');
    }
    throw new Error(`unexpected QZone request: ${target}`);
  };
  if (state) {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data", "qzone-comments.json"),
      JSON.stringify(state, null, 2),
    );
  }
  const manager = new QzoneCommentsManager({
    root,
    getConfig: () => config,
    onebot,
    fetchImpl,
    ...(typeof now === "function" ? { now } : {}),
    ...(typeof isReady === "function" ? { isReady } : {}),
    ...(timers ? { timers } : {}),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    chat: async () => {
      chatCalls += 1;
      return { content: reply };
    },
  });
  await manager.init();
  return {
    root,
    config,
    manager,
    moods,
    requests,
    chatCalls: () => chatCalls,
    statePath: path.join(root, "data", "qzone-comments.json"),
  };
}

function ownMood(commentlist = []) {
  return {
    tid: "post-1",
    created_time: Math.floor(Date.now() / 1_000),
    content: "今天天气不错",
    commentlist,
  };
}

function ownMoodAt(createdAt, commentlist = []) {
  return {
    tid: "post-1",
    created_time: Math.floor(createdAt / 1_000),
    content: "今天天气不错",
    commentlist,
  };
}

test("start waits for OneBot before the first poll", async (t) => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  let ready = false;
  let cookieCalls = 0;
  const timers = recordingTimers();
  const f = await fixture(t, {
    now: () => nowMs,
    timers,
    isReady: () => ready,
    onebotCall: async (action) => {
      if (action === "get_cookies") cookieCalls += 1;
      return undefined;
    },
  });

  await f.manager.start();
  assert.equal(cookieCalls, 0);
  assert.equal(f.manager.status().lastError, null);
  assert.equal(Date.parse(f.manager.status().nextPollAt) - nowMs, 10_000);
  const retry = [...timers.timeouts.values()][0];
  assert.equal(retry.ms, 10_000);

  const result = await f.manager.pollNow();
  assert.equal(result.ok, true);
  assert.equal(cookieCalls, 1);
  assert.equal(f.manager.status().lastError, null);

  await f.manager.stop();
  assert.equal(timers.timeouts.size, 0);
  assert.equal(timers.intervals.size, 0);
});

test("a retry tick polls normally once OneBot becomes ready", async (t) => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  let ready = false;
  let cookieCalls = 0;
  const timers = recordingTimers();
  const f = await fixture(t, {
    now: () => nowMs,
    timers,
    isReady: () => ready,
    onebotCall: async (action) => {
      if (action === "get_cookies") cookieCalls += 1;
      return undefined;
    },
  });

  await f.manager.start();
  ready = true;
  nowMs += 10_000;
  const result = await f.manager.tick();

  assert.equal(result.ok, true);
  assert.equal(cookieCalls, 1);
  assert.equal(f.manager.status().lastError, null);
  await f.manager.stop();
});

test("transient OneBot failures retry after ten seconds", async (t) => {
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const timers = recordingTimers();
  const f = await fixture(t, {
    now: () => nowMs,
    timers,
    isReady: () => true,
    onebotCall: async (action) => {
      if (action !== "get_cookies") return undefined;
      const error = new Error("OneBot is not connected");
      error.code = "ONEBOT_DISCONNECTED";
      throw error;
    },
  });

  await f.manager.start();
  const result = await f.manager.pollNow();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ONEBOT_DISCONNECTED");
  assert.equal(Date.parse(f.manager.status().nextPollAt) - nowMs, 10_000);
  const retry = [...timers.timeouts.values()][0];
  assert.equal(retry.ms, 10_000);

  await f.manager.stop();
  assert.equal(timers.timeouts.size, 0);
});

test("first own-post poll records a baseline without replying", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [
    ownMood([
      { id: "old-1", uin: "222", name: "好友", content: "历史评论" },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.baseline, true);
  assert.equal(f.requests.length, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.initialized, true);
  assert.equal(state.seenComments["123456_post-1_old-1"].status, "baseline");
});

test("own-post new comment is replied through the nested reply endpoint", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([
      { id: "new-1", uin: "222", name: "好友", content: "真好看" },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].kind, "reply");
  const body = new URLSearchParams(f.requests[0].body);
  assert.equal(body.get("commentId"), "new-1");
  assert.match(body.get("content"), /好呀/);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_new-1"].status, "replied");
  assert.equal(state.stats.replies, 1);
});

test("self, non-friend, blocked, and AI-skipped comments are not sent", async (t) => {
  const f = await fixture(t, {
    overrides: { blockedUsers: ["444"], aiDecide: true },
    reply: "[不回复]",
  });
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([
      { id: "self", uin: "123456", name: "自己", content: "自己评论" },
      { id: "stranger", uin: "999", name: "陌生人", content: "陌生评论" },
      { id: "blocked", uin: "444", name: "黑名单", content: "黑名单评论" },
      { id: "ai-skip", uin: "222", name: "好友", content: "AI 跳过" },
    ]),
  ];

  await f.manager.pollNow();

  assert.equal(f.requests.length, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_self"], undefined);
  assert.equal(state.seenComments["123456_post-1_stranger"].status, "filtered");
  assert.equal(state.seenComments["123456_post-1_blocked"].status, "filtered");
  assert.equal(state.seenComments["123456_post-1_ai-skip"].status, "skipped");
});

test("@ + QZone link comments once and records the external post", async (t) => {
  const f = await fixture(t);
  f.moods["333333"] = [
    {
      tid: "external-1",
      created_time: Math.floor(Date.now() / 1_000),
      content: "好友的说说",
      commentlist: [],
    },
  ];
  const event = {
    channel: "onebot",
    scope: "group",
    userId: "222",
    text: "@Alice 帮我评一下",
  };

  const first = await f.manager.handleMention({
    event,
    links: ["https://user.qzone.qq.com/333333/mood/external-1"],
  });
  const second = await f.manager.handleMention({
    event,
    links: ["https://user.qzone.qq.com/333333/mood/external-1"],
  });

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(f.requests.filter((item) => item.kind === "comment").length, 1);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.externalPosts["333333_external-1"].rootCommentId, "root-1");
  assert.equal(state.externalPosts["333333_external-1"].rootText, "好呀");
  assert.equal(state.stats.externalComments, 1);
});

test("external reply is nested once per new reply id", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["333333"] = [
    {
      tid: "external-1",
      content: "好友的说说",
      commentlist: [],
    },
  ];
  await f.manager.handleMention({
    event: {
      channel: "onebot",
      scope: "private",
      userId: "222",
      text: "评一下",
    },
    links: ["https://user.qzone.qq.com/333333/mood/external-1"],
  });
  f.requests.length = 0;
  f.moods["333333"] = [
    {
      tid: "external-1",
      content: "好友的说说",
      commentlist: [
        { id: "root-1", uin: "123456", name: "Alice", content: "好呀" },
        {
          id: "reply-1",
          uin: "222",
          name: "好友",
          content: "谢谢",
          commentId: "root-1",
        },
      ],
    },
  ];

  await f.manager.pollNow();
  await f.manager.pollNow();

  assert.equal(f.requests.filter((item) => item.kind === "direct_reply").length, 1);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(
    state.seenComments["333333_external-1_root-1_reply-1"].status,
    "replied",
  );
});

test("dry-run detects comments without sending or calling AI", async (t) => {
  const f = await fixture(t, { overrides: { dryRun: true } });
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([{ id: "dry-1", uin: "222", name: "好友", content: "你好" }]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.chatCalls(), 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_dry-1"].status, "dry_run");
});

test("a dry-run external mention can be commented after dry-run is disabled", async (t) => {
  const f = await fixture(t, { overrides: { dryRun: true } });
  f.moods["333333"] = [
    {
      tid: "external-1",
      created_time: Math.floor(Date.now() / 1_000),
      content: "好友的说说",
      commentlist: [],
    },
  ];
  const event = {
    channel: "onebot",
    scope: "group",
    userId: "222",
    text: "@Alice 帮我评一下",
  };
  const link = "https://user.qzone.qq.com/333333/mood/external-1";

  const dry = await f.manager.handleMention({ event, links: [link] });
  assert.equal(dry.reason, "dry_run");
  let state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.externalPosts["333333_external-1"].status, "dry_run");

  f.config.qzoneComments.dryRun = false;
  const sent = await f.manager.handleMention({ event, links: [link] });

  assert.equal(sent.ok, true);
  assert.equal(f.requests.filter((item) => item.kind === "comment").length, 1);
  state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.externalPosts["333333_external-1"].status, "commented");
});

test("local mentions are trusted even when onlyFriends is enabled", async (t) => {
  const f = await fixture(t);
  f.moods["333333"] = [
    {
      tid: "external-1",
      created_time: Math.floor(Date.now() / 1_000),
      content: "好友的说说",
      commentlist: [],
    },
  ];

  const result = await f.manager.handleMention({
    event: {
      channel: "local",
      scope: "private",
      userId: "local-owner",
      text: "帮我评一下",
    },
    links: ["https://user.qzone.qq.com/333333/mood/external-1"],
  });

  assert.equal(result.ok, true);
  assert.equal(f.requests.filter((item) => item.kind === "comment").length, 1);
});

test("demo mode skips QZone polling without reading cookies or calling AI", async (t) => {
  const f = await fixture(t);
  f.config.demo = true;
  f.moods["123456"] = [ownMood()];

  const result = await f.manager.pollNow();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "demo_mode");
  assert.equal(f.requests.length, 0);
  assert.equal(f.chatCalls(), 0);
});

test("zero reply limits allow multiple replies in one cycle", async (t) => {
  const f = await fixture(t, {
    overrides: { maxRepliesPerCycle: 0, maxRepliesPerHour: 0 },
  });
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([
      { id: "new-1", uin: "222", name: "好友", content: "一" },
      { id: "new-2", uin: "222", name: "好友", content: "二" },
      { id: "new-3", uin: "222", name: "好友", content: "三" },
    ]),
  ];

  await f.manager.pollNow();

  assert.equal(f.requests.filter((item) => item.kind === "reply").length, 3);
});

test("zero external tracking hours never expires a tracked post", async (t) => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const f = await fixture(t, {
    now: () => nowMs,
    overrides: { externalTrackHours: 0 },
  });
  await f.manager.pollNow();
  f.moods["333333"] = [
    {
      tid: "external-1",
      created_time: Math.floor(nowMs / 1_000),
      content: "好友的说说",
      commentlist: [],
    },
  ];
  await f.manager.handleMention({
    event: { channel: "onebot", scope: "private", userId: "222", text: "评一下" },
    links: ["https://user.qzone.qq.com/333333/mood/external-1"],
  });
  const before = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(before.externalPosts["333333_external-1"].trackUntil, null);

  nowMs += 100 * 60 * 60 * 1_000;
  f.moods["333333"] = [
    {
      tid: "external-1",
      content: "好友的说说",
      commentlist: [
        { id: "root-1", uin: "123456", name: "Alice", content: "好呀" },
        {
          id: "reply-1",
          uin: "222",
          name: "好友",
          content: "谢谢",
          commentId: "root-1",
        },
      ],
    },
  ];
  f.requests.length = 0;

  await f.manager.pollNow();

  assert.equal(f.requests.filter((item) => item.kind === "direct_reply").length, 1);
});

test("own tracking hours zero includes old posts while a finite window skips them", async (t) => {
  const nowMs = Date.parse("2026-01-10T00:00:00.000Z");
  const oldPostAt = nowMs - 200 * 60 * 60 * 1_000;

  const unlimited = await fixture(t, {
    now: () => nowMs,
    overrides: { ownTrackHours: 0 },
  });
  unlimited.moods["123456"] = [ownMoodAt(oldPostAt)];
  await unlimited.manager.pollNow();
  unlimited.moods["123456"] = [
    ownMoodAt(oldPostAt, [{ id: "new-1", uin: "222", name: "好友", content: "你好" }]),
  ];
  await unlimited.manager.pollNow();
  assert.equal(unlimited.requests.filter((item) => item.kind === "reply").length, 1);

  const limited = await fixture(t, {
    now: () => nowMs,
    overrides: { ownTrackHours: 1 },
  });
  limited.moods["123456"] = [ownMoodAt(oldPostAt)];
  await limited.manager.pollNow();
  limited.moods["123456"] = [
    ownMoodAt(oldPostAt, [{ id: "new-1", uin: "222", name: "好友", content: "你好" }]),
  ];
  await limited.manager.pollNow();

  assert.equal(limited.requests.length, 0);
  const state = JSON.parse(await readFile(limited.statePath, "utf8"));
  assert.equal(
    state.seenComments["123456_post-1_new-1"].status,
    "out_of_window",
  );
});

test("adaptive polling uses active, backoff, and idle intervals", async (t) => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const f = await fixture(t, {
    now: () => nowMs,
    overrides: {
      pollMinutes: 20,
      activePollMinutes: 2,
      activeWindowMinutes: 30,
      pollJitterPercent: 0,
    },
  });
  await f.manager.pollNow();
  await f.manager.noteActivity();

  let status = f.manager.status();
  assert.equal(status.pollMode, "active");
  assert.equal(status.effectivePollMinutes, 2);
  assert.equal(Date.parse(status.nextPollAt), nowMs + 2 * 60_000);

  nowMs += 35 * 60_000;
  await f.manager.pollNow();
  status = f.manager.status();
  assert.equal(status.pollMode, "backoff");
  assert.equal(Date.parse(status.nextPollAt), nowMs + 4 * 60_000);

  nowMs += 65 * 60_000;
  await f.manager.pollNow();
  status = f.manager.status();
  assert.equal(Date.parse(status.nextPollAt), nowMs + 16 * 60_000);

  nowMs += 100 * 60_000;
  await f.manager.pollNow();
  status = f.manager.status();
  assert.equal(status.pollMode, "idle");
  assert.equal(Date.parse(status.nextPollAt), nowMs + 20 * 60_000);
});

test("a newly discovered own post starts the active polling window", async (t) => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const f = await fixture(t, {
    now: () => nowMs,
    overrides: {
      pollMinutes: 20,
      activePollMinutes: 2,
      activeWindowMinutes: 30,
      pollJitterPercent: 0,
    },
  });
  f.moods["123456"] = [];
  await f.manager.pollNow();

  nowMs += 60 * 60_000;
  f.moods["123456"] = [ownMoodAt(nowMs)];
  await f.manager.pollNow();

  const status = f.manager.status();
  assert.equal(status.pollMode, "active");
  assert.equal(status.lastActivityAt, new Date(nowMs).toISOString());
  assert.equal(Date.parse(status.nextPollAt), nowMs + 2 * 60_000);
});

test("QZone comment tid is detected and counted in dry-run", async (t) => {
  const f = await fixture(t, { overrides: { dryRun: true } });
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([
      {
        tid: 101,
        uin: 222,
        name: "好友",
        content: "新评论",
        createTime: Math.floor(Date.now() / 1_000),
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.comments, 1);
  assert.equal(result.newComments, 1);
  assert.equal(result.dryRun, 1);
  assert.equal(result.replied, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_101"].status, "dry_run");
  const status = f.manager.status();
  assert.equal(status.commentsSeen, 1);
  assert.equal(status.dryRunComments, 1);
  assert.equal(status.lastPollResult.comments, 1);
});

test("QZone comment tid can be replied through the nested endpoint", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([
      {
        tid: 301,
        uin: 222,
        name: "好友",
        content: "回复我",
        createTime: Math.floor(Date.now() / 1_000),
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.replied, 1);
  assert.equal(f.requests.length, 1);
  const body = new URLSearchParams(f.requests[0].body);
  assert.equal(body.get("commentId"), "301");
});

test("own-post nested reply under an Alice thread is replied directly", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([{ tid: 11, uin: 222, name: "好友", content: "顶层评论" }]),
  ];
  await f.manager.pollNow();
  f.requests.length = 0;
  f.moods["123456"] = [
    ownMood([
      {
        tid: 11,
        uin: 222,
        name: "好友",
        content: "顶层评论",
        reply_num: 2,
        list_3: [
          {
            tid: 1101,
            uin: "123456",
            name: "Alice",
            content: "Alice 的回复",
            createTime: Math.floor(Date.now() / 1_000),
          },
          {
            tid: 1102,
            uin: "222",
            name: "好友",
            content: "楼中楼回复",
            createTime: Math.floor(Date.now() / 1_000),
          },
        ],
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.replied, 1);
  assert.equal(f.requests.filter((item) => item.kind === "direct_reply").length, 1);
  const body = new URLSearchParams(f.requests[0].body);
  assert.equal(body.get("topicId"), "123456_post-1__1");
  assert.equal(body.get("commentId"), "11");
  assert.equal(body.get("t2_tid"), "1102");
  assert.equal(body.get("t2_uin"), "222");
  assert.equal(body.get("commentUin"), "222");
  assert.match(body.get("content"), /好友/u);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_11_1102"].status, "replied");
  assert.equal(state.seenComments["123456_post-1_1101"], undefined);
});

test("nested direct reply failure does not fall back by default", async (t) => {
  const f = await fixture(t, {
    overrides: { nestedReplyFallback: false },
    directReplyCode: -1,
    state: {
      version: 2,
      initialized: true,
      stats: { polls: 1, commentsSeen: 1, replies: 1, externalComments: 0, failed: 0 },
      ownPosts: {},
      externalPosts: {},
      seenComments: {
        "123456_post-1_11": {
          at: new Date().toISOString(),
          status: "replied",
        },
      },
    },
  });
  f.moods["123456"] = [
    ownMood([
      {
        tid: 11,
        uin: 222,
        name: "好友",
        content: "顶层评论",
        reply_num: 1,
        list_3: [
          {
            tid: 1602,
            uin: "222",
            name: "好友",
            content: "楼中楼",
            createTime: Math.floor(Date.now() / 1_000),
          },
        ],
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.replied, 0);
  assert.equal(f.requests.filter((item) => item.kind === "direct_reply").length, 2);
  assert.equal(f.requests.filter((item) => item.kind === "reply").length, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_11_1602"].status, "unknown");
});

test("nested direct reply failure falls back to the thread when enabled", async (t) => {
  const f = await fixture(t, {
    overrides: { nestedReplyFallback: true },
    directReplyCode: -1,
    state: {
      version: 2,
      initialized: true,
      stats: { polls: 1, commentsSeen: 1, replies: 1, externalComments: 0, failed: 0 },
      ownPosts: {},
      externalPosts: {},
      seenComments: {
        "123456_post-1_11": {
          at: new Date().toISOString(),
          status: "replied",
        },
      },
    },
  });
  f.moods["123456"] = [
    ownMood([
      {
        tid: 11,
        uin: 222,
        name: "好友",
        content: "顶层评论",
        reply_num: 1,
        list_3: [
          {
            tid: 1603,
            uin: "222",
            name: "好友",
            content: "楼中楼",
            createTime: Math.floor(Date.now() / 1_000),
          },
        ],
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.replied, 1);
  assert.equal(f.requests.filter((item) => item.kind === "direct_reply").length, 2);
  const replies = f.requests.filter((item) => item.kind === "reply");
  assert.equal(replies.length, 1);
  assert.equal(new URLSearchParams(replies[0].body).get("commentId"), "11");
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_11_1603"].status, "replied");
});

test("top-level and nested comment ids do not collide", async (t) => {
  const f = await fixture(t, {
    state: {
      version: 2,
      initialized: true,
      stats: { polls: 1, commentsSeen: 2, replies: 1, externalComments: 0, failed: 0 },
      ownPosts: {},
      externalPosts: {},
      seenComments: {
        "123456_post-1_1": {
          at: new Date().toISOString(),
          status: "baseline",
        },
        "123456_post-1_11": {
          at: new Date().toISOString(),
          status: "replied",
        },
      },
    },
  });
  f.moods["123456"] = [
    ownMood([
      { tid: 1, uin: 222, name: "好友", content: "顶层评论 1" },
      {
        tid: 11,
        uin: 222,
        name: "好友",
        content: "顶层评论 11",
        reply_num: 1,
        list_3: [
          {
            tid: 1,
            uin: "222",
            name: "好友",
            content: "楼中楼 tid 也是 1",
            createTime: Math.floor(Date.now() / 1_000),
          },
        ],
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.replied, 1);
  const body = new URLSearchParams(f.requests[0].body);
  assert.equal(body.get("commentId"), "11");
  assert.equal(body.get("t2_tid"), "1");
  assert.equal(body.get("t2_uin"), "222");
  assert.equal(body.get("commentUin"), "222");
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_1"].status, "baseline");
  assert.equal(state.seenComments["123456_post-1_11_1"].status, "replied");
});

test("nested replies outside an Alice thread are not sent", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [
    ownMood([{ tid: 13, uin: 222, name: "好友", content: "别人聊天" }]),
  ];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([
      {
        tid: 13,
        uin: 222,
        name: "好友",
        content: "别人聊天",
        reply_num: 1,
        list_3: [
          {
            tid: 1301,
            uin: "222",
            name: "好友",
            content: "楼中楼",
            createTime: Math.floor(Date.now() / 1_000),
          },
        ],
      },
    ]),
  ];

  await f.manager.pollNow();

  assert.equal(f.requests.filter((item) => item.kind === "direct_reply").length, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_13_1301"].status, "not_for_alice");
});

test("dry-run counts nested replies under an Alice thread", async (t) => {
  const f = await fixture(t, {
    overrides: { dryRun: true },
    state: {
      version: 2,
      initialized: true,
      stats: { polls: 1, commentsSeen: 1, replies: 1, externalComments: 0, failed: 0 },
      ownPosts: {},
      externalPosts: {},
      seenComments: {
        "123456_post-1_11": {
          at: "2026-01-01T00:00:00.000Z",
          status: "replied",
        },
      },
    },
  });
  f.moods["123456"] = [
    ownMood([
      {
        tid: 11,
        uin: 222,
        name: "好友",
        content: "顶层评论",
        reply_num: 1,
        list_3: [
          {
            tid: 1501,
            uin: "222",
            name: "好友",
            content: "新楼中楼",
            createTime: Math.floor(Date.now() / 1_000),
          },
        ],
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.dryRun, 1);
  assert.equal(result.replied, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.seenComments["123456_post-1_11_1501"].status, "dry_run");
});

test("comments without a recognized id are counted and skipped", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  f.moods["123456"] = [
    ownMood([{ uin: 222, name: "好友", content: "没有评论 ID" }]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.comments, 1);
  assert.equal(result.newComments, 0);
  assert.equal(result.missingIds, 1);
  assert.equal(result.replied, 0);
});

test("version 1 state migrates to a fresh baseline without replying", async (t) => {
  const f = await fixture(t, {
    state: {
      version: 1,
      initialized: true,
      stats: { polls: 7, commentsSeen: 3, replies: 2, externalComments: 1, failed: 0 },
      ownPosts: {},
      externalPosts: {},
      seenComments: {
        "old-key": { at: "2026-01-01T00:00:00.000Z", status: "replied" },
      },
    },
  });
  f.moods["123456"] = [
    ownMood([
      {
        tid: 201,
        uin: 222,
        name: "好友",
        content: "历史评论",
        createTime: Math.floor(Date.now() / 1_000),
      },
    ]),
  ];

  const result = await f.manager.pollNow();

  assert.equal(result.baseline, true);
  assert.equal(result.baselineComments >= 1, true);
  assert.equal(f.requests.length, 0);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.version, 2);
  assert.equal(state.seenComments["old-key"], undefined);
  assert.equal(state.seenComments["123456_post-1_201"].status, "baseline");
  assert.equal(state.stats.replies, 2);
});

test("state never contains cookie material", async (t) => {
  const f = await fixture(t);
  f.moods["123456"] = [ownMood()];
  await f.manager.pollNow();
  const raw = await readFile(f.statePath, "utf8");
  assert.doesNotMatch(raw, /p_skey|skey|pskey|cookie/iu);
});
