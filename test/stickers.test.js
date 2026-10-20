import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chat as aiChat } from "../src/ai.js";
import { bodyFromOneBotReply, parseOneBotMessage } from "../src/adapters/shared.js";
import { defaultConfig } from "../src/config.js";
import { StickerLibrary } from "../src/stickers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xQAAAAASUVORK5CYII=",
  "base64",
);
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function config(overrides = {}) {
  const value = structuredClone(defaultConfig);
  value.ai.apiKey = "test-key";
  value.demo = false;
  value.policy.paused = false;
  value.stickers = { ...value.stickers, ...(overrides.stickers ?? {}) };
  return value;
}

test("sticker defaults use the relaxed caps and thresholds", () => {
  assert.equal(defaultConfig.stickers.maxItems, 1000);
  assert.equal(defaultConfig.stickers.minCuteScore, 0.6);
  assert.equal(defaultConfig.stickers.minInterestingScore, 0.75);
  assert.equal(defaultConfig.stickers.proactiveCooldownMinutes, 5);
  for (const key of [
    "maxClassificationsPerHour",
    "maxSendsPerHourPrivate",
    "maxSendsPerHourGroup",
    "maxSendsPerDayPrivate",
    "maxSendsPerDayGroup",
    "minMessagesBetweenSendsPrivate",
    "minMessagesBetweenSendsGroup",
    "firstRepliesWithoutSticker",
  ]) {
    assert.equal(Object.hasOwn(defaultConfig.stickers, key), false);
  }
});

function stickerEvent(overrides = {}) {
  const file = `${"a".repeat(32)}.png`;
  return {
    id: `sticker-${Math.random()}`,
    channel: "onebot",
    scope: "private",
    userId: "10001",
    conversationId: "10001",
    text: "",
    timestamp: Date.now(),
    attachments: [
      {
        type: "image",
        url: "https://93.184.216.34/sticker.png",
        file,
        summary: "[动画表情]",
        subType: 1,
      },
    ],
    ...overrides,
  };
}

function cuteReview(overrides = {}) {
  return {
    safe: true,
    category: "cute",
    cuteness: 0.92,
    interestingness: 0.3,
    summary: "可爱的猫猫",
    tags: ["可爱", "猫猫"],
    reason: "很可爱",
    ...overrides,
  };
}

async function fixture(t, { chat, fetchImpl, now } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "qqbot-stickers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const replies = [];
  const library = new StickerLibrary({
    root,
    getConfig: async () => config(),
    logger,
    chat:
      chat ??
      (async () => {
        replies.push(cuteReview());
        return { content: JSON.stringify(cuteReview()) };
      }),
    fetchImpl:
      fetchImpl ??
      (async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })),
    now: now ?? (() => new Date("2026-10-19T12:00:00.000Z")),
    random: () => 0.5,
  });
  await library.init();
  return { root, library };
}

test("collects a cute sticker once and stores its summary and file", async (t) => {
  let chatCalls = 0;
  const { root, library } = await fixture(t, {
    chat: async () => {
      chatCalls += 1;
      return { content: JSON.stringify(cuteReview()) };
    },
  });
  const event = stickerEvent();
  const first = await library.observe(event, config());
  assert.equal(first.saved, true);
  assert.equal(chatCalls, 1);

  const index = JSON.parse(
    await readFile(path.join(root, "data", "stickers", "index.json"), "utf8"),
  );
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].summary, "可爱的猫猫");
  assert.deepEqual(index.items[0].tags, ["可爱", "猫猫"]);
  assert.equal(index.items[0].category, "cute");
  assert.equal(index.items[0].file.endsWith(".png"), true);
  assert.deepEqual(
    await readFile(path.join(root, "data", "stickers", "files", index.items[0].file)),
    PNG,
  );

  const second = await library.observe(event, config());
  assert.equal(second.saved, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(chatCalls, 1);
});

test("rejects less cute stickers and never classifies the same sticker again", async (t) => {
  let chatCalls = 0;
  const { root, library } = await fixture(t, {
    chat: async () => {
      chatCalls += 1;
      return { content: JSON.stringify(cuteReview({ cuteness: 0.5 })) };
    },
  });
  const event = stickerEvent();
  const result = await library.observe(event, config());
  assert.equal(result.saved, false);
  assert.equal(result.reason, "below_threshold");
  assert.equal(chatCalls, 1);

  const rejected = JSON.parse(
    await readFile(path.join(root, "data", "stickers", "rejected.json"), "utf8"),
  );
  assert.equal(rejected.items.length, 1);

  const again = await library.observe(event, config());
  assert.equal(again.reason, "duplicate");
  assert.equal(chatCalls, 1);
});

test("legacy hourly classification limits are ignored", async (t) => {
  const { library } = await fixture(t);
  const result = await library.observe(
    stickerEvent(),
    config({ stickers: { maxClassificationsPerHour: 0 } }),
  );
  assert.equal(result.saved, true);
});

test("uses the configured interestingness threshold for non-cute stickers", async (t) => {
  const low = await fixture(t, {
    chat: async () => ({
      content: JSON.stringify(
        cuteReview({ category: "interesting", interestingness: 0.74, summary: "奇怪的梗图" }),
      ),
    }),
  });
  const lowResult = await low.library.observe(stickerEvent(), config());
  assert.equal(lowResult.saved, false);
  assert.equal(lowResult.reason, "below_threshold");

  const high = await fixture(t, {
    chat: async () => ({
      content: JSON.stringify(
        cuteReview({ category: "interesting", interestingness: 0.76, summary: "很妙的梗图" }),
      ),
    }),
  });
  const highResult = await high.library.observe(stickerEvent(), config());
  assert.equal(highResult.saved, true);
});

test("does not save unsafe stickers", async (t) => {
  const { library } = await fixture(t, {
    chat: async () => ({
      content: JSON.stringify(cuteReview({ safe: false, summary: "不合适的图" })),
    }),
  });
  const result = await library.observe(stickerEvent(), config());
  assert.equal(result.saved, false);
  assert.equal(result.reason, "unsafe");
});

function claimConfig(overrides = {}) {
  return config({ stickers: overrides });
}

async function collectOne(library) {
  const result = await library.observe(stickerEvent(), claimConfig());
  assert.equal(result.saved, true);
  return result;
}

test("sending has no hard frequency limits", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);

  const first = await library.claim({
    conversationKey: "private-key",
    config: claimConfig(),
  });
  assert.equal(first.ok, true);
  assert.match(first.dataUrl, /^data:image\/png;base64,/);

  const immediately = await library.claim({
    conversationKey: "private-key",
    config: claimConfig(),
  });
  assert.equal(immediately.ok, true);

  const group = await library.claim({
    conversationKey: "group-key",
    config: claimConfig(),
  });
  assert.equal(group.ok, true);
  assert.equal(library.index.items[0].useCount, 3);
});

test("explicit sticker requests fall back when the mood does not match", async (t) => {
  const { root, library } = await fixture(t);
  await collectOne(library);
  const result = await library.claim({
    conversationKey: "explicit-key",
    explicit: true,
    mood: "不存在的标签",
    config: config(),
  });
  assert.equal(result.ok, true);
  assert.match(result.dataUrl, /^data:image\/png;base64,/);

  const usage = JSON.parse(
    await readFile(path.join(root, "data", "stickers", "usage.json"), "utf8"),
  );
  assert.equal(usage.conversations["explicit-key"].sent.length, 1);
});

test("force claim keeps master safety checks", async (t) => {
  const { root, library } = await fixture(t);
  await collectOne(library);
  const key = "force-key";

  const forced = await library.claim({
    conversationKey: key,
    force: true,
    mood: "不存在的心情",
    config: claimConfig(),
  });
  assert.equal(forced.ok, true);
  assert.match(forced.dataUrl, /^data:image\/png;base64,/);

  const usage = JSON.parse(
    await readFile(path.join(root, "data", "stickers", "usage.json"), "utf8"),
  );
  assert.equal(usage.conversations[key].sent.length, 1);
  assert.equal(library.index.items[0].useCount, 1);

  const disabled = await library.claim({
    conversationKey: key,
    force: true,
    config: config({ stickers: { enabled: false } }),
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, "disabled");

  const paused = config();
  paused.policy.paused = true;
  const pausedResult = await library.claim({
    conversationKey: key,
    force: true,
    config: paused,
  });
  assert.equal(pausedResult.ok, false);
  assert.equal(pausedResult.reason, "paused");

  const emptyRoot = await fixture(t);
  const empty = await emptyRoot.library.claim({
    conversationKey: "empty-key",
    force: true,
    config: claimConfig(),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");
});

test("legacy frequency settings no longer block sends", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  const settings = claimConfig({
    firstRepliesWithoutSticker: 999,
    minMessagesBetweenSendsPrivate: 999,
    maxSendsPerHourPrivate: 0,
    maxSendsPerDayPrivate: 0,
  });

  for (let index = 0; index < 3; index += 1) {
    const result = await library.claim({
      conversationKey: "legacy-key",
      config: settings,
    });
    assert.equal(result.ok, true);
  }
});

test("rejects a tampered sticker path", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  library.index.items[0].file = "../config.json";
  const result = await library.claim({
    conversationKey: "path-key",
    config: claimConfig(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_file");
});

test("catalog exposes saved tags for the model", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  const catalog = await library.catalog();
  assert.equal(catalog.count, 1);
  assert.deepEqual([...catalog.tags].sort(), ["可爱", "猫猫"].sort());
});

test("allTags returns every unique tag while catalog stays capped", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  for (let index = 1; index <= 25; index += 1) {
    library.index.items.push({
      id: `st_extra_${index}`,
      tags: [`标签${index}`, "可爱"],
    });
  }
  const all = await library.allTags();
  assert.equal(all.count, 26);
  assert.equal(all.tags.includes("标签25"), true);
  assert.equal(all.tags.length, 27);
  const catalog = await library.catalog();
  assert.equal(catalog.tags.length, 20);
});

test("updateTags replaces saved tags and persists them", async (t) => {
  const { root, library } = await fixture(t);
  await collectOne(library);
  const id = library.index.items[0].id;
  const updated = await library.updateTags(id, [" 开心 ", "开心", "猫猫", "", "  "]);
  assert.deepEqual(updated.tags, ["开心", "猫猫"]);
  const index = JSON.parse(
    await readFile(path.join(root, "data", "stickers", "index.json"), "utf8"),
  );
  assert.deepEqual(index.items[0].tags, ["开心", "猫猫"]);
  assert.equal(await library.updateTags("st_missing", ["开心"]), null);
  assert.equal(await library.updateTags("../bad", ["开心"]), null);
});

test("tracks the last sticker time and describes known incoming stickers", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  const event = stickerEvent();
  const described = await library.describeEvent(event);
  assert.equal(described.known, true);
  assert.equal(described.summary, "可爱的猫猫");
  assert.deepEqual(described.tags, ["可爱", "猫猫"]);
  assert.equal(described.imageUrl, event.attachments[0].url);

  assert.equal(await library.lastStickerAt("known-key"), null);
  await library.claim({ conversationKey: "known-key", config: claimConfig() });
  assert.equal(
    await library.lastStickerAt("known-key"),
    "2026-10-19T12:00:00.000Z",
  );
});

test("sticker replies may fall back to any sticker when the mood misses", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  library.index.items[0].category = "interesting";

  const noFallback = await library.claim({
    conversationKey: "fallback-key",
    mood: "不存在的标签",
    config: claimConfig(),
  });
  assert.equal(noFallback.ok, false);
  assert.equal(noFallback.reason, "no_match");

  const fallback = await library.claim({
    conversationKey: "fallback-key",
    mood: "不存在的标签",
    allowFallback: true,
    config: claimConfig(),
  });
  assert.equal(fallback.ok, true);
});

test("public list omits file paths and hashes", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  const listed = await library.listPublic();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].contentType, "image/png");
  assert.equal(Object.hasOwn(listed[0], "file"), false);
  assert.equal(Object.hasOwn(listed[0], "sha256"), false);
  assert.equal(Object.hasOwn(listed[0], "sourceKey"), false);
});

test("fileFor resolves only library files and remove deletes both index and file", async (t) => {
  const { library } = await fixture(t);
  await collectOne(library);
  const id = library.index.items[0].id;
  const found = await library.fileFor(id);
  assert.ok(found);
  assert.deepEqual(await readFile(found.filePath), PNG);

  library.index.items[0].file = "../config.json";
  assert.equal(await library.fileFor(id), null);
  library.index.items[0].file = `${id}.png`;

  assert.equal(await library.remove(id), true);
  assert.equal(await library.fileFor(id), null);
  assert.equal(library.index.items.length, 0);
  await assert.rejects(readFile(found.filePath), { code: "ENOENT" });
});

test("manual uploads are stored without AI review and deduplicated", async (t) => {
  const { library } = await fixture(t);
  const result = await library.addUploaded({
    bytes: PNG,
    fileName: "cute.png",
    summary: "手动上传的猫猫",
    tags: ["可爱", "测试"],
    category: "interesting",
    config: config(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.category, "interesting");
  assert.equal(result.entry.cuteness, 0.5);
  assert.equal(result.entry.interestingness, 1);

  const listed = await library.listPublic();
  assert.equal(listed[0].summary, "手动上传的猫猫");
  assert.deepEqual(listed[0].tags, ["可爱", "测试"]);

  const duplicate = await library.addUploaded({
    bytes: PNG,
    fileName: "cute-again.png",
    summary: "重复",
    tags: [],
    category: "cute",
    config: config(),
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "duplicate");

  const unsupported = await library.addUploaded({
    bytes: Buffer.from("not an image"),
    fileName: "bad.txt",
    summary: "",
    tags: [],
    category: "cute",
    config: config(),
  });
  assert.equal(unsupported.reason, "unsupported_type");

  const tooLarge = await library.addUploaded({
    bytes: Buffer.alloc(2048, 1),
    fileName: "big.png",
    summary: "",
    tags: [],
    category: "cute",
    config: config({ stickers: { maxFileSizeBytes: 1024 } }),
  });
  assert.equal(tooLarge.reason, "too_large");
});

test("OneBot keeps sticker metadata on image attachments", () => {
  const parsed = parseOneBotMessage([
    {
      type: "image",
      data: {
        file: `${"b".repeat(32)}.png`,
        url: "https://example.com/a.png",
        summary: "[动画表情]",
        sub_type: 1,
      },
    },
  ]);
  assert.deepEqual(parsed.attachments, [
    {
      type: "image",
      url: "https://example.com/a.png",
      file: `${"b".repeat(32)}.png`,
      summary: "[动画表情]",
      subType: 1,
    },
  ]);
});

test("OneBot exposes market faces to the model without trying to download them", () => {
  const parsed = parseOneBotMessage([
    {
      type: "mface",
      data: {
        emoji_package_id: 123,
        emoji_id: "abc",
        key: "secret-key",
        summary: "[表情包]",
      },
    },
  ]);
  assert.match(parsed.text, /表情包/);
  assert.deepEqual(parsed.attachments, [
    {
      type: "mface",
      summary: "[表情包]",
      emojiPackageId: 123,
      emojiId: "abc",
      key: "secret-key",
    },
  ]);
});

test("OneBot reply carries inline sticker data URLs as image segments", () => {
  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
  assert.deepEqual(bodyFromOneBotReply({ text: "", images: [dataUrl] }), [
    { type: "image", data: { file: dataUrl } },
  ]);
});

test("AI accepts inline data images for internal sticker review", async () => {
  let request;
  const result = await aiChat({
    config: {
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      model: "deepseek-flash",
      temperature: 0.2,
    },
    messages: [{ role: "user", content: "描述这张图" }],
    imageUrls: [`data:image/png;base64,${PNG.toString("base64")}`],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "一只猫" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(result.content, "一只猫");
  const body = JSON.parse(request.options.body);
  assert.equal(body.messages[0].content[1].type, "image_url");
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});
