import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConversationState,
  conversationStateKey,
  normalizeConversationReview,
  personStateKey,
} from "../src/conversation-state.js";
import { buildStyleFlags } from "../src/conversation-style.js";

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), "alice-conversation-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function event(overrides = {}) {
  return {
    channel: "onebot",
    scope: "private",
    conversationId: "private-10001",
    userId: "10001",
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    reply: "嗯。",
    silence: false,
    topic: "今天有点累",
    unfinished: "",
    preference: "喜欢短句",
    emotion: "concerned",
    emotionIntensity: 0.6,
    globalEmotion: {
      action: "warm",
      happiness: 0,
      energy: 0,
      interest: 0,
      calm: 0,
    },
    ...overrides,
  };
}

const stateConfig = {
  conversationState: {
    ttlHours: 72,
    globalEmotionTtlHours: 24,
    maxEntries: 200,
  },
};

test("conversation reviews require the complete schema", () => {
  assert.equal(normalizeConversationReview({}), null);
  assert.equal(
    normalizeConversationReview(
      review({
        emotion: { label: "warm", intensity: 0.8 },
      }),
    ),
    null,
  );
  assert.equal(
    normalizeConversationReview({
      ...review(),
      globalEmotion: { action: "warm" },
    }),
    null,
  );
  const normalized = normalizeConversationReview(
    review({ emotion: "playful", emotionIntensity: 1.8 }),
  );
  assert.equal(normalized.emotion, "playful");
  assert.equal(normalized.emotionIntensity, 1);
  assert.equal(normalized.clearTopic, false);
  assert.equal(normalized.clearUnfinished, false);
  assert.equal(normalized.clearPreference, false);
  assert.equal(
    normalizeConversationReview(review({ clear_unfinished: "true" })).clearUnfinished,
    false,
  );
});

test("conversation state isolates hashed scopes and stores no raw account ids", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const first = conversationStateKey(event());
  const second = conversationStateKey(
    event({ conversationId: "private-20002", userId: "20002" }),
  );
  await state.updateTurn({
    conversationKey: first,
    config: stateConfig,
    review: normalizeConversationReview(review({ topic: "只属于第一个会话" })),
    now: 1000,
  });
  await state.updateTurn({
    conversationKey: second,
    config: stateConfig,
    review: normalizeConversationReview(review({ topic: "只属于第二个会话" })),
    now: 1000,
  });

  assert.equal((await state.context(first, stateConfig, 1000)).conversation.topic, "只属于第一个会话");
  assert.equal((await state.context(second, stateConfig, 1000)).conversation.topic, "只属于第二个会话");
  const saved = await readFile(path.join(root, "data", "conversation-state.json"), "utf8");
  assert.doesNotMatch(saved, /private-10001|private-20002|10001|20002/);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("irrelevant chat preserves short state and explicit flags clear completed fields", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const key = conversationStateKey(event());
  await state.updateTurn({
    conversationKey: key,
    config: stateConfig,
    review: normalizeConversationReview(
      review({
        topic: "正在处理的事",
        unfinished: "还没完成",
        preference: "偏好短消息",
      }),
    ),
    now: 1000,
  });
  const nextReview = normalizeConversationReview(
    review({
      reply: "嗯。",
      topic: "",
      unfinished: "",
      preference: "",
      globalEmotion: {
        action: "neutral",
        happiness: 0,
        energy: 0,
        interest: 0,
        calm: 0,
        reason: "绝不能进入共享状态",
      },
    }),
  );
  await state.updateTurn({
    conversationKey: key,
    config: stateConfig,
    review: nextReview,
    now: 2000,
  });
  const context = await state.context(key, stateConfig, 2000);
  assert.equal(context.conversation.topic, "正在处理的事");
  assert.equal(context.conversation.unfinished, "还没完成");
  assert.equal(context.conversation.preference, "偏好短消息");

  await state.updateTurn({
    conversationKey: key,
    config: stateConfig,
    review: normalizeConversationReview(
      review({
        topic: "",
        unfinished: "",
        preference: "",
        clear_unfinished: true,
      }),
    ),
    now: 3000,
  });
  const completed = await state.context(key, stateConfig, 3000);
  assert.equal(completed.conversation.topic, "正在处理的事");
  assert.equal(completed.conversation.unfinished, "");
  assert.equal(completed.conversation.preference, "偏好短消息");

  await state.updateTurn({
    conversationKey: key,
    config: stateConfig,
    review: normalizeConversationReview(
      review({
        topic: "",
        unfinished: "",
        preference: "",
        clear_topic: true,
        clear_preference: true,
      }),
    ),
    now: 4000,
  });
  const cleared = await state.context(key, stateConfig, 4000);
  assert.equal(cleared.conversation.topic, "");
  assert.equal(cleared.conversation.preference, "");
  const saved = await readFile(path.join(root, "data", "conversation-state.json"), "utf8");
  assert.doesNotMatch(saved, /绝不能进入共享状态/);
});

test("global emotion decays on read and concurrent updates merge from latest state", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const key = conversationStateKey(event());
  await state.updateTurn({
    conversationKey: key,
    config: stateConfig,
    review: normalizeConversationReview(review({ globalEmotion: {
      action: "excited",
      happiness: 0.1,
      energy: 0.1,
      interest: 0.1,
      calm: 0,
    } })),
    now: 1000,
  });
  const halfLife = 12 * 60 * 60 * 1000;
  const decayed = await state.context(key, stateConfig, 1000 + halfLife);
  assert.ok(decayed.global.scores.happiness < 0.59);
  assert.ok(decayed.global.scores.happiness > 0.5);
  assert.ok(decayed.conversation.emotionIntensity < 0.6);

  const left = normalizeConversationReview(review({
    globalEmotion: {
      action: "hurt",
      happiness: -0.05,
      energy: 0,
      interest: 0,
      calm: 0,
    },
  }));
  const right = normalizeConversationReview(review({
    globalEmotion: {
      action: "warm",
      happiness: 0.05,
      energy: 0,
      interest: 0,
      calm: 0,
    },
  }));
  await Promise.all([
    state.updateTurn({ conversationKey: key, config: stateConfig, review: left, now: 3000 }),
    state.updateTurn({ conversationKey: key, config: stateConfig, review: right, now: 3000 }),
  ]);
  const merged = await state.context(key, stateConfig, 3000);
  assert.ok(merged.global.scores.happiness >= 0.5);
  assert.ok(merged.global.scores.happiness <= 0.7);
});

test("conversation state enforces ttl, entry bounds, reset, and atomic files", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const config = {
    conversationState: {
      ttlHours: 1,
      globalEmotionTtlHours: 1,
      maxEntries: 20,
    },
  };
  for (let index = 0; index < 25; index += 1) {
    const key = conversationStateKey(
      event({
        conversationId: `private-${index}`,
        userId: String(index),
      }),
    );
    await state.updateTurn({
      conversationKey: key,
      config,
      review: normalizeConversationReview(review({ topic: `话题 ${index}` })),
      now: index,
    });
  }
  const bounded = JSON.parse(
    await readFile(path.join(root, "data", "conversation-state.json"), "utf8"),
  );
  assert.equal(Object.keys(bounded.conversations).length, 20);
  const files = await readdir(path.join(root, "data"));
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);

  const key = conversationStateKey(event({ conversationId: "clear-me", userId: "clear-me" }));
  await state.updateTurn({
    conversationKey: key,
    config,
    review: normalizeConversationReview(review()),
    now: 10,
  });
  assert.equal(await state.clearConversation(key), true);
  assert.equal((await state.context(key, config, 10)).conversation, null);
  await state.resetAll();
  assert.equal((await state.context(key, config, 10)).global, null);
});

test("trusted person identity shares safe profile across private and group while group ACL excludes private topics", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const config = {
    identityLinks: {},
    conversationState: {
      ttlHours: 72,
      globalEmotionTtlHours: 24,
      maxEntries: 200,
      topicTtlHours: 24,
      unfinishedTtlHours: 168,
      userEmotionTtlHours: 6,
      commonMemeTtlHours: 168,
      profileTtlHours: 720,
    },
  };
  const group = event({
    scope: "group",
    conversationId: "group-1",
    groupId: "group-1",
    userId: "10001",
  });
  const privateEvent = event({ conversationId: "private-10001", userId: "10001" });
  const otherGroupMember = event({
    scope: "group",
    conversationId: "group-1",
    groupId: "group-1",
    userId: "20002",
  });

  await state.updateTurn({
    conversationKey: conversationStateKey(group),
    event: group,
    config,
    review: normalizeConversationReview(
      review({ topic: "群里的攻略", unfinished: "周目还没打完" }),
      "周目还没打完",
    ),
    now: 1000,
  });
  await state.updateTurn({
    conversationKey: conversationStateKey(group),
    event: group,
    config,
    review: normalizeConversationReview(
      review({
        topic: "",
        unfinished: "",
        preference: "直接说就好",
        profile: {
          preference: "direct_tone",
          boundary: "nickname",
          relationship_signal: "boundary_set",
        },
      }),
      "我不喜欢你叫我宝宝",
    ),
    now: 2000,
  });
  await state.updateTurn({
    conversationKey: conversationStateKey(privateEvent),
    event: privateEvent,
    config,
    review: normalizeConversationReview(
      review({ topic: "私聊里才说的秘密", unfinished: "不要带到群里" }),
      "这是私聊",
    ),
    now: 3000,
  });
  await state.updateTurn({
    conversationKey: conversationStateKey(otherGroupMember),
    event: otherGroupMember,
    config,
    review: normalizeConversationReview(
      review({ topic: "另一个人的话题", unfinished: "" }),
      "另一个人的话题",
    ),
    now: 3000,
  });

  const groupView = await state.visibleContext(group, config, 4000);
  assert.equal(groupView.profile.preferences.includes("no_nickname"), true);
  assert.equal(groupView.profile.boundaries.includes("nickname"), true);
  assert.equal(
    groupView.contexts.some((item) => item.topic.includes("秘密")),
    false,
  );
  assert.equal(
    groupView.contexts.some((item) => item.topic.includes("另一个人")),
    false,
  );

  const privateView = await state.visibleContext(privateEvent, config, 4000);
  assert.equal(privateView.profile.preferences.includes("no_nickname"), true);
  assert.equal(privateView.contexts.some((item) => item.topic === "群里的攻略"), true);
  assert.equal(
    privateView.contexts.some((item) => item.topic === "私聊里才说的秘密"),
    true,
  );
  assert.equal(
    privateView.contexts.some((item) => item.topic === "另一个人的话题"),
    false,
  );
  assert.notEqual(
    conversationStateKey(group),
    conversationStateKey(otherGroupMember),
  );
  assert.equal(personStateKey(group, config), personStateKey(privateEvent, config));
  assert.notEqual(
    personStateKey(group, config),
    personStateKey(otherGroupMember, config),
  );
});

test("user emotion persists through unrelated chat, decays, weakens on topic change, and never mirrors into global mood", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const input = event();
  const key = conversationStateKey(input);
  const config = {
    conversationState: {
      ttlHours: 720,
      globalEmotionTtlHours: 24,
      maxEntries: 200,
      topicTtlHours: 24,
      unfinishedTtlHours: 168,
      userEmotionTtlHours: 6,
      commonMemeTtlHours: 168,
      profileTtlHours: 720,
    },
  };
  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(
      review({
        topic: "工作压力",
        user_emotion: { emotion: "sad", intensity: 0.8, clear: false },
        globalEmotion: {
          action: "hurt",
          happiness: -0.15,
          energy: -0.1,
          interest: 0,
          calm: -0.1,
        },
      }),
      "今天真的很难过",
    ),
    now: 1000,
  });
  const initial = await state.context(key, config, 1000);
  assert.equal(initial.conversation.userEmotion.emotion, "sad");
  assert.ok(initial.conversation.userEmotion.intensity >= 0.79);
  assert.ok(initial.global.scores.happiness >= 0.5);

  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(
      review({
        topic: "",
        unfinished: "",
        preference: "",
        user_emotion: { emotion: "neutral", intensity: 0, clear: false },
      }),
      "在吗",
    ),
    now: 1000 + 60 * 60 * 1000,
  });
  const persisted = await state.context(key, config, 1000 + 60 * 60 * 1000);
  assert.ok(persisted.conversation.userEmotion.intensity > 0.6);
  assert.ok(persisted.conversation.userEmotion.intensity < 0.8);

  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(
      review({
        topic: "换个轻松话题",
        user_emotion: { emotion: "neutral", intensity: 0, clear: false },
      }),
      "说点别的",
    ),
    now: 1000 + 2 * 60 * 60 * 1000,
  });
  const switched = await state.context(key, config, 1000 + 2 * 60 * 60 * 1000);
  assert.ok(switched.conversation.userEmotion.intensity < persisted.conversation.userEmotion.intensity);
  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(
      review({
        topic: "",
        user_emotion: { emotion: "neutral", intensity: 0, clear: true },
      }),
      "我已经好多了",
    ),
    now: 1000 + 3 * 60 * 60 * 1000,
  });
  assert.equal(
    (await state.context(key, config, 1000 + 3 * 60 * 60 * 1000)).conversation
      .userEmotion,
    null,
  );
});

test("unfinished items are structured, deduplicated, completable, bounded by their own ttl, and readable by flow", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const input = event();
  const key = conversationStateKey(input);
  const config = {
    conversationState: {
      ttlHours: 720,
      globalEmotionTtlHours: 24,
      maxEntries: 200,
      topicTtlHours: 24,
      unfinishedTtlHours: 1,
      userEmotionTtlHours: 6,
      commonMemeTtlHours: 168,
      profileTtlHours: 720,
    },
  };
  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(
      review({
        unfinished: "",
        unfinished_items: [
          { text: "一起确认周末安排", status: "open" },
          { text: "一起确认周末安排", status: "open" },
        ],
      }),
      "周末安排还没定",
    ),
    now: 1000,
  });
  const active = await state.unfinishedItems(key, config, 1000);
  assert.equal(active.length, 1);
  assert.equal(active[0].status, "open");
  assert.ok(active[0].createdAt > 0);
  assert.ok(active[0].expiresAt > active[0].createdAt);

  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(
      review({
        unfinished: "",
        unfinished_items: [
          { text: "一起确认周末安排", status: "done" },
        ],
      }),
      "周末安排已经定了",
    ),
    now: 2000,
  });
  assert.equal((await state.unfinishedItems(key, config, 2000)).length, 0);
  const history = await state.unfinishedItems(key, config, 2000, {
    includeCompleted: true,
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "done");
  assert.ok(history[0].completedAt > 0);

  const expired = await state.context(key, config, 2000 + 2 * 60 * 60 * 1000);
  assert.ok(expired.conversation);
  assert.equal(expired.conversation.unfinishedHistory.length, 0);
});

test("common memes require current user evidence and only expose after a second-context confirmation", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const input = event();
  const key = conversationStateKey(input);
  const config = {
    conversationState: {
      ttlHours: 720,
      globalEmotionTtlHours: 24,
      maxEntries: 200,
      topicTtlHours: 24,
      unfinishedTtlHours: 168,
      userEmotionTtlHours: 6,
      commonMemeTtlHours: 2,
      profileTtlHours: 720,
    },
  };
  const noEvidence = normalizeConversationReview(
    review({
      common_meme: { text: "假装存在的梗", kind: "mention", clear: false },
    }),
    "",
  );
  assert.equal(noEvidence.commonMeme, null);

  const first = normalizeConversationReview(
    review({
      topic: "橘子汽水",
      common_meme: { text: "橘子汽水", kind: "mention", clear: false },
    }),
    "你又提橘子汽水了",
  );
  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: first,
    now: 1000,
  });
  assert.equal(
    (await state.context(key, config, 1000)).conversation.commonMemes.length,
    0,
  );

  const second = normalizeConversationReview(
    review({
      topic: "",
      common_meme: { text: "橘子汽水", kind: "confirm", clear: false },
    }),
    "橘子汽水这个梗还继续吗",
  );
  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: second,
    now: 2000,
  });
  const confirmed = await state.context(key, config, 2000);
  assert.equal(confirmed.conversation.commonMemes.length, 1);
  assert.equal(confirmed.conversation.commonMemes[0].status, "confirmed");
  assert.equal(
    (await state.context(key, config, 2000 + 3 * 60 * 60 * 1000)).conversation
      .commonMemes.length,
    0,
  );
});

test("relationship changes by distinct interaction and explicit boundaries, not message count, and profile storage is bounded", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const config = {
    conversationState: {
      ttlHours: 720,
      globalEmotionTtlHours: 24,
      maxEntries: 20,
      topicTtlHours: 24,
      unfinishedTtlHours: 168,
      userEmotionTtlHours: 6,
      commonMemeTtlHours: 168,
      profileTtlHours: 720,
    },
  };
  const input = event();
  const key = conversationStateKey(input);
  const neutral = normalizeConversationReview(review(), "普通消息");
  for (let index = 0; index < 6; index += 1) {
    await state.updateTurn({
      conversationKey: key,
      event: input,
      config,
      review: neutral,
      now: 1000 + index,
    });
  }
  const sameDay = await state.visibleContext(input, config, 1000);
  assert.equal(sameDay.profile.relationship.level, 0.02);

  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(review(), "我不喜欢你叫我宝宝"),
    now: 24 * 60 * 60 * 1000,
  });
  const nextDay = await state.visibleContext(input, config, 24 * 60 * 60 * 1000);
  assert.equal(nextDay.profile.relationship.level, 0.04);
  assert.equal(nextDay.profile.preferences.includes("no_nickname"), true);
  assert.equal(nextDay.profile.boundaries.includes("nickname"), true);

  for (let index = 0; index < 25; index += 1) {
    const other = event({
      conversationId: `bounded-${index}`,
      userId: String(100000 + index),
    });
    await state.updateTurn({
      conversationKey: conversationStateKey(other),
      event: other,
      config,
      review: normalizeConversationReview(review(), "普通消息"),
      now: 24 * 60 * 60 * 1000 + index,
    });
  }
  const saved = JSON.parse(
    await readFile(path.join(root, "data", "conversation-state.json"), "utf8"),
  );
  assert.ok(Object.keys(saved.profiles).length <= 20);
  assert.ok(Object.keys(saved.conversations).length <= 20);
});

test("explicit nickname and joke boundaries persist locally even when AI review fails", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const config = {
    identityLinks: {},
    conversationState: {
      ttlHours: 72,
      globalEmotionTtlHours: 24,
      maxEntries: 200,
      topicTtlHours: 24,
      unfinishedTtlHours: 168,
      userEmotionTtlHours: 6,
      commonMemeTtlHours: 168,
      profileTtlHours: 720,
    },
  };
  const group = event({
    scope: "group",
    conversationId: "group-review-failure",
    groupId: "group-review-failure",
    userId: "10001",
  });
  const privateEvent = event({
    conversationId: "private-review-failure",
    userId: "10001",
  });
  await state.updateTurn({
    conversationKey: conversationStateKey(group),
    event: group,
    config,
    review: null,
    styleFlags: buildStyleFlags([], "嗯。", {
      silenceAllowed: false,
    }),
    now: 1000,
  });
  await state.updateTurn({
    conversationKey: conversationStateKey(group),
    event: {
      ...group,
      text: "以后别叫我宝宝，也别开这个玩笑",
      channel: group.channel,
      scope: group.scope,
      conversationId: group.conversationId,
      groupId: group.groupId,
      userId: group.userId,
    },
    config,
    review: null,
    styleFlags: buildStyleFlags([], "", { silenceAllowed: false }),
    now: 2000,
  });

  const groupView = await state.visibleContext(group, config, 2000);
  assert.equal(groupView.profile.boundaries.includes("nickname"), true);
  assert.equal(groupView.profile.preferences.includes("no_nickname"), true);
  const privateView = await state.visibleContext(privateEvent, config, 2000);
  assert.equal(privateView.profile.boundaries.includes("nickname"), true);
  assert.equal(privateView.profile.preferences.includes("no_teasing"), true);
});

test("cross-turn style metrics persist only aggregate numbers and booleans", async (t) => {
  const root = await temporaryDirectory(t);
  const state = await new ConversationState({ root }).init();
  const input = event();
  const key = conversationStateKey(input);
  const config = stateConfig;
  const history = [
    { role: "assistant", content: "最近完整回复原文甲？" },
    { role: "assistant", content: "最近完整回复原文乙？" },
  ];
  const flags = buildStyleFlags(history, "最近完整回复原文乙？", {
    recentStickerRepeat: true,
    stickerSent: true,
    silenceAllowed: false,
  });
  await state.updateTurn({
    conversationKey: key,
    event: input,
    config,
    review: normalizeConversationReview(review({ topic: "" })),
    styleFlags: flags,
    now: 1000,
  });
  const context = await state.context(key, config, 1000);
  assert.equal(context.conversation.styleMetrics.consecutive_questions, 2);
  assert.equal(context.conversation.styleMetrics.repeated_opening, true);
  assert.ok(context.conversation.styleMetrics.draft_similarity > 0.8);
  const saved = await readFile(path.join(root, "data", "conversation-state.json"), "utf8");
  assert.doesNotMatch(saved, /最近完整回复原文/);
});
