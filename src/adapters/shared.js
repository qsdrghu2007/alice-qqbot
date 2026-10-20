import { collectLinkStrings } from "../qzone-links.js";

const SENSITIVE_KEY =
  /^(authorization|token|access_token|secret|appsecret|app_secret|clientsecret|client_secret)$/i;
const SENSITIVE_TEXT = [
  [/(Authorization\s*:\s*)Bearer\s+[^\s,;]+/gi, "$1Bearer [redacted]"],
  [/(Authorization\s*:\s*)QQBot\s+[^\s,;]+/gi, "$1QQBot [redacted]"],
  [/(access_token=)[^&\s]+/gi, "$1[redacted]"],
  [/((?:token|secret|clientSecret|appSecret)"\s*:\s*")[^"]+/gi, "$1[redacted]"],
];

export class AdapterError extends Error {
  constructor(message, code = "ADAPTER_ERROR", options = {}) {
    super(message, options);
    this.name = "AdapterError";
    this.code = code;
    this.category = options.category ?? "internal";
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.status = options.status;
    this.bizCode = options.bizCode;
    this.restriction = options.restriction;
  }
}

export function asAdapterError(error, fallbackCode = "ADAPTER_ERROR", options = {}) {
  if (error instanceof AdapterError) return error;
  return new AdapterError(
    error instanceof Error ? error.message : String(error),
    fallbackCode,
    { ...options, cause: error },
  );
}

export function redactSecrets(value) {
  if (typeof value === "string") {
    return SENSITIVE_TEXT.reduce(
      (text, [pattern, replacement]) => text.replace(pattern, replacement),
      value,
    );
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactSecrets(item);
  }
  return result;
}

export function logSafely(logger, level, message, context) {
  const target = logger?.[level] ?? logger?.log ?? logger?.error;
  if (typeof target !== "function") return;
  try {
    const safeMessage = redactSecrets(String(message));
    if (context === undefined) {
      target.call(logger, safeMessage);
    } else {
      target.call(logger, safeMessage, redactSecrets(context));
    }
  } catch {
    // Logging must never break the transport.
  }
}

export function maskId(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 6) return `${text[0] ?? ""}***`;
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

export function normalizePolicy(policy = {}) {
  return {
    paused: policy.paused === true,
    autoActions: policy.autoActions !== false,
    allowedUsers: (Array.isArray(policy.allowedUsers) ? policy.allowedUsers : []).map(String),
    allowedGroups: (Array.isArray(policy.allowedGroups) ? policy.allowedGroups : []).map(String),
    cooldownMs: Math.max(0, Number(policy.cooldownMs) || 0),
  };
}

export function policyReason(event, policy) {
  if (policy.paused) return "paused";

  const userId = String(event.userId ?? "");
  const groupId = String(event.groupId ?? "");
  if (policy.allowedUsers.length > 0 && !policy.allowedUsers.includes(userId)) {
    return "user-not-allowed";
  }
  if (
    event.scope === "group" &&
    policy.allowedGroups.length > 0 &&
    !policy.allowedGroups.includes(groupId)
  ) {
    return "group-not-allowed";
  }
  return null;
}

export function normalizeReply(reply = {}) {
  return {
    text: typeof reply?.text === "string" ? reply.text : "",
    faces: Array.isArray(reply?.faces) ? reply.faces : [],
    images: Array.isArray(reply?.images) ? reply.images : [],
  };
}

export function parseOneBotStringMessage(message) {
  let text = String(message ?? "");
  const attachments = [];
  const links = new Set(collectLinkStrings(text));
  let mentionId;

  text = text.replace(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gi, (_full, type, params) => {
    const data = {};
    for (const pair of String(params ?? "").split(",")) {
      if (!pair) continue;
      const at = pair.indexOf("=");
      if (at < 0) continue;
      data[pair.slice(0, at)] = unescapeCq(pair.slice(at + 1));
    }
    if (type === "at") {
      mentionId = String(data.qq ?? "");
    } else if (type === "image") {
      attachments.push(imageAttachment(data));
    } else if (type === "json" || type === "xml") {
      for (const link of collectLinkStrings(data)) links.add(link);
    } else if (type === "mface") {
      return `[表情包:${data.summary || "商城表情"}]`;
    } else if (type === "face") {
      return `[face:${data.id ?? ""}]`;
    }
    return "";
  });

  return {
    text: unescapeCq(text).trim(),
    attachments,
    links: [...links],
    mentionedSelf: false,
    mentionId,
  };
}

export function parseOneBotMessage(message) {
  if (!Array.isArray(message)) return parseOneBotStringMessage(message);

  const textParts = [];
  const attachments = [];
  const links = new Set();
  let mentionId;
  for (const segment of message) {
    const type = String(segment?.type ?? "");
    const data = segment?.data ?? {};
    for (const link of collectLinkStrings(data)) links.add(link);
    if (type === "text") {
      textParts.push(String(data.text ?? ""));
    } else if (type === "face") {
      textParts.push(`[face:${data.id ?? ""}]`);
    } else if (type === "at") {
      mentionId = String(data.qq ?? "");
    } else if (type === "image") {
      attachments.push(imageAttachment(data));
    } else if (type === "mface") {
      textParts.push(`[表情包:${data.summary || "商城表情"}]`);
      attachments.push({
        type: "mface",
        summary: String(data.summary ?? ""),
        emojiPackageId: Number(data.emoji_package_id ?? 0),
        emojiId: String(data.emoji_id ?? ""),
        key: String(data.key ?? ""),
      });
    }
  }

  return {
    text: textParts.join("").trim(),
    attachments,
    links: [...links],
    mentionedSelf: false,
    mentionId,
  };
}

export function oneBotAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments
    .map((attachment) => {
      const url = String(attachment?.url ?? attachment?.file ?? "");
      if (!url) return null;
      const contentType = String(attachment?.content_type ?? attachment?.type ?? "");
      const type = contentType.startsWith("image/")
        ? "image"
        : contentType.startsWith("video/")
          ? "video"
          : contentType.startsWith("audio/")
            ? "audio"
            : attachment?.type === "image"
              ? "image"
              : "file";
      return { type, url };
    })
    .filter(Boolean);
}

export function bodyFromOneBotReply(reply) {
  const normalized = normalizeReply(reply);
  const segments = [];
  if (normalized.text) segments.push({ type: "text", data: { text: normalized.text } });
  for (const face of normalized.faces) {
    const id = String(face ?? "").trim();
    if (id) segments.push({ type: "face", data: { id } });
  }
  for (const image of normalized.images) {
    const file = String(image ?? "").trim();
    if (file) segments.push({ type: "image", data: { file } });
  }
  if (segments.length === 0) {
    throw new AdapterError("OneBot reply is empty", "EMPTY_REPLY", { category: "validation" });
  }
  return segments;
}

export function normalizeOneBotId(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

export function oneBotEchoMatches(value, expected) {
  return value === expected || String(value) === String(expected);
}

function imageAttachment(data) {
  const subType = Number(data?.sub_type ?? 0);
  return {
    type: "image",
    url: String(data?.url ?? data?.file ?? ""),
    file: String(data?.file ?? ""),
    summary: String(data?.summary ?? ""),
    subType: Number.isFinite(subType) ? subType : 0,
  };
}

function unescapeCq(value) {
  return String(value)
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}
