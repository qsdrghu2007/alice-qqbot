const QUESTION_END = /[?？]\s*$/u;

function normalizeForComparison(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function opening(value) {
  const normalized = normalizeForComparison(value);
  const commonOpening = normalized.match(/^(?:哈{2,}|嘿{2,}|呵{2,}|h{3,}|2{3,}|3{3,}|嗯{2,}|哦{2,})/u);
  if (commonOpening) return commonOpening[0][0];
  return Array.from(normalized).slice(0, 2).join("");
}

function bigrams(value) {
  const chars = Array.from(normalizeForComparison(value));
  if (chars.length < 2) return chars;
  return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
}

function similarity(left, right) {
  const leftItems = bigrams(left);
  const rightItems = bigrams(right);
  if (!leftItems.length || !rightItems.length) {
    return normalizeForComparison(left) === normalizeForComparison(right) ? 1 : 0;
  }
  const counts = new Map();
  for (const item of leftItems) counts.set(item, (counts.get(item) ?? 0) + 1);
  let overlap = 0;
  for (const item of rightItems) {
    const remaining = counts.get(item) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(item, remaining - 1);
    }
  }
  return (2 * overlap) / (leftItems.length + rightItems.length);
}

export function buildStyleFlags(
  history,
  draftText,
  {
    recentStickerRepeat = false,
    stickerSent = false,
    stickerRepeatSurfaced = false,
    silenceAllowed = false,
    maxAssistantMessages = 24,
  } = {},
) {
  const assistantReplies = (Array.isArray(history) ? history : [])
    .filter(
      (message) =>
        message?.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim(),
    )
    .slice(-Math.max(1, Math.min(50, maxAssistantMessages)))
    .map((message) => message.content.trim());

  let consecutiveQuestions = 0;
  for (let index = assistantReplies.length - 1; index >= 0; index -= 1) {
    if (!QUESTION_END.test(assistantReplies[index])) break;
    consecutiveQuestions += 1;
  }

  const draftOpening = opening(draftText);
  const recentOpenings = assistantReplies
    .slice(-5)
    .map((reply) => opening(reply))
    .filter(Boolean);
  const repeatedOpening =
    Boolean(draftOpening) &&
    recentOpenings.some((candidate) => candidate === draftOpening);

  const draftSimilarity = assistantReplies
    .slice(-8)
    .reduce(
      (maximum, reply) => Math.max(maximum, similarity(draftText, reply)),
      0,
    );

  return {
    consecutive_questions: consecutiveQuestions,
    repeated_opening: repeatedOpening,
    draft_similarity: Math.round(draftSimilarity * 100) / 100,
    recent_sticker_repeat: recentStickerRepeat === true,
    sticker_sent: stickerSent === true,
    sticker_repeat_surfaced: stickerRepeatSurfaced === true,
    silence_allowed: silenceAllowed === true,
  };
}

export function normalizeStyleFlags(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      consecutive_questions: 0,
      repeated_opening: false,
      draft_similarity: 0,
      recent_sticker_repeat: false,
      sticker_sent: false,
      sticker_repeat_surfaced: false,
      silence_allowed: false,
    };
  }
  const consecutive = Number(raw.consecutive_questions);
  const similarityValue = Number(raw.draft_similarity);
  return {
    consecutive_questions:
      Number.isInteger(consecutive) && consecutive >= 0
        ? Math.min(consecutive, 50)
        : 0,
    repeated_opening: raw.repeated_opening === true,
    draft_similarity:
      Number.isFinite(similarityValue) && similarityValue >= 0
        ? Math.min(similarityValue, 1)
        : 0,
    recent_sticker_repeat: raw.recent_sticker_repeat === true,
    sticker_sent: raw.sticker_sent === true,
    sticker_repeat_surfaced: raw.sticker_repeat_surfaced === true,
    silence_allowed: raw.silence_allowed === true,
  };
}
