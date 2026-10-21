import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeStyleFlags } from "./conversation-style.js";

export const SHORT_EMOTION_LABELS = Object.freeze([
  "neutral",
  "warm",
  "playful",
  "tired",
  "annoyed",
  "curious",
  "concerned",
]);

export const USER_EMOTION_LABELS = Object.freeze([
  "neutral",
  "happy",
  "excited",
  "sad",
  "hurt",
  "anxious",
  "angry",
  "tired",
  "confused",
]);

export const GLOBAL_EMOTION_LABELS = Object.freeze([
  "calm",
  "cheerful",
  "playful",
  "tired",
  "stressed",
  "hurt",
]);

export const GLOBAL_EMOTION_ACTIONS = Object.freeze([
  "neutral",
  "improved",
  "playful",
  "warm",
  "hurt",
  "tired",
  "stressed",
  "excited",
]);

export const PROFILE_PREFERENCE_LABELS = Object.freeze([
  "short_replies",
  "direct_tone",
  "gentle_tone",
  "no_nickname",
  "no_teasing",
  "no_topic_push",
]);

export const PROFILE_BOUNDARY_LABELS = Object.freeze([
  "nickname",
  "joke",
  "topic",
  "contact_frequency",
]);

const SHORT_EMOTIONS = new Set(SHORT_EMOTION_LABELS);
const USER_EMOTIONS = new Set(USER_EMOTION_LABELS);
const NEGATIVE_USER_EMOTIONS = new Set([
  "sad",
  "hurt",
  "anxious",
  "angry",
  "tired",
  "confused",
]);
const GLOBAL_EMOTIONS = new Set(GLOBAL_EMOTION_LABELS);
const GLOBAL_ACTIONS = new Set(GLOBAL_EMOTION_ACTIONS);
const PROFILE_PREFERENCES = new Set(PROFILE_PREFERENCE_LABELS);
const PROFILE_BOUNDARIES = new Set(PROFILE_BOUNDARY_LABELS);
const VERSION = 1;
const FILE = path.join("data", "conversation-state.json");
const HASHED_KEY = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_HOURS = 72;
const DEFAULT_GLOBAL_TTL_HOURS = 24;
const DEFAULT_TOPIC_TTL_HOURS = 24;
const DEFAULT_UNFINISHED_TTL_HOURS = 168;
const DEFAULT_USER_EMOTION_TTL_HOURS = 6;
const DEFAULT_COMMON_MEME_TTL_HOURS = 168;
const DEFAULT_PROFILE_TTL_HOURS = 720;
const MAX_TOPIC_CHARS = 180;
const MAX_DETAIL_CHARS = 160;
const MAX_UNFINISHED_ITEMS = 12;
const MAX_COMMON_MEMES = 8;
const TOPIC_SWITCH_EMOTION_FACTOR = 0.45;

const ACTION_EFFECTS = Object.freeze({
  neutral: Object.freeze({}),
  improved: Object.freeze({ happiness: 0.06, calm: 0.02 }),
  playful: Object.freeze({ happiness: 0.05, energy: 0.03, interest: 0.06 }),
  warm: Object.freeze({ happiness: 0.04, calm: 0.04, interest: 0.02 }),
  hurt: Object.freeze({ happiness: -0.09, calm: -0.05, interest: -0.03 }),
  tired: Object.freeze({ energy: -0.1, interest: -0.04 }),
  stressed: Object.freeze({ calm: -0.1, energy: -0.03 }),
  excited: Object.freeze({ happiness: 0.07, energy: 0.08, interest: 0.05 }),
});

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizedText(value) {
  return cleanText(value, 1000).toLocaleLowerCase("zh-CN");
}

function isoTime(value, fallback = 0) {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hashedId(parts) {
  return createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
}

function defaultScores() {
  return {
    happiness: 0.5,
    energy: 0.55,
    calm: 0.55,
    interest: 0.5,
  };
}

function emptyData() {
  return {
    version: VERSION,
    profiles: {},
    conversations: {},
    globalEmotion: null,
  };
}

function normalizeScores(raw, base = defaultScores()) {
  if (!isPlainObject(raw)) return { ...base };
  return {
    happiness: clamp(finite(raw.happiness, base.happiness), 0, 1),
    energy: clamp(finite(raw.energy, base.energy), 0, 1),
    calm: clamp(finite(raw.calm, base.calm), 0, 1),
    interest: clamp(finite(raw.interest, base.interest), 0, 1),
  };
}

function normalizeUnfinishedItem(raw) {
  if (!isPlainObject(raw)) return null;
  const text = cleanText(raw.text, MAX_DETAIL_CHARS);
  if (!text) return null;
  const createdAt = isoTime(raw.createdAt);
  const updatedAt = Math.max(createdAt, isoTime(raw.updatedAt, createdAt));
  const status = ["open", "done", "cancelled"].includes(raw.status)
    ? raw.status
    : "open";
  const id = hashedId(["unfinished", normalizedText(text)]).slice(0, 16);
  return {
    id,
    text,
    status,
    createdAt,
    updatedAt,
    completedAt: status === "open" ? 0 : isoTime(raw.completedAt, updatedAt),
    expiresAt: isoTime(raw.expiresAt, updatedAt),
  };
}

function normalizeCommonMeme(raw) {
  if (!isPlainObject(raw)) return null;
  const text = cleanText(raw.text, 60);
  if (!text) return null;
  const createdAt = isoTime(raw.createdAt);
  const confirmedAt = Math.max(createdAt, isoTime(raw.confirmedAt, createdAt));
  return {
    id: hashedId(["common-meme", normalizedText(text)]).slice(0, 16),
    text,
    status: raw.status === "confirmed" ? "confirmed" : "candidate",
    createdAt,
    confirmedAt,
    expiresAt: isoTime(raw.expiresAt, confirmedAt),
  };
}

function normalizeUserEmotion(raw) {
  if (!isPlainObject(raw) || !USER_EMOTIONS.has(raw.emotion)) return null;
  const updatedAt = isoTime(raw.updatedAt);
  return {
    emotion: raw.emotion,
    intensity: clamp(finite(raw.intensity, 0), 0, 1),
    updatedAt,
    expiresAt: isoTime(raw.expiresAt),
  };
}

function normalizeConversation(raw) {
  if (!isPlainObject(raw)) return null;
  const updatedAt = isoTime(raw.updatedAt);
  let unfinishedItems = Array.isArray(raw.unfinishedItems)
    ? raw.unfinishedItems.map(normalizeUnfinishedItem).filter(Boolean)
    : [];
  if (!unfinishedItems.length && typeof raw.unfinished === "string" && raw.unfinished.trim()) {
    unfinishedItems = [
      {
        id: hashedId(["unfinished", normalizedText(raw.unfinished)]).slice(0, 16),
        text: cleanText(raw.unfinished, MAX_DETAIL_CHARS),
        status: "open",
        createdAt: updatedAt,
        updatedAt,
        completedAt: 0,
        expiresAt: isoTime(raw.expiresAt, updatedAt),
      },
    ];
  }
  return {
    ownerKey:
      typeof raw.ownerKey === "string" && HASHED_KEY.test(raw.ownerKey)
        ? raw.ownerKey
        : null,
    visibility: ["private", "group", "legacy"].includes(raw.visibility)
      ? raw.visibility
      : "legacy",
    channel: ["local", "onebot", "qq"].includes(raw.channel) ? raw.channel : null,
    visibilityKey:
      typeof raw.visibilityKey === "string" && HASHED_KEY.test(raw.visibilityKey)
        ? raw.visibilityKey
        : null,
    topic: cleanText(raw.topic, MAX_TOPIC_CHARS),
    topicUpdatedAt: isoTime(raw.topicUpdatedAt, updatedAt),
    topicExpiresAt: isoTime(raw.topicExpiresAt, isoTime(raw.expiresAt, updatedAt)),
    unfinishedItems,
    preference: cleanText(raw.preference, MAX_DETAIL_CHARS),
    emotion: SHORT_EMOTIONS.has(raw.emotion) ? raw.emotion : "neutral",
    emotionIntensity: clamp(finite(raw.emotionIntensity, 0.35), 0, 1),
    userEmotion: normalizeUserEmotion(raw.userEmotion),
    commonMemes: Array.isArray(raw.commonMemes)
      ? raw.commonMemes.map(normalizeCommonMeme).filter(Boolean)
      : [],
    styleMetrics: normalizeStyleFlags(raw.styleMetrics),
    updatedAt,
    expiresAt: isoTime(raw.expiresAt),
  };
}

function normalizeProfile(raw) {
  if (!isPlainObject(raw)) return null;
  const relationship = isPlainObject(raw.relationship) ? raw.relationship : {};
  return {
    relationship: {
      level: clamp(finite(relationship.level, 0), 0, 1),
      lastInteractionAt: isoTime(relationship.lastInteractionAt),
      lastInteractionDay: cleanText(relationship.lastInteractionDay, 10),
      lastWarmthAt: isoTime(relationship.lastWarmthAt),
    },
    preferences: Array.isArray(raw.preferences)
      ? [...new Set(raw.preferences.filter((item) => PROFILE_PREFERENCES.has(item)))]
      : [],
    boundaries: Array.isArray(raw.boundaries)
      ? [...new Set(raw.boundaries.filter((item) => PROFILE_BOUNDARIES.has(item)))]
      : [],
    updatedAt: isoTime(raw.updatedAt),
    expiresAt: isoTime(raw.expiresAt),
  };
}

function normalizeGlobal(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    emotion: GLOBAL_EMOTIONS.has(raw.emotion) ? raw.emotion : "calm",
    scores: normalizeScores(raw.scores),
    updatedAt: isoTime(raw.updatedAt),
    expiresAt: isoTime(raw.expiresAt),
  };
}

function normalizeData(raw) {
  if (!isPlainObject(raw) || raw.version !== VERSION) return emptyData();
  const conversations = {};
  if (isPlainObject(raw.conversations)) {
    for (const [key, value] of Object.entries(raw.conversations)) {
      if (!HASHED_KEY.test(key)) continue;
      const normalized = normalizeConversation(value);
      if (normalized) conversations[key] = normalized;
    }
  }
  const profiles = {};
  if (isPlainObject(raw.profiles)) {
    for (const [key, value] of Object.entries(raw.profiles)) {
      if (!HASHED_KEY.test(key)) continue;
      const normalized = normalizeProfile(value);
      if (normalized) profiles[key] = normalized;
    }
  }
  return {
    version: VERSION,
    profiles,
    conversations,
    globalEmotion: normalizeGlobal(raw.globalEmotion),
  };
}

function chooseGlobalEmotion(scores) {
  if (scores.energy < 0.24) return "tired";
  if (scores.calm < 0.24) return "stressed";
  if (scores.happiness < 0.27) return "hurt";
  if (scores.happiness > 0.68 && scores.energy > 0.62) {
    return scores.interest > 0.62 ? "playful" : "cheerful";
  }
  return "calm";
}

function decayScores(scores, elapsedMs, ttlMs) {
  if (elapsedMs <= 0 || ttlMs <= 0) return { ...scores };
  const remaining = clamp(1 - elapsedMs / ttlMs, 0, 1);
  const base = defaultScores();
  return {
    happiness: base.happiness + (scores.happiness - base.happiness) * remaining,
    energy: base.energy + (scores.energy - base.energy) * remaining,
    calm: base.calm + (scores.calm - base.calm) * remaining,
    interest: base.interest + (scores.interest - base.interest) * remaining,
  };
}

function projectItem(item) {
  return {
    id: item.id,
    text: item.text,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt || null,
    expiresAt: item.expiresAt,
  };
}

function projectUserEmotion(value, now, ttlMs) {
  if (!value || value.expiresAt <= now) return null;
  const remaining = clamp(1 - Math.max(0, now - value.updatedAt) / ttlMs, 0, 1);
  const intensity = value.intensity * remaining;
  if (intensity < 0.08) return null;
  return {
    emotion: value.emotion,
    intensity,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  };
}

function projectConversation(value, now, bounds) {
  if (!value) return null;
  const topic = value.topic && value.topicExpiresAt > now ? value.topic : "";
  const history = value.unfinishedItems
    .filter((item) => item.expiresAt > now)
    .map(projectItem);
  const openItems = history.filter((item) => item.status === "open");
  const remaining = clamp(
    1 - Math.max(0, now - value.updatedAt) / bounds.ttlMs,
    0,
    1,
  );
  return {
    topic,
    unfinished: openItems.map((item) => item.text).join("；"),
    unfinishedItems: openItems,
    unfinishedHistory: history,
    preference: value.preference,
    emotion: value.emotion,
    emotionIntensity: value.emotionIntensity * remaining,
    userEmotion: projectUserEmotion(value.userEmotion, now, bounds.userEmotionTtlMs),
    commonMemes: value.commonMemes
      .filter((item) => item.status === "confirmed" && item.expiresAt > now)
      .map((item) => ({ ...item })),
    styleMetrics: { ...value.styleMetrics },
    scope: value.visibility,
    updatedAt: value.updatedAt,
  };
}

function relationshipLabel(level) {
  if (level < 0.2) return "刚开始熟悉";
  if (level < 0.45) return "有一定熟悉感";
  return "比较熟悉";
}

function projectProfile(value, now) {
  if (!value || value.expiresAt <= now) return null;
  return {
    relationship: {
      level: value.relationship.level,
      label: relationshipLabel(value.relationship.level),
    },
    preferences: [...value.preferences],
    boundaries: [...value.boundaries],
  };
}

function projectGlobal(value, now, ttlMs) {
  if (!value) return null;
  const scores = decayScores(
    value.scores,
    Math.max(0, now - value.updatedAt),
    ttlMs,
  );
  return {
    emotion: chooseGlobalEmotion(scores),
    scores,
  };
}

function resolveBounds(config, now) {
  const state = config?.conversationState ?? {};
  const hours = (value, min, max, fallback) =>
    Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  const maxEntries =
    Number.isInteger(state.maxEntries) && state.maxEntries >= 20 && state.maxEntries <= 2000
      ? state.maxEntries
      : DEFAULT_MAX_ENTRIES;
  return {
    maxEntries,
    ttlMs: hours(state.ttlHours, 1, 720, DEFAULT_TTL_HOURS) * 60 * 60 * 1000,
    globalTtlMs:
      hours(state.globalEmotionTtlHours, 1, 168, DEFAULT_GLOBAL_TTL_HOURS) *
      60 *
      60 *
      1000,
    topicTtlMs:
      hours(state.topicTtlHours, 1, 168, DEFAULT_TOPIC_TTL_HOURS) * 60 * 60 * 1000,
    unfinishedTtlMs:
      hours(state.unfinishedTtlHours, 1, 720, DEFAULT_UNFINISHED_TTL_HOURS) *
      60 *
      60 *
      1000,
    userEmotionTtlMs:
      hours(state.userEmotionTtlHours, 1, 72, DEFAULT_USER_EMOTION_TTL_HOURS) *
      60 *
      60 *
      1000,
    commonMemeTtlMs:
      hours(state.commonMemeTtlHours, 1, 720, DEFAULT_COMMON_MEME_TTL_HOURS) *
      60 *
      60 *
      1000,
    profileTtlMs:
      hours(state.profileTtlHours, 24, 8760, DEFAULT_PROFILE_TTL_HOURS) *
      60 *
      60 *
      1000,
    now,
  };
}

function pruneData(data, bounds) {
  let changed = false;
  const contexts = [];
  for (const [key, value] of Object.entries(data.conversations)) {
    if (!value || value.expiresAt <= bounds.now) {
      delete data.conversations[key];
      changed = true;
      continue;
    }
    const unfinished = value.unfinishedItems.filter((item) => item.expiresAt > bounds.now);
    const memes = value.commonMemes.filter((item) => item.expiresAt > bounds.now);
    if (unfinished.length !== value.unfinishedItems.length) {
      value.unfinishedItems = unfinished;
      changed = true;
    }
    if (memes.length !== value.commonMemes.length) {
      value.commonMemes = memes;
      changed = true;
    }
    if (value.userEmotion && value.userEmotion.expiresAt <= bounds.now) {
      value.userEmotion = null;
      changed = true;
    }
    contexts.push([key, value]);
  }
  if (contexts.length > bounds.maxEntries) {
    contexts.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
    for (const [key] of contexts.slice(bounds.maxEntries)) {
      delete data.conversations[key];
      changed = true;
    }
  }
  for (const [key, value] of Object.entries(data.profiles)) {
    if (!value || value.expiresAt <= bounds.now) {
      delete data.profiles[key];
      changed = true;
    }
  }
  const profiles = Object.entries(data.profiles);
  if (profiles.length > bounds.maxEntries) {
    profiles.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
    for (const [key] of profiles.slice(bounds.maxEntries)) {
      delete data.profiles[key];
      changed = true;
    }
  }
  if (
    data.globalEmotion &&
    (!data.globalEmotion.expiresAt || data.globalEmotion.expiresAt <= bounds.now)
  ) {
    data.globalEmotion = null;
    changed = true;
  }
  return changed;
}

function explicitBoundaryCodes(text) {
  const value = cleanText(text, 1000);
  const codes = [];
  if (/(?:别|不要|不喜欢|讨厌|接受不了).{0,16}(?:叫|称呼|昵称)|叫我.{0,16}(?:不喜欢|别)/iu.test(value)) {
    codes.push("nickname");
  }
  if (/(?:别|不要|不喜欢|讨厌|接受不了).{0,16}(?:开玩笑|玩笑|逗我|调侃|玩梗)/iu.test(value)) {
    codes.push("joke");
  }
  if (/(?:别提|不要提|不想聊|不喜欢聊|别问).{0,30}/iu.test(value)) {
    codes.push("topic");
  }
  if (/(?:别|不要).{0,8}(?:一直催|追着问|频繁找|发太多)/iu.test(value)) {
    codes.push("contact_frequency");
  }
  return codes;
}

function explicitBoundaryCode(text) {
  return explicitBoundaryCodes(text)[0] ?? null;
}

function explicitWarmth(text) {
  return /(?:喜欢和你聊|和你聊得挺舒服|谢谢你(?:\s|，|。|！|$)|你挺好|有点懂我|说到一块)/iu.test(
    cleanText(text, 1000),
  );
}

function explicitNicknameAccepted(text) {
  return /(?:可以叫我|就叫(?:我)?|我喜欢你叫我|这个称呼可以)/iu.test(
    cleanText(text, 1000),
  );
}

function explicitPreferenceCode(text) {
  const value = cleanText(text, 1000);
  const boundary = explicitBoundaryCode(value);
  if (boundary === "nickname") return "no_nickname";
  if (boundary === "joke") return "no_teasing";
  if (boundary === "topic") return "no_topic_push";
  if (/(?:说短点|短一点|简短|别写长|不要长篇|简单点)/iu.test(value)) {
    return "short_replies";
  }
  if (/(?:直接点|直接说|别绕|不用铺垫)/iu.test(value)) return "direct_tone";
  if (/(?:温柔点|轻一点|别凶|别太冲)/iu.test(value)) return "gentle_tone";
  return null;
}

function dedupeItems(items) {
  const byId = new Map();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || previous.updatedAt <= item.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_UNFINISHED_ITEMS);
}

function dedupeMemes(items) {
  const byId = new Map();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || previous.confirmedAt <= item.confirmedAt) byId.set(item.id, item);
  }
  return [...byId.values()]
    .sort((left, right) => left.confirmedAt - right.confirmedAt)
    .slice(-MAX_COMMON_MEMES);
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function conversationStateKey(event) {
  const parts = [
    "conversation-state-v1",
    event.channel,
    event.scope,
    event.conversationId,
    event.scope === "group" ? event.groupId : event.userId,
    ...(event.scope === "group" ? ["sender", event.userId] : []),
  ];
  return hashedId(parts);
}

export function personStateKey(event, config = {}) {
  const mapped = config.identityLinks?.[`${event.channel}:${event.userId}`];
  const identity =
    typeof mapped === "string" && mapped.trim()
      ? ["mapped", mapped.trim()]
      : ["channel", event.channel, event.userId];
  return hashedId(["person-profile-v1", ...identity]);
}

function contextVisibilityKey(event) {
  return event.scope === "group"
    ? hashedId(["conversation-visibility-v1", event.channel, "group", event.groupId])
    : hashedId(["conversation-visibility-v1", event.channel, "private", event.userId]);
}

export function normalizeConversationReview(raw, currentUser = "") {
  if (
    !isPlainObject(raw) ||
    typeof raw.reply !== "string" ||
    typeof raw.silence !== "boolean" ||
    typeof raw.topic !== "string" ||
    typeof raw.unfinished !== "string" ||
    typeof raw.preference !== "string" ||
    !SHORT_EMOTIONS.has(raw.emotion) ||
    typeof raw.emotionIntensity !== "number" ||
    !Number.isFinite(raw.emotionIntensity) ||
    !isPlainObject(raw.globalEmotion) ||
    !GLOBAL_ACTIONS.has(raw.globalEmotion.action)
  ) {
    return null;
  }
  const global = raw.globalEmotion;
  for (const key of ["happiness", "energy", "interest", "calm"]) {
    if (typeof global[key] !== "number" || !Number.isFinite(global[key])) {
      return null;
    }
  }

  const userText = cleanText(currentUser, 2000);
  const userEmotionRaw = isPlainObject(raw.user_emotion) ? raw.user_emotion : null;
  const userEmotion =
    userEmotionRaw && USER_EMOTIONS.has(userEmotionRaw.emotion)
      ? {
          emotion: userEmotionRaw.emotion,
          intensity: clamp(finite(userEmotionRaw.intensity, 0), 0, 1),
          clear: userEmotionRaw.clear === true,
        }
      : null;

  let commonMeme = null;
  if (isPlainObject(raw.common_meme)) {
    const text = cleanText(raw.common_meme.text, 60);
    if (text && userText && normalizedText(userText).includes(normalizedText(text))) {
      commonMeme = {
        text,
        kind: raw.common_meme.kind === "confirm" ? "confirm" : "mention",
        clear: raw.common_meme.clear === true,
      };
    }
  }

  const profileRaw = isPlainObject(raw.profile) ? raw.profile : null;
  const preferred = explicitPreferenceCode(userText);
  const boundary = explicitBoundaryCode(userText);
  const signal =
    profileRaw &&
    ["none", "warm", "boundary_set"].includes(profileRaw.relationship_signal)
      ? profileRaw.relationship_signal
      : "none";

  const items = Array.isArray(raw.unfinished_items)
    ? raw.unfinished_items
        .map((item) =>
          typeof item === "string"
            ? { text: cleanText(item, MAX_DETAIL_CHARS), status: "open" }
            : isPlainObject(item)
              ? {
                  text: cleanText(item.text, MAX_DETAIL_CHARS),
                  status: ["open", "done", "cancelled"].includes(item.status)
                    ? item.status
                    : "open",
                }
              : null,
        )
        .filter((item) => item?.text)
    : [];

  return {
    reply: raw.reply.trim(),
    silence: raw.silence === true,
    topic: cleanText(raw.topic, MAX_TOPIC_CHARS),
    unfinished: cleanText(raw.unfinished, MAX_DETAIL_CHARS),
    unfinishedItems: items,
    preference: cleanText(raw.preference, MAX_DETAIL_CHARS),
    clearTopic: raw.clear_topic === true,
    clearUnfinished: raw.clear_unfinished === true,
    clearPreference: raw.clear_preference === true,
    emotion: raw.emotion,
    emotionIntensity: clamp(raw.emotionIntensity, 0, 1),
    userEmotion,
    commonMeme,
    profile: {
      preference: preferred,
      boundary,
      relationshipSignal:
        signal === "warm" && !explicitWarmth(userText) ? "none" : signal,
      explicitWarmth: explicitWarmth(userText),
      explicitNicknameAccepted: explicitNicknameAccepted(userText),
    },
    globalEmotion: {
      action: GLOBAL_ACTIONS.has(global.action) ? global.action : "neutral",
      happiness: clamp(finite(global.happiness, 0), -0.15, 0.15),
      energy: clamp(finite(global.energy, 0), -0.15, 0.15),
      interest: clamp(finite(global.interest, 0), -0.15, 0.15),
      calm: clamp(finite(global.calm, 0), -0.15, 0.15),
    },
  };
}

export class ConversationState {
  constructor({ root, logger = console }) {
    if (typeof root !== "string" || !root.trim()) {
      throw new TypeError("root 必须是非空路径");
    }
    this.root = path.resolve(root);
    this.file = path.join(this.root, FILE);
    this.logger = logger;
    this.data = emptyData();
    this._queue = Promise.resolve();
    this._initialized = null;
  }

  init() {
    if (!this._initialized) {
      this._initialized = this._locked(() => this._initUnlocked());
    }
    return this._initialized.then(() => this);
  }

  _locked(operation) {
    const result = this._queue.then(operation, operation);
    this._queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async _initUnlocked() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!isPlainObject(parsed) || parsed.version !== VERSION) {
        throw new Error("invalid conversation state");
      }
      this.data = normalizeData(parsed);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.data = emptyData();
        await this._writeUnlocked();
        return;
      }
      try {
        await rename(
          this.file,
          `${this.file}.corrupt-${Date.now()}-${process.pid}`,
        );
      } catch {
        throw error;
      }
      this.data = emptyData();
      await this._writeUnlocked();
    }
  }

  async _writeUnlocked() {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temp = `${this.file}.${suffix}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async context(conversationKey, config = {}, now = Date.now()) {
    await this.init();
    return this._locked(async () => {
      if (!HASHED_KEY.test(conversationKey)) {
        return { conversation: null, global: null };
      }
      const bounds = resolveBounds(config, now);
      const changed = pruneData(this.data, bounds);
      if (changed) await this._writeUnlocked();
      return {
        conversation: projectConversation(
          this.data.conversations[conversationKey],
          bounds.now,
          bounds,
        ),
        global: projectGlobal(this.data.globalEmotion, bounds.now, bounds.globalTtlMs),
      };
    });
  }

  async visibleContext(event, config = {}, now = Date.now()) {
    await this.init();
    if (!isPlainObject(event) || !["local", "onebot", "qq"].includes(event.channel)) {
      throw new TypeError("event 无效");
    }
    return this._locked(async () => {
      const bounds = resolveBounds(config, now);
      const changed = pruneData(this.data, bounds);
      if (changed) await this._writeUnlocked();
      const ownerKey = personStateKey(event, config);
      const currentKey = conversationStateKey(event);
      const currentVisibilityKey = contextVisibilityKey(event);
      const contexts = Object.entries(this.data.conversations)
        .filter(([key, value]) => {
          if (value.ownerKey !== ownerKey) return false;
          if (event.scope === "private") return true;
          return (
            key === currentKey ||
            (value.visibility === "group" &&
              value.visibilityKey === currentVisibilityKey)
          );
        })
        .sort((left, right) => {
          if (left[0] === currentKey) return -1;
          if (right[0] === currentKey) return 1;
          return right[1].updatedAt - left[1].updatedAt;
        })
        .slice(0, 6)
        .map(([key, value]) => ({
          conversationKey: key,
          ...projectConversation(value, bounds.now, bounds),
        }));
      return {
        profile: projectProfile(this.data.profiles[ownerKey], bounds.now),
        contexts,
        currentConversationKey: currentKey,
      };
    });
  }

  async unfinishedItems(
    conversationKey,
    config = {},
    now = Date.now(),
    { includeCompleted = false } = {},
  ) {
    const state = await this.context(conversationKey, config, now);
    if (!state.conversation) return [];
    return includeCompleted
      ? state.conversation.unfinishedHistory
      : state.conversation.unfinishedItems;
  }

  async updateTurn({
    conversationKey,
    event = null,
    config = {},
    review = null,
    styleFlags = null,
    now = Date.now(),
  }) {
    await this.init();
    if (!HASHED_KEY.test(conversationKey)) {
      throw new TypeError("conversationKey 无效");
    }
    if (!review && !styleFlags) return false;
    return this._locked(async () => {
      const bounds = resolveBounds(config, now);
      pruneData(this.data, bounds);
      const previous = this.data.conversations[conversationKey];
      const ownerKey = event?.channel ? personStateKey(event, config) : previous?.ownerKey ?? null;
      const visibility = event
        ? event.scope === "group"
          ? "group"
          : "private"
        : previous?.visibility ?? "legacy";
      const next = previous ?? {
        ownerKey,
        visibility,
        channel: event?.channel ?? null,
        visibilityKey: event ? contextVisibilityKey(event) : null,
        topic: "",
        topicUpdatedAt: 0,
        topicExpiresAt: 0,
        unfinishedItems: [],
        preference: "",
        emotion: "neutral",
        emotionIntensity: 0.35,
        userEmotion: null,
        commonMemes: [],
        styleMetrics: normalizeStyleFlags(null),
        updatedAt: now,
        expiresAt: now + bounds.ttlMs,
      };
      if (event) {
        next.ownerKey = ownerKey;
        next.visibility = visibility;
        next.channel = event.channel;
        next.visibilityKey = contextVisibilityKey(event);
      }

      if (review) {
        const previousTopic = next.topic;
        let topicChanged = false;
        if (review.clearTopic) {
          next.topic = "";
          next.topicUpdatedAt = now;
          next.topicExpiresAt = now;
          topicChanged = Boolean(previousTopic);
        } else if (review.topic) {
          topicChanged =
            Boolean(previousTopic) &&
            normalizedText(previousTopic) !== normalizedText(review.topic);
          next.topic = review.topic;
          next.topicUpdatedAt = now;
          next.topicExpiresAt = now + bounds.topicTtlMs;
        }

        let items = next.unfinishedItems.filter((item) => item.expiresAt > now);
        if (review.clearUnfinished) {
          items = items.map((item) =>
            item.status === "open"
              ? {
                  ...item,
                  status: "done",
                  updatedAt: now,
                  completedAt: now,
                  expiresAt: now + bounds.unfinishedTtlMs,
                }
              : item,
          );
        }
        const incoming = (review.unfinishedItems ?? [])
          .map((item) =>
            normalizeUnfinishedItem({
              ...item,
              createdAt: now,
              updatedAt: now,
              expiresAt: now + bounds.unfinishedTtlMs,
            }),
          )
          .filter(Boolean);
        if (review.unfinished) {
          const item = normalizeUnfinishedItem({
            text: review.unfinished,
            status: "open",
            createdAt: now,
            updatedAt: now,
            expiresAt: now + bounds.unfinishedTtlMs,
          });
          if (item) incoming.push(item);
        }
        for (const item of incoming) {
          const existing = items.find((candidate) => candidate.id === item.id);
          if (existing) {
            if (item.status !== "open") {
              Object.assign(existing, {
                status: item.status,
                updatedAt: now,
                completedAt: now,
                expiresAt: now + bounds.unfinishedTtlMs,
              });
            } else if (existing.status !== "open") {
              Object.assign(existing, {
                status: "open",
                updatedAt: now,
                completedAt: 0,
                expiresAt: now + bounds.unfinishedTtlMs,
              });
            }
          } else {
            items.push(item);
          }
        }
        next.unfinishedItems = dedupeItems(items);
        next.preference = review.clearPreference
          ? ""
          : review.preference || next.preference || "";
        next.emotion = review.emotion;
        next.emotionIntensity = review.emotionIntensity;

        let userEmotion = projectUserEmotion(
          next.userEmotion,
          now,
          bounds.userEmotionTtlMs,
        );
        if (topicChanged && userEmotion) {
          userEmotion.intensity *= TOPIC_SWITCH_EMOTION_FACTOR;
        }
        if (review.userEmotion?.clear) {
          next.userEmotion = null;
        } else if (review.userEmotion && review.userEmotion.emotion !== "neutral") {
          next.userEmotion = {
            emotion: review.userEmotion.emotion,
            intensity: review.userEmotion.intensity,
            updatedAt: now,
            expiresAt: now + bounds.userEmotionTtlMs,
          };
        } else if (userEmotion && userEmotion.intensity >= 0.08) {
          next.userEmotion = {
            ...next.userEmotion,
            intensity: userEmotion.intensity,
            updatedAt: now,
          };
        } else {
          next.userEmotion = null;
        }

        let memes = next.commonMemes.filter((item) => item.expiresAt > now);
        if (review.commonMeme?.clear) {
          memes = [];
        } else if (review.commonMeme?.text) {
          const existing = memes.find(
            (item) =>
              normalizedText(item.text) === normalizedText(review.commonMeme.text),
          );
          const meme = normalizeCommonMeme({
            text: review.commonMeme.text,
            createdAt: existing?.createdAt ?? now,
            confirmedAt: now,
            expiresAt: now + bounds.commonMemeTtlMs,
            status: existing ? "confirmed" : "candidate",
          });
          if (meme) memes = [...memes.filter((item) => item.id !== meme.id), meme];
        }
        next.commonMemes = dedupeMemes(memes);
      }

      if (styleFlags) next.styleMetrics = normalizeStyleFlags(styleFlags);
      next.updatedAt = now;
      next.expiresAt = now + bounds.ttlMs;
      this.data.conversations[conversationKey] = next;

      if (event && (review || styleFlags)) {
        const currentUserText = String(event.text ?? "");
        const eventBoundaries = explicitBoundaryCodes(currentUserText);
        if (review?.profile?.boundary) {
          eventBoundaries.push(review.profile.boundary);
        }
        const eventPreference =
          explicitPreferenceCode(currentUserText) ||
          (review?.profile?.preference ?? null);
        const eventWarmth = explicitWarmth(currentUserText);
        const eventNicknameAccepted = explicitNicknameAccepted(currentUserText);
        const reviewProfile = review?.profile ?? {};
        const profile = structuredClone(
          this.data.profiles[ownerKey] ?? {
            relationship: {
              level: 0,
              lastInteractionAt: 0,
              lastInteractionDay: "",
              lastWarmthAt: 0,
            },
            preferences: [],
            boundaries: [],
            updatedAt: now,
            expiresAt: now + bounds.profileTtlMs,
          },
        );
        const today = dayKey(now);
        if (profile.relationship.lastInteractionDay !== today) {
          profile.relationship.level = clamp(profile.relationship.level + 0.02, 0, 1);
          profile.relationship.lastInteractionDay = today;
        }
        if (
          eventWarmth &&
          now - profile.relationship.lastWarmthAt >= 6 * 60 * 60 * 1000
        ) {
          profile.relationship.level = clamp(profile.relationship.level + 0.015, 0, 1);
          profile.relationship.lastWarmthAt = now;
        }
        if (eventNicknameAccepted) {
          profile.preferences = [...new Set([...profile.preferences, "gentle_tone"])];
        }
        if (eventPreference) {
          profile.preferences = [
            ...new Set([...profile.preferences, eventPreference]),
          ].slice(-PROFILE_PREFERENCE_LABELS.length);
        }
        for (const eventBoundary of new Set(eventBoundaries)) {
          profile.boundaries = [
            ...new Set([...profile.boundaries, eventBoundary]),
          ].slice(-PROFILE_BOUNDARY_LABELS.length);
          const safePreference =
            eventBoundary === "nickname"
              ? "no_nickname"
              : eventBoundary === "joke"
                ? "no_teasing"
                : eventBoundary === "topic"
                  ? "no_topic_push"
                  : null;
          if (safePreference) {
            profile.preferences = [
              ...new Set([...profile.preferences, safePreference]),
            ].slice(-PROFILE_PREFERENCE_LABELS.length);
          }
        }
        profile.relationship.lastInteractionAt = now;
        profile.updatedAt = now;
        profile.expiresAt = now + bounds.profileTtlMs;
        this.data.profiles[ownerKey] = profile;
      }

      if (review) {
        const previousGlobal = this.data.globalEmotion;
        const base = previousGlobal
          ? decayScores(
              previousGlobal.scores,
              Math.max(0, now - previousGlobal.updatedAt),
              bounds.globalTtlMs,
            )
          : defaultScores();
        const userNegative =
          review.userEmotion &&
          review.userEmotion.intensity >= 0.35 &&
          NEGATIVE_USER_EMOTIONS.has(review.userEmotion.emotion);
        const effect = userNegative
          ? {}
          : ACTION_EFFECTS[review.globalEmotion.action] ?? {};
        const delta = (key) =>
          userNegative
            ? Math.max(0, review.globalEmotion[key])
            : finite(review.globalEmotion[key], 0);
        const scores = normalizeScores(
          {
            happiness: base.happiness + (effect.happiness ?? 0) + delta("happiness"),
            energy: base.energy + (effect.energy ?? 0) + delta("energy"),
            interest: base.interest + (effect.interest ?? 0) + delta("interest"),
            calm: base.calm + (effect.calm ?? 0) + delta("calm"),
          },
          base,
        );
        this.data.globalEmotion = {
          emotion: chooseGlobalEmotion(scores),
          scores,
          updatedAt: now,
          expiresAt: now + bounds.globalTtlMs,
        };
      }

      pruneData(this.data, bounds);
      await this._writeUnlocked();
      return true;
    });
  }

  async clearConversation(conversationKey) {
    await this.init();
    if (!HASHED_KEY.test(conversationKey)) return false;
    return this._locked(async () => {
      if (!(conversationKey in this.data.conversations)) return false;
      delete this.data.conversations[conversationKey];
      await this._writeUnlocked();
      return true;
    });
  }

  async resetAll() {
    await this.init();
    return this._locked(async () => {
      this.data = emptyData();
      await this._writeUnlocked();
      return true;
    });
  }

  async flush() {
    await this.init();
    return this._locked(async () => {
      pruneData(this.data, resolveBounds({}, Date.now()));
      await this._writeUnlocked();
    });
  }
}
