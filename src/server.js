import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publicConfig } from "./config.js";
import { redactSecrets } from "./adapters/shared.js";
import { MEMORY_TYPES } from "./store.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, "..", "public");
const OWNER_ID = "local-owner";
const MAX_JSON_BYTES = 512 * 1024;
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_STICKER_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024;
const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

class RequestError extends Error {
  constructor(status, message, code = "REQUEST_FAILED") {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "font-src 'self'",
    ].join("; "),
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(`${JSON.stringify(redactSecrets(payload))}\n`);
  res.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "content-length": String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res, status = 204) {
  if (res.writableEnded) return;
  res.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  res.end();
}

function hostnameAllowed(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function assertRequestBoundary(req) {
  const host = req.headers.host;
  if (typeof host !== "string" || !host) {
    throw new RequestError(400, "缺少有效的 Host", "BAD_HOST");
  }
  let parsedHost;
  try {
    parsedHost = new URL(`http://${host}`);
  } catch {
    throw new RequestError(400, "Host 不匹配", "BAD_HOST");
  }
  const port = Number(req.socket.localPort);
  if (
    !hostnameAllowed(parsedHost.hostname) ||
    Number(parsedHost.port || 80) !== port
  ) {
    throw new RequestError(403, "拒绝非本机 Host", "BAD_HOST");
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new RequestError(403, "Origin 不匹配", "BAD_ORIGIN");
    }
    if (
      parsedOrigin.protocol !== "http:" ||
      parsedOrigin.host !== host ||
      !hostnameAllowed(parsedOrigin.hostname)
    ) {
      throw new RequestError(403, "Origin 不匹配", "BAD_ORIGIN");
    }
  }
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function tokenMatches(received, expected) {
  return timingSafeEqual(digest(received), digest(expected));
}

function requireBearer(req, token) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  if (!match || !tokenMatches(match[1], token)) {
    throw new RequestError(401, "控制台令牌无效或已过期", "UNAUTHORIZED");
  }
}

async function readJsonBody(req, limit = MAX_JSON_BYTES) {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new RequestError(415, "请求必须使用 application/json", "BAD_CONTENT_TYPE");
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) {
      throw new RequestError(400, "Content-Length 无效", "BAD_LENGTH");
    }
    if (size > limit) {
      req.resume();
      throw new RequestError(413, "请求内容过大", "BODY_TOO_LARGE");
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new RequestError(413, "请求内容过大", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new RequestError(400, "请求体不能为空", "EMPTY_BODY");
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "JSON 格式错误", "BAD_JSON");
  }
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requiredText(value, label, maxLength = MAX_TEXT_BYTES) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(400, `${label}不能为空`, "VALIDATION_ERROR");
  }
  if (Buffer.byteLength(value, "utf8") > maxLength) {
    throw new RequestError(400, `${label}过长`, "VALIDATION_ERROR");
  }
  return value;
}

function ownerMemoryKey(config) {
  const linked = config?.identityLinks?.[`local:${OWNER_ID}`];
  if (typeof linked === "string" && linked.trim()) {
    return JSON.stringify(["identity-memory", linked.trim()]);
  }
  return JSON.stringify(["private-memory", "local", OWNER_ID]);
}

const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
const CHANNEL_LABELS = {
  local: "本机",
  onebot: "OneBot",
  qq: "QQ",
};

function parseMemoryScopeKey(key) {
  if (typeof key !== "string" || key.length > 500) return null;
  let parsed;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return null;
  }
  if (parsed[0] === "private-memory" && parsed.length === 3 && parsed[1] && parsed[2]) {
    return { kind: "private", channel: parsed[1], id: parsed[2] };
  }
  if (parsed[0] === "group-memory" && parsed.length === 3 && parsed[1] && parsed[2]) {
    return { kind: "group", channel: parsed[1], id: parsed[2] };
  }
  if (parsed[0] === "identity-memory" && parsed.length === 2 && parsed[1]) {
    return { kind: "identity", channel: null, id: parsed[1] };
  }
  return null;
}

function understandingEventsForMemoryScope(scope, config) {
  if (!scope) return [];
  const channels = new Set(["onebot", "qq"]);
  if (scope.kind === "private" && channels.has(scope.channel)) {
    return [
      {
        channel: scope.channel,
        scope: "private",
        userId: scope.id,
        conversationId: scope.id,
        text: "",
        timestamp: Date.now(),
      },
    ];
  }
  if (scope.kind !== "identity") return [];
  const events = [];
  for (const [key, linked] of Object.entries(config.identityLinks ?? {})) {
    if (linked !== scope.id) continue;
    const separator = key.indexOf(":");
    if (separator < 1) continue;
    const channel = key.slice(0, separator);
    const userId = key.slice(separator + 1);
    if (!channels.has(channel) || !userId) continue;
    events.push({
      channel,
      scope: "private",
      userId,
      conversationId: userId,
      text: "",
      timestamp: Date.now(),
    });
  }
  return events;
}

function memoryScopeLabel(scope) {
  if (!scope) return "未知范围";
  const channel = CHANNEL_LABELS[scope.channel] ?? scope.channel;
  if (scope.kind === "group") return `${channel} 群聊 · ${scope.id}（群内共享）`;
  if (scope.kind === "private") return `${channel} 私聊 · ${scope.id}`;
  if (scope.kind === "identity") return `身份绑定 · ${scope.id}`;
  return "未知范围";
}

function parseMemoryKey(value, config, { fallbackOwner = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallbackOwner) return ownerMemoryKey(config);
    throw new RequestError(400, "记忆范围不能为空", "VALIDATION_ERROR");
  }
  if (typeof value !== "string" || value.length > 500) {
    throw new RequestError(400, "记忆范围无效", "VALIDATION_ERROR");
  }
  const scope = parseMemoryScopeKey(value);
  if (!scope) throw new RequestError(400, "记忆范围无效", "VALIDATION_ERROR");
  return value;
}

async function memoryScopesWithMeta(store, config) {
  const ownerKey = ownerMemoryKey(config);
  const stored = typeof store.memoryScopes === "function" ? await store.memoryScopes() : [];
  const keys = [...new Set([ownerKey, ...stored])];
  const scopes = [];
  for (const key of keys) {
    const scope = parseMemoryScopeKey(key);
    if (!scope) continue;
    const memories = await store.memories(key);
    scopes.push({
      key,
      ...scope,
      label: memoryScopeLabel(scope),
      owner: key === ownerKey,
      count: memories.length,
    });
  }
  scopes.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner ? -1 : 1;
    return a.label.localeCompare(b.label, "zh-CN");
  });
  return scopes;
}

function normalizeChatAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new RequestError(400, "图片附件最多 4 个", "VALIDATION_ERROR");
  }
  return value.map((item) => {
    if (!plainObject(item) || item.type !== "image") {
      throw new RequestError(400, "聊天附件只支持 image", "VALIDATION_ERROR");
    }
    let url;
    try {
      url = new URL(String(item.url));
    } catch {
      throw new RequestError(400, "图片 URL 无效", "VALIDATION_ERROR");
    }
    if (url.protocol !== "https:" || url.toString().length > 2048) {
      throw new RequestError(400, "图片只允许 HTTPS URL", "VALIDATION_ERROR");
    }
    return { type: "image", url: url.toString() };
  });
}

function normalizeHttpsImages(value, { max = 9 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new RequestError(400, `图片最多 ${max} 张`, "VALIDATION_ERROR");
  }
  return value.map((item) => {
    let url;
    try {
      url = new URL(String(item));
    } catch {
      throw new RequestError(400, "图片 URL 无效", "VALIDATION_ERROR");
    }
    if (url.protocol !== "https:" || url.toString().length > 2048) {
      throw new RequestError(400, "图片只允许 HTTPS URL", "VALIDATION_ERROR");
    }
    return url.toString();
  });
}

function stickerUploadError(reason) {
  switch (reason) {
    case "duplicate":
      return new RequestError(409, "相同表情已存在", "STICKER_DUPLICATE");
    case "library_full":
      return new RequestError(409, "表情库已满", "STICKER_LIBRARY_FULL");
    case "too_large":
      return new RequestError(413, "表情图片过大", "STICKER_TOO_LARGE");
    case "unsupported_type":
      return new RequestError(415, "只支持 PNG、JPEG、GIF、WebP", "STICKER_TYPE_UNSUPPORTED");
    case "empty_file":
      return new RequestError(400, "表情文件为空", "STICKER_EMPTY");
    default:
      return new RequestError(400, "表情保存失败", "STICKER_UPLOAD_FAILED");
  }
}

async function safeStatus(service) {
  if (!service || typeof service.status !== "function") {
    return { state: "unavailable" };
  }
  try {
    return redactSecrets((await service.status()) ?? null);
  } catch (error) {
    return {
      state: "error",
      error: redactSecrets(String(error?.message ?? "state unavailable")).slice(0, 300),
    };
  }
}

async function serveStatic(req, res, publicDir) {
  if (!["GET", "HEAD"].includes(req.method)) {
    throw new RequestError(405, "请求方法不受支持", "METHOD_NOT_ALLOWED");
  }
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  let decoded;
  try {
    decoded = decodeURIComponent(requestUrl.pathname);
  } catch {
    throw new RequestError(400, "路径编码无效", "BAD_PATH");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    throw new RequestError(400, "路径无效", "BAD_PATH");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = await realpath(publicDir).catch(() => null);
  if (!root) throw new RequestError(404, "文件不存在", "NOT_FOUND");
  const candidate = path.resolve(root, relative);
  const within = path.relative(root, candidate);
  if (within.startsWith("..") || path.isAbsolute(within)) {
    throw new RequestError(403, "禁止访问该路径", "BAD_PATH");
  }
  let file;
  try {
    file = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RequestError(404, "文件不存在", "NOT_FOUND");
    }
    throw error;
  }
  const realWithin = path.relative(root, file);
  if (realWithin.startsWith("..") || path.isAbsolute(realWithin)) {
    throw new RequestError(403, "禁止访问该路径", "BAD_PATH");
  }
  const extension = path.extname(file).toLowerCase();
  if (!STATIC_TYPES.has(extension)) {
    throw new RequestError(404, "文件不存在", "NOT_FOUND");
  }
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RequestError(404, "文件不存在", "NOT_FOUND");
    }
    throw error;
  }
  if (!info.isFile()) throw new RequestError(404, "文件不存在", "NOT_FOUND");

  res.writeHead(200, {
    ...securityHeaders(STATIC_TYPES.get(extension)),
    "content-length": String(info.size),
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=300",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

function requireMethod(req, method) {
  if (req.method !== method) {
    throw new RequestError(405, "请求方法不受支持", "METHOD_NOT_ALLOWED");
  }
}

function asSafeError(error) {
  if (error instanceof RequestError) {
    return { status: error.status, payload: { error: error.message, code: error.code } };
  }
  if (error instanceof TypeError) {
    return {
      status: 400,
      payload: {
        error: redactSecrets(String(error.message)).slice(0, 500),
        code: "VALIDATION_ERROR",
      },
    };
  }
  return {
    status: 500,
    payload: { error: "请求处理失败，请查看本机日志", code: "INTERNAL_ERROR" },
  };
}

export function generateConsoleToken() {
  return randomBytes(32).toString("base64url");
}

export function createWebServer({
  root,
  token = generateConsoleToken(),
  publicDir = path.join(root, "public"),
  getConfig,
  saveConfig,
  store,
  engine,
  adapters = {},
  qzone,
  qzoneComments,
  autonomy,
  stickers,
  conversationState,
  userUnderstanding,
  reconnect,
  configChanged,
  logger = console,
} = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  if (typeof token !== "string" || token.length < 16) throw new TypeError("token is too short");
  if (typeof getConfig !== "function") throw new TypeError("getConfig is required");
  if (typeof saveConfig !== "function") throw new TypeError("saveConfig is required");
  if (!store) throw new TypeError("store is required");
  if (!engine || typeof engine.handle !== "function") throw new TypeError("engine is required");

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      if (!requestUrl.pathname.startsWith("/api/")) {
        await serveStatic(req, res, path.resolve(publicDir));
        return;
      }

      assertRequestBoundary(req);
      requireBearer(req, token);
      const route = requestUrl.pathname;

      if (route === "/api/status" && req.method === "GET") {
        const config = await getConfig();
        const statuses = await Promise.all([
          engine.status?.(),
          safeStatus(adapters.qq),
          safeStatus(adapters.onebot),
          safeStatus(qzone),
          safeStatus(autonomy),
        ]);
        sendJson(res, 200, {
          server: {
            state: "running",
            bind: "127.0.0.1",
            port: req.socket.localPort,
          },
          demo: config.demo === true || !config.ai?.apiKey,
          paused: config.policy?.paused === true,
          ai: {
            ready: Boolean(config.ai?.apiKey),
            model: config.ai?.model,
            baseUrl: config.ai?.baseUrl,
          },
          aiReady: Boolean(config.ai?.apiKey),
          channels: {
            qq: statuses[1],
            onebot: statuses[2],
            qzone: statuses[3],
          },
          qq: statuses[1],
          onebot: statuses[2],
          qzone: statuses[3],
          autonomy: statuses[4],
          engine: statuses[0],
          note: "仅监听 127.0.0.1；连接与发布状态均来自实际适配器。",
        });
        return;
      }

      if (route === "/api/stickers" && req.method === "GET") {
        if (!stickers || typeof stickers.listPublic !== "function") {
          throw new RequestError(503, "表情库模块不可用", "STICKERS_UNAVAILABLE");
        }
        const config = await getConfig();
        const items = await stickers.listPublic();
        const stats =
          typeof stickers.status === "function" ? stickers.status() : { rejected: 0 };
        sendJson(res, 200, {
          ok: true,
          count: items.length,
          maxItems: config.stickers?.maxItems ?? null,
          maxFileSizeBytes: config.stickers?.maxFileSizeBytes ?? null,
          enabled: config.stickers?.enabled !== false,
          autoCollect: config.stickers?.autoCollect !== false,
          rejected: Number(stats?.rejected ?? 0),
          items,
        });
        return;
      }

      if (route === "/api/stickers/upload" && req.method === "POST") {
        if (!stickers || typeof stickers.addUploaded !== "function") {
          throw new RequestError(503, "表情库模块不可用", "STICKERS_UNAVAILABLE");
        }
        const body = await readJsonBody(req, MAX_STICKER_UPLOAD_BYTES);
        if (!plainObject(body)) {
          throw new RequestError(400, "上传请求格式错误", "VALIDATION_ERROR");
        }
        const fileName = String(body.fileName ?? "").trim();
        if (fileName.length > 200) {
          throw new RequestError(400, "文件名过长", "VALIDATION_ERROR");
        }
        const raw = typeof body.data === "string" ? body.data : "";
        const encoded = (raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw)
          .replace(/\s+/gu, "");
        if (!encoded || !/^[A-Za-z0-9+/=]+$/u.test(encoded)) {
          throw new RequestError(400, "图片数据无效", "VALIDATION_ERROR");
        }
        const bytes = Buffer.from(encoded, "base64");
        const summary = typeof body.summary === "string" ? body.summary.slice(0, 240) : "";
        const tags = Array.isArray(body.tags)
          ? body.tags
              .filter((item) => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 8)
          : [];
        if (!tags.length) {
          throw new RequestError(400, "手动上传至少填写一个标签", "VALIDATION_ERROR");
        }
        const category = body.category === "interesting" ? "interesting" : "cute";
        const result = await stickers.addUploaded({
          bytes,
          fileName,
          summary,
          tags,
          category,
          config: await getConfig(),
        });
        if (!result.ok) throw stickerUploadError(result.reason);
        const items = await stickers.listPublic();
        const item = items.find((entry) => entry.id === result.entry.id) ?? null;
        sendJson(res, 201, { ok: true, item });
        return;
      }

      const stickerImageMatch = /^\/api\/stickers\/([^/]+)\/image$/u.exec(route);
      if (stickerImageMatch && req.method === "GET") {
        if (!stickers || typeof stickers.fileFor !== "function") {
          throw new RequestError(503, "表情库模块不可用", "STICKERS_UNAVAILABLE");
        }
        let id;
        try {
          id = decodeURIComponent(stickerImageMatch[1]);
        } catch {
          throw new RequestError(400, "表情 ID 无效", "VALIDATION_ERROR");
        }
        const found = await stickers.fileFor(id);
        if (!found) throw new RequestError(404, "表情不存在", "STICKER_NOT_FOUND");
        let info;
        try {
          info = await stat(found.filePath);
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new RequestError(404, "表情不存在", "STICKER_NOT_FOUND");
          }
          throw error;
        }
        if (!info.isFile()) {
          throw new RequestError(404, "表情不存在", "STICKER_NOT_FOUND");
        }
        res.writeHead(200, {
          ...securityHeaders(found.contentType),
          "content-length": String(info.size),
          "cache-control": "no-store",
        });
        createReadStream(found.filePath).on("error", () => res.destroy()).pipe(res);
        return;
      }

      const stickerMatch = /^\/api\/stickers\/([^/]+)$/u.exec(route);
      if (stickerMatch && req.method === "PATCH") {
        if (!stickers || typeof stickers.updateTags !== "function") {
          throw new RequestError(503, "表情库模块不可用", "STICKERS_UNAVAILABLE");
        }
        let id;
        try {
          id = decodeURIComponent(stickerMatch[1]);
        } catch {
          throw new RequestError(400, "表情 ID 无效", "VALIDATION_ERROR");
        }
        const body = await readJsonBody(req);
        if (!plainObject(body) || !Array.isArray(body.tags)) {
          throw new RequestError(400, "标签格式错误", "VALIDATION_ERROR");
        }
        if (body.tags.some((item) => typeof item !== "string")) {
          throw new RequestError(400, "标签格式错误", "VALIDATION_ERROR");
        }
        const updated = await stickers.updateTags(id, body.tags);
        if (!updated) throw new RequestError(404, "表情不存在", "STICKER_NOT_FOUND");
        sendJson(res, 200, { ok: true, item: updated });
        return;
      }

      if (stickerMatch && req.method === "DELETE") {
        if (!stickers || typeof stickers.remove !== "function") {
          throw new RequestError(503, "表情库模块不可用", "STICKERS_UNAVAILABLE");
        }
        let id;
        try {
          id = decodeURIComponent(stickerMatch[1]);
        } catch {
          throw new RequestError(400, "表情 ID 无效", "VALIDATION_ERROR");
        }
        const removed = await stickers.remove(id);
        if (!removed) throw new RequestError(404, "表情不存在", "STICKER_NOT_FOUND");
        sendJson(res, 200, { ok: true, id });
        return;
      }

      if (route === "/api/config" && req.method === "GET") {
        sendJson(res, 200, publicConfig(await getConfig()));
        return;
      }

      if (route === "/api/config" && req.method === "POST") {
        const patch = await readJsonBody(req);
        if (!plainObject(patch)) {
          throw new RequestError(400, "配置更新必须是对象", "VALIDATION_ERROR");
        }
        const saved = await saveConfig(root, patch);
        await configChanged?.(saved);
        sendJson(res, 200, {
          ok: true,
          config: publicConfig(saved),
          transportRestartRequired:
            Object.hasOwn(patch, "qq") || Object.hasOwn(patch, "onebot"),
        });
        return;
      }

      if (route === "/api/chat" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!plainObject(body)) {
          throw new RequestError(400, "聊天请求格式错误", "VALIDATION_ERROR");
        }
        const text = requiredText(body.text, "消息");
        const attachments = normalizeChatAttachments(body.attachments);
        const result = await engine.handle({
          id: randomUUID(),
          channel: "local",
          userId: OWNER_ID,
          scope: "private",
          conversationId: OWNER_ID,
          text,
          attachments,
          timestamp: Date.now(),
        });
        sendJson(res, 200, redactSecrets(result));
        return;
      }

      if (route === "/api/memories" && req.method === "GET") {
        const config = await getConfig();
        const requested = requestUrl.searchParams.get("key");
        const key = requested ? parseMemoryKey(requested, config) : ownerMemoryKey(config);
        const storedScopes =
          typeof store.memoryScopes === "function" ? await store.memoryScopes() : [];
        if (key !== ownerMemoryKey(config) && !storedScopes.includes(key)) {
          throw new RequestError(404, "记忆范围不存在", "MEMORY_SCOPE_NOT_FOUND");
        }
        const [memories, scopes] = await Promise.all([
          store.memories(key),
          memoryScopesWithMeta(store, config),
        ]);
        const scope = parseMemoryScopeKey(key);
        sendJson(res, 200, {
          memories,
          owner: OWNER_ID,
          key,
          scope: { ...scope, label: memoryScopeLabel(scope) },
          scopes,
          count: memories.length,
          enabled: config.memory?.enabled !== false,
          autoExtract: config.memory?.autoExtract !== false,
          minImportance: config.memory?.minImportance ?? 7,
          maxPerKey: config.memory?.maxPerKey ?? 50,
          maxInjected: config.memory?.maxInjected ?? 10,
        });
        return;
      }

      if (route === "/api/memories" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!plainObject(body)) {
          throw new RequestError(400, "记忆格式错误", "VALIDATION_ERROR");
        }
        const config = await getConfig();
        const key = parseMemoryKey(body.key, config);
        const text = requiredText(body.text, "记忆", 2000);
        const type = body.type ?? "fact";
        if (typeof type !== "string" || !MEMORY_TYPE_SET.has(type)) {
          throw new RequestError(400, "记忆类型无效", "VALIDATION_ERROR");
        }
        const importance = body.importance ?? 8;
        if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
          throw new RequestError(400, "记忆重要度必须是 1..10 的整数", "VALIDATION_ERROR");
        }
        const memory = await store.remember(key, text, {
          type,
          importance,
          source: "manual",
          maxMemories: config.memory?.maxPerKey ?? 50,
        });
        sendJson(res, 201, { ok: true, key, memory });
        return;
      }

      if (route === "/api/memories" && req.method === "DELETE") {
        const config = await getConfig();
        const key = parseMemoryKey(requestUrl.searchParams.get("key"), config);
        if (typeof store.clearMemories !== "function") {
          throw new RequestError(503, "记忆清空功能不可用", "MEMORY_UNAVAILABLE");
        }
        const removed = await store.clearMemories(key);
        const scope = parseMemoryScopeKey(key);
        if (userUnderstanding && typeof userUnderstanding.clearUser === "function") {
          for (const event of understandingEventsForMemoryScope(scope, config)) {
            await userUnderstanding.clearUser(event);
          }
        }
        sendJson(res, 200, { ok: true, key, removed });
        return;
      }

      const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(route);
      if (memoryMatch && req.method === "DELETE") {
        let id;
        try {
          id = decodeURIComponent(memoryMatch[1]);
        } catch {
          throw new RequestError(400, "记忆 ID 无效", "VALIDATION_ERROR");
        }
        const config = await getConfig();
        const key = parseMemoryKey(requestUrl.searchParams.get("key"), config);
        const removed = await store.forget(key, id);
        sendJson(
          res,
          removed ? 200 : 404,
          removed ? { ok: true, key } : { error: "记忆不存在", code: "MEMORY_NOT_FOUND" },
        );
        return;
      }

      if (route === "/api/export" && req.method === "GET") {
        const data = await store.exportData();
        sendJson(res, 200, data, {
          "content-disposition": 'attachment; filename="xiaoyu-export.json"',
        });
        return;
      }

      if (route === "/api/import" && req.method === "POST") {
        const body = await readJsonBody(req, MAX_IMPORT_BYTES);
        const imported = plainObject(body) && plainObject(body.data) ? body.data : body;
        const result = await store.importData(imported);
        await conversationState?.resetAll?.();
        await userUnderstanding?.resetAll?.();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (route === "/api/backup" && req.method === "POST") {
        const backupPath = await store.backup();
        sendJson(res, 200, { ok: true, backupPath });
        return;
      }

      if (route === "/api/qzone/comments/status" && req.method === "GET") {
        if (!qzoneComments || typeof qzoneComments.status !== "function") {
          throw new RequestError(503, "空间评论模块不可用", "QZONE_COMMENTS_UNAVAILABLE");
        }
        sendJson(res, 200, { ok: true, ...qzoneComments.status() });
        return;
      }

      if (route === "/api/qzone/comments/poll" && req.method === "POST") {
        if (!qzoneComments || typeof qzoneComments.pollNow !== "function") {
          throw new RequestError(503, "空间评论模块不可用", "QZONE_COMMENTS_UNAVAILABLE");
        }
        const result = await qzoneComments.pollNow({ manual: true });
        sendJson(res, 200, {
          ok: result?.ok !== false,
          result,
          status: qzoneComments.status(),
        });
        return;
      }

      if (route === "/api/qzone/login" && req.method === "POST") {
        if (!qzone || typeof qzone.login !== "function") {
          throw new RequestError(503, "QQ 空间模块不可用", "QZONE_UNAVAILABLE");
        }
        sendJson(res, 200, await qzone.login());
        return;
      }

      if (route === "/api/qzone/publish" && req.method === "POST") {
        if (!qzone || typeof qzone.publish !== "function") {
          throw new RequestError(503, "QQ 空间模块不可用", "QZONE_UNAVAILABLE");
        }
        const body = await readJsonBody(req);
        if (!plainObject(body)) {
          throw new RequestError(400, "空间发布请求格式错误", "VALIDATION_ERROR");
        }
        const text = requiredText(body.text, "空间正文", 5000);
        const images = normalizeHttpsImages(body.images);
        const ugcRight = Number(body.ugcRight ?? body.ugc_right ?? 4);
        if (![1, 4, 16, 64, 128].includes(ugcRight)) {
          throw new RequestError(400, "可见范围无效", "VALIDATION_ERROR");
        }
        const result = await qzone.publish(text, {
          images,
          ugc_right: ugcRight,
          target_uins: normalizeTargetUins(body.targetUins ?? body.target_uins),
        });
        sendJson(res, 200, result);
        return;
      }

      if (route === "/api/reconnect" && req.method === "POST") {
        if (typeof reconnect !== "function") {
          throw new RequestError(503, "重连服务不可用", "RECONNECT_UNAVAILABLE");
        }
        sendJson(res, 200, { ok: true, ...(await reconnect()) });
        return;
      }

      if (route === "/api/pause" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!plainObject(body) || typeof body.paused !== "boolean") {
          throw new RequestError(400, "paused 必须是布尔值", "VALIDATION_ERROR");
        }
        const saved = await saveConfig(root, { policy: { paused: body.paused } });
        await configChanged?.(saved, { policyOnly: true });
        sendJson(res, 200, { ok: true, paused: saved.policy.paused });
        return;
      }

      throw new RequestError(404, "接口不存在", "NOT_FOUND");
    } catch (error) {
      const safe = asSafeError(error);
      if (safe.status >= 500) {
        try {
          logger?.error?.("HTTP request failed", redactSecrets(String(error?.message ?? error)));
        } catch {
          // Logging must not affect the response.
        }
      }
      sendJson(res, safe.status, safe.payload);
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  Object.defineProperty(server, "consoleToken", {
    configurable: false,
    enumerable: false,
    value: token,
    writable: false,
  });
  return server;
}

function normalizeTargetUins(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new RequestError(400, "targetUins 必须是数组", "VALIDATION_ERROR");
  }
  return value.map((item) => {
    const text = String(item ?? "").trim();
    if (!text || text.length > 64) {
      throw new RequestError(400, "targetUins 包含无效值", "VALIDATION_ERROR");
    }
    return text;
  });
}

export async function listenLocal(server, port = 3210) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return server.address();
}
