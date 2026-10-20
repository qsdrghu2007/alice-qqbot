import { replyDelayDefaults } from "./config.js";

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function visibleCharacterCount(text) {
  return Array.from(String(text ?? "").replace(/\s+/gu, "")).length;
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
  const jitter = Math.min(0.5, Math.max(0, Number(config.jitter) || 0));
  if (jitter > 0) {
    delay *= 1 + (random() * 2 - 1) * jitter;
  }
  const bounded = maxMs > 0 ? Math.min(maxMs, delay) : delay;
  return Math.max(0, Math.round(bounded));
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

  enqueue(key, { delayMs = 0, run }) {
    if (typeof key !== "string" || !key) {
      return Promise.reject(new TypeError("会话 key 必须是非空字符串"));
    }
    if (typeof run !== "function") {
      return Promise.reject(new TypeError("run 必须是函数"));
    }
    const wait = Number.isFinite(delayMs) && delayMs > 0 ? Math.round(delayMs) : 0;
    const previous = this._queues.get(key) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (wait > 0) await this.sleep(wait);
      return run();
    });
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this._queues.set(key, settled);
    settled.finally(() => {
      if (this._queues.get(key) === settled) this._queues.delete(key);
    });
    return current;
  }

  size() {
    return this._queues.size;
  }
}
