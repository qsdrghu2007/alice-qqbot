export class AIRequestError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "AIRequestError";
    this.status = status;
    this.code = code;
  }
}

function hasProtocol(value, protocols) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const DATA_IMAGE_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_INLINE_IMAGE_LENGTH = 12_000_000;

function validImageInput(value) {
  if (typeof value !== "string" || !value) return false;
  if (value.startsWith("data:")) {
    return value.length <= MAX_INLINE_IMAGE_LENGTH && DATA_IMAGE_URL.test(value);
  }
  return hasProtocol(value, ["https:"]);
}

function validateInput({
  config,
  messages,
  imageUrls,
  timeoutMs,
  maxTokens,
  temperature,
  thinking,
  reasoningEffort,
}) {
  if (!config?.baseUrl || !config?.model) throw new TypeError("AI 配置不完整");
  if (!hasProtocol(config.baseUrl, ["http:", "https:"])) {
    throw new TypeError("AI baseUrl 必须是合法 http(s) URL");
  }
  if (!Array.isArray(messages) || !messages.length || messages.length > 200) {
    throw new TypeError("messages 必须是 1..200 条消息");
  }
  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "user", "assistant", "tool"].includes(message.role)
    ) {
      throw new TypeError("messages 中包含无效消息");
    }
  }
  if (!Array.isArray(imageUrls) || !imageUrls.every(validImageInput)) {
    throw new TypeError("图片只允许合法的 HTTPS URL 或 data:image 内联数据");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs 必须是正数");
  }
  if (
    maxTokens !== undefined &&
    (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_000)
  ) {
    throw new TypeError("maxTokens 必须是 1..32000 的整数");
  }
  if (
    temperature !== undefined &&
    (typeof temperature !== "number" || temperature < 0 || temperature > 2)
  ) {
    throw new TypeError("temperature 必须在 0..2 之间");
  }
  if (thinking !== undefined && !["enabled", "disabled"].includes(thinking)) {
    throw new TypeError("thinking 必须是 enabled 或 disabled");
  }
  if (
    reasoningEffort !== undefined &&
    !["low", "high", "max"].includes(reasoningEffort)
  ) {
    throw new TypeError("reasoningEffort 必须是 low、high 或 max");
  }
}

function endpoint(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function contentForMessage(message, imageUrls = []) {
  if (!imageUrls.length || message.role !== "user") return message.content;
  return [
    { type: "text", text: message.content ?? "" },
    ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

function parseToolArguments(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AIRequestError("模型返回了空工具参数", { code: "BAD_TOOL_ARGUMENTS" });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AIRequestError("模型返回的工具参数不是合法 JSON", {
      code: "BAD_TOOL_ARGUMENTS",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AIRequestError("模型返回的工具参数必须是 JSON 对象", {
      code: "BAD_TOOL_ARGUMENTS",
    });
  }
  return parsed;
}

/**
 * Fixed generation entry point for chat, proactive messages, and other local callers.
 * Callers must set timeoutMs comfortably below their own scheduling deadline.
 */
export async function chat({
  config,
  messages,
  imageUrls = [],
  tools,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
  signal,
  maxTokens,
  temperature,
  thinking,
  reasoningEffort,
  responseFormat,
}) {
  validateInput({
    config,
    messages,
    imageUrls,
    timeoutMs,
    maxTokens,
    temperature,
    thinking,
    reasoningEffort,
  });
  if (!config.apiKey) {
    throw new AIRequestError("尚未配置 AI API Key", { code: "NO_API_KEY" });
  }
  if (typeof fetchImpl !== "function") {
    throw new AIRequestError("当前运行环境不支持网络请求", { code: "NO_FETCH" });
  }
  const effectiveThinking = thinking ?? "enabled";
  const body = {
    model: config.model,
    messages: messages.map((message, index) => ({
      ...message,
      content: contentForMessage(message, index === messages.length - 1 ? imageUrls : []),
    })),
    temperature: temperature ?? config.temperature,
    thinking: { type: effectiveThinking },
    ...(effectiveThinking === "enabled"
      ? { reasoning_effort: reasoningEffort ?? config.reasoningEffort ?? "high" }
      : {}),
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (responseFormat !== undefined) body.response_format = responseFormat;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(endpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AIRequestError("AI 请求已取消", { code: "CANCELLED" });
    }
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new AIRequestError("AI 服务响应超时", { code: "TIMEOUT" });
    }
    throw new AIRequestError("无法连接 AI 服务", { code: "NETWORK_ERROR" });
  }

  if (signal?.aborted) {
    throw new AIRequestError("AI 请求已取消", { code: "CANCELLED" });
  }
  if (!response.ok) {
    throw new AIRequestError(`AI 服务返回 HTTP ${response.status}`, {
      status: response.status,
      code: "HTTP_ERROR",
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AIRequestError("AI 服务返回了无法解析的响应", { code: "BAD_RESPONSE" });
  }
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new AIRequestError("AI 服务响应缺少消息内容", { code: "BAD_RESPONSE" });
  }

  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawToolCalls.map((call) => {
    if (
      !call ||
      typeof call.id !== "string" ||
      typeof call.function?.name !== "string"
    ) {
      throw new AIRequestError("AI 服务返回了无效工具调用", { code: "BAD_RESPONSE" });
    }
    return {
      id: call.id,
      name: call.function.name,
      arguments: parseToolArguments(call.function.arguments),
    };
  });

  const reasoningContent =
    typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return {
    content: typeof message.content === "string" ? message.content : "",
    reasoningContent,
    toolCalls,
    rawMessage: {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls.length
        ? {
            tool_calls: rawToolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: call.function,
            })),
          }
        : {}),
    },
  };
}
