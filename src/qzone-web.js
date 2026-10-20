const QZONE_DOMAIN = "user.qzone.qq.com";
const LIST_URL =
  "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6";
const ADD_COMMENT_URL =
  "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addcomment_ugc";
const ADD_REPLY_URL =
  "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_ugc";
const RE_FEEDS_URL =
  "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds";
const RE_FEEDS_H5_URL =
  "https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15_000;
const FRIEND_CACHE_MS = 10 * 60_000;
const AUTH_CODES = new Set([-10000, -3000, -4002]);

export class QzoneWebError extends Error {
  constructor(message, { code, status, auth = false } = {}) {
    super(message);
    this.name = "QzoneWebError";
    this.code = code;
    this.status = status;
    this.auth = auth;
  }
}

function parseCookieHeader(value) {
  const cookies = {};
  for (const part of String(value ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    cookies[key] = part.slice(index + 1).trim();
  }
  return cookies;
}

function normalizeUin(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/^o/iu, "");
  if (!/^\d+$/u.test(digits)) return "";
  return String(Number(digits));
}

function calcGtk(skey) {
  let hash = 5381;
  for (const char of String(skey ?? "")) {
    hash += (hash << 5) + char.codePointAt(0);
  }
  return hash & 0x7fffffff;
}

function parseJsonp(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const callback = raw.match(/(?:^|[;(])\s*(?:_preloadCallback|callback)\s*\(([\s\S]*)\)\s*;?\s*$/u);
  const candidate = callback ? callback[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function responseCode(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["code", "ret", "retcode"]) {
    if (Number.isFinite(Number(payload[key]))) return Number(payload[key]);
  }
  return null;
}

function isSuccessText(text) {
  const value = String(text ?? "");
  return (
    /"code"\s*:\s*0/u.test(value) ||
    /"ret"\s*:\s*0/u.test(value) ||
    /"retcode"\s*:\s*0/u.test(value) ||
    /\bsucc(?:ess)?\b/iu.test(value)
  );
}

function commentIdFrom(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload.commentId,
    payload.commentid,
    payload.id,
    payload.data?.commentId,
    payload.data?.commentid,
    payload.data?.id,
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function withMention(uin, nick, content) {
  const text = String(content ?? "").trim();
  if (!uin || text.startsWith("@{")) return text;
  const name = String(nick ?? uin).replace(/[{}]/gu, "").slice(0, 40) || uin;
  return `@{uin:${uin},nick:${name},auto:1} ${text}`;
}

function normalizeOwner(value) {
  const owner = String(value ?? "").trim();
  if (!/^\d+$/u.test(owner)) throw new QzoneWebError("空间说说 QQ 号无效", { code: "INVALID_OWNER" });
  return owner;
}

function normalizeTid(value) {
  const tid = String(value ?? "").trim();
  if (!tid || tid.length > 200 || /[^A-Za-z0-9_-]/u.test(tid)) {
    throw new QzoneWebError("空间说说 tid 无效", { code: "INVALID_TID" });
  }
  return tid;
}

export class QzoneWebClient {
  constructor({
    onebot,
    fetchImpl = globalThis.fetch,
    logger = console,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
  } = {}) {
    if (!onebot || typeof onebot.call !== "function") {
      throw new TypeError("QzoneWebClient 需要 onebot.call");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数");
    this.onebot = onebot;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.session = null;
    this.friendCache = null;
  }

  invalidateSession() {
    this.session = null;
  }

  async ensureSession({ maxAgeMs = 10 * 60_000, force = false } = {}) {
    if (
      !force &&
      this.session &&
      this.now() - this.session.fetchedAt < maxAgeMs
    ) {
      return this.session;
    }
    let response;
    try {
      response = await this.onebot.call("get_cookies", { domain: QZONE_DOMAIN });
    } catch (error) {
      throw new QzoneWebError("无法从 NapCat 获取空间 Cookie", {
        code: error?.code ?? "COOKIE_UNAVAILABLE",
      });
    }
    const raw = response?.cookies ?? response?.data?.cookies ?? "";
    const cookies = parseCookieHeader(raw);
    const uin = normalizeUin(cookies.uin);
    const skey = String(cookies.skey ?? "");
    const pSkey = String(cookies.p_skey ?? "");
    if (!uin || !pSkey) {
      throw new QzoneWebError("空间 Cookie 缺少 uin 或 p_skey", {
        code: "COOKIE_INVALID",
        auth: true,
      });
    }
    this.session = {
      uin,
      skey,
      pSkey,
      gtk: calcGtk(pSkey || skey),
      fetchedAt: this.now(),
      cookie: `uin=o0${uin}; skey=${skey}; p_skey=${pSkey}`,
    };
    return this.session;
  }

  async getFriendIds({ force = false } = {}) {
    if (
      !force &&
      this.friendCache &&
      this.now() - this.friendCache.fetchedAt < FRIEND_CACHE_MS
    ) {
      return this.friendCache.ids;
    }
    let response;
    try {
      response = await this.onebot.call("get_friend_list", {});
    } catch (error) {
      throw new QzoneWebError("获取好友列表失败", {
        code: error?.code ?? "FRIEND_LIST_UNAVAILABLE",
      });
    }
    const list = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : [];
    const ids = new Set(
      list
        .map((item) => normalizeUin(item?.user_id ?? item?.uin ?? item?.id))
        .filter(Boolean),
    );
    this.friendCache = { ids, fetchedAt: this.now() };
    return ids;
  }

  async fetchMoods(owner, num = 10) {
    const target = normalizeOwner(owner);
    const count = Math.max(1, Math.min(20, Number(num) || 10));
    const session = await this.ensureSession();
    const payload = await this._requestJson(LIST_URL, {
      method: "GET",
      session,
      params: {
        uin: target,
        ftype: 0,
        sort: 0,
        pos: 0,
        num: count,
        replynum: 100,
        g_tk: session.gtk,
        callback: "_preloadCallback",
        code_version: 1,
        format: "jsonp",
        need_comment: 1,
        need_private_comment: 1,
      },
      referer: `https://user.qzone.qq.com/${target}`,
    });
    const code = responseCode(payload);
    if (code !== null && code !== 0) {
      throw new QzoneWebError("读取空间说说失败", {
        code,
        auth: AUTH_CODES.has(code),
      });
    }
    return Array.isArray(payload?.msglist) ? payload.msglist : [];
  }

  async fetchPost(owner, tid) {
    const target = normalizeOwner(owner);
    const postId = normalizeTid(tid);
    const moods = await this.fetchMoods(target, 20);
    return (
      moods.find((mood) => String(mood?.tid ?? "") === postId) ?? null
    );
  }

  async addComment({ owner, tid, content }) {
    const target = normalizeOwner(owner);
    const postId = normalizeTid(tid);
    const text = String(content ?? "").trim();
    if (!text) throw new QzoneWebError("评论内容不能为空", { code: "EMPTY_COMMENT" });
    const session = await this.ensureSession();
    const body = new URLSearchParams({
      uin: session.uin,
      hostUin: target,
      topicId: `${target}_${postId}`,
      commentUin: session.uin,
      content: text,
      richtype: "",
      richval: "",
      private: "0",
      with_fwd: "0",
      to_tweet: "0",
      hostuin: target,
      code_version: "1",
      format: "fs",
      qzreferrer: `https://user.qzone.qq.com/${target}`,
    });
    const result = await this._requestText(ADD_COMMENT_URL, {
      method: "POST",
      session,
      params: { g_tk: session.gtk },
      body,
      referer: `https://user.qzone.qq.com/${target}`,
    });
    const payload = parseJsonp(result.text);
    return {
      ok: isSuccessText(result.text) || responseCode(payload) === 0,
      commentId: commentIdFrom(payload),
      text,
    };
  }

  async replyComment({
    owner,
    tid,
    commentId,
    commentUin,
    nick = "",
    content,
    direct = false,
    threadId = "",
    fallbackToThread = false,
  }) {
    const target = normalizeOwner(owner);
    const postId = normalizeTid(tid);
    const parentId = String(commentId ?? "").trim();
    if (!parentId) throw new QzoneWebError("缺少被回复评论 ID", { code: "INVALID_COMMENT_ID" });
    const targetUin = normalizeUin(commentUin);
    if (direct && !targetUin) {
      throw new QzoneWebError("缺少楼中楼作者 QQ 号", { code: "INVALID_COMMENT_UIN" });
    }
    const text = withMention(targetUin, nick, content);
    if (!text) throw new QzoneWebError("回复内容不能为空", { code: "EMPTY_REPLY" });
    const session = await this.ensureSession();
    const referer = `https://user.qzone.qq.com/${target}`;

    if (direct) {
      const threadTarget = String(threadId ?? "").trim() || parentId;
      const directBody = (platformid) =>
        new URLSearchParams({
          topicId: `${target}_${postId}__1`,
          uin: session.uin,
          hostUin: target,
          feedsType: "100",
          inCharset: "utf-8",
          outCharset: "utf-8",
          content: text,
          format: "fs",
          plat: "qzone",
          source: "ic",
          platformid: String(platformid),
          ref: "feeds",
          commentId: threadTarget,
          commentUin: targetUin,
          t1_uin: target,
          t1_tid: postId,
          t2_uin: targetUin,
          t2_tid: parentId,
          richtype: "",
          richval: "",
          paramstr: "2",
          qzreferrer: referer,
        });

      let lastError = null;
      for (const attempt of [
        { url: RE_FEEDS_URL, platformid: 52, mode: "re_feeds_direct_pc" },
        { url: RE_FEEDS_H5_URL, platformid: 50, mode: "re_feeds_direct_h5" },
      ]) {
        try {
          const result = await this._requestText(attempt.url, {
            method: "POST",
            session,
            params: { g_tk: session.gtk },
            body: directBody(attempt.platformid),
            referer,
          });
          const payload = parseJsonp(result.text);
          if (isSuccessText(result.text) || responseCode(payload) === 0) {
            return {
              ok: true,
              mode: attempt.mode,
              commentId: commentIdFrom(payload),
              text,
            };
          }
          lastError = new QzoneWebError("楼中楼直接回复失败", {
            code: responseCode(payload) ?? "DIRECT_REPLY_FAILED",
          });
        } catch (error) {
          lastError = error;
        }
      }

      if (fallbackToThread) {
        try {
          const result = await this._requestText(ADD_REPLY_URL, {
            method: "POST",
            session,
            params: { g_tk: session.gtk },
            body: new URLSearchParams({
              uin: session.uin,
              hostUin: target,
              topicId: `${target}_${postId}`,
              commentId: threadTarget,
              commentUin: session.uin,
              content: text,
              private: "0",
              with_fwd: "0",
              to_tweet: "0",
              hostuin: target,
              code_version: "1",
              format: "fs",
              qzreferrer: referer,
            }),
            referer,
          });
          const payload = parseJsonp(result.text);
          if (isSuccessText(result.text) || responseCode(payload) === 0) {
            return {
              ok: true,
              mode: "re_feeds_direct_fallback_thread",
              commentId: commentIdFrom(payload),
              text,
              fallback: true,
            };
          }
          lastError = new QzoneWebError("楼中楼线程回退失败", {
            code: responseCode(payload) ?? "FALLBACK_REPLY_FAILED",
          });
        } catch (error) {
          lastError = error;
        }
      }

      const code = lastError?.code ?? "DIRECT_REPLY_FAILED";
      throw new QzoneWebError("楼中楼直接回复失败", {
        code,
        auth: AUTH_CODES.has(Number(code)),
      });
    }

    const common = {
      uin: session.uin,
      hostUin: target,
      topicId: `${target}_${postId}`,
      commentId: parentId,
      commentUin: session.uin,
      content: text,
      private: "0",
      with_fwd: "0",
      to_tweet: "0",
      hostuin: target,
      code_version: "1",
      format: "fs",
      qzreferrer: referer,
    };

    const attempts = [
      {
        mode: "addreply_ugc",
        url: ADD_REPLY_URL,
        body: new URLSearchParams(common),
      },
      {
        mode: "re_feeds_pc",
        url: RE_FEEDS_URL,
        body: new URLSearchParams({
          hostUin: target,
          topicId: `${target}_${postId}`,
          content: text,
          format: "json",
          qzreferrer: referer,
          commentId: parentId,
          replyUin: targetUin,
          commentUin: targetUin,
        }),
      },
      {
        mode: "re_feeds_h5",
        url: RE_FEEDS_H5_URL,
        body: new URLSearchParams({
          topicId: `${target}_${postId}__1`,
          uin: session.uin,
          hostUin: target,
          feedsType: "100",
          inCharset: "utf-8",
          outCharset: "utf-8",
          plat: "qzone",
          source: "ic",
          platformid: "50",
          isSignIn: "",
          format: "fs",
          ref: "feeds",
          content: text,
          commentId: parentId,
          commentUin: targetUin,
          t1_uin: target,
          t1_tid: postId,
          t2_uin: targetUin,
          t2_tid: parentId,
          richval: "",
          richtype: "",
          private: "0",
          paramstr: "2",
          qzreferrer: referer,
        }),
      },
    ];

    for (const attempt of attempts) {
      try {
        const result = await this._requestText(attempt.url, {
          method: "POST",
          session,
          params: { g_tk: session.gtk },
          body: attempt.body,
          referer,
        });
        const payload = parseJsonp(result.text);
        if (isSuccessText(result.text) || responseCode(payload) === 0) {
          return {
            ok: true,
            mode: attempt.mode,
            commentId: commentIdFrom(payload),
            text,
          };
        }
      } catch (error) {
        if (error instanceof QzoneWebError && error.auth) throw error;
      }
    }

    const fallback = await this.addComment({
      owner: target,
      tid: postId,
      content: text,
    });
    return { ...fallback, mode: "addcomment_ugc" };
  }

  async _requestJson(url, options) {
    const result = await this._requestText(url, options);
    const payload = parseJsonp(result.text);
    if (!payload) {
      throw new QzoneWebError("空间接口返回了无法解析的内容", {
        code: "BAD_RESPONSE",
      });
    }
    return payload;
  }

  async _requestText(
    url,
    { method = "GET", session, params, body, referer } = {},
  ) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params ?? {})) {
      target.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers: {
          "user-agent": USER_AGENT,
          cookie: session.cookie,
          referer: referer ?? `https://user.qzone.qq.com/${session.uin}`,
          origin: "https://user.qzone.qq.com",
          ...(body
            ? { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }
            : {}),
        },
        ...(body ? { body: body.toString() } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new QzoneWebError("空间请求超时", { code: "TIMEOUT" });
      }
      throw new QzoneWebError("无法连接 QQ 空间", { code: "NETWORK_ERROR" });
    }
    if (!response.ok) {
      throw new QzoneWebError(`空间接口返回 HTTP ${response.status}`, {
        status: response.status,
        code: "HTTP_ERROR",
        auth: response.status === 401 || response.status === 403,
      });
    }
    return { text: await response.text(), status: response.status };
  }
}

export const qzoneWebConstants = Object.freeze({
  LIST_URL,
  ADD_COMMENT_URL,
  ADD_REPLY_URL,
  RE_FEEDS_URL,
  RE_FEEDS_H5_URL,
  QZONE_DOMAIN,
});
