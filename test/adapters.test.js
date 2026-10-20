import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OneBotAdapter } from "../src/adapters/onebot.js";
import { QQAdapter } from "../src/adapters/qq.js";
import { AdapterError, parseOneBotMessage } from "../src/adapters/shared.js";

class FakeSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
  }

  send(data) {
    this.sent.push(JSON.parse(String(data)));
  }

  close() {
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  receive(value) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

function response(status, body = {}, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    _bodyText: text,
    _json: typeof body === "string" ? undefined : body,
    text: async () => text,
    headers: { get: (key) => headers[key] ?? null },
  };
}

function qqConfig(overrides = {}) {
  return {
    qq: {
      enabled: true,
      appId: "102030",
      secret: "super-secret",
      sandbox: false,
      maxReconnectAttempts: 3,
      ...overrides.qq,
    },
    onebot: { enabled: false },
    policy: {
      paused: false,
      allowedUsers: [],
      allowedGroups: [],
      cooldownMs: 0,
      ...overrides.policy,
    },
  };
}

function oneBotConfig(overrides = {}) {
  return {
    qq: { enabled: false },
    onebot: {
      enabled: true,
      url: "ws://127.0.0.1:6700/",
      token: "bot-token",
      timeoutMs: 200,
      maxReconnectAttempts: 3,
      ...overrides.onebot,
    },
    policy: {
      paused: false,
      allowedUsers: [],
      allowedGroups: [],
      cooldownMs: 0,
      ...overrides.policy,
    },
  };
}

function fakeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    runNextTimeout() {
      const entry = timeouts.entries().next();
      if (entry.done) return false;
      const [id, timer] = entry.value;
      timeouts.delete(id);
      timer.fn();
      return true;
    },
  };
}

test("OneBot message parsing collects plain and card QZone links", () => {
  const plain = parseOneBotMessage(
    "看看这个 https://user.qzone.qq.com/123456/mood/abc123 好吗",
  );
  assert.deepEqual(plain.links, [
    "https://user.qzone.qq.com/123456/mood/abc123",
  ]);

  const card = parseOneBotMessage([
    {
      type: "json",
      data: {
        app: "com.tencent.qzone",
        uin: "333333",
        tid: "card-tid",
      },
    },
  ]);
  assert.deepEqual(card.links, [
    "https://user.qzone.qq.com/333333/mood/card-tid",
  ]);
});

test("QQ negotiates gateway, identifies, parses C2C, and sends a passive text reply", async () => {
  const sockets = [];
  const requests = [];
  const timers = fakeTimers();
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes("/app/getAppAccessToken")) {
      return response(200, { access_token: "access-token", expires_in: 7200 });
    }
    if (url.endsWith("/gateway")) return response(200, { url: "wss://gateway.example/ws" });
    if (url.includes("/v2/users/") && url.endsWith("/messages")) {
      return response(200, { id: "out-1", timestamp: "2026-10-19T00:00:00Z" });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const adapter = new QQAdapter({
    getConfig: () => qqConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: fetchImpl,
    socketFactory: (url, options) => {
      const socket = new FakeSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    timers,
    random: () => 0.25,
  });

  let received;
  await adapter.start(async (event) => {
    received = event;
  });
  assert.equal(sockets.length, 1);
  assert.equal(requests[0].body.appId, "102030");
  assert.equal(requests[1].init.headers.Authorization, "QQBot access-token");

  sockets[0].open();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  assert.deepEqual(sockets[0].sent[0], {
    op: 2,
    d: {
      token: "QQBot access-token",
      intents: 1 << 25,
      shard: [0, 1],
    },
  });

  sockets[0].receive({
    op: 0,
    s: 1,
    t: "READY",
    d: { session_id: "session-1" },
  });
  sockets[0].receive({
    op: 0,
    s: 2,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "msg-1",
      content: "hello",
      timestamp: "2026-10-19T00:00:00Z",
      author: { user_openid: "user-openid" },
      attachments: [{ content_type: "image/png", url: "https://example/image.png" }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.id, "msg-1");
  assert.equal(received.scope, "private");
  assert.equal(received.attachments[0].type, "image");

  const result = await adapter.send(received, { text: "world" });
  assert.equal(result.id, "out-1");
  const sendRequest = requests.at(-1);
  assert.equal(sendRequest.init.method, "POST");
  assert.equal(sendRequest.body.content, "world");
  assert.equal(sendRequest.body.msg_id, "msg-1");
  assert.ok(sendRequest.body.msg_seq >= 1 && sendRequest.body.msg_seq <= 65_535);

  assert.equal(adapter.status().appId, "1***");
  assert.equal(adapter.status().hasSecret, true);
  await assert.rejects(
    () => adapter.like("user"),
    (error) => error.code === "QQ_LIKE_UNSUPPORTED",
  );
  const count = requests.length;
  await assert.rejects(
    () => adapter.send(received, { text: "ignored", images: ["https://example/image.png"] }),
    (error) => error.code === "QQ_RICH_MEDIA_UNSUPPORTED",
  );
  assert.equal(requests.length, count);
  await adapter.stop();
  assert.equal(adapter.status().state, "stopped");
});

test("QQ error events stay contained and stop prevents a scheduled reconnect", async () => {
  const sockets = [];
  const timers = fakeTimers();
  const adapter = new QQAdapter({
    getConfig: () => qqConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url) => {
      if (url.includes("/app/getAppAccessToken")) {
        return response(200, { access_token: "access", expires_in: 7200 });
      }
      return response(200, { url: "wss://gateway.example/ws" });
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    timers,
  });

  await adapter.start(async () => {});
  sockets[0].open();
  sockets[0].emit("error", new Error("network secret=should-not-crash"));
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  sockets[0].receive({ op: 0, s: 4, t: "READY", d: { session_id: "resume-me" } });

  sockets[0].emit("close", 1001, Buffer.from("restart"));
  assert.equal(timers.timeouts.size, 1);
  await adapter.stop();
  assert.equal(timers.timeouts.size, 0);
  timers.runNextTimeout();
  assert.equal(sockets.length, 1);
});

test("QQ resumes an existing session after a recoverable disconnect", async () => {
  const sockets = [];
  const timers = fakeTimers();
  let tokenCalls = 0;
  const adapter = new QQAdapter({
    getConfig: () => qqConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url) => {
      if (url.includes("/app/getAppAccessToken")) {
        tokenCalls += 1;
        return response(200, { access_token: `access-${tokenCalls}`, expires_in: 7200 });
      }
      return response(200, { url: `wss://gateway.example/${sockets.length}` });
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    timers,
  });

  await adapter.start(async () => {});
  sockets[0].open();
  sockets[0].receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  sockets[0].receive({ op: 0, s: 9, t: "READY", d: { session_id: "session-x" } });
  sockets[0].emit("close", 1001, Buffer.from("restart"));
  assert.equal(timers.runNextTimeout(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  assert.deepEqual(sockets[1].sent[0], {
    op: 6,
    d: {
      token: "QQBot access-1",
      session_id: "session-x",
      seq: 9,
    },
  });
  await adapter.stop();
});

test("QQ reads pause policy on every inbound and reply", async () => {
  let socket;
  let config = qqConfig();
  let calls = 0;
  const requests = [];
  const adapter = new QQAdapter({
    getConfig: () => config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.includes("/app/getAppAccessToken")) {
        return response(200, { access_token: "access", expires_in: 7200 });
      }
      if (url.endsWith("/gateway")) return response(200, { url: "wss://gateway.example/ws" });
      return response(200, { id: "out" });
    },
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  await adapter.start(async () => {
    calls += 1;
  });
  socket.open();
  socket.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  socket.receive({ op: 0, s: 1, t: "READY", d: { session_id: "s" } });
  socket.receive({
    op: 0,
    s: 2,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "msg-live",
      content: "hello",
      timestamp: "2026-10-19T00:00:00Z",
      author: { user_openid: "user-1" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  config = qqConfig({ policy: { paused: true } });
  socket.receive({
    op: 0,
    s: 3,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "msg-paused",
      content: "hello again",
      timestamp: "2026-10-19T00:00:01Z",
      author: { user_openid: "user-1" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      adapter.send(
        {
          id: "msg-live",
          scope: "private",
          conversationId: "user-1",
        },
        { text: "reply" },
      ),
    (error) => error.code === "POLICY_PAUSED",
  );
  assert.equal(requests.filter((item) => item.url.includes("/messages")).length, 0);
  await adapter.stop();
});

test("QQ does not drop rapid inbound messages because of action cooldown", async () => {
  let socket;
  const config = qqConfig({ policy: { cooldownMs: 3_000 } });
  let calls = 0;
  const adapter = new QQAdapter({
    getConfig: () => config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url) => {
      if (url.includes("/app/getAppAccessToken")) {
        return response(200, { access_token: "access", expires_in: 7200 });
      }
      if (url.endsWith("/gateway")) return response(200, { url: "wss://gateway.example/ws" });
      return response(200, { id: "out" });
    },
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  await adapter.start(async () => {
    calls += 1;
  });
  socket.open();
  socket.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  socket.receive({ op: 0, s: 1, t: "READY", d: { session_id: "s" } });
  for (const [seq, id, content] of [
    [2, "msg-burst-1", "第一句"],
    [3, "msg-burst-2", "第二句"],
  ]) {
    socket.receive({
      op: 0,
      s: seq,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id,
        content,
        timestamp: "2026-10-19T00:00:00Z",
        author: { user_openid: "user-1" },
      },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  await adapter.stop();
});

test("QQ treats a platform ban close as terminal and does not reconnect", async () => {
  let socket;
  let created = 0;
  const adapter = new QQAdapter({
    getConfig: () => qqConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: async (url) => {
      if (url.includes("/app/getAppAccessToken")) {
        return response(200, { access_token: "access", expires_in: 7200 });
      }
      return response(200, { url: "wss://gateway.example/ws" });
    },
    socketFactory: () => {
      created += 1;
      socket = new FakeSocket();
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.open();
  socket.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
  socket.receive({ op: 0, s: 1, t: "READY", d: { session_id: "s" } });
  socket.emit("close", 4915, Buffer.from("disallowed"));
  assert.equal(adapter.status().running, false);
  assert.equal(adapter.status().state, "fatal");
  assert.equal(created, 1);
});

test("OneBot sends Bearer auth, converts structured segments, and correlates API echoes", async () => {
  const sockets = [];
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: (url, options) => {
      const socket = new FakeSocket(url, options);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
  });

  let received;
  await adapter.start(async (event) => {
    received = event;
  });
  assert.equal(sockets[0].options.headers.Authorization, "Bearer bot-token");
  sockets[0].open();
  const statusRequest = sockets[0].sent.find((item) => item.action === "get_status");
  sockets[0].receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: statusRequest.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].receive({
    post_type: "message",
    message_type: "group",
    self_id: 9000,
    user_id: 1234,
    group_id: 5678,
    message_id: 77,
    time: 1_729_000_000,
    message: [
      { type: "at", data: { qq: "9000" } },
      { type: "text", data: { text: " hello " } },
      { type: "image", data: { url: "https://example/image.png" } },
    ],
    sender: { user_id: 1234 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.text, "hello");
  assert.equal(received.scope, "group");
  assert.equal(received.groupId, "5678");
  assert.equal(received.attachments[0].type, "image");

  const replyPromise = adapter.send(received, {
    text: "reply",
    faces: [14],
    images: ["https://example/image.png"],
  });
  const outgoing = sockets[0].sent.at(-1);
  assert.equal(outgoing.action, "send_group_msg");
  assert.deepEqual(outgoing.params, {
    group_id: 5678,
    message: [
      { type: "text", data: { text: "reply" } },
      { type: "face", data: { id: "14" } },
      { type: "image", data: { file: "https://example/image.png" } },
    ],
  });
  sockets[0].receive({
    status: "ok",
    retcode: 0,
    data: { message_id: 88 },
    echo: outgoing.echo,
  });
  assert.deepEqual(await replyPromise, { message_id: 88 });

  const likePromise = adapter.like("2468", 3);
  const like = sockets[0].sent.at(-1);
  assert.equal(like.action, "send_like");
  assert.deepEqual(like.params, { user_id: 2468, times: 3 });
  sockets[0].receive({ status: "ok", retcode: 0, data: null, echo: like.echo });
  await likePromise;
  assert.equal(adapter.status().pendingRequests, 0);
  await adapter.stop();
});

test("OneBot public call supports Qzone and login lookup with the shared echo path", async () => {
  let socket;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
    random: () => 0.5,
  });
  await adapter.start(async () => {});
  socket.emit("open");

  const qzone = adapter.call("send_qzone_msg", {
    content: "hello qzone",
    images: ["https://example/image.png"],
    ugc_right: 1,
    target_uins: [10001],
  });
  const qzoneRequest = socket.sent.at(-1);
  assert.equal(qzoneRequest.action, "send_qzone_msg");
  assert.deepEqual(qzoneRequest.params, {
    content: "hello qzone",
    images: ["https://example/image.png"],
    ugc_right: 1,
    target_uins: [10001],
  });
  socket.receive({ status: "ok", retcode: 0, data: { tid: "tid-1" }, echo: qzoneRequest.echo });
  assert.deepEqual(await qzone, { tid: "tid-1" });

  const login = adapter.call("get_login_info", {});
  const loginRequest = socket.sent.at(-1);
  assert.equal(loginRequest.action, "get_login_info");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { user_id: 9000, nickname: "bot" },
    echo: loginRequest.echo,
  });
  assert.deepEqual(await login, { user_id: 9000, nickname: "bot" });
  await adapter.stop();
});

test("OneBot reports transport connection separately from QQ online health", async () => {
  let socket;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.emit("open");
  assert.equal(adapter.status().transportConnected, true);
  assert.equal(adapter.status().online, null);
  assert.equal(adapter.status().connected, false);

  const statusRequest = socket.sent.find((item) => item.action === "get_status");
  assert.ok(statusRequest);
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: false, good: false },
    echo: statusRequest.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.status().online, false);
  assert.equal(adapter.status().connected, false);
  await assert.rejects(
    () => adapter.call("get_login_info", {}),
    (error) => error.code === "ONEBOT_ACCOUNT_OFFLINE",
  );

  socket.receive({
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    self_id: 9000,
    status: { online: true, good: true },
  });
  assert.equal(adapter.status().online, true);
  assert.equal(adapter.status().good, true);
  assert.equal(adapter.status().connected, true);
  assert.equal(adapter.status().ready, true);
  await adapter.stop();
});

test("OneBot ignores group chatter without self mention and messages from bots", async () => {
  let socket;
  let calls = 0;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig({ onebot: { botUserIds: ["7777"] } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  await adapter.start(async () => {
    calls += 1;
  });
  socket.open();

  socket.receive({
    post_type: "message",
    message_type: "group",
    self_id: 9000,
    user_id: 1234,
    group_id: 5678,
    message_id: 1,
    message: [{ type: "text", data: { text: "chat" } }],
  });
  socket.receive({
    post_type: "message",
    message_type: "group",
    self_id: 9000,
    user_id: 7777,
    group_id: 5678,
    message_id: 2,
    message: [
      { type: "at", data: { qq: "9000" } },
      { type: "text", data: { text: "bot chat" } },
    ],
  });
  socket.receive({
    post_type: "message",
    message_type: "group",
    self_id: 9000,
    user_id: 9000,
    group_id: 5678,
    message_id: 3,
    message: [
      { type: "at", data: { qq: "9000" } },
      { type: "text", data: { text: "self" } },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  await adapter.stop();
});

test("OneBot rejects pending calls on disconnect and does not revive after stop", async () => {
  const sockets = [];
  const timers = fakeTimers();
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      const socket = new FakeSocket();
      socket.readyState = 1;
      sockets.push(socket);
      return socket;
    },
    timers,
  });
  await adapter.start(async () => {});
  sockets[0].emit("open");
  const statusRequest = sockets[0].sent.find((item) => item.action === "get_status");
  sockets[0].receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: statusRequest.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const pending = adapter.call("send_qzone_msg", { content: "hello" });
  assert.equal(adapter.status().pendingRequests, 1);
  sockets[0].emit("close", 1006, Buffer.from("gone"));
  await assert.rejects(pending, (error) => error.code === "ONEBOT_DISCONNECTED");
  assert.equal(adapter.status().pendingRequests, 0);
  assert.equal(timers.timeouts.size, 1);
  await adapter.stop();
  assert.equal(timers.timeouts.size, 0);
  timers.runNextTimeout();
  assert.equal(sockets.length, 1);
});

test("OneBot surfaces retcode and timeout failures without retrying the action", async () => {
  let socket;
  const timers = fakeTimers();
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig({ onebot: { timeoutMs: 50 } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
    timers,
    random: () => 0.1,
  });
  await adapter.start(async () => {});
  socket.emit("open");
  const statusRequest = socket.sent.find((item) => item.action === "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: statusRequest.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const requestCount = socket.sent.length;
  const failed = adapter.call("send_qzone_msg", { content: "x" });
  const failedEcho = socket.sent.at(-1).echo;
  socket.receive({ status: "failed", retcode: 1200, message: "bad", echo: failedEcho });
  await assert.rejects(
    failed,
    (error) =>
      error instanceof AdapterError &&
      error.code === "ONEBOT_API_ERROR" &&
      error.message.includes("bad"),
  );

  const timeout = adapter.call("send_qzone_msg", { content: "x" });
  assert.equal(socket.sent.length, requestCount + 2);
  assert.equal(timers.runNextTimeout(), true);
  await assert.rejects(timeout, (error) => error.code === "ONEBOT_API_TIMEOUT");
  assert.equal(socket.sent.length, requestCount + 2);
  assert.equal(adapter.status().pendingRequests, 0);
  await adapter.stop();
});

test("OneBot reads current policy for inbound, reply, and like actions", async () => {
  let socket;
  let config = oneBotConfig({ policy: { autoActions: false } });
  let inbound = 0;
  const adapter = new OneBotAdapter({
    getConfig: () => config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {
    inbound += 1;
  });
  socket.emit("open");
  const statusRequest = socket.sent.find((item) => item.action === "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: statusRequest.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  socket.receive({
    post_type: "message",
    message_type: "private",
    self_id: 9000,
    user_id: 1234,
    message_id: 1,
    message: [{ type: "text", data: { text: "hello" } }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inbound, 1);

  config = oneBotConfig({ policy: { paused: true, autoActions: false } });
  socket.receive({
    post_type: "message",
    message_type: "private",
    self_id: 9000,
    user_id: 1234,
    message_id: 2,
    message: [{ type: "text", data: { text: "paused" } }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inbound, 1);
  await assert.rejects(
    () =>
      adapter.send(
        { scope: "private", userId: "1234" },
        { text: "reply" },
      ),
    (error) => error.code === "POLICY_PAUSED",
  );
  await assert.rejects(
    () => adapter.like("1234", 10),
    (error) => error.code === "POLICY_PAUSED",
  );

  config = oneBotConfig({ policy: { paused: false, autoActions: false } });
  await assert.rejects(
    () => adapter.like("1234", 10),
    (error) => error.code === "AUTO_ACTIONS_DISABLED",
  );
  config = oneBotConfig();
  await assert.rejects(
    () => adapter.like("not-a-number", 1),
    (error) => error.code === "ONEBOT_LIKE_TARGET_INVALID",
  );
  await assert.rejects(
    () => adapter.like("1234", 11),
    (error) => error.code === "ONEBOT_LIKE_ARGUMENT_INVALID",
  );
  await adapter.stop();
});

test("OneBot does not drop rapid inbound messages because of action cooldown", async () => {
  let socket;
  const config = oneBotConfig({ policy: { cooldownMs: 3_000 } });
  let inbound = 0;
  const adapter = new OneBotAdapter({
    getConfig: () => config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {
    inbound += 1;
  });
  socket.emit("open");
  const statusRequest = socket.sent.find((item) => item.action === "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: statusRequest.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (const [id, text] of [
    [1, "第一句"],
    [2, "第二句"],
  ]) {
    socket.receive({
      post_type: "message",
      message_type: "private",
      self_id: 9000,
      user_id: 1234,
      message_id: id,
      message: [{ type: "text", data: { text } }],
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inbound, 2);
  await adapter.stop();
});

test("OneBot risk control blocks side-effect actions but keeps queries and status network truth", async () => {
  const sockets = [];
  const timers = fakeTimers();
  let inbound = 0;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      const socket = new FakeSocket();
      socket.readyState = 1;
      sockets.push(socket);
      return socket;
    },
    timers,
  });
  await adapter.start(async () => {
    inbound += 1;
  });
  sockets[0].emit("open");
  const initialStatus = sockets[0].sent.find((item) => item.action === "get_status");
  sockets[0].receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: initialStatus.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const dispatch = adapter.call("send_qzone_msg", { content: "will be blocked" });
  const dispatchEcho = sockets[0].sent.at(-1).echo;
  sockets[0].receive({
    status: "failed",
    retcode: 1200,
    wording: "账号触发风控，操作已冻结",
    echo: dispatchEcho,
  });
  await assert.rejects(dispatch, (error) => error.code === "ONEBOT_RISK_CONTROL");

  let status = adapter.status();
  assert.equal(status.transportConnected, true);
  assert.equal(status.online, true);
  assert.equal(status.connected, true);
  assert.equal(status.restricted, true);
  assert.equal(status.actionBlocked, true);
  assert.equal(status.blockedReason, "risk-control");
  assert.equal(status.blockedUntil, null);
  assert.equal(status.state, "ready");

  const sentBeforeBlockedCall = sockets[0].sent.length;
  await assert.rejects(
    () => adapter.call("send_private_msg", { user_id: 1234, message: "x" }),
    (error) => error.code === "ONEBOT_ACTION_BLOCKED",
  );
  assert.equal(sockets[0].sent.length, sentBeforeBlockedCall);

  sockets[0].receive({
    post_type: "message",
    message_type: "private",
    self_id: 9000,
    user_id: 1234,
    message_id: 11,
    message: [{ type: "text", data: { text: "do not call AI" } }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inbound, 0);

  const login = adapter.call("get_login_info", {});
  const loginRequest = sockets[0].sent.at(-1);
  assert.equal(loginRequest.action, "get_login_info");
  sockets[0].receive({
    status: "ok",
    retcode: 0,
    data: { user_id: 9000, nickname: "bot" },
    echo: loginRequest.echo,
  });
  assert.equal((await login).user_id, 9000);

  sockets[0].emit("close", 1006, Buffer.from("network restart"));
  assert.equal(timers.runNextTimeout(), true);
  sockets[1].emit("open");
  assert.equal(adapter.status().restricted, true);
  assert.equal(adapter.status().blockedReason, "risk-control");

  await adapter.stop();
  await adapter.start(async () => {});
  status = adapter.status();
  assert.equal(status.restricted, false);
  assert.equal(status.actionBlocked, false);
  assert.equal(status.blockedReason, null);
  assert.equal(status.blockedUntil, null);
  await adapter.stop();
});

test("OneBot permission failures lock actions until restart", async () => {
  let socket;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.emit("open");
  const initialStatus = socket.sent.find((item) => item.action === "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: initialStatus.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const like = adapter.like("10001", 1);
  const likeRequest = socket.sent.at(-1);
  socket.receive({
    status: "failed",
    retcode: 1403,
    message: "permission denied: action disabled",
    echo: likeRequest.echo,
  });
  await assert.rejects(like, (error) => error.code === "ONEBOT_PERMISSION_DENIED");
  assert.equal(adapter.status().restricted, true);
  assert.equal(adapter.status().blockedReason, "permission-disabled");
  assert.equal(adapter.status().blockedUntil, null);
  assert.equal(adapter.status().connected, true);

  const sent = socket.sent.length;
  await assert.rejects(
    () => adapter.call("send_like", { user_id: 10001, times: 1 }),
    (error) => error.code === "ONEBOT_ACTION_BLOCKED",
  );
  assert.equal(socket.sent.length, sent);
  await adapter.stop();
  await adapter.start(async () => {});
  assert.equal(adapter.status().restricted, false);
  await adapter.stop();
});

test("OneBot rate limits block actions for 60 seconds while queries remain available", async () => {
  let socket;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.emit("open");
  const initialStatus = socket.sent.find((item) => item.action === "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: initialStatus.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const startedAt = Date.now();
  const dispatch = adapter.call("send_group_msg", { group_id: 5678, message: "x" });
  const dispatchEcho = socket.sent.at(-1).echo;
  socket.receive({
    status: "failed",
    retcode: 1200,
    message: "rate limit exceeded, too many requests",
    echo: dispatchEcho,
  });
  await assert.rejects(dispatch, (error) => error.code === "ONEBOT_RATE_LIMITED");
  const status = adapter.status();
  assert.equal(status.restricted, true);
  assert.equal(status.actionBlocked, true);
  assert.equal(status.blockedReason, "rate-limit");
  assert.ok(status.blockedUntil >= startedAt + 59_000);
  assert.ok(status.blockedUntil <= startedAt + 61_000);
  assert.equal(status.connected, true);

  await assert.rejects(
    () => adapter.call("send_qzone_msg", { content: "blocked" }),
    (error) => error.code === "ONEBOT_ACTION_BLOCKED",
  );
  const lookup = adapter.call("get_status", {});
  const lookupRequest = socket.sent.at(-1);
  assert.equal(lookupRequest.action, "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: lookupRequest.echo,
  });
  assert.equal((await lookup).online, true);
  await adapter.stop();
});

test("OneBot does not treat ordinary content filtering as risk control", async () => {
  let socket;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.emit("open");
  const initialStatus = socket.sent.find((item) => item.action === "get_status");
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { online: true, good: true },
    echo: initialStatus.echo,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const dispatch = adapter.call("send_qzone_msg", { content: "ordinary rejection" });
  const dispatchEcho = socket.sent.at(-1).echo;
  socket.receive({
    status: "failed",
    retcode: 1200,
    message: "content filter rejected because the message contains banned words",
    echo: dispatchEcho,
  });
  await assert.rejects(dispatch, (error) => error.code === "ONEBOT_API_ERROR");
  assert.equal(adapter.status().restricted, false);
  assert.equal(adapter.status().actionBlocked, false);
  assert.equal(adapter.status().blockedReason, null);
  await adapter.stop();
});

test("OneBot typing status targets only the private user and skips groups and pause", async () => {
  let socket;
  let config = oneBotConfig();
  const adapter = new OneBotAdapter({
    getConfig: () => config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.emit("open");

  const privateEvent = {
    channel: "onebot",
    scope: "private",
    userId: "10001",
    conversationId: "10001",
  };
  const typing = adapter.setInputStatus(privateEvent);
  const typingRequest = socket.sent.at(-1);
  assert.equal(typingRequest.action, "set_input_status");
  assert.deepEqual(typingRequest.params, { user_id: "10001", event_type: 1 });
  socket.receive({ status: "ok", retcode: 0, data: {}, echo: typingRequest.echo });
  assert.deepEqual(await typing, {});

  const beforeGroup = socket.sent.length;
  assert.deepEqual(
    await adapter.setInputStatus({
      channel: "onebot",
      scope: "group",
      userId: "10001",
      groupId: "20002",
      conversationId: "20002",
    }),
    { status: "skipped" },
  );
  assert.equal(socket.sent.length, beforeGroup);

  config = oneBotConfig({ policy: { paused: true } });
  assert.deepEqual(await adapter.setInputStatus(privateEvent), { status: "paused" });
  assert.equal(socket.sent.length, beforeGroup);
  await adapter.stop();
});

test("OneBot typing failures are best-effort and do not lock message sending", async () => {
  let socket;
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    socketFactory: () => {
      socket = new FakeSocket();
      socket.readyState = 1;
      return socket;
    },
  });
  await adapter.start(async () => {});
  socket.emit("open");

  const event = {
    id: "msg-1",
    channel: "onebot",
    scope: "private",
    userId: "10001",
    conversationId: "10001",
  };
  const typing = adapter.setInputStatus(event);
  const typingRequest = socket.sent.at(-1);
  socket.receive({
    status: "failed",
    retcode: 1401,
    message: "permission denied",
    echo: typingRequest.echo,
  });
  await assert.rejects(typing, (error) => error.code === "ONEBOT_PERMISSION_DENIED");
  assert.equal(adapter.status().actionBlocked, false);

  const send = adapter.send(event, { text: "still works" });
  const sendRequest = socket.sent.at(-1);
  assert.equal(sendRequest.action, "send_private_msg");
  assert.equal(sendRequest.params.user_id, 10001);
  socket.receive({
    status: "ok",
    retcode: 0,
    data: { message_id: "reply-1" },
    echo: sendRequest.echo,
  });
  assert.deepEqual(await send, { message_id: "reply-1" });
  await adapter.stop();
});

function historyMessage(id, timeMs, role, text) {
  return {
    message_id: id,
    message_seq: id,
    time: Math.floor(timeMs / 1000),
    message_sent_type: role === "assistant" ? "self" : "normal",
    sender: { user_id: role === "assistant" ? "9999" : "10001" },
    message: [{ type: "text", data: { text } }],
  };
}

test("OneBot history pages until the seven-day cutoff and normalizes roles", async () => {
  const now = Date.UTC(2026, 9, 19, 12);
  const day = 24 * 60 * 60 * 1000;
  const pages = [
    {
      messages: [
        historyMessage("1", now, "user", "现在的猫叫咪咪"),
        historyMessage("2", now - day, "assistant", "记住了"),
      ],
    },
    {
      messages: [
        historyMessage("3", now - 2 * day, "user", "以前的猫叫花花"),
        historyMessage("4", now - 3 * day, "assistant", "嗯"),
      ],
    },
    {
      messages: [
        historyMessage("5", now - 8 * day, "user", "太老了"),
        historyMessage("6", now - 9 * day, "assistant", "太老了"),
      ],
    },
  ];
  const requests = [];
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  adapter.call = async (action, params) => {
    requests.push({ action, params });
    return pages.shift() ?? { messages: [] };
  };

  const result = await adapter.fetchHistory(
    {
      channel: "onebot",
      scope: "private",
      userId: "10001",
      conversationId: "10001",
    },
    { pageSize: 2, now: () => now, maxAgeMs: 7 * day },
  );
  assert.deepEqual(
    result.map((message) => [message.role, message.text]),
    [
      ["user", "现在的猫叫咪咪"],
      ["assistant", "记住了"],
      ["user", "以前的猫叫花花"],
      ["assistant", "嗯"],
    ],
  );
  assert.equal(requests[0].action, "get_friend_msg_history");
  assert.equal(requests[0].params.user_id, "10001");
  assert.equal(requests[0].params.count, 2);
  assert.equal(requests[0].params.disable_get_url, true);
  assert.equal("message_seq" in requests[0].params, false);
  assert.equal(requests[1].params.message_seq, "2");
  assert.equal(requests[1].params.reverse_order, true);
  assert.equal(requests[2].params.message_seq, "4");
});

test("OneBot history retries the opposite page direction and skips non-OneBot events", async () => {
  const now = Date.UTC(2026, 9, 19, 12);
  const day = 24 * 60 * 60 * 1000;
  const firstPage = [
    historyMessage("1", now, "user", "最近一"),
    historyMessage("2", now - day, "user", "最近二"),
  ];
  const pages = [
    { messages: firstPage },
    { messages: firstPage },
    {
      messages: [historyMessage("3", now - 2 * day, "user", "更早三")],
    },
  ];
  const requests = [];
  const adapter = new OneBotAdapter({
    getConfig: () => oneBotConfig(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  adapter.call = async (action, params) => {
    requests.push({ action, params });
    return pages.shift() ?? { messages: [] };
  };

  const result = await adapter.fetchHistory(
    {
      channel: "onebot",
      scope: "group",
      userId: "10001",
      groupId: "20002",
      conversationId: "20002",
    },
    { pageSize: 2, now: () => now, maxAgeMs: 7 * day },
  );
  assert.equal(requests[0].action, "get_group_msg_history");
  assert.equal(requests[0].params.group_id, "20002");
  assert.equal(requests[1].params.reverse_order, true);
  assert.equal(requests[2].params.reverse_order, false);
  assert.deepEqual(
    result.map((message) => message.text),
    ["最近一", "最近二", "更早三"],
  );

  assert.deepEqual(
    await adapter.fetchHistory({
      channel: "qq",
      scope: "private",
      userId: "10001",
      conversationId: "10001",
    }),
    [],
  );
});
