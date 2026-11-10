// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
const DEFAULT_SILENT_MS = 2_000;
const ACTIVE_CONVERSATION_WINDOW_MS = 3 * 60_000;
const DEFAULT_IDLE_RETENTION_MS = ACTIVE_CONVERSATION_WINDOW_MS;
const MAX_SEEN_EVENTS = 2_000;
const MAX_SEMANTIC_EXTRA_MS = 1_000;
const MIN_SEMANTIC_EXTRA_MS = 300;
const IMAGE_EXTRA_MS = 500;
const HABIT_EXTRA_MS = 300;
const MAX_ATTACHMENT_SUMMARY_CHARS = 100;
const MAX_ATTACHMENT_TAGS = 6;
const MAX_ATTACHMENT_LABEL_CHARS = 260;

const EXPLICIT_QUESTION_PATTERN =
  /[?？]|(?:吗|呢|嘛|么|没|没有|是不是|要不要|好不好|行不行)\s*[。.!！~～]*$/iu;
const UNFINISHED_PATTERN =
  /(?:…+|\.{3,}|[,，、;；:：——\-])\s*$|(?:然后|因为|所以|但是|不过|而且|如果|要是|我觉得|我想说|我跟你说件事|我跟你说|事情是这样的)\s*$/iu;
const COMPLETE_END_PATTERN = /(?:[。.!！?？…~～]|[吧啊呀啦哦嘛呢])\s*$/u;
const ACK_UNITS = [
  "知道了",
  "有道理",
  "确实",
  "对的",
  "对啊",
  "是啊",
  "是的",
  "没错",
  "了解",
  "收到",
  "谢谢",
  "谢啦",
  "好的",
  "好呀",
  "好吧",
  "可以",
  "行吧",
  "笑死",
  "okay",
  "ok",
  "哈哈",
  "呵呵",
  "嘿嘿",
  "嗯嗯",
  "哦哦",
  "噢噢",
  "233",
  "hh",
  "好",
  "行",
  "嗯",
  "哦",
  "噢",
  "喔",
].sort((left, right) => right.length - left.length);

function normalizeAckText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，,。.!！~～、;；:："'“”‘’（）()【】[\]]+/gu, "");
}

export function isExplicitAcknowledgement(text, { attachments = [] } = {}) {
  if (Array.isArray(attachments) && attachments.length > 0) return false;
  let remaining = normalizeAckText(text);
  if (!remaining || remaining.length > 12) return false;
  while (remaining) {
    const unit = ACK_UNITS.find((candidate) => remaining.startsWith(candidate));
    if (!unit) return false;
    remaining = remaining.slice(unit.length);
  }
  return true;
}

function safeAttachmentDetail(value, maxChars = MAX_ATTACHMENT_SUMMARY_CHARS) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/(?:https?|ftp):\/\/[^\s<>"'，。！？；）)\]}]+/giu, " ")
    .replace(/data:[^\s<>"'，。！？；）)\]}]+/giu, " ")
    .replace(/\b(?:bearer|qqbot)\s+[^\s,;]+/giu, " ")
    .replace(/\b(?:authorization\s*:\s*)?(?:bearer|token|secret|access_token)\s*[:=]\s*[^\s,;]+/giu, " ")
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'，。！？；]+/gu, " ")
    .replace(/(?:^|[\s(（])\/(?:[^\s/]+\/)+[^\s<>"'，。！？；]+/gu, " ")
    .replace(/[A-Za-z0-9+/=_-]{48,}/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxChars);
}

function attachmentLabel(attachment) {
  const rawType = String(attachment?.type ?? "").toLocaleLowerCase("en-US");
  const type = /^[a-z0-9_-]{1,20}$/u.test(rawType) ? rawType : "attachment";
  const summary = safeAttachmentDetail(attachment?.summary);
  const tags = Array.isArray(attachment?.tags)
    ? attachment.tags
        .map((tag) => safeAttachmentDetail(tag, 24))
        .filter(Boolean)
        .slice(0, MAX_ATTACHMENT_TAGS)
    : [];
  const details = [
    ...new Set(
      [summary, ...tags].filter(
        (item) =>
          item &&
          !/^\[?(?:动画表情|表情包|贴纸|图片|image|sticker)\]?$/iu.test(item),
      ),
    ),
  ];
  const detail = details.join("；").slice(0, MAX_ATTACHMENT_SUMMARY_CHARS);
  const subType = Number(attachment?.subType ?? attachment?.sub_type ?? 0);
  const sticker =
    type === "mface" ||
    (type === "image" &&
      (subType === 1 || /动画表情|表情包|贴纸/u.test(summary)));
  const label = sticker
    ? "表情"
    : type === "image"
      ? "图片"
      : type === "video"
        ? "视频"
        : type === "audio"
          ? "语音"
          : type === "file"
            ? "文件"
            : "附件";
  if (detail) return `[${label}：${detail}]`.slice(0, MAX_ATTACHMENT_LABEL_CHARS);
  if (label === "表情") return "[表情]";
  return `[${label}，内容未识别]`;
}

export function eventHistoryText(event) {
  const text = String(event?.text ?? "").trim();
  const attachments = Array.isArray(event?.attachments) ? event.attachments : [];
  const attachmentText = attachments.map(attachmentLabel).join(" ");
  if (text && attachmentText) return `${text}\n${attachmentText}`;
  return text || attachmentText || "（无文字）";
}

function semanticMaxWait(base) {
  return Math.max(base + MIN_SEMANTIC_EXTRA_MS, Math.min(15_000, base * 3));
}

function normalizeSilentMs(value) {
  return Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_SILENT_MS;
}

export function calculateInputSilence(
  text,
  silentMs = DEFAULT_SILENT_MS,
  { attachments = [], sessionMessages = 0 } = {},
) {
  const base =
    Number.isFinite(silentMs) && silentMs > 0
      ? Math.round(silentMs)
      : DEFAULT_SILENT_MS;
  const lastLine = String(text ?? "").trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
  if (EXPLICIT_QUESTION_PATTERN.test(lastLine)) return base;
  let extra = 0;
  if (UNFINISHED_PATTERN.test(lastLine)) {
    extra = Math.min(
      MAX_SEMANTIC_EXTRA_MS,
      Math.max(MIN_SEMANTIC_EXTRA_MS, Math.round(base * 0.5)),
    );
  }
  if (!lastLine && (attachments ?? []).length > 0) {
    extra += IMAGE_EXTRA_MS;
  } else if (
    (attachments ?? []).length > 0 &&
    !COMPLETE_END_PATTERN.test(lastLine) &&
    !UNFINISHED_PATTERN.test(lastLine)
  ) {
    extra += MIN_SEMANTIC_EXTRA_MS;
  }
  if (
    Number.isInteger(sessionMessages) &&
    sessionMessages >= 3 &&
    UNFINISHED_PATTERN.test(lastLine) &&
    !COMPLETE_END_PATTERN.test(lastLine) &&
    !isExplicitAcknowledgement(lastLine)
  ) {
    extra += HABIT_EXTRA_MS;
  }
  if (!extra) return base;
  return Math.min(
    semanticMaxWait(base),
    base +
      Math.min(
        MAX_SEMANTIC_EXTRA_MS + HABIT_EXTRA_MS,
        Math.round(extra),
      ),
  );
}

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
    idleRetentionMs = DEFAULT_IDLE_RETENTION_MS,
    logger = console,
    timers = globalThis,
    now = Date.now,
  } = {}) {
    if (typeof handler !== "function") throw new TypeError("handler 必须是函数");
    if (typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function") {
      throw new TypeError("timers 必须提供 setTimeout/clearTimeout");
    }
    this.handler = handler;
    this.silentMs = normalizeSilentMs(silentMs);
    this.idleRetentionMs =
      Number.isFinite(idleRetentionMs) && idleRetentionMs >= 0
        ? Math.round(idleRetentionMs)
        : DEFAULT_IDLE_RETENTION_MS;
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
        supplements: [],
        phase: "idle",
        timer: null,
        idleTimer: null,
        controller: null,
        running: null,
        collectStartedAt: null,
        collectCount: 0,
        lastTurnAt: null,
        recentBursts: [],
      };
      this._states.set(key, state);
    }
    this._cancelIdleCleanup(state);

    if (state.phase === "generating" || state.phase === "delaying") {
      if (
        !state.controller?.signal.aborted &&
        isExplicitAcknowledgement(event?.text, { attachments: event?.attachments })
      ) {
        state.supplements.push({ event, context });
        return { status: "supplemented" };
      }
      if (!state.controller?.signal.aborted) state.controller?.abort();
    }
    state.pending.push({ event, context });
    if (state.phase === "idle" || state.phase === "collecting") {
      if (state.collectStartedAt === null) {
        state.collectStartedAt = this.now();
        state.collectCount = 0;
      }
      state.collectCount += 1;
      this._schedule(state);
    }
    return { status: "batched" };
  }

  stop() {
    this._stopped = true;
    for (const state of this._states.values()) {
      this._clearTimer(state);
      this._cancelIdleCleanup(state);
      state.controller?.abort();
    }
    this._states.clear();
    this._seen.clear();
  }

  size() {
    return this._states.size;
  }

  updateConfig({ inputDelayMs, idleRetentionMs } = {}) {
    if (inputDelayMs !== undefined) {
      this.silentMs = normalizeSilentMs(inputDelayMs);
      for (const state of this._states.values()) {
        if (state.phase === "collecting") this._schedule(state);
      }
    }
    if (idleRetentionMs !== undefined) {
      this.idleRetentionMs =
        Number.isFinite(idleRetentionMs) && idleRetentionMs >= 0
          ? Math.round(idleRetentionMs)
          : DEFAULT_IDLE_RETENTION_MS;
      for (const state of this._states.values()) {
        if (state.phase === "idle") {
          this._cancelIdleCleanup(state);
          this._scheduleIdleCleanup(state);
        }
      }
    }
  }

  _schedule(state) {
    if (this._stopped) return;
    this._cancelIdleCleanup(state);
    this._clearTimer(state);
    state.phase = "collecting";
    if (state.collectStartedAt === null) {
      state.collectStartedAt = this.now();
      state.collectCount = Math.max(state.collectCount, state.pending.length);
    }
    const latestText = state.pending.at(-1)?.event?.text;
    const latestAttachments = state.pending.at(-1)?.event?.attachments;
    const recentBurstMessages = state.recentBursts.reduce(
      (sum, size) => sum + Math.max(0, size - 1),
      0,
    );
    const desired = calculateInputSilence(latestText, this.silentMs, {
      attachments: Array.isArray(latestAttachments) ? latestAttachments : [],
      sessionMessages: state.collectCount + Math.min(4, recentBurstMessages),
    });
    const maxWait = Math.max(
      desired,
      semanticMaxWait(this.silentMs),
    );
    const elapsed =
      state.collectStartedAt === null ? 0 : Math.max(0, this.now() - state.collectStartedAt);
    const delay = Math.min(desired, Math.max(0, maxWait - elapsed));
    state.timer = this.timers.setTimeout(() => {
      state.timer = null;
      this._run(state);
    }, delay);
    state.timer?.unref?.();
  }

  async _run(state) {
    if (this._stopped || state.running) return;
    if (!state.pending.length) {
      state.phase = "idle";
      this._scheduleIdleCleanup(state);
      return;
    }

    const active = state.pending;
    state.pending = [];
    state.active = active;
    state.recentBursts.push(active.length);
    if (state.recentBursts.length > 4) state.recentBursts.shift();
    state.collectStartedAt = null;
    state.collectCount = 0;
    state.phase = "generating";
    const controller = new AbortController();
    state.controller = controller;
    let committed = false;

    const events = active.map((item) => item.event);
    const turnStartedAt = this.now();
    const conversationActive =
      Number.isFinite(state.lastTurnAt) &&
      turnStartedAt - state.lastTurnAt <= ACTIVE_CONVERSATION_WINDOW_MS;
    state.lastTurnAt = turnStartedAt;
    const event = { ...mergeEvents(events), conversationActive };
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
        getSupplements: () =>
          state.active === active
            ? state.supplements.map((item) => item.event)
            : [],
        markSupplementsCommitted: () => {
          if (state.active === active) state.supplements = [];
        },
      }),
    );
    state.running = running;

    try {
      await running;
    } catch (error) {
      const cancelled = isBatchCancelled(error) || controller.signal.aborted;
      if (cancelled && !committed) {
        state.pending = [...active, ...state.supplements, ...state.pending];
        state.supplements = [];
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
      state.supplements = [];
      state.running = null;
      state.controller = null;
      if (this._stopped) return;
      if (state.pending.length) this._schedule(state);
      else {
        state.phase = "idle";
        this._scheduleIdleCleanup(state);
      }
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

  _scheduleIdleCleanup(state) {
    this._cancelIdleCleanup(state);
    if (this._stopped || this.idleRetentionMs <= 0) return;
    state.idleTimer = this.timers.setTimeout(() => {
      state.idleTimer = null;
      if (
        this._stopped ||
        state.phase !== "idle" ||
        state.pending.length ||
        state.active ||
        state.supplements.length ||
        state.running ||
        state.controller ||
        state.timer
      ) {
        return;
      }
      this._states.delete(state.key);
    }, this.idleRetentionMs);
    state.idleTimer?.unref?.();
  }

  _cancelIdleCleanup(state) {
    if (!state.idleTimer) return;
    this.timers.clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}
