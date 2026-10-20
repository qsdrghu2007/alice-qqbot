import WebSocket from "ws";
import {
  AdapterError,
  asAdapterError,
  bodyFromOneBotReply,
  logSafely,
  maskId,
  normalizeOneBotId,
  normalizePolicy,
  oneBotEchoMatches,
  parseOneBotMessage,
  policyReason,
  redactSecrets,
} from "./shared.js";

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const RATE_LIMIT_BLOCK_MS = 60_000;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const READ_ONLY_ACTIONS = new Set(["get_status", "get_login_info"]);
const CHAT_ACTION_POLICY = new Set([
  "send_private_msg",
  "send_group_msg",
  "send_like",
  "set_input_status",
]);
const RESTRICTION_RANK = { "rate-limit": 1, "permission-disabled": 2, "risk-control": 3 };

export class OneBotAdapter {
  constructor({
    getConfig,
    logger = console,
    socketFactory = (url, options) => new WebSocket(url, options),
    timers = globalThis,
    random = Math.random,
  } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig must be a function");
    if (typeof socketFactory !== "function") throw new TypeError("socketFactory must be a function");

    this.getConfig = getConfig;
    this.logger = logger;
    this.socketFactory = socketFactory;
    this.timers = timers;
    this.random = random;
    this._running = false;
    this._state = "stopped";
    this._connected = false;
    this._online = null;
    this._good = null;
    this._socketOpenedAt = 0;
    this._socket = null;
    this._onMessage = null;
    this._generation = 0;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._lastError = null;
    this._lastEventAt = null;
    this._lastConfig = null;
    this._selfId = null;
    this._pending = new Map();
    this._echoCounter = 0;
    this._actionBlocked = false;
    this._blockedReason = null;
    this._blockedUntil = null;
  }

  async start(onMessage) {
    if (typeof onMessage !== "function") throw new TypeError("onMessage must be a function");
    if (this._running) return;
    this._clearActionBlock();

    const config = this._readConfig();
    if (!config.enabled) {
      this._state = "disabled";
      return;
    }
    if (!config.url) {
      throw new AdapterError("OneBot URL is required", "ONEBOT_CONFIG_INVALID", {
        category: "config",
        fatal: true,
      });
    }

    this._lastConfig = config;
    this._onMessage = onMessage;
    this._running = true;
    this._generation += 1;
    this._reconnectAttempts = 0;
    this._socketOpenedAt = 0;
    this._state = "connecting";
    this._lastError = null;
    this._connect(this._generation);
  }

  async stop() {
    this._running = false;
    this._generation += 1;
    this._state = "stopped";
    this._connected = false;
    this._online = null;
    this._good = null;
    this._socketOpenedAt = 0;
    this._clearReconnectTimer();
    this._rejectPending(
      new AdapterError("OneBot adapter stopped", "ONEBOT_DISCONNECTED", {
        category: "state",
        retryable: true,
      }),
    );
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else if (typeof socket.close === "function") socket.close(1000, "adapter stopped");
      } catch (error) {
        logSafely(this.logger, "debug", `OneBot socket close failed: ${error?.message ?? error}`);
      }
    }
  }

  async send(event, reply) {
    if (!event || !["private", "group"].includes(event.scope)) {
      throw new AdapterError("Invalid OneBot event", "ONEBOT_EVENT_INVALID", {
        category: "validation",
      });
    }
    const policy = normalizePolicy(this._currentPolicy());
    if (policy.paused) {
      throw new AdapterError("OneBot policy is paused", "POLICY_PAUSED", { category: "policy" });
    }

    const message = bodyFromOneBotReply(reply);
    if (event.scope === "private") {
      return this.call("send_private_msg", {
        user_id: normalizeOneBotId(event.userId),
        message,
      });
    }
    return this.call("send_group_msg", {
      group_id: normalizeOneBotId(event.groupId ?? event.conversationId),
      message,
    });
  }

  async setInputStatus(event) {
    if (!event || event.scope !== "private") return { status: "skipped" };
    if (event.channel && event.channel !== "onebot") return { status: "skipped" };
    const policy = normalizePolicy(this._currentPolicy());
    if (policy.paused) return { status: "paused" };
    const userId = String(event.userId ?? "").trim();
    if (!/^\d+$/.test(userId)) return { status: "skipped" };
    return this.call(
      "set_input_status",
      { user_id: userId, event_type: 1 },
      { bestEffort: true },
    );
  }

  async fetchHistory(
    event,
    {
      maxAgeMs = HISTORY_MAX_AGE_MS,
      pageSize = HISTORY_PAGE_SIZE,
      now = Date.now,
    } = {},
  ) {
    if (!event || event.channel !== "onebot") return [];
    if (!["private", "group"].includes(event.scope)) return [];
    if (this._refreshRestrictionState()) return [];

    const currentTime = typeof now === "function" ? Number(now()) : Number(now);
    const cutoff = currentTime - Math.max(0, Number(maxAgeMs) || 0);
    const boundedPageSize =
      Number.isInteger(pageSize) && pageSize > 0 ? pageSize : HISTORY_PAGE_SIZE;
    const action =
      event.scope === "private" ? "get_friend_msg_history" : "get_group_msg_history";
    const target =
      event.scope === "private"
        ? { user_id: String(event.userId) }
        : { group_id: String(event.groupId ?? event.conversationId) };

    const fetchPage = async (messageSeq, reverseOrder) => {
      const params = {
        ...target,
        count: boundedPageSize,
        disable_get_url: true,
        parse_mult_msg: false,
      };
      if (messageSeq) {
        params.message_seq = String(messageSeq);
        params.reverse_order = reverseOrder === true;
      }
      const data = await this.call(action, params);
      return Array.isArray(data?.messages) ? data.messages : [];
    };

    const records = [];
    const seen = new Set();
    let messageSeq = null;
    let reverseOrder = true;
    let triedAlternative = false;
    let oldestTime = Infinity;

    for (;;) {
      const page = await fetchPage(messageSeq, reverseOrder);
      if (!page.length) break;

      let pageMinTime = Infinity;
      let pageOldestMessage = null;
      let hasNew = false;
      for (const message of page) {
        const id = historyMessageId(message);
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const time = historyMessageTime(message);
        if (time === null) continue;
        hasNew = true;
        if (time < pageMinTime) {
          pageMinTime = time;
          pageOldestMessage = message;
        }
        if (time < cutoff) continue;
        const normalized = normalizeHistoryMessage(message, time);
        if (normalized) records.push(normalized);
      }

      if (!hasNew || pageMinTime === Infinity) {
        if (messageSeq && !triedAlternative) {
          triedAlternative = true;
          reverseOrder = !reverseOrder;
          continue;
        }
        break;
      }
      if (pageMinTime < cutoff) break;
      if (pageMinTime >= oldestTime) {
        if (messageSeq && !triedAlternative) {
          triedAlternative = true;
          reverseOrder = !reverseOrder;
          continue;
        }
        break;
      }

      triedAlternative = false;
      oldestTime = pageMinTime;
      const nextSeq = historyMessageSeq(pageOldestMessage);
      if (!nextSeq) break;
      messageSeq = nextSeq;
      reverseOrder = true;
    }

    return records.sort((left, right) => right.time - left.time);
  }

  async like(userId, times = 1) {
    const policy = normalizePolicy(this._currentPolicy());
    if (policy.paused) {
      throw new AdapterError("OneBot actions are paused", "POLICY_PAUSED", {
        category: "policy",
      });
    }
    if (!policy.autoActions) {
      throw new AdapterError("OneBot automatic actions are disabled", "AUTO_ACTIONS_DISABLED", {
        category: "policy",
      });
    }
    const count = Number(times);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new AdapterError(
        "OneBot like count must be an integer from 1 to 10",
        "ONEBOT_LIKE_ARGUMENT_INVALID",
        { category: "validation" },
      );
    }
    const target = String(userId ?? "").trim();
    const normalizedTarget = normalizeOneBotId(target);
    if (
      !/^\d+$/.test(target) ||
      (this._selfId && String(normalizedTarget) === this._selfId)
    ) {
      throw new AdapterError(
        "OneBot like target must be another QQ numeric user",
        "ONEBOT_LIKE_TARGET_INVALID",
        { category: "validation" },
      );
    }
    return this.call("send_like", {
      user_id: normalizedTarget,
      times: count,
    });
  }

  /**
   * Internal integration API. Callers trusted by the application may invoke
   * OneBot actions through the existing echo correlation and error checks.
   */
  async call(action, params = {}, { bestEffort = false } = {}) {
    const name = String(action ?? "").trim();
    if (!name) {
      throw new AdapterError("OneBot action is required", "ONEBOT_ACTION_INVALID", {
        category: "validation",
      });
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new AdapterError("OneBot params must be an object", "ONEBOT_PARAMS_INVALID", {
        category: "validation",
      });
    }
    this._assertActionAllowed(name);
    this._assertCallPolicy(name);
    if (!this._connected || !this._socket || this._socket.readyState !== 1) {
      throw new AdapterError("OneBot is not connected", "ONEBOT_DISCONNECTED", {
        category: "network",
        retryable: true,
      });
    }
    if (this._online === false) {
      throw new AdapterError(
        "OneBot WebSocket is connected but the QQ account is offline",
        "ONEBOT_ACCOUNT_OFFLINE",
        { category: "control", retryable: true },
      );
    }

    const socket = this._socket;
    const echo = `ob-${(this._echoCounter += 1)}-${Math.floor(this.random() * 1_000_000)}`;
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this._pending.delete(echo);
        reject(
          new AdapterError(
            `OneBot ${name} timed out after ${this._lastConfig.timeoutMs}ms`,
            "ONEBOT_API_TIMEOUT",
            { category: "network", retryable: true },
          ),
        );
      }, this._lastConfig.timeoutMs);
      timer?.unref?.();
      this._pending.set(echo, {
        resolve,
        reject,
        timer,
        action: name,
        bestEffort: bestEffort === true,
      });
      try {
        socket.send(JSON.stringify({ action: name, params, echo }));
      } catch (error) {
        this._pending.delete(echo);
        this._clearTimer("timeout", timer);
        reject(
          asAdapterError(error, "ONEBOT_SEND_FAILED", {
            category: "network",
            retryable: true,
          }),
        );
      }
    });
  }

  status() {
    const restricted = this._refreshRestrictionState();
    return {
      channel: "onebot",
      enabled: this._lastConfig?.enabled === true,
      running: this._running,
      state: this._state,
      transportConnected: this._connected,
      online: this._online,
      good: this._good,
      connected: this._connected && this._online === true,
      ready: this._connected && this._online === true && this._good !== false,
      restricted,
      actionBlocked: restricted,
      blockedReason: restricted ? this._blockedReason : null,
      blockedUntil: restricted ? this._blockedUntil : null,
      url: redactUrl(this._lastConfig?.url),
      hasToken: Boolean(this._lastConfig?.token),
      selfId: maskId(this._selfId),
      reconnectAttempts: this._reconnectAttempts,
      pendingRequests: this._pending.size,
      lastEventAt: this._lastEventAt,
      lastError: this._lastError
        ? {
            code: this._lastError.code,
            category: this._lastError.category,
            message: redactSecrets(this._lastError.message),
          }
        : null,
    };
  }

  _readConfig() {
    const config = this.getConfig() ?? {};
    const onebot = config.onebot ?? {};
    return {
      enabled: onebot.enabled === true,
      url: String(onebot.url ?? "").trim(),
      token: String(onebot.token ?? ""),
      timeoutMs: positive(onebot.timeoutMs, 10_000),
      maxReconnectAttempts: nonNegative(onebot.maxReconnectAttempts, 8),
      botUserIds: (Array.isArray(onebot.botUserIds) ? onebot.botUserIds : []).map(String),
      policy: config.policy ?? {},
    };
  }

  _currentPolicy() {
    return this.getConfig()?.policy ?? this._lastConfig?.policy ?? {};
  }

  _connect(generation) {
    if (!this._running || generation !== this._generation) return;
    this._state = "connecting";

    let socket;
    try {
      const config = this._lastConfig;
      const headers = { "User-Agent": "xiaoyu-qqbot/0.1" };
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      socket = this.socketFactory(config.url, {
        headers,
        handshakeTimeout: config.timeoutMs,
      });
    } catch (error) {
      const adapterError = asAdapterError(error, "ONEBOT_CONNECT_FAILED", {
        category: "network",
        retryable: true,
      });
      this._reportError(adapterError);
      this._scheduleReconnect(generation);
      return;
    }

    this._socket = socket;
    socket.on("open", () => {
      if (!this._ownsSocket(socket, generation)) return;
      this._connected = true;
      this._online = null;
      this._good = null;
      this._socketOpenedAt = Date.now();
      this._state = "transport-connected";
      this._refreshOnlineStatus().catch((error) => {
        this._reportError(error);
      });
    });
    socket.on("message", (data) => {
      if (!this._ownsSocket(socket, generation)) return;
      try {
        this._handleMessage(data);
      } catch (error) {
        this._reportError(
          asAdapterError(error, "ONEBOT_MESSAGE_INVALID", { category: "protocol" }),
        );
      }
    });
    socket.on("error", (error) => {
      if (!this._ownsSocket(socket, generation)) return;
      this._reportError(
        asAdapterError(error, "ONEBOT_SOCKET_ERROR", {
          category: "network",
          retryable: true,
        }),
      );
    });
    socket.on("close", () => {
      if (!this._ownsSocket(socket, generation)) return;
      this._socket = null;
      this._connected = false;
      this._online = null;
      this._good = null;
      if (this._socketOpenedAt > 0 && Date.now() - this._socketOpenedAt >= 5_000) {
        this._reconnectAttempts = 0;
      }
      this._socketOpenedAt = 0;
      this._state = "disconnected";
      this._rejectPending(
        new AdapterError(
          "OneBot disconnected before the API response arrived",
          "ONEBOT_DISCONNECTED",
          { category: "network", retryable: true },
        ),
      );
      this._scheduleReconnect(generation);
    });
  }

  _handleMessage(raw) {
    const payload = JSON.parse(decodeSocketData(raw));
    if (!payload || typeof payload !== "object") {
      throw new AdapterError("OneBot payload must be an object", "ONEBOT_MESSAGE_INVALID", {
        category: "protocol",
      });
    }

    if (payload.echo !== undefined) {
      for (const [echo, pending] of this._pending) {
        if (!oneBotEchoMatches(payload.echo, echo)) continue;
        this._pending.delete(echo);
        this._clearTimer("timeout", pending.timer);
        if (Number(payload.retcode) === 0 || (payload.status === "ok" && payload.retcode == null)) {
          pending.resolve(payload.data ?? payload);
        } else {
          const failure = classifyOneBotResult(payload, pending.action);
          if (!pending.bestEffort) this._applyRestriction(failure);
          pending.reject(failure);
        }
        return;
      }
      logSafely(this.logger, "debug", "OneBot response had an unknown echo; ignored");
      return;
    }

    if (payload.post_type === "meta_event") {
      this._selfId = String(payload.self_id ?? this._selfId ?? "");
      this._applyAccountStatus(payload.status);
      return;
    }

    if (payload.post_type !== "message" || !["private", "group"].includes(payload.message_type)) {
      return;
    }
    this._handleEvent(payload).catch((error) => {
      this._reportError(
        asAdapterError(error, "ONEBOT_ON_MESSAGE_FAILED", { category: "handler" }),
      );
    });
  }

  async _handleEvent(payload) {
    this._selfId = String(payload.self_id ?? this._selfId ?? "");
    if (this._refreshRestrictionState()) return;
    const userId = String(payload.user_id ?? payload.sender?.user_id ?? "");
    if (!userId || (this._selfId && userId === this._selfId)) return;
    if (
      payload.sender?.is_bot === true ||
      payload.sender?.bot === true ||
      payload.sender?.role === "bot"
    ) {
      return;
    }
    if (this._lastConfig.botUserIds.includes(userId)) return;

    const parsed = parseOneBotMessage(payload.message);
    const rawMessage = String(payload.raw_message ?? "");
    const mentionedSelf =
      parsed.mentionId === this._selfId ||
      Boolean(this._selfId && rawMessage.includes(`[CQ:at,qq=${this._selfId}]`));
    const scope = payload.message_type;
    if (scope === "group" && !mentionedSelf) return;

    const groupId = scope === "group" ? String(payload.group_id ?? "") : undefined;
    if (scope === "group" && !groupId) return;
    const event = {
      id: String(payload.message_id ?? ""),
      channel: "onebot",
      userId,
      scope,
      conversationId: scope === "group" ? groupId : userId,
      ...(groupId ? { groupId } : {}),
      text: parsed.text || (Array.isArray(payload.message) ? "" : rawMessage),
      attachments: parsed.attachments,
      links: Array.isArray(parsed.links) ? parsed.links : [],
      timestamp: Number.isFinite(Number(payload.time))
        ? new Date(Number(payload.time) * 1_000).toISOString()
        : new Date().toISOString(),
    };
    if (!event.id) return;

    this._lastEventAt = new Date().toISOString();
    const policy = normalizePolicy(this._currentPolicy());
    const reason = policyReason(event, policy);
    if (reason) {
      logSafely(this.logger, "debug", `OneBot inbound skipped: ${reason}`);
      return;
    }
    await this._onMessage(event);
  }

  async _refreshOnlineStatus() {
    try {
      const data = await this.call("get_status", {});
      this._applyAccountStatus(data);
    } catch (error) {
      this._online = null;
      this._good = null;
      if (!["ONEBOT_API_ERROR", "ONEBOT_API_TIMEOUT"].includes(error?.code)) throw error;
    }
  }

  _applyAccountStatus(status) {
    if (!status || typeof status !== "object") return;
    if (typeof status.online === "boolean") this._online = status.online;
    if (typeof status.good === "boolean") this._good = status.good;
    if (!this._connected) return;
    if (this._online === false) {
      this._state = "account-offline";
    } else if (this._online === true) {
      this._state = this._good === false ? "account-unhealthy" : "ready";
    } else {
      this._state = "transport-connected";
    }
  }

  _assertActionAllowed(action) {
    if (READ_ONLY_ACTIONS.has(action) || !this._refreshRestrictionState()) return;
    throw new AdapterError(
      `OneBot side-effect action ${action} is blocked: ${this._blockedReason}`,
      "ONEBOT_ACTION_BLOCKED",
      {
        category: "restriction",
        retryable: this._blockedUntil !== null,
      },
    );
  }

  _assertCallPolicy(action) {
    if (!CHAT_ACTION_POLICY.has(action)) return;
    const policy = normalizePolicy(this._currentPolicy());
    if (policy.paused) {
      throw new AdapterError("OneBot policy is paused", "POLICY_PAUSED", {
        category: "policy",
      });
    }
    if (action === "send_like" && !policy.autoActions) {
      throw new AdapterError("OneBot automatic actions are disabled", "AUTO_ACTIONS_DISABLED", {
        category: "policy",
      });
    }
  }

  _applyRestriction(error) {
    const restriction = error?.restriction;
    if (!restriction) return;
    const permanent = restriction !== "rate-limit";
    const currentRank = RESTRICTION_RANK[this._blockedReason] ?? 0;
    const nextRank = RESTRICTION_RANK[restriction] ?? 0;
    if (!this._actionBlocked || nextRank > currentRank || (!permanent && currentRank === nextRank)) {
      this._actionBlocked = true;
      this._blockedReason = restriction;
      this._blockedUntil = permanent ? null : Date.now() + RATE_LIMIT_BLOCK_MS;
    }
    this._reportError(error);
  }

  _refreshRestrictionState() {
    if (
      this._actionBlocked &&
      this._blockedUntil !== null &&
      Date.now() >= this._blockedUntil
    ) {
      this._clearActionBlock();
    }
    return this._actionBlocked;
  }

  _clearActionBlock() {
    this._actionBlocked = false;
    this._blockedReason = null;
    this._blockedUntil = null;
  }

  _scheduleReconnect(generation) {
    if (!this._running || generation !== this._generation || this._reconnectTimer) return;
    if (this._reconnectAttempts >= this._lastConfig.maxReconnectAttempts) {
      this._reportError(
        new AdapterError(
          `OneBot reconnect attempts exhausted (${this._lastConfig.maxReconnectAttempts})`,
          "ONEBOT_RETRY_EXHAUSTED",
          { category: "network", fatal: true },
        ),
      );
      this._running = false;
      this._state = "fatal";
      return;
    }

    const delay =
      RECONNECT_DELAYS[Math.min(this._reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempts += 1;
    this._state = "reconnecting";
    this._reconnectTimer = this.timers.setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._running || generation !== this._generation) return;
      this._connect(generation);
    }, delay);
    this._reconnectTimer?.unref?.();
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      this._clearTimer("timeout", pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _ownsSocket(socket, generation) {
    return this._running && generation === this._generation && socket === this._socket;
  }

  _reportError(error) {
    this._lastError = error;
    logSafely(
      this.logger,
      error.retryable || error.category === "handler" ? "warn" : "error",
      `OneBot adapter: ${error.message}`,
      { code: error.code, category: error.category },
    );
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) this._clearTimer("timeout", this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _clearTimer(kind, timer) {
    const clear = kind === "interval" ? this.timers.clearInterval : this.timers.clearTimeout;
    if (typeof clear === "function") clear.call(this.timers, timer);
  }
}

function historyMessageId(message) {
  const value =
    message?.message_id ?? message?.message_seq ?? message?.real_id ?? message?.id;
  return value === undefined || value === null ? "" : String(value);
}

function historyMessageSeq(message) {
  const value =
    message?.message_seq ?? message?.message_id ?? message?.real_id ?? message?.id;
  return value === undefined || value === null ? "" : String(value);
}

function historyMessageTime(message) {
  const raw = Number(message?.time);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 1e12 ? raw : raw * 1_000;
}

function normalizeHistoryMessage(message, time) {
  const parsed = parseOneBotMessage(message?.message ?? message?.raw_message ?? "");
  const text =
    String(parsed?.text ?? "").trim() || String(message?.raw_message ?? "").trim();
  if (!text) return null;
  const selfId = String(message?.self_id ?? "");
  const senderId = String(message?.sender?.user_id ?? message?.user_id ?? "");
  const role =
    message?.message_sent_type === "self" || (selfId && senderId === selfId)
      ? "assistant"
      : "user";
  return { role, text: text.slice(0, 1_000), time };
}

function classifyOneBotResult(payload, action) {
  const retcode = Number(payload.retcode);
  const message = String(
    payload.message || payload.wording || payload.msg || payload.error || "OneBot API failed",
  );
  const compact = message.toLowerCase();
  const riskControl =
    /风控|封禁|冻结|risk\s*control|account\s+(?:is\s+)?(?:banned|frozen)/i.test(message);
  if (riskControl) {
    return new AdapterError(`OneBot ${action} was blocked by risk control: ${message}`, "ONEBOT_RISK_CONTROL", {
      category: "restriction",
      bizCode: retcode,
      restriction: "risk-control",
    });
  }
  const permissionDenied =
    retcode === 1401 ||
    retcode === 1403 ||
    /permission\s+denied|forbidden|access\s+denied|not\s+allowed|permission.*disabled|disabled.*permission|action\s+(?:is\s+)?disabled|feature\s+(?:is\s+)?disabled|account\s+(?:is\s+)?disabled|权限不足|无权限|没有权限|功能已禁用|操作已禁用/i.test(
      compact,
    );
  if (permissionDenied) {
    return new AdapterError(
      `OneBot ${action} was denied: ${message}`,
      "ONEBOT_PERMISSION_DENIED",
      {
        category: "permission",
        bizCode: retcode,
        fatal: true,
        restriction: "permission-disabled",
      },
    );
  }
  if (/rate[\s_-]*limit|too many requests|too frequent|频繁|限流|请求过快/i.test(compact)) {
    return new AdapterError(
      `OneBot ${action} was rate limited: ${message}`,
      "ONEBOT_RATE_LIMITED",
      {
        category: "rate-limit",
        bizCode: retcode,
        retryable: true,
        restriction: "rate-limit",
      },
    );
  }
  return new AdapterError(`OneBot ${action} failed: ${message}`, "ONEBOT_API_ERROR", {
    category: "api",
    bizCode: retcode,
  });
}

function decodeSocketData(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data ?? "");
}

function redactUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of ["access_token", "token"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return String(value).replace(/(access_token=)[^&\s]+/gi, "$1[redacted]");
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
