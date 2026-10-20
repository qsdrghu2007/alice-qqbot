const MAX_SEARCH_TERMS = 40;

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function searchTerms(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const terms = new Set();
  const add = (value) => {
    const term = normalizeSearchText(value);
    if (!term) return;
    if (!/[\u3400-\u9fff]/u.test(term) && Array.from(term).length < 2) return;
    terms.add(term);
  };

  add(normalized);
  for (const token of normalized.split(" ")) {
    add(token);
    if (!/[\u3400-\u9fff]/u.test(token) || Array.from(token).length < 2) continue;
    const chars = Array.from(token);
    for (let index = 0; index < chars.length - 1; index += 1) {
      add(chars[index] + chars[index + 1]);
    }
  }
  return [...terms].slice(0, MAX_SEARCH_TERMS);
}

export function searchScore(text, terms) {
  const normalized = normalizeSearchText(text);
  if (!normalized) return 0;
  let score = 0;
  for (const term of terms) {
    if (!normalized.includes(term)) continue;
    score += Math.min(8, Math.max(1, Array.from(term).length));
  }
  return score;
}

export function rankMatches(
  records,
  query,
  { limit = 10, textOf = (record) => record?.text, compare = null } = {},
) {
  const terms = searchTerms(query);
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
  if (!terms.length || !Array.isArray(records)) return [];

  const matches = [];
  records.forEach((record, index) => {
    const score = searchScore(textOf(record), terms);
    if (score > 0) matches.push({ record, score, index });
  });

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (typeof compare === "function") {
      const order = compare(left.record, right.record);
      if (order) return order;
    }
    return right.index - left.index;
  });

  return matches.slice(0, boundedLimit).map((match) => match.record);
}
