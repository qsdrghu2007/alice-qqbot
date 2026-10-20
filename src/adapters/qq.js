import WebSocket from "ws";
import {
  AdapterError,
  asAdapterError,
  logSafely,
  maskId,
  normalizePolicy,
  normalizeReply,
  oneBotAttachments,
  policyReason,
  redactSecrets,
} from "./shared.js";

const GATEWAY_GROUP_AND_C2C = 1 << 25;
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const RATE_LIMIT_DELAY = 60_000;
const MAX_QUICK_DISCONNECTS = 3;

export class QQAdapter {
  constructor({
    getConfig,
    logger = console,
    fetch: fetchImpl = globalThis.fetch,
    socketFactory = (url, options) => new WebSocket(url, options),
    timers = globalThis,
    random = Math.random,
  } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig must be a function");
    if (typeof fetchImpl !== "function") throw new TypeError("fetch must be a function");
    if (typeof socketFactory !== "function") throw new TypeError("socketFactory must be a function");

    this.getConfig = getConfig;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.socketFactory = socketFactory;
    this.timers = timers;
    this.random = random;

    this._running = false;
    this._state = "stopped";
    this._connected = false;
    this._ready = false;
    this._socket = null;
    this._onMessage = null;
    this._generation = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._reconnectAttempts = 0;
    this._quickDisconnects = 0;
    this._socketOpenedAt = 0;
    this._lastError = null;
    this._lastEventAt = null;
    this._lastConfig = null;
    this._accessToken = null;
    this._tokenExpiresAt = 0;
    this._tokenPromise = null;
    this._sessionId = null;
    this._lastSeq = null;
    this._heartbeatsOutstanding = 0;
    this._msgSequences = new Map();
  }

  async start(onMessage) {
    if (typeof onMessage !== "function") throw new TypeError("onMessage must be a function");
    if (this._running) return;

    const config = this._readConfig();
    if (!config.enabled) {
      this._state = "disabled";
      return;
    }
    if (!config.appId || !config.secret) {
      throw new AdapterError("QQ appId and secret are required", "QQ_CONFIG_INVALID", {
        category: "config",
        fatal: true,
      });
    }

    this._lastConfig = config;
    this._onMessage = onMessage;
    this._running = true;
    this._generation += 1;
    this._reconnectAttempts = 0;
    this._quickDisconnects = 0;
    this._state = "connecting";
    this._lastError = null;
    await this._connect(this._generation);
  }

  async stop() {
    if (!this._running && !this._socket) {
      this._state = "stopped";
      return;
    }
    this._running = false;
    this._generation += 1;
    this._ready = false;
    this._connected = false;
    this._state = "stopped";
    this._clearConnectionTimers();
    this._clearReconnectTimer();
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else if (typeof socket.close === "function") socket.close(1000, "adapter stopped");
      } catch (error) {
        logSafely(this.logger, "debug", `QQ socket close failed: ${error?.message ?? error}`);
      }
    }
  }

  async send(event, reply) {
    if (!this._running) {
      throw new AdapterError("QQ adapter is not running", "ADAPTER_NOT_RUNNING", {
        category: "state",
        retryable: true,
      });
    }
    if (!event?.id || !event?.conversationId || !["private", "group"].includes(event.scope)) {
      throw new AdapterError("Invalid QQ reply event", "QQ_EVENT_INVALID", {
        category: "validation",
      });
    }

    const normalized = normalizeReply(reply);
    if (normalized.images.length > 0 || normalized.faces.length > 0) {
      throw new AdapterError(
        "QQ official adapter currently supports text replies only; faces/images were not sent",
        "QQ_RICH_MEDIA_UNSUPPORTED",
        { category: "unsupported", fatal: false },
      );
    }
    if (!normalized.text.trim()) {
      throw new AdapterError("QQ official adapter requires non-empty reply text", "EMPTY_REPLY", {
        category: "validation",
      });
    }

    const config = this._lastConfig ?? this._readConfig();
    if (normalizePolicy(this._currentPolicy()).paused) {
      throw new AdapterError("QQ policy is paused", "POLICY_PAUSED", { category: "policy" });
    }

    const body = {
      content: normalized.text,
      msg_type: 0,
      msg_id: event.id,
      msg_seq: this._nextMsgSeq(event.id),
    };
    const target = encodeURIComponent(String(event.conversationId));
    const path =
      event.scope === "private"
        ? `/v2/users/${target}/messages`
        : `/v2/groups/${target}/messages`;

    let refreshed = false;
    while (true) {
      const token = await this._getAccessToken(config);
      const response = await this._request(config, "POST", path, body, token);
      if (response.status === 401 && !refreshed) {
        this._clearToken();
        refreshed = true;
        continue;
      }
      if (!response.ok) throw this._httpError(response, "QQ_SEND_FAILED");
      return parseJsonResponse(response, "QQ_SEND_RESPONSE_INVALID");
    }
  }

  async like() {
    throw new AdapterError(
      "QQ official Bot API does not provide a user-like endpoint",
      "QQ_LIKE_UNSUPPORTED",
      { category: "unsupported", fatal: false },
    );
  }

  status() {
    const config = this._lastConfig ?? { enabled: false, appId: "", sandbox: false };
    return {
      channel: "qq",
      enabled: config.enabled === true,
      running: this._running,
      state: this._state,
      connected: this._connected,
      ready: this._ready,
      sandbox: config.sandbox === true,
      appId: maskId(config.appId),
      hasSecret: Boolean(config.secret),
      hasAccessToken: Boolean(this._accessToken && this._tokenExpiresAt > Date.now()),
      tokenExpiresAt: this._tokenExpiresAt || null,
      resumableSession: Boolean(this._sessionId && this._lastSeq !== null),
      reconnectAttempts: this._reconnectAttempts,
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
    const qq = config.qq ?? {};
    return {
      enabled: qq.enabled === true,
      appId: String(qq.appId ?? "").trim(),
      secret: String(qq.secret ?? "").trim(),
      sandbox: qq.sandbox === true,
      baseUrl: String(
        qq.baseUrl ??
          (qq.sandbox
            ? "https://sandbox.api.sgroup.qq.com"
            : "https://api.sgroup.qq.com"),
      ).replace(/\/+$/, ""),
      tokenUrl: String(qq.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken"),
      timeoutMs: positive(qq.timeoutMs, 30_000),
      maxReconnectAttempts: nonNegative(qq.maxReconnectAttempts, 12),
      policy: config.policy ?? {},
    };
  }

  _currentPolicy() {
    return this.getConfig()?.policy ?? this._lastConfig?.policy ?? {};
  }

  async _connect(generation) {
    if (!this._running || generation !== this._generation) return;
    this._state = "connecting";
    this._clearConnectionTimers();

    try {
      const config = this._lastConfig;
      const token = await this._getAccessToken(config);
      if (!this._running || generation !== this._generation) return;
      const gatewayResponse = await this._request(config, "GET", "/gateway", undefined, token);
      if (!gatewayResponse.ok) throw this._httpError(gatewayResponse, "QQ_GATEWAY_FAILED");
      const gateway = parseJsonResponse(gatewayResponse, "QQ_GATEWAY_RESPONSE_INVALID");
      if (!gateway?.url) {
        throw new AdapterError("QQ gateway response has no URL", "QQ_GATEWAY_RESPONSE_INVALID", {
          category: "protocol",
          retryable: true,
        });
      }
      if (!this._running || generation !== this._generation) return;

      const socket = this.socketFactory(gateway.url, {
        headers: { "User-Agent": "xiaoyu-qqbot/0.1" },
        handshakeTimeout: config.timeoutMs,
      });
      this._socket = socket;
      this._state = "handshaking";

      socket.on("open", () => {
        if (!this._ownsSocket(socket, generation)) return;
        this._connected = true;
        this._socketOpenedAt = Date.now();
        this._state = "identifying";
      });
      socket.on("message", (data) => {
        if (!this._ownsSocket(socket, generation)) return;
        this._handlePayload(socket, data, token, generation).catch((error) => {
          this._reportError(error, "QQ_MESSAGE_HANDLER_FAILED");
        });
      });
      socket.on("error", (error) => {
        if (!this._ownsSocket(socket, generation)) return;
        this._reportError(
          asAdapterError(error, "QQ_SOCKET_ERROR", {
            category: "network",
            retryable: true,
          }),
        );
      });
      socket.on("close", (code, reason) => {
        if (!this._ownsSocket(socket, generation)) return;
        this._handleClose(code, reason, generation);
      });
    } catch (error) {
      if (!this._running || generation !== this._generation) return;
      const adapterError = asAdapterError(error, "QQ_CONNECT_FAILED", {
        category: "network",
        retryable: true,
      });
      this._reportError(adapterError);
      this._cleanupSocket();
      if (adapterError.fatal) {
        this._running = false;
        this._state = "fatal";
        return;
      }
      this._scheduleReconnect(
        generation,
        adapterError.category === "rate-limit" ? RATE_LIMIT_DELAY : undefined,
      );
    }
  }

  async _handlePayload(socket, raw, token, generation) {
    let payload;
    try {
      payload = JSON.parse(decodeSocketData(raw));
    } catch (error) {
      throw new AdapterError("Invalid QQ gateway JSON", "QQ_GATEWAY_JSON_INVALID", {
        category: "protocol",
        retryable: false,
        cause: error,
      });
    }

    if (typeof payload?.s === "number") this._lastSeq = payload.s;
    const op = payload?.op;
    const d = payload?.d;

    if (op === 10) {
      const interval = Math.max(100, Number(d?.heartbeat_interval) || 30_000);
      this._sendIdentifyOrResume(socket, token);
      if (this._heartbeatTimer) this._clearTimer("interval", this._heartbeatTimer);
      this._heartbeatTimer = this.timers.setInterval(() => {
        if (!this._ownsSocket(socket, generation) || socket.readyState !== 1) return;
        if (this._heartbeatsOutstanding > 0) {
          this._reportError(
            new AdapterError(
              "QQ heartbeat ACK was not received",
              "QQ_HEARTBEAT_TIMEOUT",
              { category: "network", retryable: true },
            ),
          );
          this._handleGatewayReconnect(generation);
          return;
        }
        this._heartbeatsOutstanding += 1;
        socket.send(JSON.stringify({ op: 1, d: this._lastSeq }));
      }, interval);
      this._heartbeatTimer?.unref?.();
      this._state = this._sessionId ? "resuming" : "identifying";
      return;
    }

    if (op === 11) {
      this._heartbeatsOutstanding = 0;
      return;
    }

    if (op === 7) {
      this._handleGatewayReconnect(generation);
      return;
    }

    if (op === 9) {
      if (d !== true) {
        this._resetSession();
        this._clearToken();
      }
      this._handleGatewayReconnect(generation, 3_000);
      return;
    }

    if (op !== 0) return;

    if (payload.t === "READY") {
      this._sessionId = String(d?.session_id ?? "");
      this._ready = true;
      this._state = "ready";
      this._reconnectAttempts = 0;
      this._quickDisconnects = 0;
      return;
    }
    if (payload.t === "RESUMED") {
      this._ready = true;
      this._state = "ready";
      this._reconnectAttempts = 0;
      return;
    }

    if (payload.t !== "C2C_MESSAGE_CREATE" && payload.t !== "GROUP_AT_MESSAGE_CREATE") return;
    const event = this._normalizeEvent(payload.t, d);
    this._lastEventAt = new Date().toISOString();
    if (!event) return;

    const policy = normalizePolicy(this._currentPolicy());
    const reason = policyReason(event, policy);
    if (reason) {
      logSafely(this.logger, "debug", `QQ inbound skipped: ${reason}`);
      return;
    }

    try {
      await this._onMessage(event);
    } catch (error) {
      this._reportError(
        asAdapterError(error, "QQ_ON_MESSAGE_FAILED", { category: "handler" }),
      );
    }
  }

  _sendIdentifyOrResume(socket, token) {
    if (this._sessionId !== null && this._lastSeq !== null) {
      socket.send(
        JSON.stringify({
          op: 6,
          d: {
            token: `QQBot ${token}`,
            session_id: this._sessionId,
            seq: this._lastSeq,
          },
        }),
      );
      return;
    }
    socket.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: GATEWAY_GROUP_AND_C2C,
          shard: [0, 1],
        },
      }),
    );
  }

  _normalizeEvent(type, data) {
    if (!data || typeof data !== "object") return null;
    if (type === "C2C_MESSAGE_CREATE") {
      const userId = String(data.author?.user_openid ?? "");
      if (!userId || !data.id) return null;
      return {
        id: String(data.id),
        channel: "qq",
        userId,
        scope: "private",
        conversationId: userId,
        text: String(data.content ?? ""),
        attachments: oneBotAttachments(data.attachments),
        timestamp: data.timestamp ?? new Date().toISOString(),
      };
    }

    const userId = String(data.author?.member_openid ?? data.author?.id ?? "");
    const groupId = String(data.group_openid ?? "");
    if (!userId || !groupId || !data.id || data.author?.bot === true) return null;
    return {
      id: String(data.id),
      channel: "qq",
      userId,
      scope: "group",
      conversationId: groupId,
      groupId,
      text: String(data.content ?? ""),
      attachments: oneBotAttachments(data.attachments),
      timestamp: data.timestamp ?? new Date().toISOString(),
    };
  }

  _handleClose(code, reason, generation) {
    if (!this._running || generation !== this._generation) return;
    this._connected = false;
    this._ready = false;
    this._heartbeatsOutstanding = 0;
    this._clearConnectionTimers();
    this._socket = null;

    const reasonText = safeReason(reason);
    logSafely(this.logger, "info", `QQ gateway closed: ${code} ${reasonText}`);

    if (code === 4914 || code === 4915) {
      const error = new AdapterError(
        code === 4914
          ? "QQ bot is unavailable in this environment (insufficient intents or sandbox restriction)"
          : "QQ Bot was disallowed or banned by the platform",
        code === 4914 ? "QQ_INTENTS_REJECTED" : "QQ_BANNED",
        { category: code === 4914 ? "permission" : "control", fatal: true },
      );
      this._reportError(error);
      this._running = false;
      this._state = "fatal";
      return;
    }

    if (code === 4004) {
      this._clearToken();
      if (this._reconnectAttempts >= 2) {
        const error = new AdapterError(
          "QQ authentication repeatedly failed",
          "QQ_AUTH_FAILED",
          { category: "auth", fatal: true },
        );
        this._reportError(error);
        this._running = false;
        this._state = "fatal";
        return;
      }
    }

    if ([4006, 4007, 4009].includes(code) || (code >= 4900 && code <= 4913)) {
      this._resetSession();
      this._clearToken();
    }

    const delay = code === 4008 ? RATE_LIMIT_DELAY : undefined;
    this._state = "disconnected";
    this._scheduleReconnect(generation, delay);
  }

  _handleGatewayReconnect(generation, delay) {
    if (!this._running || generation !== this._generation) return;
    const socket = this._socket;
    this._socket = null;
    this._connected = false;
    this._ready = false;
    this._clearConnectionTimers();
    if (socket) {
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else if (typeof socket.close === "function") {
          socket.close(4000, "gateway requested reconnect");
        }
      } catch {
        // The reconnect decision is already durable.
      }
    }
    this._state = "disconnected";
    this._scheduleReconnect(generation, delay);
  }

  _scheduleReconnect(generation, customDelay) {
    if (!this._running || generation !== this._generation || this._reconnectTimer) return;
    const maxAttempts = this._lastConfig.maxReconnectAttempts;
    if (this._reconnectAttempts >= maxAttempts) {
      this._reportError(
        new AdapterError(
          `QQ reconnect attempts exhausted (${maxAttempts})`,
          "QQ_RETRY_EXHAUSTED",
          { category: "network", fatal: true },
        ),
      );
      this._running = false;
      this._state = "fatal";
      return;
    }

    if (
      this._socketOpenedAt > 0 &&
      Date.now() - this._socketOpenedAt < 5_000 &&
      !this._ready
    ) {
      this._quickDisconnects += 1;
    } else {
      this._quickDisconnects = 0;
    }
    this._socketOpenedAt = 0;

    const quickDelay =
      this._quickDisconnects >= MAX_QUICK_DISCONNECTS ? RATE_LIMIT_DELAY : undefined;
    const delay =
      customDelay ??
      quickDelay ??
      RECONNECT_DELAYS[Math.min(this._reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempts += 1;
    this._state = "reconnecting";
    this._reconnectTimer = this.timers.setTimeout(() => {
      this._reconnectTimer = null;
      void this._connect(generation);
    }, delay);
    this._reconnectTimer?.unref?.();
  }

  async _getAccessToken(config) {
    const now = Date.now();
    const refreshAhead = Math.min(300_000, Math.max(0, (this._tokenExpiresAt - now) / 3));
    if (this._accessToken && now < this._tokenExpiresAt - refreshAhead) {
      return this._accessToken;
    }
    if (this._tokenPromise) return this._tokenPromise;

    this._tokenPromise = (async () => {
      const response = await this._request(
        config,
        "POST",
        null,
        { appId: config.appId, clientSecret: config.secret },
        null,
        config.tokenUrl,
      );
      if (!response.ok) throw this._httpError(response, "QQ_TOKEN_FAILED");
      const data = parseJsonResponse(response, "QQ_TOKEN_RESPONSE_INVALID");
      if (!data.access_token) {
        throw new AdapterError(
          "QQ token response has no access_token",
          "QQ_TOKEN_RESPONSE_INVALID",
          { category: "protocol", retryable: true },
        );
      }
      this._accessToken = String(data.access_token);
      this._tokenExpiresAt =
        Date.now() + Math.max(60, Number(data.expires_in) || 7_200) * 1_000;
      return this._accessToken;
    })().finally(() => {
      this._tokenPromise = null;
    });
    return this._tokenPromise;
  }

  async _request(config, method, path, body, token, absoluteUrl) {
    const url = absoluteUrl ?? `${config.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": "xiaoyu-qqbot/0.1",
      };
      if (token) headers.Authorization = `QQBot ${token}`;
      const response = await this.fetchImpl(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response || typeof response.status !== "number") {
        throw new AdapterError(
          "QQ HTTP response is invalid",
          "QQ_HTTP_RESPONSE_INVALID",
          { category: "protocol", retryable: true },
        );
      }
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch (error) {
        throw new AdapterError(
          "Failed to read QQ HTTP response",
          "QQ_HTTP_RESPONSE_INVALID",
          { category: "protocol", retryable: true, cause: error },
        );
      }
      let json;
      if (bodyText) {
        try {
          json = JSON.parse(bodyText);
        } catch {
          // Keep raw text for API error classification.
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        _bodyText: bodyText,
        _json: json,
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const aborted = error?.name === "AbortError";
      throw new AdapterError(
        aborted
          ? `QQ HTTP request timed out after ${config.timeoutMs}ms`
          : "QQ HTTP request failed",
        aborted ? "QQ_HTTP_TIMEOUT" : "QQ_HTTP_NETWORK_ERROR",
        { category: "network", retryable: true, cause: error },
      );
    } finally {
      this._clearTimer("timeout", timer);
    }
  }

  _httpError(response, code) {
    const status = Number(response.status);
    const text = response._bodyText ?? "";
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // The body may be an HTML gateway page or plain text.
    }
    const bizCode = payload?.code ?? payload?.err_code;
    const platformMessage = String(payload?.message ?? payload?.msg ?? text).slice(0, 300);
    const compact = platformMessage.toLowerCase();

    if (status === 401) {
      return new AdapterError("QQ authentication failed", "QQ_AUTH_FAILED", {
        category: "auth",
        status,
        bizCode,
        fatal: true,
      });
    }
    if (
      status === 403 ||
      /forbidden|permission|拒绝|禁止|权限|风控|封禁/.test(compact)
    ) {
      return new AdapterError(
        `QQ request was denied: ${platformMessage}`,
        "QQ_PERMISSION_DENIED",
        { category: "permission", status, bizCode, fatal: true },
      );
    }
    if (status === 429 || /rate|limit|频繁|限流/.test(compact)) {
      return new AdapterError(
        `QQ rate limited the request: ${platformMessage}`,
        "QQ_RATE_LIMITED",
        { category: "rate-limit", status, bizCode, retryable: true },
      );
    }
    if (status >= 500) {
      return new AdapterError(
        `QQ service error: ${platformMessage}`,
        "QQ_SERVICE_ERROR",
        { category: "network", status, bizCode, retryable: true },
      );
    }
    return new AdapterError(`QQ API failed: ${platformMessage}`, code, {
      category: "api",
      status,
      bizCode,
    });
  }

  _nextMsgSeq(messageId) {
    const key = String(messageId);
    const current = this._msgSequences.get(key);
    const next =
      current === undefined
        ? ((Math.floor(this.random() * 65_535) + 1) & 0xffff) || 1
        : (current % 65_535) + 1;
    this._msgSequences.set(key, next);
    while (this._msgSequences.size > 128) {
      this._msgSequences.delete(this._msgSequences.keys().next().value);
    }
    return next;
  }

  _ownsSocket(socket, generation) {
    return this._running && generation === this._generation && socket === this._socket;
  }

  _reportError(error, fallbackCode) {
    const adapterError = asAdapterError(error, fallbackCode ?? "QQ_ERROR");
    this._lastError = adapterError;
    logSafely(
      this.logger,
      adapterError.retryable || adapterError.category === "handler" ? "warn" : "error",
      `QQ adapter: ${adapterError.message}`,
      { code: adapterError.code, category: adapterError.category },
    );
  }

  _cleanupSocket() {
    this._clearConnectionTimers();
    const socket = this._socket;
    this._socket = null;
    this._connected = false;
    this._ready = false;
    if (socket) {
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else if (typeof socket.close === "function") socket.close();
      } catch {
        // Cleanup is best-effort.
      }
    }
  }

  _clearConnectionTimers() {
    this._heartbeatsOutstanding = 0;
    if (this._heartbeatTimer) this._clearTimer("interval", this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) this._clearTimer("timeout", this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _clearTimer(kind, timer) {
    const clear = kind === "interval" ? this.timers.clearInterval : this.timers.clearTimeout;
    if (typeof clear === "function") clear.call(this.timers, timer);
  }

  _resetSession() {
    this._sessionId = null;
    this._lastSeq = null;
  }

  _clearToken() {
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }
}

function parseJsonResponse(response, code) {
  try {
    return response._json ?? (response._bodyText ? JSON.parse(response._bodyText) : null);
  } catch (error) {
    throw new AdapterError("QQ API returned invalid JSON", code, {
      category: "protocol",
      retryable: false,
      cause: error,
    });
  }
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

function safeReason(reason) {
  try {
    return Buffer.isBuffer(reason)
      ? reason.toString("utf8").slice(0, 200)
      : String(reason ?? "").slice(0, 200);
  } catch {
    return "";
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
