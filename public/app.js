const TOKEN_KEY = "xiaoyu.console.token";
const CHAT_KEY = "xiaoyu.chat.recent";
const CHAT_LIMIT = 30;
const MEMORY_TYPE_LABELS = {
  personal: "个人",
  preference: "偏好",
  event: "事件",
  emotion: "情感",
  fact: "事实",
};
const MEMORY_SOURCE_LABELS = {
  auto: "自动",
  tool: "AI 工具",
  manual: "手动",
};

class ApiError extends Error {
  constructor(message, status = 0, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const state = {
  token: "",
  authInvalid: false,
  serverReachable: false,
  status: null,
  statusUpdatedAt: null,
  config: null,
  configLoaded: false,
  memories: [],
  memoriesLoaded: false,
  memoryScopes: [],
  memoryScopeKey: "",
  memoryScope: null,
  memoryMeta: null,
  chatMessages: loadChatMessages(),
  chatAttachments: [],
  chatBusy: false,
  paused: false,
  transportSnapshot: "",
  recognition: null,
  stickers: [],
  stickersLoaded: false,
  stickerMeta: null,
  stickerSearch: "",
  stickerCategory: "all",
  stickerObjectUrls: new Map(),
  stickerLoading: new Map(),
  stickerObserver: null,
  stickerPreviewId: null,
};

const elements = {
  demoBadge: document.querySelector("#demoBadge"),
  mobileDemoBadge: document.querySelector("#mobileDemoBadge"),
  mobilePauseButton: document.querySelector("#mobilePauseButton"),
  connectionBadge: document.querySelector("#connectionBadge"),
  serverBadge: document.querySelector("#serverBadge"),
  statusFreshness: document.querySelector("#statusFreshness"),
  sideServer: document.querySelector("#sideServer"),
  sideAi: document.querySelector("#sideAi"),
  sideQq: document.querySelector("#sideQq"),
  sideOnebot: document.querySelector("#sideOnebot"),
  sideQzone: document.querySelector("#sideQzone"),
  contextServer: document.querySelector("#contextServer"),
  contextAi: document.querySelector("#contextAi"),
  contextQq: document.querySelector("#contextQq"),
  contextOnebot: document.querySelector("#contextOnebot"),
  contextQzone: document.querySelector("#contextQzone"),
  pauseToggle: document.querySelector("#pauseToggle"),
  pauseLabel: document.querySelector("#pauseLabel"),
  railReminder: document.querySelector("#railReminder"),
  authNotice: document.querySelector("#authNotice"),
  authNoticeText: document.querySelector("#authNoticeText"),
  viewTitle: document.querySelector("#viewTitle"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatImageUrl: document.querySelector("#chatImageUrl"),
  chatMessages: document.querySelector("#chatMessages"),
  chatError: document.querySelector("#chatError"),
  chatAttachmentTray: document.querySelector("#chatAttachmentTray"),
  chatAttachments: document.querySelector("#chatAttachments"),
  addImageButton: document.querySelector("#addImageButton"),
  sendChatButton: document.querySelector("#sendChatButton"),
  refreshChatButton: document.querySelector("#refreshChatButton"),
  voiceInputButton: document.querySelector("#voiceInputButton"),
  speakReplyButton: document.querySelector("#speakReplyButton"),
  speechNote: document.querySelector(".speech-note"),
  qzoneForm: document.querySelector("#qzoneForm"),
  qzoneText: document.querySelector("#qzoneText"),
  qzoneImages: document.querySelector("#qzoneImages"),
  qzoneVisibility: document.querySelector("#qzoneVisibility"),
  qzoneAutoPublishToggle: document.querySelector("#qzoneAutoPublishToggle"),
  qzonePublishButton: document.querySelector("#qzonePublishButton"),
  qzoneLoginButton: document.querySelector("#qzoneLoginButton"),
  qzoneLoginState: document.querySelector("#qzoneLoginState"),
  qzoneResult: document.querySelector("#qzoneResult"),
  qzoneResultBadge: document.querySelector("#qzoneResultBadge"),
  qzoneResultTitle: document.querySelector("#qzoneResultTitle"),
  qzoneResultText: document.querySelector("#qzoneResultText"),
  qzoneResultRaw: document.querySelector("#qzoneResultRaw"),
  memoryForm: document.querySelector("#memoryForm"),
  memoryInput: document.querySelector("#memoryInput"),
  memoryType: document.querySelector("#memoryType"),
  memoryImportance: document.querySelector("#memoryImportance"),
  memoryScope: document.querySelector("#memoryScope"),
  memoryScopeNote: document.querySelector("#memoryScopeNote"),
  memoryMeta: document.querySelector("#memoryMeta"),
  clearMemoriesButton: document.querySelector("#clearMemoriesButton"),
  addMemoryButton: document.querySelector("#addMemoryButton"),
  memoryList: document.querySelector("#memoryList"),
  memoryError: document.querySelector("#memoryError"),
  refreshMemoriesButton: document.querySelector("#refreshMemoriesButton"),
  refreshStickersButton: document.querySelector("#refreshStickersButton"),
  stickerSearch: document.querySelector("#stickerSearch"),
  stickerCategory: document.querySelector("#stickerCategory"),
  openStickerUploadButton: document.querySelector("#openStickerUploadButton"),
  stickerCount: document.querySelector("#stickerCount"),
  stickerRejected: document.querySelector("#stickerRejected"),
  stickerAutoCollectToggle: document.querySelector("#stickerAutoCollectToggle"),
  stickerEnabledToggle: document.querySelector("#stickerEnabledToggle"),
  stickerError: document.querySelector("#stickerError"),
  stickerGrid: document.querySelector("#stickerGrid"),
  stickerEmpty: document.querySelector("#stickerEmpty"),
  stickerUploadDialog: document.querySelector("#stickerUploadDialog"),
  stickerUploadForm: document.querySelector("#stickerUploadForm"),
  stickerUploadFile: document.querySelector("#stickerUploadFile"),
  stickerUploadSummary: document.querySelector("#stickerUploadSummary"),
  stickerUploadTags: document.querySelector("#stickerUploadTags"),
  stickerUploadCategory: document.querySelector("#stickerUploadCategory"),
  stickerUploadSubmit: document.querySelector("#stickerUploadSubmit"),
  closeStickerUploadButton: document.querySelector("#closeStickerUploadButton"),
  cancelStickerUploadButton: document.querySelector("#cancelStickerUploadButton"),
  stickerUploadError: document.querySelector("#stickerUploadError"),
  stickerPreviewDialog: document.querySelector("#stickerPreviewDialog"),
  stickerPreviewImage: document.querySelector("#stickerPreviewImage"),
  stickerPreviewSummary: document.querySelector("#stickerPreviewSummary"),
  stickerPreviewMeta: document.querySelector("#stickerPreviewMeta"),
  stickerPreviewTags: document.querySelector("#stickerPreviewTags"),
  stickerTagEditor: document.querySelector("#stickerTagEditor"),
  stickerTagEditorInput: document.querySelector("#stickerTagEditorInput"),
  stickerTagEditorError: document.querySelector("#stickerTagEditorError"),
  editStickerTagsButton: document.querySelector("#editStickerTagsButton"),
  saveStickerTagsButton: document.querySelector("#saveStickerTagsButton"),
  cancelStickerTagsButton: document.querySelector("#cancelStickerTagsButton"),
  closeStickerPreviewButton: document.querySelector("#closeStickerPreviewButton"),
  deleteStickerFromPreviewButton: document.querySelector("#deleteStickerFromPreviewButton"),
  configForm: document.querySelector("#configForm"),
  configError: document.querySelector("#configError"),
  configSaveState: document.querySelector("#configSaveState"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  refreshConfigButton: document.querySelector("#refreshConfigButton"),
  reconnectNotice: document.querySelector("#reconnectNotice"),
  reconnectAfterSaveButton: document.querySelector("#reconnectAfterSaveButton"),
  personaName: document.querySelector("#personaName"),
  aiBaseUrl: document.querySelector("#aiBaseUrl"),
  aiApiKey: document.querySelector("#aiApiKey"),
  aiModel: document.querySelector("#aiModel"),
  aiReasoningEffort: document.querySelector("#aiReasoningEffort"),
  aiTemperature: document.querySelector("#aiTemperature"),
  aiHistoryMessages: document.querySelector("#aiHistoryMessages"),
  aiSystemPrompt: document.querySelector("#aiSystemPrompt"),
  demoMode: document.querySelector("#demoMode"),
  memoryEnabled: document.querySelector("#memoryEnabled"),
  memoryAutoExtract: document.querySelector("#memoryAutoExtract"),
  memoryMinImportance: document.querySelector("#memoryMinImportance"),
  memoryMaxPerKey: document.querySelector("#memoryMaxPerKey"),
  memoryMaxInjected: document.querySelector("#memoryMaxInjected"),
  memoryJudgeModel: document.querySelector("#memoryJudgeModel"),
  stickerEnabled: document.querySelector("#stickerEnabled"),
  stickerAutoCollect: document.querySelector("#stickerAutoCollect"),
  stickerMaxItems: document.querySelector("#stickerMaxItems"),
  stickerMaxFileSizeMb: document.querySelector("#stickerMaxFileSizeMb"),
  stickerMinCuteScore: document.querySelector("#stickerMinCuteScore"),
  stickerMinInterestingScore: document.querySelector("#stickerMinInterestingScore"),
  stickerProactiveCooldownMinutes: document.querySelector("#stickerProactiveCooldownMinutes"),
  webSearchEnabled: document.querySelector("#webSearchEnabled"),
  webSearchSearchEnabled: document.querySelector("#webSearchSearchEnabled"),
  webSearchFetchEnabled: document.querySelector("#webSearchFetchEnabled"),
  webSearchApiKey: document.querySelector("#webSearchApiKey"),
  webSearchMaxCallsPerTurn: document.querySelector("#webSearchMaxCallsPerTurn"),
  webSearchMaxResults: document.querySelector("#webSearchMaxResults"),
  webSearchMaxContentChars: document.querySelector("#webSearchMaxContentChars"),
  maxToolCallsPerTurn: document.querySelector("#maxToolCallsPerTurn"),
  inputDelayMs: document.querySelector("#inputDelayMs"),
  replyDelayEnabled: document.querySelector("#replyDelayEnabled"),
  replyDelayTypingIndicator: document.querySelector("#replyDelayTypingIndicator"),
  replyDelayBaseMs: document.querySelector("#replyDelayBaseMs"),
  replyDelayMsPerChar: document.querySelector("#replyDelayMsPerChar"),
  replyDelayMaxMs: document.querySelector("#replyDelayMaxMs"),
  chatExitEnabled: document.querySelector("#chatExitEnabled"),
  chatExitIdleMinutes: document.querySelector("#chatExitIdleMinutes"),
  chatExitMinConfidence: document.querySelector("#chatExitMinConfidence"),
  chatExitJudgeModel: document.querySelector("#chatExitJudgeModel"),
  chatExitJudgeTimeoutMs: document.querySelector("#chatExitJudgeTimeoutMs"),
  followUpEnabled: document.querySelector("#followUpEnabled"),
  followUpMinMinutes: document.querySelector("#followUpMinMinutes"),
  followUpMaxMinutes: document.querySelector("#followUpMaxMinutes"),
  followUpQuietStart: document.querySelector("#followUpQuietStart"),
  followUpQuietEnd: document.querySelector("#followUpQuietEnd"),
  followUpTimezone: document.querySelector("#followUpTimezone"),
  followUpRetryDelayMinutes: document.querySelector("#followUpRetryDelayMinutes"),
  qqAppId: document.querySelector("#qqAppId"),
  qqSecret: document.querySelector("#qqSecret"),
  qqEnabled: document.querySelector("#qqEnabled"),
  qqSandbox: document.querySelector("#qqSandbox"),
  onebotUrl: document.querySelector("#onebotUrl"),
  onebotToken: document.querySelector("#onebotToken"),
  onebotEnabled: document.querySelector("#onebotEnabled"),
  policyAutoActions: document.querySelector("#policyAutoActions"),
  policyPaused: document.querySelector("#policyPaused"),
  policyAllowedUsers: document.querySelector("#policyAllowedUsers"),
  policyAllowedGroups: document.querySelector("#policyAllowedGroups"),
  policyActionUsers: document.querySelector("#policyActionUsers"),
  policyCooldownMs: document.querySelector("#policyCooldownMs"),
  policyMaxActionsPerHour: document.querySelector("#policyMaxActionsPerHour"),
  qzoneEnabled: document.querySelector("#qzoneEnabled"),
  settingsQzoneAutoPublish: document.querySelector("#settingsQzoneAutoPublish"),
  qzoneHeadless: document.querySelector("#qzoneHeadless"),
  qzoneCommentsEnabled: document.querySelector("#qzoneCommentsEnabled"),
  qzoneCommentsDryRun: document.querySelector("#qzoneCommentsDryRun"),
  qzoneCommentsOnlyFriends: document.querySelector("#qzoneCommentsOnlyFriends"),
  qzoneCommentsAiDecide: document.querySelector("#qzoneCommentsAiDecide"),
  qzoneCommentsNestedReplyFallback: document.querySelector("#qzoneCommentsNestedReplyFallback"),
  qzoneCommentsPollMinutes: document.querySelector("#qzoneCommentsPollMinutes"),
  qzoneCommentsActivePollMinutes: document.querySelector("#qzoneCommentsActivePollMinutes"),
  qzoneCommentsActiveWindowMinutes: document.querySelector("#qzoneCommentsActiveWindowMinutes"),
  qzoneCommentsPollJitterPercent: document.querySelector("#qzoneCommentsPollJitterPercent"),
  qzoneCommentsCookieRefreshMinutes: document.querySelector("#qzoneCommentsCookieRefreshMinutes"),
  qzoneCommentsOwnTrackHours: document.querySelector("#qzoneCommentsOwnTrackHours"),
  qzoneCommentsExternalTrackHours: document.querySelector("#qzoneCommentsExternalTrackHours"),
  qzoneCommentsMaxRepliesPerCycle: document.querySelector("#qzoneCommentsMaxRepliesPerCycle"),
  qzoneCommentsMaxRepliesPerHour: document.querySelector("#qzoneCommentsMaxRepliesPerHour"),
  qzoneCommentsDelayMinSeconds: document.querySelector("#qzoneCommentsDelayMinSeconds"),
  qzoneCommentsDelayMaxSeconds: document.querySelector("#qzoneCommentsDelayMaxSeconds"),
  qzoneCommentsMaxReplyChars: document.querySelector("#qzoneCommentsMaxReplyChars"),
  qzoneCommentsAllowedUsers: document.querySelector("#qzoneCommentsAllowedUsers"),
  qzoneCommentsBlockedUsers: document.querySelector("#qzoneCommentsBlockedUsers"),
  qzoneCommentsReplyPrompt: document.querySelector("#qzoneCommentsReplyPrompt"),
  qzoneCommentsStatus: document.querySelector("#qzoneCommentsStatus"),
  qzoneCommentsError: document.querySelector("#qzoneCommentsError"),
  qzoneCommentsPollButton: document.querySelector("#qzoneCommentsPollButton"),
  autonomyEnabled: document.querySelector("#autonomyEnabled"),
  autonomyIntervalMinutes: document.querySelector("#autonomyIntervalMinutes"),
  autonomyPrompt: document.querySelector("#autonomyPrompt"),
  autonomyQuietStart: document.querySelector("#autonomyQuietStart"),
  autonomyQuietEnd: document.querySelector("#autonomyQuietEnd"),
  autonomyTimezone: document.querySelector("#autonomyTimezone"),
  refreshStatusButton: document.querySelector("#refreshStatusButton"),
  reconnectButton: document.querySelector("#reconnectButton"),
  exportButton: document.querySelector("#exportButton"),
  backupButton: document.querySelector("#backupButton"),
  importFile: document.querySelector("#importFile"),
  diagnosticError: document.querySelector("#diagnosticError"),
  diagnosticResult: document.querySelector("#diagnosticResult"),
  diagServer: document.querySelector("#diagServer"),
  diagAi: document.querySelector("#diagAi"),
  diagQq: document.querySelector("#diagQq"),
  diagOnebot: document.querySelector("#diagOnebot"),
  diagQzone: document.querySelector("#diagQzone"),
  diagPause: document.querySelector("#diagPause"),
  diagDemo: document.querySelector("#diagDemo"),
  autonomyNextAt: document.querySelector("#autonomyNextAt"),
  autonomyLastStatus: document.querySelector("#autonomyLastStatus"),
  autonomyLastError: document.querySelector("#autonomyLastError"),
  toastRegion: document.querySelector("#toastRegion"),
};

function resolveConsoleToken() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : "";
  let hashToken = "";

  if (hash) {
    try {
      const params = new URLSearchParams(hash);
      hashToken = String(params.get("token") || "").trim();
      if (hashToken) {
        try {
          sessionStorage.setItem(TOKEN_KEY, hashToken);
        } catch {
          // The token can still be used for this page load when storage is unavailable.
        }
      }
      if (params.has("token") || hash.startsWith("token=")) {
        try {
          history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
        } catch {
          // Ignore a browser restriction; the token is never inserted into the page.
        }
      }
    } catch {
      if (hash.startsWith("token=")) {
        try {
          history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
        } catch {
          // Ignore a browser restriction.
        }
      }
    }
  }

  if (hashToken) return hashToken;
  try {
    return String(sessionStorage.getItem(TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

function safeServerText(value, fallback = "请求失败，请稍后重试。") {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }
  let text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (state.token) {
    text = text.split(state.token).join("[已隐藏]");
    try {
      text = text.split(encodeURIComponent(state.token)).join("[已隐藏]");
    } catch {
      // Ignore a token that cannot be URI encoded.
    }
  }
  for (const input of [
    elements.aiApiKey,
    elements.qqSecret,
    elements.onebotToken,
    elements.webSearchApiKey,
  ]) {
    const secret = input?.value?.trim();
    if (secret) text = text.split(secret).join("[已隐藏]");
  }
  return (text || fallback).slice(0, 700);
}

function getErrorMessage(error) {
  if (error instanceof ApiError) {
    return safeServerText(error.message, "接口请求失败。");
  }
  return safeServerText(error?.message, "操作失败，请检查本地控制台。");
}

function setNodeText(node, value) {
  if (node) node.textContent = String(value ?? "");
}

function setInlineError(node, message) {
  if (!node) return;
  if (!message) {
    node.textContent = "";
    node.hidden = true;
    return;
  }
  node.textContent = safeServerText(message);
  node.hidden = false;
}

function showToast(message, kind = "info") {
  const toast = document.createElement("div");
  toast.className = `toast${kind === "error" ? " is-error" : ""}`;
  toast.textContent = safeServerText(message);
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function showTokenProblem(message = "控制台 token 缺失、过期或无效，请使用服务端提供的新控制台链接。") {
  state.authInvalid = true;
  state.serverReachable = false;
  elements.authNotice.hidden = false;
  setNodeText(elements.authNoticeText, safeServerText(message, "控制台 token 无效。"));
}

function clearTokenProblem() {
  state.authInvalid = false;
  elements.authNotice.hidden = true;
}

function markTokenInvalid(message) {
  state.token = "";
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Keep the in-memory session state.
  }
  showTokenProblem(message);
  renderStatus();
}

function authHeaders() {
  return {
    Authorization: `Bearer ${state.token}`,
    "Content-Type": "application/json",
  };
}

async function requestResponse(path, options = {}) {
  if (!state.token) {
    showTokenProblem();
    throw new ApiError(
      "控制台 token 缺失、过期或无效，请使用服务端提供的新控制台链接。",
      401,
      "AUTH_REQUIRED",
    );
  }

  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: authHeaders(),
    });
  } catch {
    throw new ApiError(
      "无法连接本地控制台，请确认服务仍在运行。",
      0,
      "NETWORK_ERROR",
    );
  }

  if (response.status === 401 || response.status === 403) {
    markTokenInvalid(
      "控制台 token 已过期或无效，请使用服务端重新生成的控制台链接。",
    );
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const serverMessage = [
      payload?.error?.message,
      typeof payload?.error === "string" ? payload.error : "",
      payload?.message,
      payload?.detail,
      payload?.data?.message,
    ].find((value) => typeof value === "string" && value.trim());
    const message =
      response.status === 401 || response.status === 403
        ? "控制台 token 已过期或无效，请使用服务端重新生成的控制台链接。"
        : safeServerText(
            serverMessage,
            `请求失败（HTTP ${response.status}）。`,
          );
    throw new ApiError(message, response.status, "HTTP_ERROR");
  }

  return response;
}

async function requestJson(path, options = {}) {
  const requestOptions = { ...options };
  if (
    requestOptions.body !== undefined &&
    requestOptions.body !== null &&
    typeof requestOptions.body !== "string" &&
    !(requestOptions.body instanceof Blob)
  ) {
    requestOptions.body = JSON.stringify(requestOptions.body);
  }
  const response = await requestResponse(path, requestOptions);
  if (response.status === 204) return null;

  const raw = await response.text();
  if (!raw.trim()) return null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError(
        "服务返回了无法解析的 JSON 数据。",
        response.status,
        "BAD_JSON",
      );
    }
  }
  return raw;
}

function setBusy(button, busy) {
  if (button) {
    button.disabled = Boolean(busy);
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function readPath(object, path) {
  let value = object;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapConfig(payload) {
  const candidate =
    payload?.config ??
    payload?.data?.config ??
    (isPlainObject(payload?.data) ? payload.data : payload);
  return isPlainObject(candidate) ? candidate : {};
}

function unwrapStatus(payload) {
  const candidates = [
    payload?.status,
    payload?.data?.status,
    payload?.data,
    payload,
  ];
  const status = candidates.find(isPlainObject) || {};
  return {
    data: status,
    config: isPlainObject(status.config)
      ? status.config
      : isPlainObject(payload?.config)
        ? payload.config
        : {},
  };
}

function getChannelInfo(statusData, config, key) {
  const aliases = {
    qq: ["qq", "qqOfficial"],
    onebot: ["onebot", "oneBot"],
    qzone: ["qzone"],
  };
  const names = aliases[key] || [key];
  const directFields = {
    qq: ["qqConnected", "qqOfficialConnected"],
    onebot: ["onebotConnected", "oneBotConnected"],
    qzone: ["qzoneConnected", "qzoneLoggedIn"],
  };
  for (const field of directFields[key] || []) {
    if (field in statusData) {
      return { value: statusData[field], kind: "connection" };
    }
  }
  let runtime;
  for (const name of names) {
    runtime = firstDefined(
      readPath(statusData, `adapters.${name}`),
      readPath(statusData, `channels.${name}`),
      readPath(statusData, name),
    );
    if (runtime !== undefined) break;
  }

  if (isPlainObject(runtime)) {
    for (const field of [
      "connected",
      "online",
      "authenticated",
      "ready",
      "loggedIn",
    ]) {
      if (field in runtime) return { value: runtime[field], kind: "connection" };
    }
    if ("status" in runtime) return { value: runtime.status, kind: "status" };
    if ("state" in runtime) return { value: runtime.state, kind: "status" };
    if ("enabled" in runtime) return { value: runtime.enabled, kind: "enabled" };
  } else if (
    typeof runtime === "boolean" ||
    typeof runtime === "string" ||
    typeof runtime === "number"
  ) {
    return { value: runtime, kind: key === "qzone" ? "status" : "connection" };
  }

  let configSection;
  for (const name of names) {
    configSection = config[name];
    if (isPlainObject(configSection)) break;
  }
  if (isPlainObject(configSection) && "enabled" in configSection) {
    return { value: configSection.enabled, kind: "enabled" };
  }
  return { value: undefined, kind: "unknown" };
}

function displayChannel(info) {
  const value = info?.value;
  if (value === undefined || value === null || value === "") return "未知";
  if (typeof value === "boolean") {
    if (info.kind === "enabled") {
      return value ? "已启用，连接未确认" : "未启用";
    }
    return value ? "已连接" : "未连接";
  }

  const stringValue = safeServerText(value, "未知");
  const normalized = stringValue.toLowerCase();
  if (["connected", "online", "ready", "ok", "healthy", "open"].includes(normalized)) {
    return info.kind === "enabled" ? "已启用，连接未确认" : "已连接";
  }
  if (["enabled", "active"].includes(normalized)) return "已启用，连接未确认";
  if (["disabled", "inactive", "off"].includes(normalized)) return "未启用";
  if (
    ["disconnected", "offline", "not_connected", "unavailable", "error", "failed"].includes(
      normalized,
    )
  ) {
    return "未连接";
  }
  return stringValue;
}

function displayAiReady(value) {
  if (value === undefined || value === null) return "未知";
  if (typeof value === "boolean") return value ? "已就绪" : "未就绪";
  const text = safeServerText(value, "未知").toLowerCase();
  if (["ready", "configured", "ok", "true"].includes(text)) return "已就绪";
  if (["missing", "unconfigured", "false", "none"].includes(text)) return "未就绪";
  return safeServerText(value, "未知");
}

function statusClass(value) {
  if (value === true) return "is-connected";
  if (value === false) return "is-unavailable";
  const normalized = String(value || "").toLowerCase();
  if (
    normalized.includes("未确认") ||
    ["未连接", "未就绪", "未启用"].some((text) => normalized.includes(text))
  ) {
    return "is-unavailable";
  }
  if (["已连接", "已就绪", "已启用"].some((text) => normalized.includes(text))) {
    return "is-connected";
  }
  return "";
}

function renderStatus() {
  const status = state.status;
  const serverText = state.serverReachable ? "已连接" : "未连接";
  const aiText = displayAiReady(status?.aiReady);
  const qqText = displayChannel(status?.qq);
  const onebotText = displayChannel(status?.onebot);
  const qzoneText = displayChannel(status?.qzone);
  const demo = status?.demo;
  const demoText = demo === true ? "本地演示" : demo === false ? "运行时" : "本地演示";
  const pauseText =
    status?.paused === true
      ? "已暂停"
      : status?.paused === false
        ? "运行中"
        : "未知";
  const autonomy = status?.autonomy || {};
  const nextAt = safeServerText(autonomy.nextAt, "未返回");
  const lastStatus = safeServerText(autonomy.lastStatus, "未返回");
  const lastError = safeServerText(autonomy.lastError, "未返回");

  setNodeText(elements.sideServer, serverText);
  setNodeText(elements.sideAi, aiText);
  setNodeText(elements.sideQq, qqText);
  setNodeText(elements.sideOnebot, onebotText);
  setNodeText(elements.sideQzone, qzoneText);
  setNodeText(elements.contextServer, serverText);
  setNodeText(elements.contextAi, aiText);
  setNodeText(elements.contextQq, qqText);
  setNodeText(elements.contextOnebot, onebotText);
  setNodeText(elements.contextQzone, qzoneText);
  setNodeText(elements.diagServer, serverText);
  setNodeText(elements.diagAi, aiText);
  setNodeText(elements.diagQq, qqText);
  setNodeText(elements.diagOnebot, onebotText);
  setNodeText(elements.diagQzone, qzoneText);
  setNodeText(elements.diagPause, pauseText);
  setNodeText(elements.diagDemo, demoText);
  setNodeText(elements.autonomyNextAt, nextAt);
  setNodeText(elements.autonomyLastStatus, lastStatus);
  setNodeText(elements.autonomyLastError, lastError);

  setNodeText(elements.connectionBadge, state.serverReachable ? "已连接" : "未连接");
  setNodeText(elements.serverBadge, state.serverReachable ? "控制台已连接" : "未连接");
  setNodeText(elements.demoBadge, demoText);
  setNodeText(elements.mobileDemoBadge, demoText);
  elements.connectionBadge.className = `badge ${state.serverReachable ? "badge-connected" : "badge-neutral"}`;
  elements.serverBadge.className = `badge ${state.serverReachable ? "badge-connected" : "badge-neutral"}`;

  elements.pauseToggle.checked = Boolean(status?.paused);
  state.paused = Boolean(status?.paused);
  setNodeText(
    elements.pauseLabel,
    status ? pauseText : "当前未知",
  );
  elements.policyPaused.checked = Boolean(status?.paused);
  elements.mobilePauseButton.setAttribute(
    "aria-pressed",
    state.paused ? "true" : "false",
  );
  elements.mobilePauseButton.setAttribute(
    "aria-label",
    state.paused ? "恢复机器人" : "暂停机器人",
  );
  elements.mobilePauseButton.title = state.paused ? "恢复机器人" : "暂停机器人";

  const statusMappings = [
    [elements.contextServer?.parentElement, serverText],
    [elements.contextAi?.parentElement, aiText],
    [elements.contextQq?.parentElement, qqText],
    [elements.contextOnebot?.parentElement, onebotText],
    [elements.contextQzone?.parentElement, qzoneText],
  ];
  for (const [row, value] of statusMappings) {
    if (!row) continue;
    row.classList.remove("is-connected", "is-unavailable");
    const className = statusClass(value);
    if (className) row.classList.add(className);
  }

  if (!state.token || state.authInvalid) {
    setNodeText(elements.railReminder, "等待有效控制台链接");
  } else if (!state.serverReachable) {
    setNodeText(elements.railReminder, "控制台暂不可达");
  } else if (status?.paused) {
    setNodeText(elements.railReminder, "机器人已暂停");
  } else if (demo === true) {
    setNodeText(elements.railReminder, "本地演示模式");
  } else {
    setNodeText(elements.railReminder, "等待适配器状态");
  }
}

function extractStatus(payload) {
  const { data, config } = unwrapStatus(payload);
  const demo = firstDefined(data.demo, config.demo);
  const policy = firstDefined(data.policy, config.policy);
  const paused = firstDefined(
    data.paused,
    readPath(data, "policy.paused"),
    readPath(config, "policy.paused"),
    isPlainObject(policy) ? policy.paused : undefined,
  );
  const aiReady = firstDefined(
    data.aiKeyReady,
    data.aiKeyConfigured,
    data.apiKeyReady,
    data.apiKeyConfigured,
    readPath(data, "ai.keyReady"),
    readPath(data, "ai.configured"),
    readPath(data, "ai.apiKeyConfigured"),
    readPath(config, "ai.apiKeyReady"),
    readPath(config, "ai.apiKeyConfigured"),
    readPath(config, "ai.apiKeySet"),
  );
  return {
    demo: typeof demo === "boolean" ? demo : undefined,
    paused: typeof paused === "boolean" ? paused : undefined,
    aiReady,
    qq: getChannelInfo(data, config, "qq"),
    onebot: getChannelInfo(data, config, "onebot"),
    qzone: getChannelInfo(data, config, "qzone"),
    autonomy: isPlainObject(data.autonomy) ? data.autonomy : {},
    raw: data,
  };
}

async function loadStatus({ notify = false } = {}) {
  if (!state.token) {
    showTokenProblem();
    renderStatus();
    return false;
  }
  setNodeText(elements.statusFreshness, "检查中");
  try {
    const payload = await requestJson("/api/status", { method: "GET" });
    state.status = extractStatus(payload);
    state.serverReachable = true;
    state.statusUpdatedAt = new Date();
    clearTokenProblem();
    setNodeText(elements.statusFreshness, "刚刚更新");
    renderStatus();
    if (notify) showToast("状态已刷新。");
    return true;
  } catch (error) {
    state.serverReachable = false;
    state.status = null;
    state.statusUpdatedAt = null;
    setNodeText(elements.statusFreshness, "读取失败");
    renderStatus();
    if (notify || error?.status === 401 || error?.status === 403) {
      showToast(getErrorMessage(error), "error");
    }
    return false;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function fillConfigForm(config) {
  state.config = config;
  state.configLoaded = true;
  setNodeText(elements.configSaveState, "配置已载入");
  setInlineError(elements.configError, "");

  const personaName = firstDefined(
    readPath(config, "persona.name"),
    readPath(config, "personality.name"),
    config.name,
  );
  elements.personaName.value = String(personaName || "");
  elements.aiBaseUrl.value = String(firstDefined(readPath(config, "ai.baseUrl"), "") || "");
  elements.aiApiKey.value = "";
  elements.aiModel.value = String(firstDefined(readPath(config, "ai.model"), "") || "");
  const reasoningEffort = String(
    firstDefined(readPath(config, "ai.reasoningEffort"), "high") || "high",
  );
  elements.aiReasoningEffort.value = ["low", "high", "max"].includes(reasoningEffort)
    ? reasoningEffort
    : "high";
  elements.aiTemperature.value = String(
    firstDefined(readPath(config, "ai.temperature"), "") ?? "",
  );
  elements.aiHistoryMessages.value = String(
    firstDefined(readPath(config, "ai.historyMessages"), 30) ?? "",
  );
  elements.aiSystemPrompt.value = String(
    firstDefined(readPath(config, "ai.systemPrompt"), "") || "",
  );
  elements.demoMode.checked = Boolean(readPath(config, "demo"));
  elements.memoryEnabled.checked = readPath(config, "memory.enabled") !== false;
  elements.memoryAutoExtract.checked = readPath(config, "memory.autoExtract") !== false;
  elements.memoryMinImportance.value = String(
    firstDefined(readPath(config, "memory.minImportance"), 7) ?? "",
  );
  elements.memoryMaxPerKey.value = String(
    firstDefined(readPath(config, "memory.maxPerKey"), 50) ?? "",
  );
  elements.memoryMaxInjected.value = String(
    firstDefined(readPath(config, "memory.maxInjected"), 10) ?? "",
  );
  elements.memoryJudgeModel.value = String(
    firstDefined(readPath(config, "memory.judgeModel"), "") || "",
  );
  elements.stickerEnabled.checked = readPath(config, "stickers.enabled") !== false;
  elements.stickerAutoCollect.checked =
    readPath(config, "stickers.autoCollect") !== false;
  elements.stickerMaxItems.value = String(
    firstDefined(readPath(config, "stickers.maxItems"), 1000) ?? "",
  );
  const maxFileSizeBytes = Number(
    firstDefined(readPath(config, "stickers.maxFileSizeBytes"), 4 * 1024 * 1024),
  );
  elements.stickerMaxFileSizeMb.value = String(
    Number.isFinite(maxFileSizeBytes) ? maxFileSizeBytes / (1024 * 1024) : 4,
  );
  elements.stickerMinCuteScore.value = String(
    firstDefined(readPath(config, "stickers.minCuteScore"), 0.6) ?? "",
  );
  elements.stickerMinInterestingScore.value = String(
    firstDefined(readPath(config, "stickers.minInterestingScore"), 0.75) ?? "",
  );
  elements.stickerProactiveCooldownMinutes.value = String(
    firstDefined(readPath(config, "stickers.proactiveCooldownMinutes"), 5) ?? "",
  );
  elements.webSearchEnabled.checked = readPath(config, "webSearch.enabled") !== false;
  elements.webSearchSearchEnabled.checked =
    readPath(config, "webSearch.searchEnabled") !== false;
  elements.webSearchFetchEnabled.checked =
    readPath(config, "webSearch.fetchEnabled") !== false;
  elements.webSearchApiKey.value = "";
  elements.webSearchMaxCallsPerTurn.value = String(
    firstDefined(readPath(config, "webSearch.maxCallsPerTurn"), 4) ?? "",
  );
  elements.webSearchMaxResults.value = String(
    firstDefined(readPath(config, "webSearch.maxResults"), 5) ?? "",
  );
  elements.webSearchMaxContentChars.value = String(
    firstDefined(readPath(config, "webSearch.maxContentChars"), 6000) ?? "",
  );
  elements.maxToolCallsPerTurn.value = String(
    firstDefined(readPath(config, "maxToolCallsPerTurn"), 6) ?? "",
  );
  elements.replyDelayEnabled.checked = readPath(config, "replyDelay.enabled") !== false;
  elements.replyDelayTypingIndicator.checked =
    readPath(config, "replyDelay.typingIndicator") !== false;
  elements.inputDelayMs.value = String(
    firstDefined(readPath(config, "inputDelayMs"), 2000) ?? "",
  );
  elements.replyDelayBaseMs.value = String(
    firstDefined(readPath(config, "replyDelay.baseMs"), 500) ?? "",
  );
  elements.replyDelayMsPerChar.value = String(
    firstDefined(readPath(config, "replyDelay.msPerChar"), 120) ?? "",
  );
  elements.replyDelayMaxMs.value = String(
    firstDefined(readPath(config, "replyDelay.maxMs"), 0) ?? "",
  );
  elements.chatExitEnabled.checked = readPath(config, "chatExit.enabled") !== false;
  elements.chatExitIdleMinutes.value = String(
    firstDefined(readPath(config, "chatExit.idleMinutes"), 10) ?? "",
  );
  elements.chatExitMinConfidence.value = String(
    firstDefined(readPath(config, "chatExit.minConfidence"), 0.75) ?? "",
  );
  elements.chatExitJudgeModel.value = String(
    firstDefined(readPath(config, "chatExit.judgeModel"), "") || "",
  );
  elements.chatExitJudgeTimeoutMs.value = String(
    firstDefined(readPath(config, "chatExit.judgeTimeoutMs"), 10000) ?? "",
  );
  elements.followUpEnabled.checked = readPath(config, "followUp.enabled") !== false;
  elements.followUpMinMinutes.value = String(
    firstDefined(readPath(config, "followUp.minMinutes"), 5) ?? "",
  );
  elements.followUpMaxMinutes.value = String(
    firstDefined(readPath(config, "followUp.maxMinutes"), 1440) ?? "",
  );
  elements.followUpQuietStart.value = String(
    firstDefined(readPath(config, "followUp.quietHours.start"), 23) ?? "",
  );
  elements.followUpQuietEnd.value = String(
    firstDefined(readPath(config, "followUp.quietHours.end"), 8) ?? "",
  );
  elements.followUpTimezone.value = String(
    firstDefined(readPath(config, "followUp.timezone"), "Asia/Shanghai") || "",
  );
  elements.followUpRetryDelayMinutes.value = String(
    firstDefined(readPath(config, "followUp.retryDelayMinutes"), 5) ?? "",
  );
  elements.qqAppId.value = String(firstDefined(readPath(config, "qq.appId"), "") || "");
  elements.qqSecret.value = "";
  elements.qqEnabled.checked = Boolean(readPath(config, "qq.enabled"));
  elements.qqSandbox.checked = Boolean(readPath(config, "qq.sandbox"));
  elements.onebotUrl.value = String(
    firstDefined(readPath(config, "onebot.url"), "") || "",
  );
  elements.onebotToken.value = "";
  elements.onebotEnabled.checked = Boolean(readPath(config, "onebot.enabled"));
  elements.policyAutoActions.checked = Boolean(readPath(config, "policy.autoActions"));
  elements.policyPaused.checked = Boolean(readPath(config, "policy.paused"));
  elements.policyAllowedUsers.value = normalizeStringArray(
    readPath(config, "policy.allowedUsers"),
  ).join("\n");
  elements.policyAllowedGroups.value = normalizeStringArray(
    readPath(config, "policy.allowedGroups"),
  ).join("\n");
  elements.policyActionUsers.value = normalizeStringArray(
    readPath(config, "policy.actionUsers"),
  ).join("\n");
  elements.policyCooldownMs.value = String(
    firstDefined(readPath(config, "policy.cooldownMs"), "") ?? "",
  );
  elements.policyMaxActionsPerHour.value = String(
    firstDefined(readPath(config, "policy.maxActionsPerHour"), "") ?? "",
  );
  elements.qzoneEnabled.checked = Boolean(readPath(config, "qzone.enabled"));
  elements.settingsQzoneAutoPublish.checked = Boolean(
    readPath(config, "qzone.autoPublish"),
  );
  elements.qzoneAutoPublishToggle.checked = Boolean(
    readPath(config, "qzone.autoPublish"),
  );
  elements.qzoneHeadless.checked = Boolean(readPath(config, "qzone.headless"));
  elements.qzoneCommentsEnabled.checked = readPath(config, "qzoneComments.enabled") === true;
  elements.qzoneCommentsDryRun.checked = readPath(config, "qzoneComments.dryRun") !== false;
  elements.qzoneCommentsOnlyFriends.checked =
    readPath(config, "qzoneComments.onlyFriends") !== false;
  elements.qzoneCommentsAiDecide.checked =
    readPath(config, "qzoneComments.aiDecide") !== false;
  elements.qzoneCommentsNestedReplyFallback.checked =
    readPath(config, "qzoneComments.nestedReplyFallback") === true;
  for (const [element, key, fallback] of [
    [elements.qzoneCommentsPollMinutes, "pollMinutes", 5],
    [elements.qzoneCommentsActivePollMinutes, "activePollMinutes", 2],
    [elements.qzoneCommentsActiveWindowMinutes, "activeWindowMinutes", 60],
    [elements.qzoneCommentsPollJitterPercent, "pollJitterPercent", 20],
    [elements.qzoneCommentsCookieRefreshMinutes, "cookieRefreshMinutes", 10],
    [elements.qzoneCommentsOwnTrackHours, "ownTrackHours", 168],
    [elements.qzoneCommentsExternalTrackHours, "externalTrackHours", 72],
    [elements.qzoneCommentsMaxRepliesPerCycle, "maxRepliesPerCycle", 3],
    [elements.qzoneCommentsMaxRepliesPerHour, "maxRepliesPerHour", 6],
    [elements.qzoneCommentsDelayMinSeconds, "delayMinSeconds", 5],
    [elements.qzoneCommentsDelayMaxSeconds, "delayMaxSeconds", 20],
    [elements.qzoneCommentsMaxReplyChars, "maxReplyChars", 60],
  ]) {
    element.value = String(
      firstDefined(readPath(config, `qzoneComments.${key}`), fallback) ?? "",
    );
  }
  elements.qzoneCommentsAllowedUsers.value = formatList(
    readPath(config, "qzoneComments.allowedUsers"),
  );
  elements.qzoneCommentsBlockedUsers.value = formatList(
    readPath(config, "qzoneComments.blockedUsers"),
  );
  elements.qzoneCommentsReplyPrompt.value = String(
    firstDefined(readPath(config, "qzoneComments.replyPrompt"), "") || "",
  );
  elements.autonomyEnabled.checked = Boolean(readPath(config, "autonomy.enabled"));
  elements.autonomyIntervalMinutes.value = String(
    firstDefined(readPath(config, "autonomy.intervalMinutes"), "") ?? "",
  );
  elements.autonomyPrompt.value = String(
    firstDefined(readPath(config, "autonomy.prompt"), "") || "",
  );
  elements.autonomyQuietStart.value = String(
    firstDefined(readPath(config, "autonomy.quietHours.start"), "") ?? "",
  );
  elements.autonomyQuietEnd.value = String(
    firstDefined(readPath(config, "autonomy.quietHours.end"), "") ?? "",
  );
  elements.autonomyTimezone.value = String(
    firstDefined(readPath(config, "autonomy.timezone"), "") || "",
  );
  state.transportSnapshot = transportSnapshotFromForm();
}

async function loadConfig({ notify = false } = {}) {
  if (!state.token) return false;
  try {
    const payload = await requestJson("/api/config", { method: "GET" });
    fillConfigForm(unwrapConfig(payload));
    loadQzoneCommentsStatus().catch(() => {});
    if (notify) showToast("设置已刷新。");
    return true;
  } catch (error) {
    state.configLoaded = false;
    setInlineError(elements.configError, getErrorMessage(error));
    if (notify) showToast(getErrorMessage(error), "error");
    return false;
  }
}

function formatQzoneCommentStatus(status) {
  if (!status || typeof status !== "object") return "状态不可用";
  const time = (value) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN") : "未运行";
  };
  const modeLabels = { active: "活跃", backoff: "退避", idle: "空闲" };
  const mode = modeLabels[status.pollMode] ?? status.pollMode ?? "unknown";
  const interval = Number(status.effectivePollMinutes);
  const lastActivity = status.lastActivityAt ? time(status.lastActivityAt) : "无";
  const parts = [
    status.enabled ? "已开启" : "已关闭",
    status.dryRun ? "只检测" : "会发送",
    `Cookie:${status.cookie ?? "unknown"}`,
    `轮询:${mode}${Number.isFinite(interval) ? ` ${interval} 分钟` : ""}`,
    `上次:${time(status.lastPollAt)}`,
    `下次:${time(status.nextPollAt)}`,
    `最近活动:${lastActivity}`,
    `跟踪:${Number(status.trackedPosts ?? 0)} 条`,
    `已见:${Number(status.commentsSeen ?? 0)}`,
    `已回:${Number(status.replies ?? 0)}`,
    `外部评论:${Number(status.externalComments ?? 0)}`,
  ];
  if (Number(status.dryRunComments ?? 0) > 0) {
    parts.push(`dryRun:${Number(status.dryRunComments)}`);
  }
  const last = status.lastPollResult;
  if (last && Number.isFinite(Number(last.comments))) {
    parts.push(
      `本次:评论${Number(last.comments)}/新${Number(last.newComments ?? 0)}/回复${Number(last.replied ?? 0)}`,
    );
  }
  if (status.lastError) parts.push(`错误:${status.lastError}`);
  return parts.join(" · ");
}

async function loadQzoneCommentsStatus({ notify = false } = {}) {
  if (!state.token) return false;
  try {
    const payload = await requestJson("/api/qzone/comments/status", {
      method: "GET",
    });
    setNodeText(elements.qzoneCommentsStatus, formatQzoneCommentStatus(payload));
    setInlineError(elements.qzoneCommentsError, payload.lastError ?? "");
    if (notify) showToast("空间评论状态已刷新。");
    return true;
  } catch (error) {
    setInlineError(elements.qzoneCommentsError, getErrorMessage(error));
    if (notify) showToast(getErrorMessage(error), "error");
    return false;
  }
}

async function pollQzoneComments() {
  if (!state.token) return;
  const button = elements.qzoneCommentsPollButton;
  button.disabled = true;
  setInlineError(elements.qzoneCommentsError, "");
  try {
    const payload = await requestJson("/api/qzone/comments/poll", {
      method: "POST",
    });
    const result = payload.result ?? {};
    setNodeText(
      elements.qzoneCommentsStatus,
      formatQzoneCommentStatus(payload.status ?? payload),
    );
    const summary = Number.isFinite(Number(result.comments))
      ? `评论 ${Number(result.comments)}，新 ${Number(result.newComments ?? 0)}，dryRun ${Number(result.dryRun ?? 0)}，回复 ${Number(result.replied ?? 0)}`
      : "";
    showToast(
      payload.ok
        ? `空间评论检查完成${summary ? `：${summary}` : "。"}`
        : `空间评论检查未完成${result.reason ? `：${result.reason}` : "。"}`,
    );
    await loadQzoneCommentsStatus();
  } catch (error) {
    setInlineError(elements.qzoneCommentsError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    button.disabled = false;
  }
}

function formatList(value) {
  return Array.isArray(value) ? value.map(String).join("\n") : "";
}

function parseListInput(value) {
  const values = String(value || "")
    .split(/[,\n，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function numberValue(input) {
  if (!input.value.trim()) return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : undefined;
}

function collectConfigPatch() {
  const ai = {
    baseUrl: elements.aiBaseUrl.value.trim(),
    model: elements.aiModel.value.trim(),
    systemPrompt: elements.aiSystemPrompt.value,
    temperature: numberValue(elements.aiTemperature),
    reasoningEffort: elements.aiReasoningEffort.value,
    historyMessages: numberValue(elements.aiHistoryMessages),
  };
  if (elements.aiApiKey.value.trim()) ai.apiKey = elements.aiApiKey.value.trim();

  const qq = {
    appId: elements.qqAppId.value.trim(),
    enabled: elements.qqEnabled.checked,
    sandbox: elements.qqSandbox.checked,
  };
  if (elements.qqSecret.value.trim()) qq.secret = elements.qqSecret.value.trim();

  const onebot = {
    url: elements.onebotUrl.value.trim(),
    enabled: elements.onebotEnabled.checked,
  };
  if (elements.onebotToken.value.trim()) {
    onebot.token = elements.onebotToken.value.trim();
  }

  const policy = {
    autoActions: elements.policyAutoActions.checked,
    paused: elements.policyPaused.checked,
    allowedUsers: parseListInput(elements.policyAllowedUsers.value),
    allowedGroups: parseListInput(elements.policyAllowedGroups.value),
    actionUsers: parseListInput(elements.policyActionUsers.value),
    cooldownMs: numberValue(elements.policyCooldownMs),
    maxActionsPerHour: numberValue(elements.policyMaxActionsPerHour),
  };

  const stickerMaxFileSizeMb = numberValue(elements.stickerMaxFileSizeMb);
  return {
    demo: elements.demoMode.checked,
    inputDelayMs: numberValue(elements.inputDelayMs),
    maxToolCallsPerTurn: numberValue(elements.maxToolCallsPerTurn),
    persona: { name: elements.personaName.value.trim() },
    ai,
    stickers: {
      enabled: elements.stickerEnabled.checked,
      autoCollect: elements.stickerAutoCollect.checked,
      maxItems: numberValue(elements.stickerMaxItems),
      maxFileSizeBytes: Number.isFinite(stickerMaxFileSizeMb)
        ? Math.round(stickerMaxFileSizeMb * 1024 * 1024)
        : undefined,
      minCuteScore: numberValue(elements.stickerMinCuteScore),
      minInterestingScore: numberValue(elements.stickerMinInterestingScore),
      proactiveCooldownMinutes: numberValue(
        elements.stickerProactiveCooldownMinutes,
      ),
    },
    webSearch: {
      enabled: elements.webSearchEnabled.checked,
      searchEnabled: elements.webSearchSearchEnabled.checked,
      fetchEnabled: elements.webSearchFetchEnabled.checked,
      ...(elements.webSearchApiKey.value.trim()
        ? { apiKey: elements.webSearchApiKey.value.trim() }
        : {}),
      maxCallsPerTurn: numberValue(elements.webSearchMaxCallsPerTurn),
      maxResults: numberValue(elements.webSearchMaxResults),
      maxContentChars: numberValue(elements.webSearchMaxContentChars),
    },
    memory: {
      enabled: elements.memoryEnabled.checked,
      autoExtract: elements.memoryAutoExtract.checked,
      minImportance: numberValue(elements.memoryMinImportance),
      maxPerKey: numberValue(elements.memoryMaxPerKey),
      maxInjected: numberValue(elements.memoryMaxInjected),
      judgeModel: elements.memoryJudgeModel.value.trim(),
    },
    replyDelay: {
      enabled: elements.replyDelayEnabled.checked,
      typingIndicator: elements.replyDelayTypingIndicator.checked,
      baseMs: numberValue(elements.replyDelayBaseMs),
      msPerChar: numberValue(elements.replyDelayMsPerChar),
      maxMs: numberValue(elements.replyDelayMaxMs),
    },
    chatExit: {
      enabled: elements.chatExitEnabled.checked,
      idleMinutes: numberValue(elements.chatExitIdleMinutes),
      minConfidence: numberValue(elements.chatExitMinConfidence),
      judgeModel: elements.chatExitJudgeModel.value.trim(),
      judgeTimeoutMs: numberValue(elements.chatExitJudgeTimeoutMs),
    },
    followUp: {
      enabled: elements.followUpEnabled.checked,
      minMinutes: numberValue(elements.followUpMinMinutes),
      maxMinutes: numberValue(elements.followUpMaxMinutes),
      quietHours: {
        start: numberValue(elements.followUpQuietStart),
        end: numberValue(elements.followUpQuietEnd),
      },
      timezone: elements.followUpTimezone.value.trim(),
      retryDelayMinutes: numberValue(elements.followUpRetryDelayMinutes),
    },
    qq,
    onebot,
    policy,
    qzone: {
      enabled: elements.qzoneEnabled.checked,
      autoPublish: elements.settingsQzoneAutoPublish.checked,
      headless: elements.qzoneHeadless.checked,
    },
    qzoneComments: {
      enabled: elements.qzoneCommentsEnabled.checked,
      dryRun: elements.qzoneCommentsDryRun.checked,
      onlyFriends: elements.qzoneCommentsOnlyFriends.checked,
      aiDecide: elements.qzoneCommentsAiDecide.checked,
      nestedReplyFallback: elements.qzoneCommentsNestedReplyFallback.checked,
      pollMinutes: numberValue(elements.qzoneCommentsPollMinutes),
      activePollMinutes: numberValue(elements.qzoneCommentsActivePollMinutes),
      activeWindowMinutes: numberValue(elements.qzoneCommentsActiveWindowMinutes),
      pollJitterPercent: numberValue(elements.qzoneCommentsPollJitterPercent),
      cookieRefreshMinutes: numberValue(elements.qzoneCommentsCookieRefreshMinutes),
      ownTrackHours: numberValue(elements.qzoneCommentsOwnTrackHours),
      externalTrackHours: numberValue(elements.qzoneCommentsExternalTrackHours),
      maxRepliesPerCycle: numberValue(elements.qzoneCommentsMaxRepliesPerCycle),
      maxRepliesPerHour: numberValue(elements.qzoneCommentsMaxRepliesPerHour),
      delayMinSeconds: numberValue(elements.qzoneCommentsDelayMinSeconds),
      delayMaxSeconds: numberValue(elements.qzoneCommentsDelayMaxSeconds),
      maxReplyChars: numberValue(elements.qzoneCommentsMaxReplyChars),
      allowedUsers: parseListInput(elements.qzoneCommentsAllowedUsers.value),
      blockedUsers: parseListInput(elements.qzoneCommentsBlockedUsers.value),
      replyPrompt: elements.qzoneCommentsReplyPrompt.value,
    },
    autonomy: {
      enabled: elements.autonomyEnabled.checked,
      intervalMinutes: numberValue(elements.autonomyIntervalMinutes),
      prompt: elements.autonomyPrompt.value,
      quietHours: {
        start: numberValue(elements.autonomyQuietStart),
        end: numberValue(elements.autonomyQuietEnd),
      },
      timezone: elements.autonomyTimezone.value.trim(),
    },
  };
}

function transportSnapshotFromForm() {
  return JSON.stringify({
    aiBaseUrl: elements.aiBaseUrl.value.trim(),
    qqAppId: elements.qqAppId.value.trim(),
    qqEnabled: elements.qqEnabled.checked,
    qqSandbox: elements.qqSandbox.checked,
    onebotUrl: elements.onebotUrl.value.trim(),
    onebotEnabled: elements.onebotEnabled.checked,
  });
}

async function saveConfig() {
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  setBusy(elements.saveConfigButton, true);
  setInlineError(elements.configError, "");
  setNodeText(elements.configSaveState, "正在保存");
  elements.reconnectNotice.hidden = true;

  const transportSecretsTouched = Boolean(
    elements.qqSecret.value.trim() || elements.onebotToken.value.trim(),
  );
  const nextTransportSnapshot = transportSnapshotFromForm();
  const transportChanged =
    transportSecretsTouched ||
    (Boolean(state.transportSnapshot) &&
      state.transportSnapshot !== nextTransportSnapshot);

  try {
    await requestJson("/api/config", {
      method: "POST",
      body: collectConfigPatch(),
    });
    setNodeText(elements.configSaveState, "已保存");
    showToast("设置已保存。");
    await Promise.allSettled([loadConfig(), loadStatus(), loadQzoneCommentsStatus()]);
    elements.reconnectNotice.hidden = !transportChanged;
  } catch (error) {
    setNodeText(elements.configSaveState, "保存失败");
    setInlineError(elements.configError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    setBusy(elements.saveConfigButton, false);
  }
}

async function changePause(checked) {
  if (!state.token) {
    elements.pauseToggle.checked = state.paused;
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  elements.pauseToggle.disabled = true;
  try {
    await requestJson("/api/config", {
      method: "POST",
      body: { policy: { paused: checked } },
    });
    elements.policyPaused.checked = checked;
    state.paused = checked;
    showToast(checked ? "机器人已暂停。" : "机器人已恢复。");
    await loadStatus();
    await loadConfig();
  } catch (error) {
    elements.pauseToggle.checked = state.paused;
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.pauseToggle.disabled = false;
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return [];
  const urls = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (isPlainObject(item) && typeof item.url === "string") return item.url;
      return "";
    })
    .filter((url) => isHttpsUrl(url));
  return [...new Set(urls)];
}

function normalizeFaces(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item);
      if (isPlainObject(item)) {
        return String(firstDefined(item.id, item.faceId, item.face_id, "") ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 30);
}

function loadChatMessages() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CHAT_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (message) =>
          isPlainObject(message) &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.text === "string",
      )
      .slice(-CHAT_LIMIT)
      .map((message) => ({
        role: message.role,
        text: message.text.slice(0, 12000),
        faces: normalizeFaces(message.faces),
        images: normalizeImages(message.images),
        createdAt:
          typeof message.createdAt === "string"
            ? message.createdAt
            : new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function saveChatMessages() {
  try {
    sessionStorage.setItem(
      CHAT_KEY,
      JSON.stringify(
        state.chatMessages.slice(-CHAT_LIMIT).map((message) => ({
          role: message.role,
          text: message.text,
          faces: message.faces,
          images: message.images,
          createdAt: message.createdAt,
        })),
      ),
    );
  } catch {
    // Chat history is a convenience; the page still works without storage.
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createEmptyState(title, description) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  const content = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = description;
  content.append(strong, paragraph);
  wrapper.append(content);
  return wrapper;
}

function renderChatMessage(message) {
  const article = document.createElement("article");
  article.className = `message is-${message.role}`;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = message.role === "user" ? "我" : "鱼";

  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.textContent =
    message.role === "user" ? "我" : state.config?.persona?.name || "Alice";
  const time = document.createElement("time");
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt);
  meta.append(author, time);
  body.append(meta);

  if (message.text) {
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = message.text;
    body.append(text);
  }

  if (message.faces?.length) {
    const faces = document.createElement("div");
    faces.className = "message-faces";
    for (const face of message.faces) {
      const token = document.createElement("span");
      token.className = "face-token";
      token.textContent = `[QQ表情 #${face}]`;
      faces.append(token);
    }
    body.append(faces);
  }

  if (message.images?.length) {
    const images = document.createElement("div");
    images.className = "message-images";
    for (const url of message.images) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "打开聊天图片");
      const image = document.createElement("img");
      image.src = url;
      image.alt = "聊天图片";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      link.append(image);
      images.append(link);
    }
    body.append(images);
  }

  article.append(avatar, body);
  return article;
}

function renderChat() {
  elements.chatMessages.replaceChildren();
  if (!state.chatMessages.length) {
    const empty = createEmptyState(
      "还没有消息",
      state.token
        ? "从一句自然的问候开始。"
        : "需要有效的控制台链接才能开始会话。",
    );
    elements.chatMessages.append(empty);
  } else {
    for (const message of state.chatMessages) {
      elements.chatMessages.append(renderChatMessage(message));
    }
  }

  if (state.chatBusy) {
    const typing = document.createElement("div");
    typing.className = "typing-state";
    typing.setAttribute("aria-label", "正在等待回复");
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.append(
      document.createElement("i"),
      document.createElement("i"),
      document.createElement("i"),
    );
    const label = document.createElement("span");
    label.textContent = "正在等待回复";
    typing.append(dots, label);
    elements.chatMessages.append(typing);
  }

  updateSpeakButton();
  window.requestAnimationFrame(() => {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  });
}

function renderAttachments() {
  elements.chatAttachments.replaceChildren();
  for (const [index, url] of state.chatAttachments.entries()) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const label = document.createElement("span");
    label.textContent = url;
    label.title = url;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除图片");
    remove.title = "移除图片";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.chatAttachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(label, remove);
    elements.chatAttachments.append(chip);
  }
  elements.chatAttachmentTray.hidden = state.chatAttachments.length === 0;
}

function addChatImage() {
  const url = elements.chatImageUrl.value.trim();
  if (!isHttpsUrl(url)) {
    showToast("图片地址必须是合法的 HTTPS URL。", "error");
    elements.chatImageUrl.focus();
    return;
  }
  if (state.chatAttachments.includes(url)) {
    showToast("这张图片已经添加。");
    return;
  }
  if (state.chatAttachments.length >= 4) {
    showToast("一次最多添加 4 张图片。", "error");
    return;
  }
  state.chatAttachments.push(url);
  elements.chatImageUrl.value = "";
  renderAttachments();
}

function setChatBusy(busy) {
  state.chatBusy = busy;
  elements.sendChatButton.disabled = busy;
  elements.addImageButton.disabled = busy;
  elements.chatInput.disabled = busy;
  elements.chatImageUrl.disabled = busy;
  elements.voiceInputButton.disabled = busy;
  elements.sendChatButton.setAttribute("aria-busy", busy ? "true" : "false");
  renderChat();
}

async function sendChat() {
  if (state.chatBusy) return;
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }

  const text = elements.chatInput.value.trim();
  const attachments = state.chatAttachments.map((url) => ({
    type: "image",
    url,
  }));
  if (!text && !attachments.length) {
    showToast("写一句话或添加一张图片。", "error");
    elements.chatInput.focus();
    return;
  }

  setInlineError(elements.chatError, "");
  const userMessage = {
    role: "user",
    text,
    faces: [],
    images: attachments.map((attachment) => attachment.url),
    createdAt: new Date().toISOString(),
  };
  state.chatMessages.push(userMessage);
  state.chatMessages = state.chatMessages.slice(-CHAT_LIMIT);
  saveChatMessages();
  elements.chatInput.value = "";
  state.chatAttachments = [];
  renderAttachments();
  setChatBusy(true);

  try {
    const payload = await requestJson("/api/chat", {
      method: "POST",
      body: { text, attachments },
    });
    const result =
      payload?.result ??
      payload?.data?.result ??
      (isPlainObject(payload?.data) ? payload.data : payload) ??
      {};
    const replyText = firstDefined(
      typeof result.text === "string" ? result.text : undefined,
      typeof result.reply === "string" ? result.reply : undefined,
      typeof result.message === "string" ? result.message : undefined,
      "",
    );
    const faces = normalizeFaces(result.faces);
    const images = normalizeImages(result.images);
    if (!replyText && !faces.length && !images.length) {
      throw new ApiError("服务响应中没有可显示的回复内容。");
    }
    state.chatMessages.push({
      role: "assistant",
      text: replyText,
      faces,
      images,
      createdAt: new Date().toISOString(),
    });
    state.chatMessages = state.chatMessages.slice(-CHAT_LIMIT);
    saveChatMessages();
  } catch (error) {
    setInlineError(elements.chatError, getErrorMessage(error));
  } finally {
    setChatBusy(false);
  }
}

function lastAssistantText() {
  for (let index = state.chatMessages.length - 1; index >= 0; index -= 1) {
    const message = state.chatMessages[index];
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return "";
}

function updateSpeakButton() {
  const supported = "speechSynthesis" in window;
  elements.speakReplyButton.hidden = !supported;
  elements.speakReplyButton.disabled = state.chatBusy || !lastAssistantText();
  elements.speechNote.hidden = !supported;
}

function speakLastReply() {
  const text = lastAssistantText();
  if (!text || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  window.speechSynthesis.speak(utterance);
}

function initializeSpeechInput() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    elements.voiceInputButton.hidden = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = false;
  recognition.continuous = false;
  state.recognition = recognition;
  elements.voiceInputButton.hidden = false;

  recognition.addEventListener("start", () => {
    elements.voiceInputButton.classList.add("is-recording");
    elements.voiceInputButton.setAttribute("aria-label", "停止浏览器语音输入");
  });
  recognition.addEventListener("end", () => {
    elements.voiceInputButton.classList.remove("is-recording");
    elements.voiceInputButton.setAttribute("aria-label", "浏览器语音输入");
  });
  recognition.addEventListener("result", (event) => {
    const heard = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join("")
      .trim();
    if (!heard) return;
    const current = elements.chatInput.value.trim();
    elements.chatInput.value = current ? `${current} ${heard}` : heard;
    elements.chatInput.focus();
  });
  recognition.addEventListener("error", () => {
    showToast("浏览器语音输入未完成，请重试。", "error");
  });
}

function toggleVoiceInput() {
  if (!state.recognition || state.chatBusy) return;
  if (elements.voiceInputButton.classList.contains("is-recording")) {
    state.recognition.stop();
    return;
  }
  try {
    state.recognition.start();
  } catch {
    showToast("语音输入当前不可用。", "error");
  }
}

function formatMemoryTime(value) {
  const timestamp = String(value ?? "");
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function renderMemoryScopes() {
  if (!elements.memoryScope) return;
  elements.memoryScope.replaceChildren();
  if (!state.memoryScopes.length) {
    const option = document.createElement("option");
    option.textContent = "暂无记忆范围";
    option.value = "";
    elements.memoryScope.append(option);
    elements.memoryScope.disabled = true;
    return;
  }
  for (const scope of state.memoryScopes) {
    const option = document.createElement("option");
    option.value = scope.key;
    option.textContent = `${scope.label} · ${scope.count} 条`;
    option.selected = scope.key === state.memoryScopeKey;
    elements.memoryScope.append(option);
  }
  elements.memoryScope.disabled = state.memoryScopes.length <= 1;
}

function renderMemorySummary() {
  if (elements.memoryMeta) {
    const count = state.memoryMeta?.count ?? state.memories.length;
    const max = state.memoryMeta?.maxPerKey;
    elements.memoryMeta.textContent =
      max === undefined || max === null
        ? `当前范围 ${count} 条记忆`
        : `当前范围 ${count} / ${max} 条记忆`;
  }
  if (elements.clearMemoriesButton) {
    elements.clearMemoriesButton.disabled = !state.memoryScopeKey || !state.memories.length;
  }
  if (elements.memoryScopeNote) {
    const scope = state.memoryScope;
    const kindText =
      scope?.kind === "group"
        ? "群内共享：这份记忆会影响该群所有成员的对话。"
        : scope?.kind === "identity"
          ? "身份绑定共享：同一绑定身份下的会话会共用这份记忆。"
          : "仅当前账号的私聊会使用这份记忆。";
    const autoText =
      state.memoryMeta?.autoExtract === false
        ? "自动提取已关闭。"
        : "自动提取已开启。";
    elements.memoryScopeNote.textContent = `${kindText} ${autoText}`;
  }
}

function renderMemories() {
  elements.memoryList.replaceChildren();
  renderMemoryScopes();
  renderMemorySummary();
  if (!state.memoriesLoaded) {
    elements.memoryList.append(
      createEmptyState("正在读取记忆", "稍候片刻，本地数据会显示在这里。"),
    );
    return;
  }
  if (!state.memoryScopeKey) {
    elements.memoryList.append(
      createEmptyState("还没有记忆范围", "先在对话中产生记忆，或在本机会话中手动添加一条。"),
    );
    return;
  }
  if (!state.memories.length) {
    elements.memoryList.append(
      createEmptyState("当前范围还没有记忆", "聊天中的重要信息会自动出现在这里。"),
    );
    return;
  }

  for (const memory of state.memories) {
    const item = document.createElement("article");
    item.className = "memory-item";
    const content = document.createElement("div");
    content.className = "memory-content";
    const text = document.createElement("p");
    text.className = "memory-text";
    text.textContent = String(memory.text ?? "");

    const meta = document.createElement("div");
    meta.className = "memory-meta";
    const type = document.createElement("span");
    type.className = "memory-badge memory-type";
    type.textContent = MEMORY_TYPE_LABELS[memory.type] ?? "事实";
    const importance = document.createElement("span");
    importance.className = "memory-badge memory-importance";
    importance.textContent = `重要度 ${memory.importance ?? 5}`;
    const source = document.createElement("span");
    source.className = "memory-badge memory-source";
    source.textContent = MEMORY_SOURCE_LABELS[memory.source] ?? "手动";
    const createdAt = document.createElement("time");
    const timestamp = formatMemoryTime(memory.updatedAt ?? memory.createdAt);
    createdAt.textContent = timestamp;
    createdAt.dateTime = String(memory.updatedAt ?? memory.createdAt ?? "");
    meta.append(type, importance, source, createdAt);
    content.append(text, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", "删除这条记忆");
    remove.title = "删除这条记忆";
    remove.disabled = !memory.id;
    remove.addEventListener("click", () => deleteMemory(memory));
    item.append(content, remove);
    elements.memoryList.append(item);
  }
}

function extractMemories(payload) {
  const value =
    payload?.memories ??
    payload?.data?.memories ??
    (Array.isArray(payload?.data) ? payload.data : payload);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (memory) =>
      isPlainObject(memory) &&
      (typeof memory.id === "string" || typeof memory.id === "number") &&
      typeof memory.text === "string",
  );
}

function extractMemoryScopes(payload) {
  const value = payload?.scopes ?? payload?.data?.scopes;
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (scope) =>
        isPlainObject(scope) &&
        typeof scope.key === "string" &&
        scope.key &&
        typeof scope.label === "string" &&
        scope.label,
    )
    .map((scope) => ({
      ...scope,
      count: Number(scope.count ?? 0),
    }));
}

async function loadMemories({ notify = false, key = state.memoryScopeKey } = {}) {
  if (!state.token) {
    state.memoriesLoaded = false;
    renderMemories();
    return false;
  }
  try {
    const query = key ? `?key=${encodeURIComponent(key)}` : "";
    const payload = await requestJson(`/api/memories${query}`, { method: "GET" });
    state.memories = extractMemories(payload);
    state.memoryScopes = extractMemoryScopes(payload);
    state.memoryScopeKey = String(payload?.key ?? key ?? "");
    state.memoryScope = isPlainObject(payload?.scope)
      ? payload.scope
      : state.memoryScopes.find((scope) => scope.key === state.memoryScopeKey) ?? null;
    state.memoryMeta = {
      count: Number(payload?.count ?? state.memories.length),
      maxPerKey: payload?.maxPerKey,
      maxInjected: payload?.maxInjected,
      enabled: payload?.enabled !== false,
      autoExtract: payload?.autoExtract !== false,
    };
    state.memoriesLoaded = true;
    setInlineError(elements.memoryError, "");
    renderMemories();
    if (notify) showToast("记忆已刷新。");
    return true;
  } catch (error) {
    state.memoriesLoaded = false;
    state.memories = [];
    state.memoryScopes = [];
    state.memoryMeta = null;
    setInlineError(elements.memoryError, getErrorMessage(error));
    renderMemories();
    if (notify) showToast(getErrorMessage(error), "error");
    return false;
  }
}

async function switchMemoryScope() {
  if (!elements.memoryScope?.value) return;
  state.memoryScopeKey = elements.memoryScope.value;
  state.memoriesLoaded = false;
  renderMemories();
  await loadMemories({ key: state.memoryScopeKey });
}

async function addMemory() {
  const text = elements.memoryInput.value.trim();
  if (!text) {
    showToast("记忆内容不能为空。", "error");
    elements.memoryInput.focus();
    return;
  }
  const importance = Number(elements.memoryImportance?.value ?? 8);
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    showToast("重要度必须是 1–10 的整数。", "error");
    elements.memoryImportance?.focus();
    return;
  }
  setBusy(elements.addMemoryButton, true);
  setInlineError(elements.memoryError, "");
  try {
    await requestJson("/api/memories", {
      method: "POST",
      body: {
        key: state.memoryScopeKey || undefined,
        text,
        type: elements.memoryType?.value ?? "fact",
        importance,
      },
    });
    elements.memoryInput.value = "";
    showToast("记忆已保存。");
    await loadMemories({ key: state.memoryScopeKey });
  } catch (error) {
    setInlineError(elements.memoryError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    setBusy(elements.addMemoryButton, false);
  }
}

async function deleteMemory(memory) {
  if (!memory?.id) return;
  const confirmed = window.confirm("删除这条长期记忆？");
  if (!confirmed) return;
  setInlineError(elements.memoryError, "");
  try {
    const query = state.memoryScopeKey
      ? `?key=${encodeURIComponent(state.memoryScopeKey)}`
      : "";
    await requestJson(`/api/memories/${encodeURIComponent(String(memory.id))}${query}`, {
      method: "DELETE",
    });
    showToast("记忆已删除。");
    await loadMemories({ key: state.memoryScopeKey });
  } catch (error) {
    setInlineError(elements.memoryError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  }
}

async function clearMemories() {
  if (!state.memoryScopeKey) return;
  const label = state.memoryScope?.label ?? "当前范围";
  const confirmed = window.confirm(`清空「${label}」的全部长期记忆？此操作不可撤销。`);
  if (!confirmed) return;
  setInlineError(elements.memoryError, "");
  setBusy(elements.clearMemoriesButton, true);
  try {
    await requestJson(
      `/api/memories?key=${encodeURIComponent(state.memoryScopeKey)}`,
      { method: "DELETE" },
    );
    showToast("当前范围的记忆已清空。");
    await loadMemories({ key: state.memoryScopeKey });
  } catch (error) {
    setInlineError(elements.memoryError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.clearMemoriesButton.setAttribute("aria-busy", "false");
    elements.clearMemoriesButton.disabled = !state.memoryScopeKey || !state.memories.length;
  }
}

function normalizeStickerItem(item) {
  if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) return null;
  return {
    id: item.id,
    summary: typeof item.summary === "string" && item.summary ? item.summary : "一张表情包",
    tags: Array.isArray(item.tags)
      ? item.tags.filter((tag) => typeof tag === "string" && tag).slice(0, 8)
      : [],
    category: item.category === "interesting" ? "interesting" : "cute",
    cuteness: Number(item.cuteness) || 0,
    interestingness: Number(item.interestingness) || 0,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    lastUsedAt: typeof item.lastUsedAt === "string" ? item.lastUsedAt : null,
    useCount: Number.isFinite(Number(item.useCount)) ? Number(item.useCount) : 0,
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
    contentType: typeof item.contentType === "string" ? item.contentType : "",
  };
}

function stickerCategoryLabel(category) {
  return category === "interesting" ? "有趣" : "可爱";
}

function revokeStickerObjectUrls() {
  for (const url of state.stickerObjectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  state.stickerObjectUrls.clear();
  state.stickerLoading.clear();
}

async function loadStickers({ notify = false } = {}) {
  if (!state.token) {
    state.stickersLoaded = false;
    state.stickers = [];
    state.stickerMeta = null;
    renderStickers();
    return false;
  }
  try {
    const payload = await requestJson("/api/stickers", { method: "GET" });
    const data = isPlainObject(payload?.data) ? payload.data : payload ?? {};
    if (elements.stickerPreviewDialog.open) elements.stickerPreviewDialog.close();
    revokeStickerObjectUrls();
    state.stickers = (Array.isArray(data.items) ? data.items : [])
      .map(normalizeStickerItem)
      .filter(Boolean);
    state.stickerMeta = {
      count: Number(data.count ?? state.stickers.length),
      maxItems: Number.isFinite(Number(data.maxItems)) ? Number(data.maxItems) : null,
      maxFileSizeBytes: Number.isFinite(Number(data.maxFileSizeBytes))
        ? Number(data.maxFileSizeBytes)
        : 4 * 1024 * 1024,
      enabled: data.enabled !== false,
      autoCollect: data.autoCollect !== false,
      rejected: Number(data.rejected ?? 0),
    };
    state.stickersLoaded = true;
    setInlineError(elements.stickerError, "");
    renderStickers();
    if (notify) showToast("表情库已刷新。");
    return true;
  } catch (error) {
    state.stickersLoaded = false;
    state.stickers = [];
    state.stickerMeta = null;
    revokeStickerObjectUrls();
    setInlineError(elements.stickerError, getErrorMessage(error));
    renderStickers();
    if (notify) showToast(getErrorMessage(error), "error");
    return false;
  }
}

function stickerMatches(item) {
  if (state.stickerCategory !== "all" && item.category !== state.stickerCategory) {
    return false;
  }
  const query = state.stickerSearch.trim().toLowerCase();
  if (!query) return true;
  return [item.summary, ...item.tags].join(" ").toLowerCase().includes(query);
}

function renderStickerEmpty(title, description) {
  elements.stickerEmpty.hidden = false;
  elements.stickerEmpty.replaceChildren(createEmptyState(title, description));
}

function renderStickers() {
  if (!elements.stickerGrid) return;
  state.stickerObserver?.disconnect();
  state.stickerObserver = null;
  elements.stickerGrid.replaceChildren();

  const meta = state.stickerMeta;
  const total = state.stickers.length;
  setNodeText(
    elements.stickerCount,
    meta?.maxItems ? `已收藏 ${total} / ${meta.maxItems} 张` : `已收藏 ${total} 张`,
  );
  if (meta?.rejected > 0) {
    elements.stickerRejected.hidden = false;
    setNodeText(elements.stickerRejected, `已拒绝 ${meta.rejected} 个`);
  } else {
    elements.stickerRejected.hidden = true;
    setNodeText(elements.stickerRejected, "");
  }
  if (elements.stickerAutoCollectToggle) {
    elements.stickerAutoCollectToggle.checked = meta?.autoCollect !== false;
  }
  if (elements.stickerEnabledToggle) {
    elements.stickerEnabledToggle.checked = meta?.enabled !== false;
  }

  if (!state.stickersLoaded) {
    renderStickerEmpty("正在读取表情库", "稍等一下，收藏的图片会显示在这里。");
    return;
  }
  if (!state.stickers.length) {
    renderStickerEmpty(
      "还没有收藏表情",
      "发几个可爱的表情包给 Alice，审核通过后就会出现在这里；也可以手动上传。",
    );
    return;
  }

  const visible = state.stickers.filter(stickerMatches);
  if (!visible.length) {
    renderStickerEmpty("没有匹配的表情", "换个关键词或分类试试。");
    return;
  }

  elements.stickerEmpty.hidden = true;
  elements.stickerEmpty.replaceChildren();
  for (const item of visible) {
    elements.stickerGrid.append(renderStickerCard(item));
  }
}

function renderStickerCard(item) {
  const card = document.createElement("article");
  card.className = "sticker-card";
  const thumbButton = document.createElement("button");
  thumbButton.type = "button";
  thumbButton.className = "sticker-thumb";
  thumbButton.setAttribute("aria-label", `预览 ${item.summary}`);
  const image = document.createElement("img");
  image.alt = item.summary;
  image.decoding = "async";
  image.loading = "lazy";
  const existing = state.stickerObjectUrls.get(item.id);
  if (existing) {
    image.src = existing;
    image.classList.add("is-loaded");
  } else {
    image.dataset.stickerId = item.id;
    image.classList.add("is-loading");
    observeStickerImage(image);
  }
  thumbButton.append(image);
  thumbButton.addEventListener("click", () => openStickerPreview(item.id));

  const body = document.createElement("div");
  body.className = "sticker-card-body";
  const summary = document.createElement("p");
  summary.className = "sticker-card-summary";
  summary.textContent = item.summary;

  const tags = document.createElement("div");
  tags.className = "sticker-tags";
  for (const tag of item.tags) {
    const tagButton = document.createElement("button");
    tagButton.type = "button";
    tagButton.className = "sticker-tag";
    tagButton.textContent = tag;
    tagButton.addEventListener("click", () => {
      elements.stickerSearch.value = tag;
      state.stickerSearch = tag;
      renderStickers();
    });
    tags.append(tagButton);
  }

  const footer = document.createElement("div");
  footer.className = "sticker-card-footer";
  const metadata = document.createElement("span");
  metadata.className = "sticker-card-meta";
  metadata.textContent = `${stickerCategoryLabel(item.category)} · 使用 ${item.useCount} 次`;
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "sticker-delete";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => deleteSticker(item.id));
  footer.append(metadata, deleteButton);
  body.append(summary, tags, footer);
  card.append(thumbButton, body);
  return card;
}

function observeStickerImage(image) {
  if (typeof IntersectionObserver !== "function") {
    loadStickerImage(image);
    return;
  }
  if (!state.stickerObserver) {
    state.stickerObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.stickerObserver?.unobserve(entry.target);
          loadStickerImage(entry.target);
        }
      },
      { rootMargin: "200px" },
    );
  }
  state.stickerObserver.observe(image);
}

async function ensureStickerImageUrl(id) {
  if (state.stickerObjectUrls.has(id)) return state.stickerObjectUrls.get(id);
  if (state.stickerLoading.has(id)) return state.stickerLoading.get(id);
  const promise = (async () => {
    const response = await requestResponse(`/api/stickers/${encodeURIComponent(id)}/image`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    state.stickerObjectUrls.set(id, url);
    return url;
  })();
  state.stickerLoading.set(id, promise);
  try {
    return await promise;
  } finally {
    state.stickerLoading.delete(id);
  }
}

async function loadStickerImage(image) {
  const id = image.dataset.stickerId;
  if (!id) return;
  try {
    const url = await ensureStickerImageUrl(id);
    if (image.dataset.stickerId !== id) return;
    image.src = url;
    image.classList.remove("is-loading");
    image.classList.add("is-loaded");
  } catch {
    image.classList.remove("is-loading");
    image.classList.add("is-error");
    image.alt = "图片加载失败";
  }
}

async function openStickerPreview(id) {
  const item = state.stickers.find((entry) => entry.id === id);
  if (!item) return;
  state.stickerPreviewId = id;
  resetStickerTagEditor();
  setNodeText(elements.stickerPreviewSummary, item.summary);
  const lastUsed = item.lastUsedAt ? ` · 最近 ${formatTime(item.lastUsedAt)}` : "";
  setNodeText(
    elements.stickerPreviewMeta,
    `${stickerCategoryLabel(item.category)} · 使用 ${item.useCount} 次${lastUsed}`,
  );
  renderStickerPreviewTags(item);
  elements.stickerPreviewImage.removeAttribute("src");
  try {
    const url = await ensureStickerImageUrl(id);
    elements.stickerPreviewImage.src = url;
  } catch {
    showToast("表情图片加载失败。", "error");
  }
  if (!elements.stickerPreviewDialog.open) {
    elements.stickerPreviewDialog.showModal();
  }
}

function renderStickerPreviewTags(item) {
  elements.stickerPreviewTags.replaceChildren();
  for (const tag of item.tags) {
    const tagNode = document.createElement("span");
    tagNode.className = "sticker-tag";
    tagNode.textContent = tag;
    elements.stickerPreviewTags.append(tagNode);
  }
}

function resetStickerTagEditor() {
  if (!elements.stickerTagEditor) return;
  elements.stickerTagEditor.hidden = true;
  elements.stickerTagEditorInput.value = "";
  setInlineError(elements.stickerTagEditorError, "");
}

function openStickerTagEditor() {
  const item = state.stickers.find((entry) => entry.id === state.stickerPreviewId);
  if (!item) return;
  elements.stickerTagEditorInput.value = item.tags.join(", ");
  setInlineError(elements.stickerTagEditorError, "");
  elements.stickerTagEditor.hidden = false;
  elements.stickerTagEditorInput.focus();
  elements.stickerTagEditorInput.select();
}

async function saveStickerTags() {
  const id = state.stickerPreviewId;
  const item = state.stickers.find((entry) => entry.id === id);
  if (!id || !item) return;
  const tags = parseListInput(elements.stickerTagEditorInput.value);
  if (!tags.length) {
    setInlineError(elements.stickerTagEditorError, "至少填写一个标签。");
    return;
  }
  if (tags.length > 8) {
    setInlineError(elements.stickerTagEditorError, "最多填写 8 个标签。");
    return;
  }
  setBusy(elements.saveStickerTagsButton, true);
  setInlineError(elements.stickerTagEditorError, "");
  try {
    await requestJson(`/api/stickers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { tags },
    });
    item.tags = tags;
    renderStickerPreviewTags(item);
    renderStickers();
    resetStickerTagEditor();
    showToast("表情标签已保存。");
  } catch (error) {
    setInlineError(elements.stickerTagEditorError, getErrorMessage(error));
  } finally {
    setBusy(elements.saveStickerTagsButton, false);
  }
}

function closeStickerPreview() {
  state.stickerPreviewId = null;
  resetStickerTagEditor();
  if (elements.stickerPreviewDialog.open) elements.stickerPreviewDialog.close();
}

function closeStickerUpload() {
  if (elements.stickerUploadDialog.open) elements.stickerUploadDialog.close();
}

function openStickerUpload() {
  elements.stickerUploadForm.reset();
  setInlineError(elements.stickerUploadError, "");
  elements.stickerUploadDialog.showModal();
}

async function deleteSticker(id) {
  if (!id) return;
  if (!window.confirm("从本地表情库删除这张表情？")) return;
  try {
    await requestJson(`/api/stickers/${encodeURIComponent(id)}`, { method: "DELETE" });
    const url = state.stickerObjectUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      state.stickerObjectUrls.delete(id);
    }
    if (state.stickerPreviewId === id) closeStickerPreview();
    showToast("表情已删除。");
    await loadStickers();
  } catch (error) {
    setInlineError(elements.stickerError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function uploadSticker() {
  const file = elements.stickerUploadFile.files?.[0];
  if (!file) {
    setInlineError(elements.stickerUploadError, "先选择一张图片。");
    return;
  }
  const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  if (!allowed.has(file.type)) {
    setInlineError(elements.stickerUploadError, "只支持 PNG、JPEG、GIF、WebP。");
    return;
  }
  const maxBytes = Number(state.stickerMeta?.maxFileSizeBytes ?? 4 * 1024 * 1024);
  if (file.size > maxBytes) {
    setInlineError(
      elements.stickerUploadError,
      `图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`,
    );
    return;
  }
  const tags = parseListInput(elements.stickerUploadTags.value);
  if (!tags.length) {
    setInlineError(elements.stickerUploadError, "请自己填写至少一个标签。");
    elements.stickerUploadTags.focus();
    return;
  }
  if (tags.length > 8) {
    setInlineError(elements.stickerUploadError, "最多填写 8 个标签。");
    elements.stickerUploadTags.focus();
    return;
  }
  setBusy(elements.stickerUploadSubmit, true);
  setInlineError(elements.stickerUploadError, "");
  try {
    const data = await readFileAsDataUrl(file);
    await requestJson("/api/stickers/upload", {
      method: "POST",
      body: {
        fileName: file.name,
        data,
        summary: elements.stickerUploadSummary.value.trim(),
        tags,
        category: elements.stickerUploadCategory.value,
      },
    });
    closeStickerUpload();
    showToast("表情已上传。");
    await loadStickers();
  } catch (error) {
    setInlineError(elements.stickerUploadError, getErrorMessage(error));
  } finally {
    setBusy(elements.stickerUploadSubmit, false);
  }
}

async function updateStickerConfig(name, checked, input) {
  if (!state.token) {
    input.checked = !checked;
    showTokenProblem();
    return;
  }
  input.disabled = true;
  try {
    await requestJson("/api/config", {
      method: "POST",
      body: { stickers: { [name]: checked } },
    });
    showToast(
      name === "autoCollect"
        ? checked
          ? "已开启自动收藏。"
          : "已关闭自动收藏。"
        : checked
          ? "表情库已启用。"
          : "表情库已关闭。",
    );
    await loadStickers();
  } catch (error) {
    input.checked = !checked;
    showToast(getErrorMessage(error), "error");
  } finally {
    input.disabled = false;
  }
}

function parseQzoneImages() {
  const lines = elements.qzoneImages.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const invalid = lines.filter((line) => !isHttpsUrl(line));
  return {
    images: [...new Set(lines.filter((line) => isHttpsUrl(line)))],
    invalid,
  };
}

function showQzoneResult(rawStatus, message = "") {
  const raw = String(rawStatus || "").trim();
  const normalized = raw.toLowerCase();
  const mappings = {
    sent: {
      zh: "已发送",
      description: "接口返回了明确的成功状态。",
      tone: "sent",
    },
    blocked: {
      zh: "被阻止",
      description: "当前策略或服务端阻止了这次发布。",
      tone: "warning",
    },
    failed: {
      zh: "失败",
      description: "发布未成功。",
      tone: "danger",
    },
    unknown: {
      zh: "结果不明",
      description: "无法确认发布结果，不会自动重发。请先在 QQ 空间核对。",
      tone: "warning",
    },
    duplicate: {
      zh: "重复请求",
      description: "相同内容已有记录，不会自动重发。",
      tone: "warning",
    },
  };
  const mapped = mappings[normalized];
  const status = raw || "unknown";
  const details = mapped || {
    zh: "未确认",
    description: "服务响应缺少明确的发布状态，不能视为成功。",
    tone: "warning",
  };

  elements.qzoneResult.hidden = false;
  elements.qzoneResultBadge.className = `status-badge${
    details.tone ? ` is-${details.tone}` : ""
  }`;
  setNodeText(elements.qzoneResultBadge, `${status} · ${details.zh}`);
  setNodeText(elements.qzoneResultTitle, details.zh);
  const messageText = safeServerText(message, "");
  setNodeText(
    elements.qzoneResultText,
    messageText
      ? `${details.description} ${messageText}`
      : details.description,
  );
  elements.qzoneResultRaw.hidden = !raw;
  setNodeText(elements.qzoneResultRaw, raw ? `status: ${status}` : "");
}

async function publishQzone() {
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  const text = elements.qzoneText.value.trim();
  const { images, invalid } = parseQzoneImages();
  if (invalid.length) {
    showQzoneResult(
      "failed",
      `图片地址必须是 HTTPS，共 ${invalid.length} 行无效。`,
    );
    return;
  }
  if (!text) {
    showQzoneResult("failed", "空间正文不能为空。");
    return;
  }

  setBusy(elements.qzonePublishButton, true);
  try {
    const payload = await requestJson("/api/qzone/publish", {
      method: "POST",
      body: {
        text,
        images,
        ugcRight: Number(elements.qzoneVisibility.value),
      },
    });
    const result =
      payload?.result ??
      payload?.data?.result ??
      (isPlainObject(payload?.data) ? payload.data : payload) ??
      {};
    const rawStatus = firstDefined(result.status, "", "");
    const message = firstDefined(result.message, result.reason, "");
    showQzoneResult(rawStatus, message);
  } catch (error) {
    showQzoneResult("failed", getErrorMessage(error));
  } finally {
    setBusy(elements.qzonePublishButton, false);
  }
}

async function loginQzone() {
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  setBusy(elements.qzoneLoginButton, true);
  elements.qzoneLoginState.hidden = false;
  setNodeText(elements.qzoneLoginState, "正在请求登录结果…");
  try {
    const payload = await requestJson("/api/qzone/login", { method: "POST" });
    const result =
      payload?.result ??
      payload?.data?.result ??
      (isPlainObject(payload?.data) ? payload.data : payload) ??
      {};
    const rawStatus = firstDefined(result.status, "");
    const message = firstDefined(result.message, result.prompt, "");
    const statusText = rawStatus
      ? `登录请求返回：${safeServerText(rawStatus, "未知")}`
      : "登录请求已返回，但没有明确状态。";
    const messageText = safeServerText(message, "");
    setNodeText(
      elements.qzoneLoginState,
      messageText ? `${statusText} ${messageText}` : statusText,
    );
  } catch (error) {
    setNodeText(elements.qzoneLoginState, getErrorMessage(error));
  } finally {
    setBusy(elements.qzoneLoginButton, false);
  }
}

async function updateQzoneAutoPublish(checked) {
  if (!state.token) {
    elements.qzoneAutoPublishToggle.checked = !checked;
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  elements.qzoneAutoPublishToggle.disabled = true;
  try {
    await requestJson("/api/config", {
      method: "POST",
      body: { qzone: { autoPublish: checked } },
    });
    elements.settingsQzoneAutoPublish.checked = checked;
    showToast(checked ? "已允许空间手动发布和模型发布。" : "已关闭所有空间发布。");
    await loadConfig();
  } catch (error) {
    elements.qzoneAutoPublishToggle.checked = !checked;
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.qzoneAutoPublishToggle.disabled = false;
  }
}

function displayOperation(title, text) {
  elements.diagnosticResult.hidden = false;
  elements.diagnosticResult.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = title;
  const paragraph = document.createElement("span");
  paragraph.textContent = safeServerText(text, "操作已完成，服务未返回详细说明。");
  elements.diagnosticResult.append(heading, paragraph);
}

async function reconnect() {
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  setInlineError(elements.diagnosticError, "");
  const buttons = [elements.reconnectButton, elements.reconnectAfterSaveButton];
  buttons.forEach((button) => setBusy(button, true));
  try {
    const payload = await requestJson("/api/reconnect", { method: "POST" });
    const result =
      payload?.result ??
      payload?.data?.result ??
      (isPlainObject(payload?.data) ? payload.data : payload) ??
      {};
    const status = firstDefined(result.status, "");
    const message = firstDefined(result.message, "");
    const title = status
      ? `重连请求返回 ${safeServerText(status, "未知状态")}`
      : "重连请求已返回";
    displayOperation(
      title,
      safeServerText(message, "服务未返回明确连接结果，请查看状态。"),
    );
    elements.reconnectNotice.hidden = true;
    await loadStatus();
  } catch (error) {
    setInlineError(elements.diagnosticError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    buttons.forEach((button) => setBusy(button, false));
  }
}

async function exportData() {
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  setBusy(elements.exportButton, true);
  setInlineError(elements.diagnosticError, "");
  try {
    const response = await requestResponse("/api/export", { method: "GET" });
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `xiaoyu-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    displayOperation("导出已开始", "导出文件由当前浏览器下载。");
  } catch (error) {
    setInlineError(elements.diagnosticError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    setBusy(elements.exportButton, false);
  }
}

async function backupData() {
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  setBusy(elements.backupButton, true);
  setInlineError(elements.diagnosticError, "");
  try {
    const payload = await requestJson("/api/backup", { method: "POST" });
    const result =
      payload?.result ??
      payload?.data?.result ??
      (isPlainObject(payload?.data) ? payload.data : payload) ??
      {};
    const backupPath = firstDefined(result.backupPath, "");
    displayOperation(
      backupPath ? "备份已创建" : "备份请求已返回",
      backupPath
        ? `backupPath: ${safeServerText(backupPath, "")}`
        : "服务没有返回 backupPath，无法确认备份位置。",
    );
    await Promise.allSettled([loadStatus(), loadMemories()]);
  } catch (error) {
    setInlineError(elements.diagnosticError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    setBusy(elements.backupButton, false);
  }
}

async function importData(file) {
  if (!file) return;
  if (!state.token) {
    showTokenProblem();
    showToast("需要有效的控制台 token。", "error");
    return;
  }
  setInlineError(elements.diagnosticError, "");
  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new ApiError("导入文件不能超过 16 MB。");
    }
    const raw = await file.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ApiError("所选文件不是有效的 JSON。");
    }
    if (!isPlainObject(data)) {
      throw new ApiError("导入文件必须包含 JSON 对象。");
    }
    const payload = await requestJson("/api/import", {
      method: "POST",
      body: data,
    });
    const result =
      payload?.result ??
      payload?.data?.result ??
      (isPlainObject(payload?.data) ? payload.data : payload) ??
      {};
    const backupPath = firstDefined(result.backupPath, "");
    displayOperation(
      "导入已完成",
      backupPath
        ? `导入前备份：${safeServerText(backupPath, "")}`
        : "导入请求已返回。",
    );
    await Promise.allSettled([loadMemories(), loadStatus()]);
  } catch (error) {
    setInlineError(elements.diagnosticError, getErrorMessage(error));
    showToast(getErrorMessage(error), "error");
  } finally {
    elements.importFile.value = "";
  }
}

const viewTitles = {
  chat: "聊天",
  space: "空间",
  stickers: "表情库",
  memories: "记忆",
  settings: "设置",
  diagnostics: "诊断",
};

function activateView(name) {
  if (!viewTitles[name]) return;
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === name;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  for (const section of document.querySelectorAll("[data-tabpanel]")) {
    const active = section.dataset.tabpanel === name;
    section.classList.toggle("is-active", active);
    section.hidden = !active;
  }
  setNodeText(elements.viewTitle, viewTitles[name]);
  if (name === "settings" && state.token && !state.configLoaded) loadConfig();
  if (name === "memories" && state.token && !state.memoriesLoaded) loadMemories();
  if (name === "stickers" && state.token && !state.stickersLoaded) loadStickers();
  if (name === "diagnostics" && state.token && !state.statusUpdatedAt) loadStatus();
}

function bindEvents() {
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => activateView(button.dataset.view));
  }

  elements.pauseToggle.addEventListener("change", () => {
    changePause(elements.pauseToggle.checked);
  });
  elements.mobilePauseButton.addEventListener("click", () => {
    changePause(!state.paused);
  });

  elements.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChat();
  });
  elements.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChat();
    }
  });
  elements.addImageButton.addEventListener("click", addChatImage);
  elements.chatImageUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addChatImage();
    }
  });
  elements.refreshChatButton.addEventListener("click", () => loadStatus({ notify: true }));
  elements.voiceInputButton.addEventListener("click", toggleVoiceInput);
  elements.speakReplyButton.addEventListener("click", speakLastReply);

  elements.qzoneForm.addEventListener("submit", (event) => {
    event.preventDefault();
    publishQzone();
  });
  elements.qzoneLoginButton.addEventListener("click", loginQzone);
  elements.qzoneCommentsPollButton.addEventListener("click", pollQzoneComments);
  elements.qzoneAutoPublishToggle.addEventListener("change", () => {
    updateQzoneAutoPublish(elements.qzoneAutoPublishToggle.checked);
  });

  elements.memoryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addMemory();
  });
  elements.refreshMemoriesButton.addEventListener("click", () => {
    loadMemories({ notify: true, key: state.memoryScopeKey });
  });
  elements.memoryScope.addEventListener("change", () => {
    switchMemoryScope();
  });
  elements.clearMemoriesButton.addEventListener("click", () => {
    clearMemories();
  });

  elements.refreshStickersButton.addEventListener("click", () => {
    loadStickers({ notify: true });
  });
  elements.stickerSearch.addEventListener("input", () => {
    state.stickerSearch = elements.stickerSearch.value;
    renderStickers();
  });
  elements.stickerCategory.addEventListener("change", () => {
    state.stickerCategory = elements.stickerCategory.value;
    renderStickers();
  });
  elements.openStickerUploadButton.addEventListener("click", openStickerUpload);
  elements.closeStickerUploadButton.addEventListener("click", closeStickerUpload);
  elements.cancelStickerUploadButton.addEventListener("click", closeStickerUpload);
  elements.stickerUploadForm.addEventListener("submit", (event) => {
    event.preventDefault();
    uploadSticker();
  });
  elements.stickerUploadDialog.addEventListener("close", () => {
    setInlineError(elements.stickerUploadError, "");
  });
  elements.closeStickerPreviewButton.addEventListener("click", closeStickerPreview);
  elements.stickerPreviewDialog.addEventListener("close", () => {
    state.stickerPreviewId = null;
    resetStickerTagEditor();
  });
  elements.editStickerTagsButton.addEventListener("click", openStickerTagEditor);
  elements.saveStickerTagsButton.addEventListener("click", saveStickerTags);
  elements.cancelStickerTagsButton.addEventListener("click", resetStickerTagEditor);
  elements.deleteStickerFromPreviewButton.addEventListener("click", () => {
    deleteSticker(state.stickerPreviewId);
  });
  elements.stickerAutoCollectToggle.addEventListener("change", () => {
    updateStickerConfig(
      "autoCollect",
      elements.stickerAutoCollectToggle.checked,
      elements.stickerAutoCollectToggle,
    );
  });
  elements.stickerEnabledToggle.addEventListener("change", () => {
    updateStickerConfig(
      "enabled",
      elements.stickerEnabledToggle.checked,
      elements.stickerEnabledToggle,
    );
  });

  elements.configForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveConfig();
  });
  elements.refreshConfigButton.addEventListener("click", () => {
    loadConfig({ notify: true });
  });
  elements.reconnectAfterSaveButton.addEventListener("click", reconnect);

  elements.refreshStatusButton.addEventListener("click", () => {
    loadStatus({ notify: true });
  });
  elements.reconnectButton.addEventListener("click", reconnect);
  elements.exportButton.addEventListener("click", exportData);
  elements.backupButton.addEventListener("click", backupData);
  elements.importFile.addEventListener("change", () => {
    importData(elements.importFile.files?.[0]);
  });
}

async function initialize() {
  state.token = resolveConsoleToken();
  state.authInvalid = !state.token;
  bindEvents();
  initializeSpeechInput();
  renderAttachments();
  renderChat();
  renderMemories();
  renderStickers();
  renderStatus();

  if (!state.token) {
    showTokenProblem();
    return;
  }

  clearTokenProblem();
  const statusLoaded = await loadStatus();
  if (statusLoaded || !state.authInvalid) {
    await Promise.allSettled([loadConfig(), loadMemories()]);
  }
}

initialize();
