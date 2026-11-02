// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { groupChatDefaults } from "./config.js";
import { conversationStateKey } from "./conversation-state.js";
import { projectGroupSafePreferenceCategories } from "./group-preferences.js";
import { rankMatches, searchScore, searchTerms } from "./search.js";

const VERSION = 1;
const FILE = path.join("data", "group-chat.json");
const GENERIC_AUDIENCE =
  /(?:有人|有没有人|谁|大家).{0,12}(?:玩过|试过|用过|看过|听过|知道|去过|喜欢|会|吗|么)|(?:在吗|在不在)/iu;
const QUESTION =
  /[？?]|(?:吗|么|怎样|怎么样|怎么|为什么|为何|如何|哪个|哪里|是不是|能不能|可不可以|有没有|求推荐|想问问)/iu;
const MODES = new Set(["mention", "natural", "active"]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function cleanText(value, max = 360) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function nonNegative(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
}

function eventTime(event, fallback) {
  const parsed = Date.parse(event?.timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function groupStateKey(groupId) {
  return createHash("sha256")
    .update(`onebot-group:${String(groupId)}`, "utf8")
    .digest("hex");
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function defaultGroupState() {
  return {
    familiarity: 0.25,
    lastFamiliarityDay: "",
    cooldownUntil: 0,
    consecutiveMessages: 0,
    modelCalls: [],
    updatedAt: 0,
  };
}

function normalizeGroupState(raw, now) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    familiarity: Math.max(0, Math.min(1, Number(source.familiarity) || 0.25)),
    lastFamiliarityDay:
      typeof source.lastFamiliarityDay === "string"
        ? source.lastFamiliarityDay.slice(0, 10)
        : "",
    cooldownUntil: nonNegative(source.cooldownUntil),
    consecutiveMessages: Math.max(
      0,
      Math.min(10, Math.floor(Number(source.consecutiveMessages) || 0)),
    ),
    modelCalls: Array.isArray(source.modelCalls)
      ? source.modelCalls
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > now - 60 * 60 * 1000)
          .slice(-100)
      : [],
    updatedAt: nonNegative(source.updatedAt),
  };
}

function emptyData() {
  return { version: VERSION, groups: {} };
}

function localHour(timezone, now) {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(now)),
    );
  } catch {
    return new Date(now).getHours();
  }
}

export function inQuietHours(quietHours, timezone, now) {
  const start = Number(quietHours?.start);
  const end = Number(quietHours?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) {
    return false;
  }
  const hour = localHour(timezone, now);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function proactiveWaitMs(config, memberCount) {
  const settings = { ...groupChatDefaults, ...(config?.groupChat ?? {}) };
  const count = Number(memberCount);
  if (!Number.isInteger(count) || count < 1) return null;
  return (
    nonNegative(settings.proactiveWaitBaseMs, 30000) +
    count * nonNegative(settings.proactiveWaitPerMemberMs, 1200)
  );
}

function delay(ms, signal, timerApi = globalThis) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      timerApi.clearTimeout(timer);
      reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
    };
    const timer = timerApi.setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    timer?.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function mergeGroupConfig(config) {
  const group = config?.groupChat ?? {};
  return {
    ...groupChatDefaults,
    ...group,
    quietHours: { ...groupChatDefaults.quietHours, ...(group.quietHours ?? {}) },
    modes: { ...(group.modes ?? {}) },
  };
}

export class GroupChatManager {
  constructor({
    root,
    getConfig,
    adapter,
    store,
    conversationState,
    deliver = null,
    logger = console,
    now = Date.now,
    timerApi = globalThis,
  } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("root 必须是非空路径");
    if (typeof getConfig !== "function") throw new TypeError("getConfig 必须是函数");
    if (!adapter || typeof adapter.send !== "function") {
      throw new TypeError("adapter 必须是可发送的 OneBot 适配器");
    }
    if (!store) throw new TypeError("store 不能为空");
    this.root = path.resolve(root);
    this.file = path.join(this.root, FILE);
    this.getConfig = getConfig;
    this.adapter = adapter;
    this.store = store;
    this.conversationState = conversationState;
    this.deliver = deliver;
    this.logger = logger;
    this.now = now;
    this.timerApi = timerApi;
    this.data = emptyData();
    this._scenes = new Map();
    this._candidates = new Map();
    this._threads = new Map();
    this._responseTimers = new Map();
    this._evaluations = new Map();
    this._writeQueue = Promise.resolve();
    this._initialized = null;
  }

  setDeliver(deliver) {
    if (typeof deliver !== "function") throw new TypeError("deliver 必须是函数");
    this.deliver = deliver;
  }

  init() {
    if (!this._initialized) this._initialized = this._init().then(() => this);
    return this._initialized;
  }

  async _init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (!isPlainObject(parsed) || parsed.version !== VERSION) throw new Error("invalid state");
      this.data = emptyData();
      for (const [key, value] of Object.entries(parsed.groups ?? {})) {
        if (/^[a-f0-9]{64}$/u.test(key)) {
          this.data.groups[key] = normalizeGroupState(value, this.now());
        }
      }
    } catch {
      this.data = emptyData();
      await this._persist();
    }
  }

  _state(key) {
    if (!this.data.groups[key]) this.data.groups[key] = defaultGroupState();
    return this.data.groups[key];
  }

  _scene(groupId) {
    if (!this._scenes.has(groupId)) {
      this._scenes.set(groupId, {
        messages: [],
        labels: new Map(),
        lastMessageAt: 0,
      });
    }
    return this._scenes.get(groupId);
  }

  _trimScene(scene, config, now) {
    const settings = mergeGroupConfig(config);
    const cutoff = now - settings.sceneWindowMinutes * 60 * 1000;
    scene.messages = scene.messages
      .filter((message) => message.time >= cutoff)
      .slice(-settings.sceneMessages);
  }

  _recordScene(event, config) {
    const now = eventTime(event, this.now());
    const scene = this._scene(event.groupId);
    if (!scene.labels.has(event.userId)) {
      scene.labels.set(event.userId, `成员${scene.labels.size + 1}`);
    }
    const quote = event.quotedMessageId
      ? scene.messages.find((item) => item.id === event.quotedMessageId)
      : null;
    scene.messages.push({
      id: event.id,
      userId: event.userId,
      speaker: scene.labels.get(event.userId),
      text: cleanText(event.text, 500),
      time: now,
      quoteId: event.quotedMessageId || "",
      quoteSpeaker:
        quote?.speaker ?? (event.quotedSelf ? config.persona?.name || "bot" : ""),
      mentionIds: Array.isArray(event.mentionIds) ? event.mentionIds.map(String) : [],
    });
    scene.lastMessageAt = now;
    this._trimScene(scene, config, now);
  }

  _mode(groupId, config) {
    const settings = mergeGroupConfig(config);
    return MODES.has(settings.modes[String(groupId)])
      ? settings.modes[String(groupId)]
      : settings.defaultMode;
  }

  explicitReason(event, config = this.getConfig()) {
    if (!event || event.scope !== "group" || event.channel !== "onebot") return null;
    if (event.mentionedSelf === true) return "mention";
    if (event.quotedSelf === true) return "quote";
    const name = cleanText(config?.persona?.name, 80);
    if (!name) return null;
    const text = cleanText(event.text, 2000);
    if (!text) return null;
    if (/^[\x00-\x7f]+$/u.test(name)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "iu").test(text)
        ? "name"
        : null;
    }
    return text.toLocaleLowerCase("zh-CN").includes(name.toLocaleLowerCase("zh-CN"))
      ? "name"
      : null;
  }

  async route(event, { deliver = this.deliver } = {}) {
    if (!event || event.scope !== "group" || event.channel !== "onebot") {
      return { explicit: false, observed: false };
    }
    const config = this.getConfig();
    const settings = mergeGroupConfig(config);
    const reason = this.explicitReason(event, config);
    const previousThread = this._threads.get(event.groupId);
    const continuesThread =
      previousThread?.awaitingReply === true &&
      previousThread.anchorUserId === event.userId &&
      this.now() - previousThread.lastAliceAt <= 3 * 60 * 1000;
    if (continuesThread) event.groupContinuation = true;
    this._recordScene(event, config);
    if (
      reason ||
      event.quotedSelf === true ||
      continuesThread
    ) {
      this._clearResponseTimer(event.groupId);
    }

    const candidate = this._candidates.get(event.groupId);
    if (candidate && candidate.anchorId !== event.id) {
      candidate.followups.push(event);
      if (this._invalidatesCandidate(candidate, event)) {
        candidate.controller.abort();
        this._candidates.delete(event.groupId);
      }
    }

    if (reason) {
      event.mentionedSelf = true;
      this._clearEvaluation(event.groupId);
      this._threads.set(event.groupId, {
        anchorUserId: event.userId,
        lastAliceAt: this.now(),
        awaitingReply: false,
        explicitPending: true,
        divertedAt: 0,
      });
      return { explicit: true, reason, observed: false };
    }
    const pendingThread = this._threads.get(event.groupId);
    if (
      pendingThread?.explicitPending === true &&
      pendingThread.anchorUserId === event.userId &&
      this.now() - pendingThread.lastAliceAt <= 3 * 60 * 1000
    ) {
      this._clearEvaluation(event.groupId);
      return { explicit: true, reason: "pending_continuation", observed: false };
    }
    if (settings.enabled !== false && this._mode(event.groupId, config) !== "mention") {
      this._scheduleEvaluation({ event, config, deliver });
    }
    return { explicit: false, observed: true };
  }

  _scheduleEvaluation({ event, config, deliver }) {
    const settings = mergeGroupConfig(config);
    if (
      settings.enabled === false ||
      config.demo === true ||
      !config.ai?.apiKey ||
      (event.mentionIds ?? []).length > 0 ||
      (event.quotedMessageId && event.quotedSelf !== true) ||
      inQuietHours(settings.quietHours, settings.timezone, this.now()) ||
      this._candidates.has(event.groupId) ||
      this._evaluations.has(event.groupId)
    ) {
      return;
    }
    const operation = this._evaluate({ event, config, deliver })
      .catch((error) => {
        if (error?.code !== "CANCELLED") this._warn("群聊候选生成失败", error);
      })
      .finally(() => {
        if (this._evaluations.get(event.groupId) === operation) {
          this._evaluations.delete(event.groupId);
        }
      });
    this._evaluations.set(event.groupId, operation);
  }

  _clearEvaluation(groupId) {
    const candidate = this._candidates.get(groupId);
    candidate?.controller.abort();
    this._candidates.delete(groupId);
  }

  async waitForIdle() {
    await Promise.allSettled([...this._evaluations.values()]);
  }

  async _evaluate({ event, config, deliver }) {
    const settings = mergeGroupConfig(config);
    const key = groupStateKey(event.groupId);
    const state = this._state(key);
    const now = this.now();
    if (state.cooldownUntil > now) return;
    if (state.cooldownUntil > 0) {
      state.cooldownUntil = 0;
      state.consecutiveMessages = 0;
    }
    if (!this._budgetAvailable(state, settings, now)) return;
    if (typeof deliver !== "function") return;

    const thread = this._threads.get(event.groupId);
    let kind = "proactive";
    if (
      event.groupContinuation === true &&
      thread?.anchorUserId === event.userId &&
      now - thread.lastAliceAt <= 3 * 60 * 1000
    ) {
      kind = "continuation";
    }
    if (
      thread?.divertedAt > 0 &&
      now - thread.divertedAt <= 3 * 60 * 1000
    ) {
      return;
    }
    if (
      thread?.explicitPending === true &&
      now - thread.lastAliceAt <= 3 * 60 * 1000
    ) {
      if (event.userId !== thread.anchorUserId) return;
      kind = "continuation";
    }
    if (
      thread &&
      thread.anchorUserId === event.userId &&
      now - thread.lastAliceAt <= 3 * 60 * 1000 &&
      thread.awaitingReply === true
    ) {
      kind = "continuation";
      thread.awaitingReply = false;
    } else if (
      thread &&
      thread.awaitingReply === true &&
      event.userId !== thread.anchorUserId
    ) {
      thread.awaitingReply = false;
      thread.divertedAt = now;
      return;
    }

    let score = null;
    if (kind === "proactive") {
      score = await this._scoreCandidate(event, config, settings, state);
      if (!score.shouldOffer) return;
    }

    const controller = new AbortController();
    const candidate = {
      groupId: event.groupId,
      anchorId: event.id,
      anchorUserId: event.userId,
      anchorText: event.text,
      kind,
      controller,
      followups: [],
      unrelated: 0,
      startedAt: now,
      status: "waiting",
    };
    this._candidates.set(event.groupId, candidate);

    try {
      if (kind === "proactive") {
        let memberCount;
        try {
          memberCount = await this.adapter.getGroupInfo(event.groupId);
        } catch (error) {
          this._warn("获取群人数失败，跳过本次主动候选", error);
          return;
        }
        const waitMs = proactiveWaitMs(config, memberCount);
        if (waitMs === null) return;
        await delay(waitMs, controller.signal, this.timerApi);
        if (controller.signal.aborted) return;
        const refreshed = await this._scoreCandidate(
          this._candidateAnchor(candidate),
          config,
          settings,
          state,
          candidate.followups,
        );
        if (!refreshed.shouldOffer) return;
        score = refreshed;
      }

      if (
        config.policy?.paused ||
        state.cooldownUntil > this.now() ||
        !this._budgetAvailable(state, settings, this.now())
      ) {
        return;
      }
      candidate.status = "generating";
      state.modelCalls = [
        ...state.modelCalls.filter((time) => time > this.now() - 60 * 60 * 1000),
        this.now(),
      ];
      state.updatedAt = this.now();
      await this._persist();
      if (controller.signal.aborted) return;

      const decisionEvent = {
        ...event,
        id: `group-decision-${event.id}-${this.now()}`,
        text: cleanText(event.text, 500),
        groupDecision: {
          kind,
          score: score?.score ?? null,
          familiarity: state.familiarity,
          mode: this._mode(event.groupId, config),
          scene: this._decisionScene(event.groupId),
          anchorId: event.id,
        },
      };
      const outcome = await deliver(decisionEvent, {
        signal: controller.signal,
        onBeforeSend: () => {
          if (
            controller.signal.aborted ||
            this._candidates.get(event.groupId) !== candidate
          ) {
            throw Object.assign(new Error("群聊候选已失效"), { code: "CANCELLED" });
          }
        },
      });
      await this.recordDelivery(decisionEvent, outcome);
    } finally {
      if (this._candidates.get(event.groupId) === candidate) {
        this._candidates.delete(event.groupId);
      }
    }
  }

  _candidateAnchor(candidate) {
    return {
      id: candidate.anchorId,
      channel: "onebot",
      scope: "group",
      groupId: candidate.groupId,
      conversationId: candidate.groupId,
      userId: candidate.anchorUserId,
      text: candidate.anchorText,
      timestamp: new Date(candidate.startedAt).toISOString(),
    };
  }

  async _scoreCandidate(anchor, config, settings, state, followups = []) {
    const text = cleanText(anchor.text, 1000);
    if (!text || GENERIC_AUDIENCE.test(text)) {
      return { shouldOffer: false, reason: "generic_audience" };
    }
    const now = this.now();
    const scene = this._scene(anchor.groupId);
    this._trimScene(scene, config, now);
    const human = scene.messages.filter((message) => message.userId !== "self");
    const recent90 = human.filter((message) => message.time >= now - 90_000);
    const speakers = new Set(recent90.map((message) => message.userId));
    const question = QUESTION.test(text);
    let score = question ? 0.52 : 0.3;

    const terms = searchTerms(text).filter((term) => Array.from(term).length >= 2);
    const previous = [...human.slice(0, -1), ...followups].slice(-8);
    const overlap = previous.reduce(
      (total, message) => total + (searchScore(message.text, terms) > 0 ? 0.04 : 0),
      0,
    );
    score += Math.min(0.2, overlap);

    let memoryEvidence = false;
    try {
      const memoryKey = JSON.stringify(["group-memory", "onebot", anchor.groupId]);
      const memories = await this.store.memories(memoryKey, { limit: 20, touch: false });
      const probe = [text, ...previous.map((message) => message.text)].join(" ");
      if (rankMatches(memories, probe, { limit: 3, textOf: (memory) => memory.text }).length) {
        score += 0.16;
        memoryEvidence = true;
      }
    } catch {
      // Candidate scoring remains useful when memories are unavailable.
    }

    let privateInterestEvidence = false;
    try {
      const linked = config.identityLinks?.[`${anchor.channel}:${anchor.userId}`];
      const privateMemoryKey =
        typeof linked === "string" && linked.trim()
          ? JSON.stringify(["identity-memory", linked.trim()])
          : JSON.stringify(["private-memory", anchor.channel, anchor.userId]);
      const privateMemories = await this.store.memories(privateMemoryKey, {
        limit: 50,
        touch: false,
      });
      privateInterestEvidence =
        projectGroupSafePreferenceCategories(privateMemories, text).length > 0;
      if (privateInterestEvidence) score += 0.08;
    } catch {
      privateInterestEvidence = false;
    }

    const personaText = [
      ...(config.persona?.preferences ?? []),
      ...(config.persona?.opinions ?? []),
    ].join(" ");
    const topicEvidence = overlap > 0;
    const personaEvidence = Boolean(
      personaText &&
      searchScore(
        `${text} ${previous.map((item) => item.text).join(" ")}`,
        searchTerms(personaText),
      ) > 0,
    );
    if (personaEvidence) score += 0.08;

    let relationship = 0;
    let willingness = 0.5;
    if (this.conversationState?.visibleContext) {
      try {
        const visible = await this.conversationState.visibleContext(anchor, config, now);
        relationship = Number(visible?.profile?.relationship?.level) || 0;
      } catch {
        relationship = 0;
      }
    }
    if (this.conversationState?.context) {
      try {
        const current = await this.conversationState.context(
          conversationStateKey(anchor),
          config,
          now,
        );
        const scores = current?.global?.scores;
        if (scores) {
          willingness =
            (Number(scores.interest) +
              Number(scores.energy) +
              Number(scores.happiness) +
              Number(scores.calm)) /
            4;
        }
      } catch {
        willingness = 0.5;
      }
    }
    score += Math.min(0.08, relationship * 0.08);
    score += (Math.max(0, Math.min(1, willingness)) - 0.5) * 0.1;
    score += state.familiarity * 0.06;

    if (recent90.length > 1) score -= Math.min(0.32, (recent90.length - 1) * 0.05);
    if (speakers.size > 2) score -= Math.min(0.12, (speakers.size - 2) * 0.03);
    const active = this._mode(anchor.groupId, config) === "active";
    if (active) score += 0.045;
    const threshold = active ? 0.5 : 0.57;
    const supportSignals = [
      topicEvidence ? "topic" : "",
      memoryEvidence ? "memory" : "",
      personaEvidence ? "interest" : "",
      privateInterestEvidence ? "private_interest" : "",
      relationship >= 0.2 ? "relationship" : "",
      state.familiarity > 0.2501 ? "group_history" : "",
    ].filter(Boolean);
    if (question && supportSignals.length === 0) {
      return {
        shouldOffer: false,
        reason: "question_without_support",
        score: Number(score.toFixed(3)),
        threshold,
        supportSignals,
        recentMessages: recent90.length,
        speakers: speakers.size,
      };
    }
    return {
      shouldOffer: score >= threshold,
      reason: question ? "question_or_topic" : "shared_topic",
      score: Number(score.toFixed(3)),
      threshold,
      recentMessages: recent90.length,
      speakers: speakers.size,
      willingness: Number(willingness.toFixed(3)),
      supportSignals,
    };
  }

  _invalidatesCandidate(candidate, event) {
    if (event.userId === candidate.anchorUserId) return false;
    if (event.quotedMessageId === candidate.anchorId) return true;
    if ((event.mentionIds ?? []).length > 0) return true;
    const terms = searchTerms(candidate.anchorText).filter(
      (term) => Array.from(term).length >= 2,
    );
    const overlap = searchScore(event.text, terms) > 0;
    if (overlap && (QUESTION.test(candidate.anchorText) || cleanText(event.text))) {
      return true;
    }
    candidate.unrelated += 1;
    const recent = this._scene(candidate.groupId).messages.filter(
      (message) => message.time >= this.now() - 90_000 && message.userId !== "self",
    );
    return candidate.unrelated >= 2 && recent.length >= 4;
  }

  _decisionScene(groupId) {
    return this._scene(groupId).messages.slice(-12).map((message) => ({
      speaker: message.speaker,
      text: message.text,
      quoteSpeaker: message.quoteSpeaker,
    }));
  }

  _budgetAvailable(state, settings, now) {
    if (settings.budgetPerHour === 0) return true;
    state.modelCalls = (state.modelCalls ?? []).filter(
      (time) => time > now - 60 * 60 * 1000,
    );
    return state.modelCalls.length < settings.budgetPerHour;
  }

  _clearResponseTimer(groupId) {
    const timer = this._responseTimers.get(groupId);
    if (timer !== undefined) this.timerApi.clearTimeout(timer);
    this._responseTimers.delete(groupId);
    const thread = this._threads.get(groupId);
    if (thread?.awaitingReply) thread.awaitingReply = false;
  }

  async recordDelivery(event, outcome) {
    if (!event || event.scope !== "group" || event.channel !== "onebot") return;
    if (outcome?.status !== "sent") return;
    const config = this.getConfig();
    const settings = mergeGroupConfig(config);
    const key = groupStateKey(event.groupId);
    const state = this._state(key);
    const now = this.now();
    if (state.cooldownUntil <= now) state.consecutiveMessages += 1;
    const today = dayKey(now);
    if (state.lastFamiliarityDay !== today) {
      state.familiarity = Math.min(1, state.familiarity + 0.01);
      state.lastFamiliarityDay = today;
    }
    if (state.consecutiveMessages >= settings.maxConsecutiveMessages) {
      state.cooldownUntil = now + settings.cooldownMinutes * 60 * 1000;
    }
    state.updatedAt = now;
    this._threads.set(event.groupId, {
      anchorUserId: event.userId,
      lastAliceAt: now,
      awaitingReply: true,
      explicitPending: false,
      divertedAt: 0,
    });
    const sentText = (outcome.sentSegments ?? [])
      .map((segment) => segment.text)
      .filter(Boolean)
      .join("");
    const scene = this._scene(event.groupId);
    scene.messages.push({
      id: `alice-${now}`,
      userId: "self",
      speaker: config.persona?.name || "bot",
      text: sentText || "[表情回应]",
      time: now,
      quoteId: "",
      quoteSpeaker: "",
      mentionIds: [],
    });
    this._trimScene(scene, config, now);
    await this._persist();
    if (state.cooldownUntil <= now) this._scheduleNoResponse(event.groupId);
  }

  _scheduleNoResponse(groupId) {
    this._clearResponseTimer(groupId);
    const settings = mergeGroupConfig(this.getConfig());
    const thread = this._threads.get(groupId);
    if (!thread) return;
    thread.awaitingReply = true;
    const timer = this.timerApi.setTimeout(() => {
      this._responseTimers.delete(groupId);
      const key = groupStateKey(groupId);
      if (this._state(key).cooldownUntil > this.now()) return;
      void this._enterCooldown(groupId).catch((error) =>
        this._warn("群聊无人接话退场失败", error),
      );
    }, settings.noResponseMinutes * 60 * 1000);
    timer?.unref?.();
    this._responseTimers.set(groupId, timer);
  }

  async _enterCooldown(groupId) {
    const settings = mergeGroupConfig(this.getConfig());
    const state = this._state(groupStateKey(groupId));
    state.cooldownUntil = this.now() + settings.cooldownMinutes * 60 * 1000;
    state.consecutiveMessages = settings.maxConsecutiveMessages;
    state.updatedAt = this.now();
    const thread = this._threads.get(groupId);
    if (thread) thread.awaitingReply = false;
    await this._persist();
  }

  async _persist() {
    const operation = async () => {
      const suffix = `${process.pid}-${this.now()}-${Math.random().toString(16).slice(2)}`;
      const temp = `${this.file}.${suffix}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await rename(temp, this.file);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    };
    const result = this._writeQueue.then(operation, operation);
    this._writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  status() {
    return {
      enabled: mergeGroupConfig(this.getConfig()).enabled !== false,
      activeCandidates: [...this._candidates.values()].map((candidate) => ({
        group: groupStateKey(candidate.groupId),
        kind: candidate.kind,
        status: candidate.status,
      })),
      groupsTracked: Object.keys(this.data.groups).length,
    };
  }

  async stop() {
    for (const timer of this._responseTimers.values()) this.timerApi.clearTimeout(timer);
    this._responseTimers.clear();
    for (const candidate of this._candidates.values()) candidate.controller.abort();
    this._candidates.clear();
    await Promise.allSettled([...this._evaluations.values()]);
    await this._writeQueue;
  }

  _warn(message, error) {
    try {
      this.logger?.warn?.(message, String(error?.message ?? error).slice(0, 300));
    } catch {
      // Logging must not affect group chat.
    }
  }
}
