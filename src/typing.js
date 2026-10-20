import { conversationDeliveryKey } from "./delivery.js";

const DEFAULT_REFRESH_MS = 3_000;
const DEFAULT_BACKOFF_MS = 60_000;

export function typingEligible(event, config) {
  return (
    event?.channel === "onebot" &&
    event.scope === "private" &&
    Boolean(event.userId) &&
    config?.replyDelay?.typingIndicator !== false
  );
}

export class TypingIndicator {
  constructor({
    getConfig,
    adapter,
    logger = console,
    refreshMs = DEFAULT_REFRESH_MS,
    backoffMs = DEFAULT_BACKOFF_MS,
    timers = globalThis,
    now = Date.now,
  } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (!adapter || typeof adapter.setInputStatus !== "function") {
      throw new TypeError("adapter.setInputStatus 必须是函数");
    }
    if (typeof timers.setInterval !== "function" || typeof timers.clearInterval !== "function") {
      throw new TypeError("timers 必须提供 setInterval/clearInterval");
    }
    this.getConfig = getConfig;
    this.adapter = adapter;
    this.logger = logger;
    this.refreshMs = Math.max(250, Number(refreshMs) || DEFAULT_REFRESH_MS);
    this.backoffMs = Math.max(0, Number(backoffMs) || 0);
    this.timers = timers;
    this.now = now;
    this._entries = new Map();
  }

  start(event) {
    if (!this._shouldStart(event)) return () => {};

    const key = conversationDeliveryKey(event);
    let entry = this._entries.get(key);
    if (!entry) {
      entry = {
        event: { ...event },
        count: 0,
        timer: null,
        active: true,
        retryAt: 0,
      };
      this._entries.set(key, entry);
    } else {
      entry.event = { ...event };
    }

    entry.count += 1;
    if (entry.count === 1) {
      this._send(entry);
      entry.timer = this.timers.setInterval(() => {
        if (this._shouldContinue(entry)) this._send(entry);
      }, this.refreshMs);
      entry.timer?.unref?.();
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this._stop(key, entry);
    };
  }

  stopAll() {
    for (const entry of this._entries.values()) {
      entry.active = false;
      this._clear(entry.timer);
    }
    this._entries.clear();
  }

  size() {
    return this._entries.size;
  }

  _shouldStart(event) {
    const config = this.getConfig();
    return typingEligible(event, config) && config?.policy?.paused !== true;
  }

  _shouldContinue(entry) {
    if (!entry.active) return false;
    const config = this.getConfig();
    return typingEligible(entry.event, config) && config?.policy?.paused !== true;
  }

  _send(entry) {
    if (!entry.active) return;
    const now = this.now();
    if (entry.retryAt > now) return;
    Promise.resolve()
      .then(() => this.adapter.setInputStatus(entry.event))
      .catch((error) => {
        entry.retryAt = this.now() + this.backoffMs;
        try {
          this.logger?.debug?.(
            "typing indicator failed",
            String(error?.message ?? error),
          );
        } catch {
          // Logging must not affect delivery.
        }
      });
  }

  _stop(key, entry) {
    if (this._entries.get(key) !== entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    entry.active = false;
    this._clear(entry.timer);
    this._entries.delete(key);
  }

  _clear(timer) {
    if (!timer) return;
    this.timers.clearInterval(timer);
  }
}
