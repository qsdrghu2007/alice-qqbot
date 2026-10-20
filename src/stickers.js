import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { chat as defaultChat } from "./ai.js";

const INDEX_VERSION = 1;
const MAX_REJECTED = 500;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 16;
const MAX_SUMMARY_LENGTH = 240;
const MAX_REDIRECTS = 3;
const MAX_SENT_HISTORY = 100;

const DEFAULT_STICKER_CONFIG = Object.freeze({
  enabled: true,
  autoCollect: true,
  maxItems: 1000,
  maxFileSizeBytes: 4 * 1024 * 1024,
  minCuteScore: 0.6,
  minInterestingScore: 0.75,
  proactiveCooldownMinutes: 5,
});

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const tag = String(item ?? "")
      .trim()
      .replace(/\s+/gu, " ")
      .slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function normalizeSummary(value, fallback) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ");
  return (text || fallback).slice(0, MAX_SUMMARY_LENGTH);
}

function parseJsonObject(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  const unfenced = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  for (const candidate of [unfenced, source]) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function detectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  const gif = bytes.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { ext: "gif", mime: "image/gif" };
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

function mimeForFile(file) {
  switch (path.extname(String(file ?? "")).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

function isStickerAttachment(attachment) {
  if (!isPlainObject(attachment)) return false;
  if (attachment.type !== "image") return false;
  const subType = Number(attachment.subType ?? attachment.sub_type ?? 0);
  if (subType === 1) return true;
  return /动画表情|表情包|贴纸/u.test(String(attachment.summary ?? ""));
}

function isStickerLikeAttachment(attachment) {
  return isPlainObject(attachment) &&
    (attachment.type === "mface" || isStickerAttachment(attachment));
}

function sourceKeyFor(attachment) {
  const file = path.basename(String(attachment?.file ?? ""));
  const match = /^([a-f0-9]{32})(?:\.[a-z0-9]+)?$/iu.exec(file);
  return match ? `md5:${match[1].toLowerCase()}` : null;
}

function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

async function assertPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("表情图片地址无效");
  }
  if (url.protocol !== "https:") {
    throw new TypeError("表情图片只允许 HTTPS 地址");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new TypeError("表情图片地址不允许指向本机");
  }
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname }];
  } else {
    addresses = await lookup(hostname, { all: true });
  }
  if (!addresses.length) throw new TypeError("表情图片域名无法解析");
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw new TypeError("表情图片地址不允许指向内网");
  }
  return url;
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new TypeError("表情图片过大");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TypeError("表情图片过大");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures.
    }
  }
  return Buffer.concat(chunks);
}

async function fetchImageBytes(urlValue, { fetchImpl, maxBytes, timeoutMs = 20_000 }) {
  if (typeof fetchImpl !== "function") throw new TypeError("当前环境不支持网络请求");
  let current = String(urlValue);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttpsUrl(current);
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new TypeError("表情图片重定向缺少地址");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new TypeError(`表情图片下载失败（HTTP ${response.status}）`);
    const buffer = await readLimitedBody(response, maxBytes);
    if (!buffer.length) throw new TypeError("表情图片为空");
    return buffer;
  }
  throw new TypeError("表情图片重定向次数过多");
}

async function atomicWriteJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporary = `${file}.${suffix}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export class StickerLibrary {
  constructor({
    root,
    getConfig,
    logger = console,
    chat = defaultChat,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    random = Math.random,
  } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("root 必须是非空路径");
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (typeof chat !== "function") throw new TypeError("chat 必须是函数");

    this.root = path.resolve(root);
    this.getConfig = getConfig;
    this.logger = logger;
    this.chat = chat;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.dir = path.join(this.root, "data", "stickers");
    this.filesDir = path.join(this.dir, "files");
    this.indexPath = path.join(this.dir, "index.json");
    this.rejectedPath = path.join(this.dir, "rejected.json");
    this.usagePath = path.join(this.dir, "usage.json");
    this.index = { version: INDEX_VERSION, items: [] };
    this.rejected = { version: INDEX_VERSION, items: [] };
    this.usage = { version: INDEX_VERSION, conversations: {} };
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(this.filesDir, { recursive: true });
    this.index = await this.#readState(this.indexPath, (data) => {
      if (!isPlainObject(data) || !Array.isArray(data.items)) return null;
      return {
        version: INDEX_VERSION,
        items: data.items.filter(
          (item) =>
            isPlainObject(item) &&
            typeof item.id === "string" &&
            typeof item.file === "string" &&
            typeof item.summary === "string",
        ),
      };
    });
    this.rejected = await this.#readState(this.rejectedPath, (data) => {
      if (!isPlainObject(data) || !Array.isArray(data.items)) return null;
      return { version: INDEX_VERSION, items: data.items.filter(isPlainObject) };
    });
    this.usage = await this.#readState(this.usagePath, (data) => {
      if (!isPlainObject(data)) return null;
      return {
        version: INDEX_VERSION,
        conversations: isPlainObject(data.conversations) ? data.conversations : {},
      };
    });
    this.initialized = true;
    return this;
  }

  async #readState(file, normalize) {
    try {
      const parsed = await readJson(file);
      if (parsed === null) {
        return normalize({}) ?? { version: INDEX_VERSION, items: [] };
      }
      const normalized = normalize(parsed);
      if (normalized) return normalized;
      throw new TypeError("文件格式无效");
    } catch (error) {
      try {
        await rename(file, `${file}.broken-${Date.now()}`);
      } catch {
        // Missing or locked file; start empty.
      }
      this.logger?.warn?.(`[stickers] 状态文件无效，已重新开始：${path.basename(file)}`);
      return file === this.usagePath
        ? { version: INDEX_VERSION, conversations: {} }
        : { version: INDEX_VERSION, items: [] };
    }
  }

  #serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #config(config) {
    const raw = config?.stickers ?? {};
    return {
      ...DEFAULT_STICKER_CONFIG,
      ...(isPlainObject(raw) ? raw : {}),
    };
  }

  isStickerEvent(event) {
    return (
      Array.isArray(event?.attachments) &&
      event.attachments.some(
        (attachment) => attachment?.type === "mface" || isStickerAttachment(attachment),
      )
    );
  }

  #tagCounts() {
    const counts = new Map();
    for (const item of this.index.items) {
      for (const tag of Array.isArray(item.tags) ? item.tags : []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }

  async catalog() {
    await this.init();
    const tags = [...this.#tagCounts().entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .slice(0, 20)
      .map(([tag]) => tag);
    return {
      count: this.index.items.length,
      tags,
      samples: this.index.items.slice(-5).map((item) => item.summary),
    };
  }

  async allTags() {
    await this.init();
    const tags = [...this.#tagCounts().entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .map(([tag]) => tag);
    return {
      count: this.index.items.length,
      tags,
    };
  }

  async list() {
    await this.init();
    return this.index.items.map((item) => ({ ...item }));
  }

  async listPublic() {
    await this.init();
    return this.index.items
      .map((item) => ({
        id: item.id,
        summary: item.summary,
        tags: Array.isArray(item.tags) ? [...item.tags] : [],
        category: item.category,
        cuteness: item.cuteness,
        interestingness: item.interestingness,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        useCount: item.useCount,
        size: item.size,
        contentType: mimeForFile(item.file),
      }))
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  }

  async lastStickerAt(conversationKey) {
    await this.init();
    if (typeof conversationKey !== "string" || !conversationKey) return null;
    const value = this.usage.conversations?.[conversationKey]?.lastStickerAt;
    return typeof value === "string" ? value : null;
  }

  async describeEvent(event) {
    await this.init();
    const attachment = (Array.isArray(event?.attachments) ? event.attachments : []).find(
      isStickerLikeAttachment,
    );
    if (!attachment) return null;
    const sourceKey = sourceKeyFor(attachment);
    const known = sourceKey
      ? this.index.items.find((item) => item.sourceKey === sourceKey)
      : null;
    const summary =
      (known ? known.summary : String(attachment.summary ?? "").trim()) || "";
    const tags = known && Array.isArray(known.tags) ? [...known.tags] : [];
    const imageUrl =
      typeof attachment.url === "string" && /^https:\/\//iu.test(attachment.url)
        ? attachment.url
        : "";
    return {
      summary,
      tags,
      imageUrl,
      known: Boolean(known),
    };
  }

  async fileFor(id) {
    await this.init();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(id)) return null;
    const entry = this.index.items.find((item) => item.id === id);
    if (!entry) return null;
    const filePath = path.resolve(this.filesDir, entry.file);
    if (!filePath.startsWith(`${this.filesDir}${path.sep}`)) return null;
    return { entry, filePath, contentType: mimeForFile(entry.file) };
  }

  async remove(id) {
    await this.init();
    return this.#serialize(async () => {
      const index = this.index.items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      const entry = this.index.items[index];
      const next = {
        ...this.index,
        items: this.index.items.filter((item) => item.id !== id),
      };
      await atomicWriteJson(this.indexPath, next);
      this.index = next;
      const filePath = path.resolve(this.filesDir, entry.file);
      if (filePath.startsWith(`${this.filesDir}${path.sep}`)) {
        await rm(filePath, { force: true }).catch(() => {});
      }
      return true;
    });
  }

  async updateTags(id, tags) {
    await this.init();
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(id)) return null;
    return this.#serialize(async () => {
      const entry = this.index.items.find((item) => item.id === id);
      if (!entry) return null;
      const nextTags = normalizeTags(tags);
      const next = {
        ...this.index,
        items: this.index.items.map((item) =>
          item.id === id ? { ...item, tags: nextTags } : item,
        ),
      };
      await atomicWriteJson(this.indexPath, next);
      this.index = next;
      return { id, tags: [...nextTags] };
    });
  }

  async addUploaded({ bytes, fileName, summary, tags, category, config }) {
    await this.init();
    return this.#serialize(async () => {
      const settings = this.#config(config);
      if (this.index.items.length >= settings.maxItems) {
        return { ok: false, reason: "library_full" };
      }
      if (!Buffer.isBuffer(bytes) || !bytes.length) {
        return { ok: false, reason: "empty_file" };
      }
      if (bytes.length > settings.maxFileSizeBytes) {
        return { ok: false, reason: "too_large" };
      }
      const image = detectImage(bytes);
      if (!image) return { ok: false, reason: "unsupported_type" };

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (this.index.items.some((item) => item.sha256 === sha256)) {
        return { ok: false, reason: "duplicate" };
      }

      const id = `st_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const fileNameText = path.basename(String(fileName ?? ""));
      const fallbackSummary =
        fileNameText.replace(/\.[^.]+$/u, "").trim() || "上传的表情包";
      const selectedCategory = category === "interesting" ? "interesting" : "cute";
      const entry = {
        id,
        file: `${id}.${image.ext}`,
        sha256,
        sourceKey: null,
        summary: normalizeSummary(summary, fallbackSummary),
        tags: normalizeTags(tags),
        category: selectedCategory,
        cuteness: selectedCategory === "cute" ? 1 : 0.5,
        interestingness: selectedCategory === "interesting" ? 1 : 0,
        createdAt: this.#nowIso(),
        lastUsedAt: null,
        useCount: 0,
        size: bytes.length,
      };
      try {
        await writeFile(path.join(this.filesDir, entry.file), bytes, {
          mode: 0o600,
          flag: "wx",
        });
        this.index.items.push(entry);
        await this.#saveIndex();
      } catch (error) {
        try {
          await rm(path.join(this.filesDir, entry.file), { force: true });
        } catch {
          // Ignore cleanup failures.
        }
        this.index.items = this.index.items.filter((item) => item.id !== id);
        this.logger?.warn?.(`[stickers] 上传保存失败：${String(error?.message ?? error).slice(0, 160)}`);
        return { ok: false, reason: "save_failed" };
      }
      this.logger?.info?.(`[stickers] 已上传表情：${entry.summary}`);
      return { ok: true, entry };
    });
  }

  async observe(event, config) {
    await this.init();
    const settings = this.#config(config);
    if (!settings.enabled || !settings.autoCollect) return { saved: false, reason: "disabled" };
    if (config?.demo || !config?.ai?.apiKey || config?.policy?.paused) {
      return { saved: false, reason: "unavailable" };
    }
    const attachments = Array.isArray(event?.attachments)
      ? event.attachments.filter(isStickerAttachment)
      : [];
    if (!attachments.length) return { saved: false, reason: "not_sticker" };

    return this.#serialize(() => this.#observeNow(event, attachments[0], config, settings));
  }

  async #observeNow(event, attachment, config, settings) {
    if (this.index.items.length >= settings.maxItems) {
      return { saved: false, reason: "library_full" };
    }

    const sourceKey = sourceKeyFor(attachment);
    if (sourceKey && this.#isKnown(sourceKey, null)) {
      return { saved: false, reason: "duplicate" };
    }
    const url = String(attachment?.url ?? "");
    if (!url) return { saved: false, reason: "missing_url" };

    let bytes;
    try {
      bytes = await fetchImageBytes(url, {
        fetchImpl: this.fetchImpl,
        maxBytes: Math.min(settings.maxFileSizeBytes, 8 * 1024 * 1024),
      });
    } catch (error) {
      this.logger?.debug?.(`[stickers] 下载失败：${String(error?.message ?? error).slice(0, 160)}`);
      return { saved: false, reason: "download_failed" };
    }
    if (bytes.length > settings.maxFileSizeBytes) {
      return { saved: false, reason: "too_large" };
    }
    const image = detectImage(bytes);
    if (!image) return { saved: false, reason: "unsupported_type" };

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (this.#isKnown(sourceKey, sha256)) {
      return { saved: false, reason: "duplicate" };
    }

    let review;
    try {
      review = await this.#classify(bytes, image.mime, config, settings);
    } catch (error) {
      this.logger?.warn?.(`[stickers] 审核失败：${String(error?.message ?? error).slice(0, 160)}`);
      return { saved: false, reason: "classifier_failed" };
    }

    if (!review.save) {
      this.#reject(sourceKey, sha256, review.reason);
      await this.#saveRejected();
      return { saved: false, reason: review.reason };
    }

    const id = `st_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const fileName = `${id}.${image.ext}`;
    const entry = {
      id,
      file: fileName,
      sha256,
      sourceKey,
      summary: review.summary,
      tags: review.tags,
      category: review.category,
      cuteness: review.cuteness,
      interestingness: review.interestingness,
      createdAt: this.#nowIso(),
      lastUsedAt: null,
      useCount: 0,
      size: bytes.length,
    };
    try {
      await writeFile(path.join(this.filesDir, fileName), bytes, {
        mode: 0o600,
        flag: "wx",
      });
      this.index.items.push(entry);
      await this.#saveIndex();
    } catch (error) {
      this.logger?.warn?.(`[stickers] 保存失败：${String(error?.message ?? error).slice(0, 160)}`);
      try {
        await rm(path.join(this.filesDir, fileName), { force: true });
      } catch {
        // Ignore cleanup failures.
      }
      return { saved: false, reason: "save_failed" };
    }
    this.logger?.info?.(`[stickers] 已收藏表情：${entry.summary}`);
    return { saved: true, id: entry.id };
  }

  #isKnown(sourceKey, sha256) {
    if (sourceKey && this.index.items.some((item) => item.sourceKey === sourceKey)) {
      return true;
    }
    if (sha256 && this.index.items.some((item) => item.sha256 === sha256)) {
      return true;
    }
    if (sourceKey && this.rejected.items.some((item) => item.sourceKey === sourceKey)) {
      return true;
    }
    if (sha256 && this.rejected.items.some((item) => item.sha256 === sha256)) {
      return true;
    }
    return false;
  }

  #reject(sourceKey, sha256, reason) {
    this.rejected.items.push({
      sourceKey: sourceKey ?? null,
      sha256: sha256 ?? null,
      reason: String(reason ?? "rejected").slice(0, 80),
      at: this.#nowIso(),
    });
    this.rejected.items = this.rejected.items.slice(-MAX_REJECTED);
  }

  async #classify(bytes, mime, config, settings) {
    const persona = String(config?.persona?.name ?? "Alice").trim() || "Alice";
    const systemPrompt = [
      `你是「${persona}」的表情包收藏评审。`,
      `${persona}喜欢可爱、软萌、温柔、治愈、日常、猫猫/小动物、动漫风和轻微搞笑的表情包。`,
      "你的任务是判断用户发来的这张表情包是否值得永久收藏，标准要克制。",
      "",
      "优先收藏：可爱、软萌、温暖、治愈，并且符合人设。",
      "非可爱类只有“特别有意思”才收藏，标准非常严格：独特、自然、有梗、不冒犯，interestingness 必须很高。",
      "一律不收藏：色情或擦边、暴力血腥、恐怖恶心、政治、仇恨歧视、广告或二维码、截图或文字很多、真人隐私、低清模糊、无意义。",
      "",
      "只返回一个 JSON 对象，不要使用 Markdown 代码块，不要输出其他文字：",
      '{"safe":true,"category":"cute|interesting|none","cuteness":0.0,"interestingness":0.0,"summary":"一句中文描述画面","tags":["可爱","猫猫"],"reason":"简短理由"}',
      "summary 不超过 80 字，tags 为 2-6 个中文关键词。",
    ].join("\n");

    const reply = await this.chat({
      config: { ...config.ai, temperature: 0.2 },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "判断这张表情包是否值得收藏。" },
      ],
      imageUrls: [`data:${mime};base64,${bytes.toString("base64")}`],
      timeoutMs: 25_000,
      fetchImpl: this.fetchImpl,
    });

    const parsed = parseJsonObject(reply?.content ?? "");
    if (!parsed) {
      return {
        save: false,
        reason: "invalid_classifier",
        summary: "一张表情包",
        tags: [],
        category: "none",
        cuteness: 0,
        interestingness: 0,
      };
    }

    const safe = parsed.safe === true;
    const category = ["cute", "interesting", "none"].includes(parsed.category)
      ? parsed.category
      : "none";
    const cuteness = clamp01(parsed.cuteness ?? parsed.score);
    const interestingness = clamp01(parsed.interestingness);
    const summary = normalizeSummary(parsed.summary, "一张表情包");
    const tags = normalizeTags(parsed.tags);
    const save =
      safe &&
      ((category === "cute" && cuteness >= settings.minCuteScore) ||
        (category === "interesting" && interestingness >= settings.minInterestingScore));

    return {
      save,
      category,
      cuteness,
      interestingness,
      summary,
      tags: tags.length ? tags : category === "cute" ? ["可爱"] : ["表情包"],
      reason: save
        ? "saved"
        : safe
          ? "below_threshold"
          : "unsafe",
    };
  }

  async claim({
    conversationKey,
    explicit = false,
    force = false,
    allowFallback = false,
    mood,
    id,
    config,
  }) {
    await this.init();
    return this.#serialize(() =>
      this.#claimNow({
        conversationKey,
        explicit,
        force,
        allowFallback,
        mood,
        id,
        config,
      }),
    );
  }

  #deny(reason, message, extra = {}) {
    this.logger?.debug?.(`[stickers] 未发送：${reason}`);
    return { ok: false, reason, message, ...extra };
  }

  async #claimNow({
    conversationKey,
    explicit,
    force,
    allowFallback,
    mood,
    id,
    config,
  }) {
    const settings = this.#config(config);
    if (!settings.enabled) return this.#deny("disabled", "表情库已关闭");
    if (!this.index.items.length) return this.#deny("empty", "表情库还是空的");
    if (config?.policy?.paused) return this.#deny("paused", "当前已暂停");

    const usage = this.#conversationUsage(conversationKey);

    let entry = this.#select({ id, mood });
    if (!entry && (explicit || force || allowFallback)) entry = this.#select({});
    if (!entry) {
      return this.#deny("no_match", "没有找到合适的表情", {
        tags: (await this.allTags()).tags,
      });
    }

    const fullPath = path.resolve(this.filesDir, entry.file);
    if (!fullPath.startsWith(`${this.filesDir}${path.sep}`)) {
      return this.#deny("invalid_file", "表情文件路径无效");
    }
    let bytes;
    try {
      bytes = await readFile(fullPath);
    } catch {
      return this.#deny("missing_file", "表情文件不存在");
    }

    entry.useCount = Number(entry.useCount ?? 0) + 1;
    entry.lastUsedAt = this.#nowIso();
    usage.sent = [...usage.sent, entry.lastUsedAt].slice(-MAX_SENT_HISTORY);
    usage.lastStickerAt = entry.lastUsedAt;
    this.usage.conversations[conversationKey] = usage;
    await Promise.allSettled([this.#saveIndex(), this.#saveUsage()]);

    return {
      ok: true,
      entry: {
        id: entry.id,
        summary: entry.summary,
        tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
      },
      dataUrl: `data:${mimeForFile(entry.file)};base64,${bytes.toString("base64")}`,
    };
  }

  #select({ id, mood }) {
    const items = this.index.items;
    if (id) {
      const wanted = String(id).trim();
      return items.find((item) => item.id === wanted) ?? null;
    }

    const query = String(mood ?? "").trim().toLowerCase();
    if (query) {
      const scored = items
        .map((item) => {
          const tags = (Array.isArray(item.tags) ? item.tags : []).map((tag) =>
            String(tag).toLowerCase(),
          );
          const summary = String(item.summary ?? "").toLowerCase();
          let score = 0;
          if (tags.includes(query)) score += 6;
          if (tags.some((tag) => tag.includes(query) || query.includes(tag))) score += 3;
          if (summary.includes(query)) score += 2;
          if (item.category === "cute") score += 0.5;
          score -= Math.min(2, Number(item.useCount ?? 0) * 0.05);
          return { item, score };
        })
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(a.item.useCount ?? 0) - Number(b.item.useCount ?? 0) ||
            this.random() - 0.5,
        );
      return scored[0]?.item ?? null;
    }

    const weights = items.map((item) => {
      const useCount = Number(item.useCount ?? 0);
      return Math.max(0.2, (item.category === "cute" ? 1.6 : 1) / (useCount + 1));
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    let target = this.random() * total;
    for (let index = 0; index < items.length; index += 1) {
      target -= weights[index];
      if (target <= 0) return items[index];
    }
    return items.at(-1) ?? null;
  }

  #conversationUsage(conversationKey) {
    const existing = this.usage.conversations?.[conversationKey];
    return {
      sent: Array.isArray(existing?.sent)
        ? existing.sent.filter((value) => typeof value === "string")
        : [],
      lastStickerAt:
        typeof existing?.lastStickerAt === "string" ? existing.lastStickerAt : null,
    };
  }

  async #saveIndex() {
    await atomicWriteJson(this.indexPath, this.index);
  }

  async #saveRejected() {
    await atomicWriteJson(this.rejectedPath, this.rejected);
  }

  async #saveUsage() {
    await atomicWriteJson(this.usagePath, this.usage);
  }

  #nowIso() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("clock returned invalid date");
    return date.toISOString();
  }

  async stop() {
    await this.queue.catch(() => {});
    return this.status();
  }

  status() {
    return {
      count: this.index.items.length,
      rejected: this.rejected.items.length,
      conversations: Object.keys(this.usage.conversations ?? {}).length,
    };
  }
}
