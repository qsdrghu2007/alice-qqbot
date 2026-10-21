import { replyDelayDefaults } from "./config.js";

function deliveryCancelledError(message = "消息已被更新的输入取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "CANCELLED";
  return error;
}

function defaultSleep(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
  if (signal.aborted) return Promise.reject(deliveryCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(deliveryCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener?.("abort", onAbort, { once: true });
  });
}

function abortCancellation(signal) {
  if (!signal) return { promise: null, dispose() {} };
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(deliveryCancelledError());
    signal.addEventListener?.("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      signal.removeEventListener?.("abort", onAbort);
    },
  };
}

export function visibleCharacterCount(text) {
  return Array.from(String(text ?? "").replace(/\s+/gu, "")).length;
}

function hasSlowPacingHint(reply) {
  if (reply?.needsSlowPacing === true) return true;
  const hints = reply?.pacingHints;
  return Boolean(
    hints &&
      (hints.tool === true ||
        hints.web === true ||
        hints.recall === true ||
        hints.serious === true),
  );
}

function isSimpleReply(text) {
  const value = String(text ?? "").trim();
  const characters = visibleCharacterCount(value);
  return (
    characters > 0 &&
    characters <= 10 &&
    !/[\r\n]/u.test(value) &&
    (value.match(/[。！？!?]/gu) ?? []).length <= 1
  );
}

export function calculateReplyDelay(reply, settings = {}, { random = Math.random } = {}) {
  const config = { ...replyDelayDefaults, ...(settings ?? {}) };
  if (config.enabled === false) return 0;
  if (reply?.stickerOnly === true) return 0;
  const characters = visibleCharacterCount(reply?.text);
  if (!characters) return 0;

  const baseMs = Math.max(0, Number(config.baseMs) || 0);
  const msPerChar = Math.max(0, Number(config.msPerChar) || 0);
  const maxMs = Math.max(0, Number(config.maxMs) || 0);
  let delay = baseMs + characters * msPerChar;
  if (hasSlowPacingHint(reply)) delay *= 1.25;
  else if (isSimpleReply(reply?.text)) delay *= 0.85;
  const jitter = Math.min(0.5, Math.max(0, Number(config.jitter) || 0));
  if (jitter > 0) {
    delay *= 1 + (random() * 2 - 1) * jitter;
  }
  const bounded = maxMs > 0 ? Math.min(maxMs, delay) : delay;
  return Math.max(0, Math.round(bounded));
}

const UNSAFE_SEGMENT_PATTERN =
  /```|`[^`\n]+`|https?:\/\/|www\.|(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|.*\|)|\b(?:JSON|XML|YAML|HTML)\b/iu;
const ACTION_RESULT_PATTERN =
  /已(?:加入本次回复|发送|发布|点赞|收藏)|发送失败|发布结果不确定|结果不确定|操作已执行|QQ\s*空间|表情包已|图片已/iu;

function naturalSentenceParts(text) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  return (
    value.match(
      /[^。！？!?…]+[。！？!?…]+(?:[”’」』）)]*)|[^。！？!?…]+$/gu,
    ) ?? []
  )
    .map((part) => part.trim())
    .filter(Boolean);
}

export function canSegmentReply(reply, {
  event = null,
  settings = {},
  maxSegments = 2,
} = {}) {
  if (settings?.enabled === false || settings?.segments === false) return false;
  if (!["onebot", "qq"].includes(event?.channel)) return false;
  if (reply?.stickerOnly === true) return false;
  if ((reply?.faces ?? []).length > 0 || (reply?.images ?? []).length > 0) return false;
  const text = String(reply?.text ?? "").trim();
  const totalCharacters = visibleCharacterCount(text);
  if (totalCharacters < 12 || totalCharacters > 180) return false;
  if (
    UNSAFE_SEGMENT_PATTERN.test(text) ||
    ACTION_RESULT_PATTERN.test(text) ||
    reply?.actionExecuted === true ||
    reply?.operationResult === true
  ) {
    return false;
  }
  const parts = naturalSentenceParts(text);
  return (
    maxSegments >= 2 &&
    parts.length >= 2 &&
    parts.every((part) => {
      const characters = visibleCharacterCount(part);
      return characters >= 2 && characters <= 120;
    })
  );
}

function bestSentenceSplit(parts) {
  let total = parts.reduce((sum, part) => sum + visibleCharacterCount(part), 0);
  let left = "";
  let leftCount = 0;
  for (let index = 0; index < parts.length - 1; index += 1) {
    left += parts[index];
    leftCount += visibleCharacterCount(parts[index]);
    const rightCount = total - leftCount;
    if (leftCount >= 3 && rightCount >= 3 && leftCount / total >= 0.2) {
      return [left.trim(), parts.slice(index + 1).join("").trim()];
    }
  }
  return null;
}

export function planReplySegments(reply, {
  event = null,
  settings = {},
  random = Math.random,
  maxSegments = 2,
} = {}) {
  if (!canSegmentReply(reply, { event, settings, maxSegments })) {
    return [{ index: 0, total: 1, text: String(reply?.text ?? "") }];
  }
  const configuredProbability = Number(settings?.probability);
  const probability =
    Number.isFinite(configuredProbability) && configuredProbability >= 0
      ? Math.min(1, configuredProbability)
      : hasSlowPacingHint(reply)
        ? 0.5
        : 0.35;
  if (random() >= probability) {
    return [{ index: 0, total: 1, text: String(reply?.text ?? "") }];
  }
  const split = bestSentenceSplit(naturalSentenceParts(reply.text));
  if (!split) {
    return [{ index: 0, total: 1, text: String(reply?.text ?? "") }];
  }
  return split.map((text, index) => ({ index, total: 2, text }));
}

export function segmentReply(reply, segment) {
  if (segment.total <= 1) return reply;
  return {
    ...reply,
    text: segment.text,
    faces: [],
    images: [],
    stickerOnly: false,
    deliverySegment: {
      index: segment.index,
      total: segment.total,
    },
  };
}

export function calculateSegmentGap(
  reply,
  { random = Math.random, minMs = 180, maxMs = 900 } = {},
) {
  const low = Math.max(0, Math.min(minMs, maxMs));
  const high = Math.max(low, maxMs);
  const jitter = low + Math.max(0, random()) * (high - low);
  return Math.min(1_200, Math.round(jitter * (hasSlowPacingHint(reply) ? 1.25 : 1)));
}

export function conversationDeliveryKey(event) {
  return JSON.stringify([event.channel, event.scope, event.conversationId]);
}

export class ConversationDeliveryQueue {
  constructor({ sleep = defaultSleep } = {}) {
    if (typeof sleep !== "function") throw new TypeError("sleep 必须是函数");
    this.sleep = sleep;
    this._queues = new Map();
  }

  enqueue(key, { delayMs = 0, run, signal = null }) {
    if (typeof key !== "string" || !key) {
      return Promise.reject(new TypeError("会话 key 必须是非空字符串"));
    }
    if (typeof run !== "function") {
      return Promise.reject(new TypeError("run 必须是函数"));
    }
    const wait = Number.isFinite(delayMs) && delayMs > 0 ? Math.round(delayMs) : 0;
    if (signal?.aborted) {
      return Promise.reject(deliveryCancelledError());
    }
    const previous = this._queues.get(key) ?? Promise.resolve();
    const execution = (async () => {
      await previous;
      if (signal?.aborted) throw deliveryCancelledError();
      if (wait > 0) await this.sleep(wait, signal);
      if (signal?.aborted) throw deliveryCancelledError();
      return run();
    })();
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    this._queues.set(key, settled);
    settled.finally(() => {
      if (this._queues.get(key) === settled) this._queues.delete(key);
    });
    const cancellation = abortCancellation(signal);
    if (!cancellation.promise) return execution;
    return Promise.race([execution, cancellation.promise]).finally(
      cancellation.dispose,
    );
  }

  size() {
    return this._queues.size;
  }
}

export async function deliverPlannedReply({
  queue,
  key,
  event,
  reply,
  segments,
  delayMs = 0,
  signal = null,
  send,
  isAllowed = () => true,
  pauseBetween = null,
  beforeFirstSend = null,
  afterSegmentSent = null,
  onStatus = null,
}) {
  if (!queue || typeof queue.enqueue !== "function") {
    throw new TypeError("queue 必须提供 enqueue");
  }
  if (typeof send !== "function") throw new TypeError("send 必须是函数");
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new TypeError("segments 必须是非空数组");
  }
  const notify = (status, extra = {}) => {
    try {
      onStatus?.(status, extra);
    } catch {
      // Status callbacks must not affect delivery.
    }
  };
  return queue.enqueue(key, {
    delayMs,
    signal,
    run: async () => {
      let firstSendStarted = false;
      const sentSegments = [];
      for (const segment of segments) {
        if (segment.index > 0 && pauseBetween) {
          await pauseBetween(segment.index, reply);
        }
        if (!isAllowed()) {
          notify("suppressed", { sentSegments });
          return {
            status: sentSegments.length ? "partial" : "suppressed",
            sentSegments,
            suppressedAtSegment: segment.index,
          };
        }
        if (!firstSendStarted) {
          await beforeFirstSend?.();
          firstSendStarted = true;
          notify("sending");
        }
        try {
          await send(event, segmentReply(reply, segment));
        } catch (error) {
          notify("failed", {
            failedAtSegment: segment.index,
            sentSegments,
          });
          return {
            status: sentSegments.length ? "partial" : "failed",
            sentSegments,
            failedAtSegment: segment.index,
            error,
          };
        }
        sentSegments.push(segment);
        await afterSegmentSent?.(segment, {
          first: segment.index === 0,
          last: segment.index === segments.length - 1,
        });
      }
      notify("sent", { sentSegments });
      return { status: "sent", sentSegments };
    },
  });
}
