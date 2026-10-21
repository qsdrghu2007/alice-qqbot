import path from "node:path";
import { fileURLToPath } from "node:url";

import { OneBotAdapter } from "./adapters/onebot.js";
import { QQAdapter } from "./adapters/qq.js";
import { chat as aiChat } from "./ai.js";
import { Autonomy } from "./autonomy.js";
import { ChatActivityTracker, IdleExitScheduler } from "./chat-activity.js";
import { ChatExitManager } from "./chat-exit.js";
import { defaultConfig, loadConfig, saveConfig } from "./config.js";
import { ConversationState } from "./conversation-state.js";
import {
  ConversationDeliveryQueue,
  calculateReplyDelay,
  conversationDeliveryKey,
  deliverPlannedReply,
  planReplySegments,
  segmentReply,
} from "./delivery.js";
import { Engine } from "./engine.js";
import { FollowUpScheduler } from "./follow-up.js";
import { MemoryManager } from "./memory.js";
import {
  BatchCancelledError,
  MessageBatcher,
  eventHistoryText,
  isBatchCancelled,
  sleepWithSignal,
} from "./message-batcher.js";
import { QzoneCommentsManager } from "./qzone-comments.js";
import { QzonePublisher } from "./qzone.js";
import { createWebServer, listenLocal } from "./server.js";
import { StickerLibrary } from "./stickers.js";
import { Store } from "./store.js";
import { TypingIndicator } from "./typing.js";
import { UserUnderstanding } from "./user-understanding.js";
import { WebSearchClient } from "./web-search.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createConfigController(initialConfig) {
  let currentConfig = initialConfig;
  return {
    getConfig: () => currentConfig,
    setConfig(nextConfig) {
      currentConfig = nextConfig;
      return currentConfig;
    },
  };
}

export function createQzoneToolPublisher(qzone) {
  if (!qzone || typeof qzone.publish !== "function") {
    throw new TypeError("qzone.publish is required");
  }
  return async function publishQzoneForTool(text, options) {
    const result = await qzone.publish(text, options);
    if (result?.status === "sent") return result;
    const error = new Error(
      result?.message ?? `QQ 空间未确认发布（${result?.status ?? "unknown"}）`,
    );
    error.code = result?.reason ?? result?.status ?? "QZONE_NOT_SENT";
    error.dispatched =
      result?.status === "unknown" || result?.status === "sending";
    error.result = result;
    throw error;
  };
}

function safeLog(logger, level, message, error) {
  const detail = error
    ? String(error?.message ?? error)
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
        .replace(/((?:token|secret|apiKey)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    : "";
  try {
    logger?.[level]?.(message, ...(detail ? [detail] : []));
  } catch {
    // Logging must not prevent startup or shutdown.
  }
}

export function createReplyFlow({
  getConfig,
  engine,
  delivery,
  typing,
  activity,
  logger = console,
  sleep = sleepWithSignal,
  random = Math.random,
}) {
  if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
  if (!engine || typeof engine.handle !== "function") {
    throw new TypeError("engine 必须提供 handle");
  }
  if (!delivery || typeof delivery.enqueue !== "function") {
    throw new TypeError("delivery 必须提供 enqueue");
  }
  if (!typing || typeof typing.start !== "function") {
    throw new TypeError("typing 必须提供 start");
  }
  if (typeof sleep !== "function") throw new TypeError("sleep 必须是函数");
  if (typeof random !== "function") throw new TypeError("random 必须是函数");

  function conversationAllowed(event, policy) {
    const allowedUsers = Array.isArray(policy?.allowedUsers) ? policy.allowedUsers : [];
    const allowedGroups = Array.isArray(policy?.allowedGroups) ? policy.allowedGroups : [];
    if (allowedUsers.length && !allowedUsers.includes(event.userId)) return false;
    if (
      event.scope === "group" &&
      allowedGroups.length &&
      !allowedGroups.includes(event.groupId)
    ) {
      return false;
    }
    return true;
  }

  async function deliverReply(
    adapter,
    event,
    reply,
    {
      onStatus,
      beforeSend,
      afterSegmentSent,
      delayMs: delayOverride,
      segmentation = true,
      signal = null,
    } = {},
  ) {
    const notify = (status, extra = {}) => {
      try {
        onStatus?.(status, extra);
      } catch {
        // Status callbacks must not break sending.
      }
    };
    const latest = getConfig();
    if (latest.policy?.paused || !conversationAllowed(event, latest.policy)) {
      notify("suppressed");
      return { status: "suppressed", sentSegments: [] };
    }
    const segmentSettings = latest.replyPacing ?? {};
    const planned =
      segmentation && latest.replyDelay?.enabled !== false
        ? planReplySegments(reply, { event, settings: segmentSettings })
        : [{ index: 0, total: 1, text: String(reply?.text ?? "") }];
    const delayMs =
      Number.isFinite(delayOverride) && delayOverride >= 0
        ? delayOverride
        : calculateReplyDelay(segmentReply(reply, planned[0]), latest.replyDelay, {
            random,
          });
    notify("delayed", { delayMs });
    const outcome = await deliverPlannedReply({
      queue: delivery,
      key: conversationDeliveryKey(event),
      event,
      reply,
      segments: planned,
      delayMs,
      signal,
      send: (target, segmentReply) => adapter.send(target, segmentReply),
      isAllowed: () => {
        const current = getConfig();
        return !current.policy?.paused && conversationAllowed(event, current.policy);
      },
      pauseBetween: (segmentIndex) =>
        sleep(
          calculateReplyDelay(
            segmentReply(reply, planned[segmentIndex]),
            latest.replyDelay,
            { random },
          ),
          signal,
        ),
      beforeFirstSend: beforeSend,
      afterSegmentSent,
      onStatus: notify,
    });
    if ((outcome?.sentSegments?.length ?? 0) > 0) {
      try {
        if (reply?.chatEnded) {
          await activity.clear(event);
        } else {
          const current = getConfig();
          await activity.noteBot(event, {
            idleMinutes: current.chatExit?.idleMinutes ?? 10,
          });
        }
      } catch (error) {
        safeLog(logger, "warn", "chat activity update failed", error);
      }
    }
    return outcome;
  }

  async function processEvent(
    adapter,
    event,
    {
      signal = null,
      deferCommit = false,
      onBeforeSend = null,
      onStatus = null,
      getSupplements = null,
      markSupplementsCommitted = null,
    } = {},
  ) {
    if (signal?.aborted) throw new BatchCancelledError();
    const stopTyping = typing.start(event);
    try {
      const latest = getConfig();
      if (latest.policy?.paused || !conversationAllowed(event, latest.policy)) {
        return { status: "suppressed" };
      }
      if (signal?.aborted) throw new BatchCancelledError();

      const reply = await engine.handle(event, { signal, deferCommit });
      if (signal?.aborted) throw new BatchCancelledError();
      let supplementsCommitted = false;
      const supplementTexts = () =>
        supplementsCommitted
          ? []
          : (getSupplements?.() ?? []).map(eventHistoryText);
      const commitDelivered = async ({
        assistantText = null,
        userTexts = [],
        final = false,
      } = {}) => {
        if (typeof engine.commitDeliveredTurn === "function") {
          await engine.commitDeliveredTurn(reply, {
            assistantText,
            userTexts,
            final,
          });
          return true;
        }
        if (
          final &&
          userTexts.length === 0 &&
          assistantText === (reply?.turn?.assistantText ?? null)
        ) {
          return engine.commitTurn(reply);
        }
        throw new Error("Engine 未提供分段历史提交接口");
      };
      const commitFirst = async (assistantText, final) => {
        const userTexts = supplementTexts();
        supplementsCommitted = true;
        await commitDelivered({ assistantText, userTexts, final });
        if (userTexts.length) markSupplementsCommitted?.();
      };
      if (reply?.duplicate || reply?.suppressed) {
        if (deferCommit) {
          if (signal?.aborted) throw new BatchCancelledError();
          onBeforeSend?.();
          if (signal?.aborted) throw new BatchCancelledError();
          try {
            await commitFirst(null, true);
          } catch (error) {
            safeLog(logger, "warn", "chat history commit failed", error);
          }
        }
        if (reply?.chatEnded) {
          try {
            await activity.clear(event);
          } catch (error) {
            safeLog(logger, "warn", "chat activity clear failed", error);
          }
        }
        return { status: "suppressed", duplicate: Boolean(reply.duplicate) };
      }

      let firstSegmentCommitted = false;
      const outcome = await deliverReply(adapter, event, reply, {
        signal,
        onStatus,
        beforeSend: onBeforeSend
          ? async () => {
              if (signal?.aborted) throw new BatchCancelledError();
              onBeforeSend();
            }
          : undefined,
        afterSegmentSent: deferCommit
          ? async (segment, { first, last }) => {
              if (first && !firstSegmentCommitted) {
                firstSegmentCommitted = true;
                await commitFirst(segment.text, last);
              } else {
                await commitDelivered({
                  assistantText: segment.text,
                  userTexts: [],
                  final: last,
                });
              }
            }
          : undefined,
      });
      if (
        deferCommit &&
        !firstSegmentCommitted &&
        ["failed", "partial", "suppressed"].includes(outcome?.status)
      ) {
        if (signal?.aborted) throw new BatchCancelledError();
        if (outcome?.status === "suppressed") onBeforeSend?.();
        try {
          await commitFirst(null, true);
        } catch (error) {
          safeLog(logger, "warn", "chat history commit failed", error);
        }
      } else if (
        deferCommit &&
        firstSegmentCommitted &&
        ["failed", "partial", "suppressed"].includes(outcome?.status)
      ) {
        try {
          await commitDelivered({
            assistantText: null,
            userTexts: [],
            final: true,
          });
        } catch (error) {
          safeLog(logger, "warn", "chat history finalize failed", error);
        }
      }
      if (reply?.chatEnded && outcome?.status === "sent") {
        try {
          await activity.clear(event);
        } catch (error) {
          safeLog(logger, "warn", "chat activity clear failed", error);
        }
      }
      return outcome;
    } catch (error) {
      if (isBatchCancelled(error) || signal?.aborted) {
        throw new BatchCancelledError();
      }
      safeLog(logger, "error", `${event.channel} message handling failed`, error);
      return { status: "failed" };
    } finally {
      stopTyping();
    }
  }

  return { conversationAllowed, deliverReply, processEvent };
}

async function main() {
  const logger = console;
  const controller = createConfigController(await loadConfig(ROOT));
  const getConfig = controller.getConfig;
  const delivery = new ConversationDeliveryQueue();
  const store = new Store(ROOT);
  await store.init();
  const conversationState = new ConversationState({ root: ROOT, logger });
  await conversationState.init();
  const webSearch = new WebSearchClient({ getConfig, logger });
  const chatExit = new ChatExitManager({ root: ROOT, logger });
  await chatExit.init();
  const activity = new ChatActivityTracker({ root: ROOT, logger });
  await activity.init();
  const stickers = new StickerLibrary({ root: ROOT, getConfig, logger });
  await stickers.init();

  const qq = new QQAdapter({ getConfig, logger });
  const onebot = new OneBotAdapter({ getConfig, logger });
  const typing = new TypingIndicator({ getConfig, adapter: onebot, logger });
  const qzoneComments = new QzoneCommentsManager({
    root: ROOT,
    getConfig,
    onebot,
    logger,
  });
  await qzoneComments.init();
  const qzone = new QzonePublisher({
    root: ROOT,
    getConfig,
    logger,
    onebot,
    onSent: () => qzoneComments.noteActivity(),
  });
  const memory = new MemoryManager({ getConfig, store, logger });
  const userUnderstanding = new UserUnderstanding({
    root: ROOT,
    getConfig,
    chat: aiChat,
    logger,
  });
  await userUnderstanding.init();
  let autonomy = null;
  let idleExit = null;
  let replyFlow = null;
  const followUp = new FollowUpScheduler({
    getConfig,
    state: chatExit.state,
    store,
    conversationState,
    deliver: (event, reply) =>
      replyFlow.deliverReply(onebot, event, reply, { segmentation: false }),
    isReady: () => onebot.status().ready === true,
    onTick: async () => {
      await Promise.allSettled([autonomy?.tick(), idleExit?.tick()]);
    },
    logger,
  });
  await followUp.init();
  chatExit.onNeedsTime = (context) => {
    followUp.notifyNeedsTime(context).catch((error) => {
      safeLog(logger, "warn", "follow-up time resolution failed", error);
    });
  };
  idleExit = new IdleExitScheduler({
    getConfig,
    store,
    chatExit,
    activity,
    onNeedsTime: (context) => followUp.notifyNeedsTime(context),
    logger,
  });

  let engine;
  engine = new Engine({
    getConfig,
    store,
    services: {
      like: (userId, times) => onebot.like(userId, times),
      publishQzone: createQzoneToolPublisher(qzone),
      stickers,
      memory,
      userUnderstanding,
      chatExit,
      conversationState,
      webSearch,
      qzoneComments,
      fetchHistory: (event, options) => onebot.fetchHistory(event, options),
      logger,
    },
  });
  replyFlow = createReplyFlow({
    getConfig,
    engine,
    delivery,
    typing,
    activity,
    logger,
  });

  const receivedEvents = new Map();
  const inflightEvents = new Map();

  function rememberEvent(key, outcome) {
    receivedEvents.set(key, outcome);
    while (receivedEvents.size > 1000) {
      receivedEvents.delete(receivedEvents.keys().next().value);
    }
  }

  const batcher = new MessageBatcher({
    handler: async ({
      event,
      context,
      signal,
      onBeforeSend,
      getSupplements,
      markSupplementsCommitted,
    }) => {
      return replyFlow.processEvent(context.adapter, event, {
        signal,
        deferCommit: true,
        onBeforeSend,
        getSupplements,
        markSupplementsCommitted,
      });
    },
    silentMs: getConfig().inputDelayMs,
    logger,
  });

  async function receive(adapter, event) {
    const current = getConfig();
    if (current.policy?.paused || !replyFlow.conversationAllowed(event, current.policy)) {
      return { status: "suppressed" };
    }

    if (event.channel !== "local") {
      const result = batcher.enqueue(event, { adapter });
      if (["batched", "supplemented"].includes(result.status)) {
        try {
          await activity.noteUser(event);
        } catch (error) {
          safeLog(logger, "warn", "chat activity update failed", error);
        }
      }
      return result;
    }

    const key = event.id
      ? `${event.channel}:${event.id}`
      : `${event.channel}:${Date.now()}:${Math.random()}`;
    if (receivedEvents.has(key)) return receivedEvents.get(key);
    if (inflightEvents.has(key)) return inflightEvents.get(key);
    const operation = (async () => {
      try {
        await activity.noteUser(event);
      } catch (error) {
        safeLog(logger, "warn", "chat activity update failed", error);
      }
      const outcome = await replyFlow.processEvent(adapter, event, {
        onStatus: (status, extra) => rememberEvent(key, { status, ...extra }),
      });
      rememberEvent(key, outcome);
      return outcome;
    })();
    inflightEvents.set(key, operation);
    try {
      return await operation;
    } finally {
      inflightEvents.delete(key);
    }
  }

  async function startAdapter(adapter, name) {
    try {
      await adapter.start((event) => receive(adapter, event));
    } catch (error) {
      safeLog(logger, "error", `${name} adapter failed to start`, error);
    }
  }

  async function reconnect() {
    typing.stopAll();
    await Promise.allSettled([qq.stop(), onebot.stop()]);
    const results = await Promise.allSettled([
      qq.start((event) => receive(qq, event)),
      onebot.start((event) => receive(onebot, event)),
    ]);
    const errors = results
      .map((result, index) =>
        result.status === "rejected"
          ? `${index === 0 ? "QQ" : "OneBot"}: ${result.reason?.message ?? "启动失败"}`
          : null,
      )
      .filter(Boolean);
    return {
      status: errors.length ? "partial" : "ok",
      errors,
      qq: await qq.status(),
      onebot: await onebot.status(),
    };
  }

  autonomy = new Autonomy({ root: ROOT, getConfig, qzone, logger });
  await autonomy.init();

  async function persistConfig(root, patch) {
    return controller.setConfig(await saveConfig(root, patch));
  }

  async function onConfigChanged(next, { policyOnly = false } = {}) {
    controller.setConfig(next);
    if (!policyOnly) {
      await autonomy.reconcile();
      await qzoneComments.reconcile();
    }
  }

  const disableWeb =
    process.argv.includes("--no-web") || process.env.ALICE_DISABLE_WEB === "1";
  let server = null;
  if (disableWeb) {
    console.log("Web 控制台已禁用，OneBot 和后台任务继续运行。");
  } else {
    server = createWebServer({
      root: ROOT,
      getConfig,
      saveConfig: persistConfig,
      store,
      engine,
      adapters: { qq, onebot },
      qzone,
      qzoneComments,
      autonomy,
      stickers,
      conversationState,
      userUnderstanding,
      reconnect,
      configChanged: onConfigChanged,
      logger,
    });

    let address;
    try {
      address = await listenLocal(
        server,
        controller.getConfig().port ?? defaultConfig.port,
      );
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        console.error(
          `端口 ${controller.getConfig().port} 已被占用。关闭占用该端口的程序，或在 data/config.json 中修改 port。`,
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    const url = `http://127.0.0.1:${address.port}/#token=${encodeURIComponent(
      server.consoleToken,
    )}`;
    console.log(`Alice 控制台：${url}`);
    console.log("控制台仅监听 127.0.0.1。上面的随机令牌只保存在当前浏览器会话。");
  }

  await Promise.all([startAdapter(qq, "QQ"), startAdapter(onebot, "OneBot")]);
  await qzoneComments.start();
  await autonomy.start();
  await followUp.start();
  await userUnderstanding.start();

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`收到 ${signal}，正在停止…`);
    batcher.stop();
    typing.stopAll();
    await userUnderstanding.stop();
    if (server) {
      server.closeIdleConnections?.();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await Promise.allSettled([
      autonomy.stop(),
      qzoneComments.stop(),
      followUp.stop(),
      qq.stop(),
      onebot.stop(),
      qzone.stop(),
    ]);
    await Promise.allSettled([
      engine.flushMemory({ timeoutMs: 2000 }),
      conversationState.flush(),
      userUnderstanding.flush(),
    ]);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown(signal)
        .catch((error) => safeLog(logger, "error", "Shutdown failed", error))
        .finally(() => process.exit());
    });
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    safeLog(console, "error", "Alice 启动失败", error);
    process.exitCode = 1;
  });
}
