const DEFAULT_SILENT_MS = 2_000;
const MAX_SEEN_EVENTS = 2_000;

export class BatchCancelledError extends Error {
  constructor(message = "消息批次已取消") {
    super(message);
    this.name = "BatchCancelledError";
    this.code = "CANCELLED";
  }
}

export function isBatchCancelled(error) {
  return error?.name === "BatchCancelledError" || error?.code === "CANCELLED";
}

export function mergeEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    throw new TypeError("events 必须是非空数组");
  }
  const last = events[events.length - 1];
  const texts = events
    .map((event) => String(event?.text ?? "").trim())
    .filter(Boolean);
  const attachments = events.flatMap((event) =>
    Array.isArray(event?.attachments) ? event.attachments : [],
  );
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mergedId =
    typeof last?.id === "string" && last.id.trim()
      ? last.id
      : `merged-${suffix}`;
  return {
    ...last,
    id: mergedId,
    text: texts.join("\n"),
    attachments,
    timestamp: last?.timestamp ?? new Date().toISOString(),
    mergedCount: events.length,
  };
}

export function sleepWithSignal(ms, signal, {
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (signal?.aborted) return Promise.reject(new BatchCancelledError());
  const delay = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  if (!delay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeoutImpl(() => finish(), delay);
    timer?.unref?.();
    const onAbort = () => finish(new BatchCancelledError());
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function conversationKey(event) {
  return JSON.stringify([
    event.channel,
    event.scope,
    event.conversationId,
    event.userId,
  ]);
}

export class MessageBatcher {
  constructor({
    handler,
    silentMs = DEFAULT_SILENT_MS,
    logger = console,
    timers = globalThis,
    now = Date.now,
  } = {}) {
    if (typeof handler !== "function") throw new TypeError("handler 必须是函数");
    if (typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function") {
      throw new TypeError("timers 必须提供 setTimeout/clearTimeout");
    }
    this.handler = handler;
    this.silentMs = Number.isFinite(silentMs) && silentMs > 0
      ? Math.round(silentMs)
      : DEFAULT_SILENT_MS;
    this.logger = logger;
    this.timers = timers;
    this.now = now;
    this._states = new Map();
    this._seen = new Map();
    this._counter = 0;
    this._stopped = false;
  }

  enqueue(event, context = {}) {
    if (this._stopped) return { status: "stopped" };
    const seenKey = this._seenKey(event);
    if (this._seen.has(seenKey)) return { status: "duplicate" };
    this._rememberSeen(seenKey);

    const key = conversationKey(event);
    let state = this._states.get(key);
    if (!state) {
      state = {
        key,
        pending: [],
        active: null,
        phase: "idle",
        timer: null,
        controller: null,
        running: null,
      };
      this._states.set(key, state);
    }

    state.pending.push({ event, context });
    if (state.phase === "idle" || state.phase === "collecting") {
      this._schedule(state);
    } else if (state.phase === "generating" || state.phase === "delaying") {
      state.controller?.abort();
    }
    return { status: "batched" };
  }

  stop() {
    this._stopped = true;
    for (const state of this._states.values()) {
      this._clearTimer(state);
      state.controller?.abort();
    }
    this._states.clear();
    this._seen.clear();
  }

  size() {
    return this._states.size;
  }

  _schedule(state) {
    if (this._stopped) return;
    this._clearTimer(state);
    state.phase = "collecting";
    state.timer = this.timers.setTimeout(() => {
      state.timer = null;
      this._run(state);
    }, this.silentMs);
    state.timer?.unref?.();
  }

  async _run(state) {
    if (this._stopped || state.running) return;
    if (!state.pending.length) {
      state.phase = "idle";
      return;
    }

    const active = state.pending;
    state.pending = [];
    state.active = active;
    state.phase = "generating";
    const controller = new AbortController();
    state.controller = controller;
    let committed = false;

    const events = active.map((item) => item.event);
    const event = mergeEvents(events);
    const context = active[active.length - 1]?.context ?? {};
    const onBeforeSend = () => {
      if (state.active !== active) throw new BatchCancelledError();
      if (controller.signal.aborted) throw new BatchCancelledError();
      committed = true;
      state.phase = "sending";
    };

    const running = Promise.resolve().then(() =>
      this.handler({
        event,
        events,
        context,
        signal: controller.signal,
        onBeforeSend,
      }),
    );
    state.running = running;

    try {
      await running;
    } catch (error) {
      const cancelled = isBatchCancelled(error) || controller.signal.aborted;
      if (cancelled && !committed) {
        state.pending = [...active, ...state.pending];
      } else if (!cancelled) {
        try {
          this.logger?.error?.(
            "消息批次处理失败",
            String(error?.message ?? error),
          );
        } catch {
          // Logging must not break batching.
        }
      }
    } finally {
      if (state.active === active) state.active = null;
      state.running = null;
      state.controller = null;
      if (this._stopped) return;
      if (state.pending.length) this._schedule(state);
      else state.phase = "idle";
    }
  }

  _seenKey(event) {
    const id = typeof event?.id === "string" ? event.id.trim() : "";
    if (id) return `${event.channel}:${id}`;
    this._counter += 1;
    return `${event.channel}:${event.scope}:${event.conversationId}:${event.userId}:${this.now()}:${this._counter}`;
  }

  _rememberSeen(key) {
    this._seen.set(key, true);
    while (this._seen.size > MAX_SEEN_EVENTS) {
      this._seen.delete(this._seen.keys().next().value);
    }
  }

  _clearTimer(state) {
    if (!state.timer) return;
    this.timers.clearTimeout(state.timer);
    state.timer = null;
  }
}
