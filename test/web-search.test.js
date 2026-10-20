import test from "node:test";
import assert from "node:assert/strict";

import { WebSearchClient, WebSearchError } from "../src/web-search.js";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function makeClient({
  fetchImpl,
  apiKey = "test-key",
  baseUrl = "https://api.deepseek.com",
  timeoutMs = 2_000,
  webSearch = {},
} = {}) {
  const config = {
    ai: { apiKey },
    webSearch: {
      enabled: true,
      maxResults: 5,
      maxContentChars: 6_000,
      ...webSearch,
    },
  };
  return new WebSearchClient({
    getConfig: () => config,
    fetchImpl,
    baseUrl,
    timeoutMs,
  });
}

test("search uses the DeepSeek tools endpoint and normalizes results", async () => {
  let request;
  const client = makeClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        results: [
          {
            rerank_score: 1.8,
            title: "Example",
            url: "https://example.com/article",
            snippet: "short",
            summary: "long summary",
            site_name: "Example Site",
            date: "2026-10-20T00:00:00Z",
            authority: 3,
            content: "ignored",
          },
          {
            title: "invalid",
            url: "ftp://example.com/file",
          },
        ],
      });
    },
  });

  const result = await client.search({
    query: "DeepSeek 搜索",
    count: 3,
    oriQuestion: "DeepSeek 搜索怎么用",
  });

  assert.equal(request.url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(request.options.body), {
    query: "DeepSeek 搜索",
    count: 3,
    need_content: false,
    ori_question: "DeepSeek 搜索怎么用",
  });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.deepEqual(result.results, [
    {
      title: "Example",
      url: "https://example.com/article",
      site: "Example Site",
      date: "2026-10-20T00:00:00Z",
      score: 1.8,
      authority: 3,
      summary: "long summary",
    },
  ]);
});

test("search uses webSearch.apiKey first and falls back to the AI key", async () => {
  const keys = [];
  const fetchImpl = async (_url, options) => {
    keys.push(options.headers.authorization);
    return response({ results: [] });
  };
  const dedicated = makeClient({
    apiKey: "ai-key",
    webSearch: { apiKey: "web-key" },
    fetchImpl,
  });
  await dedicated.search({ query: "test" });
  const fallback = makeClient({
    apiKey: "ai-key",
    webSearch: { apiKey: "" },
    fetchImpl,
  });
  await fallback.search({ query: "test" });
  const whitespace = makeClient({
    apiKey: "ai-key",
    webSearch: { apiKey: "   " },
    fetchImpl,
  });
  await whitespace.search({ query: "test" });
  assert.deepEqual(keys, ["Bearer web-key", "Bearer ai-key", "Bearer ai-key"]);
});

test("search clamps count to configured max and reports empty results", async () => {
  let body;
  const client = makeClient({
    webSearch: { maxResults: 3 },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response({ results: [] });
    },
  });

  const result = await client.search({ query: "test", count: 10 });

  assert.equal(body.count, 3);
  assert.equal(result.found, false);
  assert.deepEqual(result.results, []);
});

test("fetch returns truncated Markdown content", async () => {
  let request;
  const content = "a".repeat(1_200);
  const client = makeClient({
    webSearch: { maxContentChars: 1_000 },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ title: "Title", content });
    },
  });

  const result = await client.fetch({ url: "https://example.com/page" });

  assert.equal(request.url, "https://api.deepseek.com/v1/tools/fetch");
  assert.deepEqual(JSON.parse(request.options.body), {
    url: "https://example.com/page",
  });
  assert.equal(result.title, "Title");
  assert.equal(result.content, "a".repeat(1_000));
  assert.equal(result.truncated, true);
  assert.equal(result.originalChars, 1_200);
});

test("base URL ending in /v1 does not duplicate the version", async () => {
  let url;
  const client = makeClient({
    baseUrl: "https://api.deepseek.com/v1",
    fetchImpl: async (requestUrl) => {
      url = requestUrl;
      return response({ results: [] });
    },
  });

  await client.search({ query: "test" });

  assert.equal(url, "https://api.deepseek.com/v1/tools/search");
});

test("search and fetch validate inputs", async () => {
  const client = makeClient({
    fetchImpl: async () => response({}),
  });

  await assert.rejects(client.search({ query: "   " }), /搜索词不能为空/);
  await assert.rejects(
    client.search({ query: "x".repeat(129) }),
    /不能超过 128/,
  );
  await assert.rejects(client.search({ query: "test", count: 0 }), /1\.\.50/);
  await assert.rejects(client.fetch({ url: "ftp://example.com/a" }), /HTTP\/HTTPS/);
  await assert.rejects(
    client.fetch({ url: "https://user:pass@example.com/a" }),
    /HTTP\/HTTPS/,
  );
  await assert.rejects(client.fetch({ url: "https://example.com/" }), /正文/);
});

test("search and fetch can be cancelled", async () => {
  const controller = new AbortController();
  const client = makeClient({
    fetchImpl: async (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  });
  const pending = client.search({ query: "test", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error instanceof WebSearchError, true);
    assert.equal(error.code, "CANCELLED");
    return true;
  });
});

test("missing key, HTTP errors, and malformed responses are surfaced safely", async () => {
  const noKey = makeClient({
    apiKey: "",
    fetchImpl: async () => response({ results: [] }),
  });
  await assert.rejects(noKey.search({ query: "test" }), /API Key/);

  const insufficient = makeClient({
    fetchImpl: async () => response({}, 402),
  });
  await assert.rejects(insufficient.search({ query: "test" }), (error) => {
    assert.equal(error instanceof WebSearchError, true);
    assert.equal(error.status, 402);
    assert.match(error.message, /余额不足/);
    return true;
  });

  const limited = makeClient({
    fetchImpl: async () => response({}, 429),
  });
  await assert.rejects(limited.search({ query: "test" }), /太频繁/);

  const malformed = makeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new Error("bad json");
      },
    }),
  });
  await assert.rejects(malformed.search({ query: "test" }), /无法解析/);
});
