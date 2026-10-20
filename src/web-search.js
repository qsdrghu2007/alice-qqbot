const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CONTENT_CHARS = 6_000;
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8_192;
const SEARCH_PATH = "/v1/tools/search";
const FETCH_PATH = "/v1/tools/fetch";

export class WebSearchError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "WebSearchError";
    this.status = status;
    this.code = code;
  }
}

function validHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      Boolean(parsed.host) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function limitText(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function endpoint(baseUrl, targetPath) {
  const trimmed = String(baseUrl ?? "").replace(/\/+$/u, "");
  if (trimmed.endsWith(targetPath)) return trimmed;
  const withoutV1 = trimmed.replace(/\/v1$/iu, "");
  return `${withoutV1}${targetPath}`;
}

function statusMessage(status) {
  switch (status) {
    case 401:
      return "联网搜索的 DeepSeek API Key 无效";
    case 402:
      return "DeepSeek 账户余额不足";
    case 403:
      return "网页抓取被安全策略拒绝";
    case 404:
      return "网页没有可抓取的内容";
    case 408:
      return "联网请求超时";
    case 413:
      return "网页内容过大";
    case 429:
      return "联网请求太频繁";
    case 500:
      return "联网搜索服务内部错误";
    case 504:
      return "联网抓取超时";
    default:
      return `联网服务返回 HTTP ${status}`;
  }
}

function normalizeSearchResult(item) {
  if (!item || typeof item !== "object") return null;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!validHttpUrl(url)) return null;
  const score = Number(item.rerank_score);
  const authority = Number(item.authority);
  const summary = limitText(item.summary || item.snippet, 1_500);
  return {
    title: limitText(item.title, 300),
    url,
    site: typeof item.site_name === "string" && item.site_name.trim()
      ? item.site_name.trim()
      : null,
    date: typeof item.date === "string" && item.date.trim() ? item.date.trim() : null,
    score: Number.isFinite(score) ? score : null,
    authority: Number.isInteger(authority) ? authority : null,
    summary,
  };
}

export class WebSearchClient {
  constructor({
    getConfig,
    fetchImpl = globalThis.fetch,
    logger = console,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl 必须是函数");
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async search({ query, count, oriQuestion, signal } = {}) {
    const normalizedQuery = this._query(query);
    const maxResults = this._maxResults();
    const normalizedCount = this._count(count, maxResults);
    const body = {
      query: normalizedQuery,
      count: normalizedCount,
      need_content: false,
    };
    const question = limitText(oriQuestion, MAX_QUERY_CHARS);
    if (question) body.ori_question = question;

    const payload = await this._post(SEARCH_PATH, body, signal);
    const results = (Array.isArray(payload?.results) ? payload.results : [])
      .map(normalizeSearchResult)
      .filter(Boolean)
      .slice(0, normalizedCount);

    return {
      ok: true,
      found: results.length > 0,
      query: normalizedQuery,
      results,
    };
  }

  async fetch({ url, signal } = {}) {
    const normalizedUrl = this._url(url);
    const payload = await this._post(FETCH_PATH, { url: normalizedUrl }, signal);
    const raw = typeof payload?.content === "string" ? payload.content.trim() : "";
    if (!raw) {
      throw new WebSearchError("网页没有可提取的正文", { code: "EMPTY_CONTENT" });
    }
    const chars = Array.from(raw);
    const maxChars = this._maxContentChars();
    return {
      ok: true,
      found: true,
      url: normalizedUrl,
      title: limitText(payload?.title, 500),
      content: chars.slice(0, maxChars).join(""),
      truncated: chars.length > maxChars,
      originalChars: chars.length,
    };
  }

  async _post(targetPath, body, signal) {
    const config = this.getConfig();
    const apiKey =
      String(config?.webSearch?.apiKey ?? "").trim() ||
      String(config?.ai?.apiKey ?? "").trim();
    if (!apiKey) {
      throw new WebSearchError("尚未配置 DeepSeek API Key", { code: "NO_API_KEY" });
    }
    const baseUrl = String(config?.webSearch?.baseUrl ?? this.baseUrl ?? DEFAULT_BASE_URL).trim();
    if (!validHttpUrl(baseUrl)) {
      throw new WebSearchError("联网搜索 Base URL 无效", { code: "BAD_BASE_URL" });
    }
    const configuredTimeout = Number(config?.webSearch?.timeoutMs ?? this.timeoutMs);
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS;

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([timeoutSignal, signal])
      : timeoutSignal;
    let response;
    try {
      response = await this.fetchImpl(endpoint(baseUrl, targetPath), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new WebSearchError("联网请求已取消", { code: "CANCELLED" });
      }
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new WebSearchError("联网请求超时", { code: "TIMEOUT" });
      }
      throw new WebSearchError("无法连接联网搜索服务", { code: "NETWORK_ERROR" });
    }

    if (signal?.aborted) {
      throw new WebSearchError("联网请求已取消", { code: "CANCELLED" });
    }
    if (!response.ok) {
      throw new WebSearchError(statusMessage(response.status), {
        status: response.status,
        code: "HTTP_ERROR",
      });
    }

    try {
      return await response.json();
    } catch {
      throw new WebSearchError("联网服务返回了无法解析的响应", {
        code: "BAD_RESPONSE",
      });
    }
  }

  _query(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new WebSearchError("搜索词不能为空", { code: "INVALID_QUERY" });
    }
    const query = value.trim();
    if (Array.from(query).length > MAX_QUERY_CHARS) {
      throw new WebSearchError("搜索词不能超过 128 个字符", {
        code: "INVALID_QUERY",
      });
    }
    return query;
  }

  _count(value, maxResults) {
    if (value === undefined || value === null) return maxResults;
    if (!Number.isInteger(value) || value < 1 || value > 50) {
      throw new WebSearchError("搜索结果条数必须是 1..50 的整数", {
        code: "INVALID_COUNT",
      });
    }
    return Math.min(value, maxResults);
  }

  _url(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new WebSearchError("网页地址不能为空", { code: "INVALID_URL" });
    }
    const url = value.trim();
    if (url.length > MAX_URL_CHARS) {
      throw new WebSearchError("网页地址不能超过 8192 个字符", {
        code: "INVALID_URL",
      });
    }
    if (!validHttpUrl(url)) {
      throw new WebSearchError("网页地址必须是合法的 HTTP/HTTPS 地址", {
        code: "INVALID_URL",
      });
    }
    return url;
  }

  _maxResults() {
    const value = Number(this.getConfig()?.webSearch?.maxResults);
    return Number.isInteger(value) && value >= 1
      ? Math.min(value, 50)
      : DEFAULT_MAX_RESULTS;
  }

  _maxContentChars() {
    const value = Number(this.getConfig()?.webSearch?.maxContentChars);
    return Number.isInteger(value) && value >= 1_000
      ? Math.min(value, 20_000)
      : DEFAULT_MAX_CONTENT_CHARS;
  }
}
