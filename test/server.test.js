import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OneBotAdapter } from "../src/adapters/onebot.js";
import { QQAdapter } from "../src/adapters/qq.js";
import { defaultConfig } from "../src/config.js";
import {
  createConfigController,
  createQzoneToolPublisher,
} from "../src/index.js";
import { createWebServer, listenLocal } from "../src/server.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "xiaoyu-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = path.join(root, "public");
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>test</title>");
  await writeFile(path.join(publicDir, "app.js"), "console.log('test');");

  let config = structuredClone(defaultConfig);
  config.ai.apiKey = "ai-secret";
  config.qq.secret = "qq-secret";
  config.onebot.token = "onebot-secret";
  config.webSearch.apiKey = "web-search-secret";

  const memoriesByKey = new Map();
  const memoryKeys = [];
  let memoryCounter = 0;
  const listFor = (key) => {
    if (!memoriesByKey.has(key)) memoriesByKey.set(key, []);
    return memoriesByKey.get(key);
  };
  const store = {
    async memories(key) {
      memoryKeys.push(key);
      return listFor(key);
    },
    async remember(
      key,
      text,
      { type = "fact", importance = 5, source = "manual" } = {},
    ) {
      memoryKeys.push(key);
      const list = listFor(key);
      const now = new Date().toISOString();
      const memory = {
        id: `m-${(memoryCounter += 1)}`,
        text,
        type,
        importance,
        source,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
      };
      list.push(memory);
      return memory;
    },
    async forget(key, id) {
      memoryKeys.push(key);
      const list = listFor(key);
      const index = list.findIndex((item) => item.id === id);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    },
    async clearMemories(key) {
      memoryKeys.push(key);
      const list = listFor(key);
      const count = list.length;
      list.splice(0, list.length);
      return count;
    },
    async memoryScopes() {
      return [...memoriesByKey.keys()];
    },
    async exportData() {
      return { version: 2, conversations: {}, memories: {} };
    },
    async importData() {
      return { backupPath: "/tmp/backup.json" };
    },
    async backup() {
      return "/tmp/backup.json";
    },
  };

  const events = [];
  const engine = {
    async handle(event) {
      events.push(event);
      return { text: "收到", faces: [14], images: [] };
    },
    async status() {
      return { aiReady: true };
    },
  };

  let published;
  const qzone = {
    async publish(text, options) {
      published = { text, options };
      return { status: "sent", providerId: "tid-1" };
    },
    async login() {
      return { status: "manual_action_required", message: "请在 NapCat 扫码" };
    },
    async status() {
      return { transport: "napcat-onebot", token: "must-not-leak" };
    },
  };

  const qzoneComments = options.qzoneComments ?? {
    status: () => ({
      enabled: false,
      running: false,
      dryRun: true,
      cookie: "missing",
      replies: 0,
    }),
    pollNow: async () => ({ ok: true, replies: 0 }),
  };

  const server = createWebServer({
    root,
    publicDir,
    token: "test-console-token-1234567890",
    getConfig: () => config,
    saveConfig: async (_root, patch) => {
      config = {
        ...config,
        ...patch,
        ai: { ...config.ai, ...(patch.ai ?? {}) },
        policy: { ...config.policy, ...(patch.policy ?? {}) },
      };
      return config;
    },
    store,
    engine,
    qzone,
    qzoneComments,
    adapters: {
      qq: { status: () => ({ connected: false, secret: "must-not-leak" }) },
      onebot: { status: () => ({ connected: false, token: "must-not-leak" }) },
    },
    autonomy: { status: () => ({ running: false, nextAt: null }) },
    stickers: options.stickers,
    conversationState: options.conversationState,
    userUnderstanding: options.userUnderstanding,
  });
  const address = await listenLocal(server, 0);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return {
    root,
    token: "test-console-token-1234567890",
    base: `http://127.0.0.1:${address.port}`,
    port: address.port,
    events,
    memoriesByKey,
    memoryKeys,
    getConfig: () => config,
    published: () => published,
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function rawRequest(port, { method = "GET", path: requestPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: requestPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("API requires Bearer authentication and rejects a mismatched Origin", async (t) => {
  const app = await fixture(t);
  const anonymous = await fetch(`${app.base}/api/status`);
  assert.equal(anonymous.status, 401);

  const badOrigin = await fetch(`${app.base}/api/status`, {
    headers: { ...auth(app.token), origin: "https://example.com" },
  });
  assert.equal(badOrigin.status, 403);

  const allowed = await fetch(`${app.base}/api/status`, {
    headers: { ...auth(app.token), origin: app.base },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("x-frame-options"), "DENY");
});

test("API rejects a mismatched Host header", async (t) => {
  const app = await fixture(t);
  const response = await rawRequest(app.port, {
    path: "/api/status",
    headers: {
      host: `evil.example:${app.port}`,
      authorization: `Bearer ${app.token}`,
    },
  });
  assert.equal(response.status, 403);
});

test("config and status responses never expose secrets", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/config`, {
    headers: auth(app.token),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /ai-secret|qq-secret|onebot-secret|web-search-secret/);
  assert.doesNotMatch(body, /"apiKey"|"secret"|"token"/);

  const status = await fetch(`${app.base}/api/status`, {
    headers: auth(app.token),
  });
  const statusBody = await status.text();
  assert.equal(status.status, 200);
  assert.doesNotMatch(statusBody, /must-not-leak/);
});

test("QZone comments status and manual poll endpoints are available", async (t) => {
  let polled = 0;
  const app = await fixture(t, {
    qzoneComments: {
      status: () => ({
        enabled: true,
        running: true,
        dryRun: false,
        cookie: "ready",
        replies: 4,
        lastError: null,
      }),
      pollNow: async () => {
        polled += 1;
        return { ok: true, replies: 1 };
      },
    },
  });
  const status = await fetch(`${app.base}/api/qzone/comments/status`, {
    headers: auth(app.token),
  });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.cookie, "ready");
  assert.equal(statusBody.replies, 4);

  const poll = await fetch(`${app.base}/api/qzone/comments/poll`, {
    method: "POST",
    headers: auth(app.token),
  });
  assert.equal(poll.status, 200);
  const pollBody = await poll.json();
  assert.equal(pollBody.ok, true);
  assert.equal(pollBody.result.replies, 1);
  assert.equal(polled, 1);
});

test("config API accepts sticker and idle termination settings", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/config`, {
    method: "POST",
    headers: { ...auth(app.token), "content-type": "application/json" },
    body: JSON.stringify({
      inputDelayMs: 2500,
      maxToolCallsPerTurn: 7,
      stickers: { ...defaultConfig.stickers, proactiveCooldownMinutes: 9 },
      chatExit: { ...defaultConfig.chatExit, idleMinutes: 15 },
      webSearch: {
        ...defaultConfig.webSearch,
        searchEnabled: false,
        fetchEnabled: false,
        maxCallsPerTurn: 2,
        maxResults: 7,
        maxContentChars: 9000,
      },
      qzoneComments: {
        ...defaultConfig.qzoneComments,
        enabled: true,
        pollMinutes: 8,
      },
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.config.inputDelayMs, 2500);
  assert.equal(payload.config.maxToolCallsPerTurn, 7);
  assert.equal(payload.config.stickers.proactiveCooldownMinutes, 9);
  assert.equal(payload.config.chatExit.idleMinutes, 15);
  assert.equal(payload.config.webSearch.searchEnabled, false);
  assert.equal(payload.config.webSearch.fetchEnabled, false);
  assert.equal(payload.config.webSearch.maxCallsPerTurn, 2);
  assert.equal(payload.config.webSearch.maxResults, 7);
  assert.equal(payload.config.webSearch.maxContentChars, 9000);
  assert.equal(payload.config.qzoneComments.enabled, true);
  assert.equal(payload.config.qzoneComments.pollMinutes, 8);
});

test("body size limits are enforced before parsing", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/chat`, {
    method: "POST",
    headers: {
      ...auth(app.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "x".repeat(520 * 1024) }),
  });
  assert.equal(response.status, 413);
});

test("import alone accepts exports larger than the normal API limit", async (t) => {
  let conversationResets = 0;
  let understandingResets = 0;
  const app = await fixture(t, {
    conversationState: {
      async resetAll() {
        conversationResets += 1;
      },
    },
    userUnderstanding: {
      async resetAll() {
        understandingResets += 1;
      },
    },
  });
  const response = await fetch(`${app.base}/api/import`, {
    method: "POST",
    headers: {
      ...auth(app.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: 1,
      conversations: {},
      memories: {},
      padding: "x".repeat(600 * 1024),
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(conversationResets, 1);
  assert.equal(understandingResets, 1);
});

test("chat uses the fixed local owner event and accepts HTTPS images", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/chat`, {
    method: "POST",
    headers: {
      ...auth(app.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: "看看这张图",
      attachments: [{ type: "image", url: "https://example.com/a.png" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(app.events.length, 1);
  assert.equal(app.events[0].channel, "local");
  assert.equal(app.events[0].userId, "local-owner");
  assert.equal(app.events[0].conversationId, "local-owner");
  assert.deepEqual(app.events[0].attachments, [
    { type: "image", url: "https://example.com/a.png" },
  ]);
});

test("memory routes share the engine's configured local identity link", async (t) => {
  const app = await fixture(t);
  app.getConfig().identityLinks["local:local-owner"] = "person-42";
  const created = await fetch(`${app.base}/api/memories`, {
    method: "POST",
    headers: {
      ...auth(app.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "共享记忆" }),
  });
  assert.equal(created.status, 201);
  const listed = await fetch(`${app.base}/api/memories`, {
    headers: auth(app.token),
  });
  assert.equal(listed.status, 200);
  const expected = JSON.stringify(["identity-memory", "person-42"]);
  assert.ok(app.memoryKeys.length >= 2);
  assert.ok(app.memoryKeys.every((key) => key === expected));
});

test("memory API lists scopes and manages private and group memories", async (t) => {
  const app = await fixture(t);
  const ownerKey = JSON.stringify(["private-memory", "local", "local-owner"]);
  const groupKey = JSON.stringify(["group-memory", "onebot", "group-1"]);
  const headers = {
    ...auth(app.token),
    "content-type": "application/json",
  };

  const ownerCreated = await fetch(`${app.base}/api/memories`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "本机偏好", type: "preference", importance: 8 }),
  });
  assert.equal(ownerCreated.status, 201);
  const ownerBody = await ownerCreated.json();
  assert.equal(ownerBody.memory.type, "preference");
  assert.equal(ownerBody.memory.source, "manual");

  const groupCreated = await fetch(`${app.base}/api/memories`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      key: groupKey,
      text: "群内共享约定",
      type: "event",
      importance: 7,
    }),
  });
  assert.equal(groupCreated.status, 201);
  const groupBody = await groupCreated.json();
  assert.equal(groupBody.key, groupKey);

  const listed = await fetch(`${app.base}/api/memories`, { headers: auth(app.token) });
  assert.equal(listed.status, 200);
  const ownerPayload = await listed.json();
  assert.equal(ownerPayload.key, ownerKey);
  assert.equal(ownerPayload.count, 1);
  assert.equal(ownerPayload.memories[0].text, "本机偏好");
  assert.ok(ownerPayload.scopes.some((scope) => scope.key === ownerKey && scope.owner));
  assert.ok(
    ownerPayload.scopes.some(
      (scope) => scope.key === groupKey && scope.label.includes("群内共享"),
    ),
  );

  const groupListed = await fetch(
    `${app.base}/api/memories?key=${encodeURIComponent(groupKey)}`,
    { headers: auth(app.token) },
  );
  assert.equal(groupListed.status, 200);
  const groupPayload = await groupListed.json();
  assert.equal(groupPayload.scope.kind, "group");
  assert.equal(groupPayload.count, 1);
  assert.equal(groupPayload.memories[0].text, "群内共享约定");

  const removed = await fetch(
    `${app.base}/api/memories/${encodeURIComponent(groupPayload.memories[0].id)}?key=${encodeURIComponent(groupKey)}`,
    { method: "DELETE", headers: auth(app.token) },
  );
  assert.equal(removed.status, 200);

  await fetch(`${app.base}/api/memories`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: groupKey, text: "第二条群记忆" }),
  });
  const cleared = await fetch(
    `${app.base}/api/memories?key=${encodeURIComponent(groupKey)}`,
    { method: "DELETE", headers: auth(app.token) },
  );
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { ok: true, key: groupKey, removed: 1 });

  const understandingClears = [];
  const privateApp = await fixture(t, {
    userUnderstanding: {
      async clearUser(input) {
        understandingClears.push({
          channel: input.channel,
          scope: input.scope,
          userId: input.userId,
        });
      },
    },
  });
  const privateKey = JSON.stringify(["private-memory", "onebot", "30003"]);
  await fetch(`${privateApp.base}/api/memories`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: privateKey, text: "仅属于 30003" }),
  });
  const privateClear = await fetch(
    `${privateApp.base}/api/memories?key=${encodeURIComponent(privateKey)}`,
    { method: "DELETE", headers: auth(privateApp.token) },
  );
  assert.equal(privateClear.status, 200);
  assert.deepEqual(understandingClears, [
    { channel: "onebot", scope: "private", userId: "30003" },
  ]);

  const invalidType = await fetch(`${app.base}/api/memories`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "坏类型", type: "unknown" }),
  });
  assert.equal(invalidType.status, 400);
  const invalidKey = await fetch(`${app.base}/api/memories?key=not-json`, {
    headers: auth(app.token),
  });
  assert.equal(invalidKey.status, 400);
  const missingScope = await fetch(
    `${app.base}/api/memories?key=${encodeURIComponent(
      JSON.stringify(["group-memory", "onebot", "missing"]),
    )}`,
    { headers: auth(app.token) },
  );
  assert.equal(missingScope.status, 404);
});

test("QZone API passes HTTPS images and visibility to NapCat publisher", async (t) => {
  const app = await fixture(t);
  const response = await fetch(`${app.base}/api/qzone/publish`, {
    method: "POST",
    headers: {
      ...auth(app.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: "一条动态",
      images: ["https://example.com/one.jpg"],
      ugcRight: 4,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(app.published(), {
    text: "一条动态",
    options: {
      images: ["https://example.com/one.jpg"],
      ugc_right: 4,
      target_uins: [],
    },
  });
});

test("sticker library API lists, serves, uploads, and deletes", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xQAAAAASUVORK5CYII=",
    "base64",
  );
  let stickerPath;
  let uploadedBytes = 0;
  const items = [
    {
      id: "st_1",
      summary: "可爱猫猫",
      tags: ["可爱"],
      category: "cute",
      cuteness: 1,
      interestingness: 0,
      createdAt: "2026-10-19T00:00:00.000Z",
      lastUsedAt: null,
      useCount: 0,
      size: png.length,
      contentType: "image/png",
    },
  ];
  const stickers = {
    async listPublic() {
      return items.map((item) => ({ ...item }));
    },
    async fileFor(id) {
      return id === "st_1"
        ? { entry: { id }, filePath: stickerPath, contentType: "image/png" }
        : null;
    },
    async remove(id) {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    },
    async updateTags(id, tags) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return null;
      item.tags = [...tags];
      return { id, tags: [...item.tags] };
    },
    async addUploaded({ bytes, fileName }) {
      if (fileName === "dup.png") return { ok: false, reason: "duplicate" };
      uploadedBytes = bytes.length;
      items.push({
        id: "st_2",
        summary: "上传猫猫",
        tags: ["可爱", "猫猫"],
        category: "cute",
        cuteness: 1,
        interestingness: 0,
        createdAt: "2026-10-19T00:01:00.000Z",
        lastUsedAt: null,
        useCount: 0,
        size: bytes.length,
        contentType: "image/png",
      });
      return { ok: true, entry: { id: "st_2" } };
    },
    status: () => ({ rejected: 2 }),
  };
  const app = await fixture(t, { stickers });
  stickerPath = path.join(app.root, "sticker.png");
  await writeFile(stickerPath, png);

  const list = await fetch(`${app.base}/api/stickers`, { headers: auth(app.token) });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.count, 1);
  assert.equal(listBody.rejected, 2);
  assert.equal(listBody.maxFileSizeBytes > 0, true);
  assert.equal(listBody.items[0].summary, "可爱猫猫");
  assert.equal(Object.hasOwn(listBody.items[0], "file"), false);

  const image = await fetch(`${app.base}/api/stickers/st_1/image`, {
    headers: auth(app.token),
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(`${app.base}/api/stickers/st_1/image`)).status, 401);
  assert.equal(
    (
      await fetch(`${app.base}/api/stickers/st_missing/image`, {
        headers: auth(app.token),
      })
    ).status,
    404,
  );

  const upload = await fetch(`${app.base}/api/stickers/upload`, {
    method: "POST",
    headers: { ...auth(app.token), "content-type": "application/json" },
    body: JSON.stringify({
      fileName: "cat.png",
      data: `data:image/png;base64,${png.toString("base64")}`,
      summary: "上传猫猫",
      tags: ["可爱", "猫猫"],
      category: "cute",
    }),
  });
  assert.equal(upload.status, 201);
  assert.equal(uploadedBytes, png.length);
  const uploadBody = await upload.json();
  assert.equal(uploadBody.item.id, "st_2");

  const missingTags = await fetch(`${app.base}/api/stickers/upload`, {
    method: "POST",
    headers: { ...auth(app.token), "content-type": "application/json" },
    body: JSON.stringify({
      fileName: "no-tags.png",
      data: `data:image/png;base64,${png.toString("base64")}`,
      tags: [],
    }),
  });
  assert.equal(missingTags.status, 400);

  const duplicate = await fetch(`${app.base}/api/stickers/upload`, {
    method: "POST",
    headers: { ...auth(app.token), "content-type": "application/json" },
    body: JSON.stringify({
      fileName: "dup.png",
      data: `data:image/png;base64,${png.toString("base64")}`,
      tags: ["可爱"],
    }),
  });
  assert.equal(duplicate.status, 409);

  const patched = await fetch(`${app.base}/api/stickers/st_1`, {
    method: "PATCH",
    headers: { ...auth(app.token), "content-type": "application/json" },
    body: JSON.stringify({ tags: ["开心", "猫猫"] }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.deepEqual(patchedBody.item.tags, ["开心", "猫猫"]);
  assert.deepEqual(items[0].tags, ["开心", "猫猫"]);
  assert.equal(
    (
      await fetch(`${app.base}/api/stickers/st_missing`, {
        method: "PATCH",
        headers: { ...auth(app.token), "content-type": "application/json" },
        body: JSON.stringify({ tags: ["开心"] }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${app.base}/api/stickers/st_1`, {
        method: "PATCH",
        headers: { ...auth(app.token), "content-type": "application/json" },
        body: JSON.stringify({ tags: "开心" }),
      })
    ).status,
    400,
  );

  const deleted = await fetch(`${app.base}/api/stickers/st_1`, {
    method: "DELETE",
    headers: auth(app.token),
  });
  assert.equal(deleted.status, 200);
  assert.equal(
    (
      await fetch(`${app.base}/api/stickers/st_1`, {
        method: "DELETE",
        headers: auth(app.token),
      })
    ).status,
    404,
  );
});

test("static serving blocks traversal and missing files", async (t) => {
  const app = await fixture(t);
  const traversal = await rawRequest(app.port, {
    path: "/..%2Fpackage.json",
  });
  assert.notEqual(traversal.status, 200);
  assert.doesNotMatch(traversal.body, /xiaoyu-qqbot/);

  const missing = await fetch(`${app.base}/missing.js`);
  assert.equal(missing.status, 404);
  const index = await fetch(`${app.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-security-policy"), /script-src 'self'/);
});

test("runtime config accessor is synchronous so adapters become enabled", () => {
  const config = structuredClone(defaultConfig);
  config.qq.enabled = true;
  config.qq.appId = "app-id";
  config.qq.secret = "app-secret";
  config.onebot.enabled = true;
  const controller = createConfigController(config);

  const qq = new QQAdapter({ getConfig: controller.getConfig });
  const onebot = new OneBotAdapter({ getConfig: controller.getConfig });
  assert.equal(qq._readConfig().enabled, true);
  assert.equal(onebot._readConfig().enabled, true);
  assert.ok(!(controller.getConfig() instanceof Promise));
});

test("QZone tool wrapper only treats confirmed tid as success", async () => {
  const sent = createQzoneToolPublisher({
    publish: async () => ({ status: "sent", providerId: "tid-1" }),
  });
  assert.equal((await sent("ok")).status, "sent");

  const unknown = createQzoneToolPublisher({
    publish: async () => ({ status: "unknown", reason: "timeout", message: "结果未知" }),
  });
  await assert.rejects(
    () => unknown("maybe"),
    (error) => error.dispatched === true && error.code === "timeout",
  );
});
