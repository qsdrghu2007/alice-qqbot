import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSearchText,
  rankMatches,
  searchScore,
  searchTerms,
} from "../src/search.js";

test("search normalization and terms handle Chinese and English", () => {
  assert.equal(normalizeSearchText("  猫猫，名字！ "), "猫猫 名字");
  assert.equal(normalizeSearchText("  Hello   WORLD "), "hello world");
  const terms = searchTerms("猫猫名字");
  assert.ok(terms.includes("猫猫名字"));
  assert.ok(terms.includes("猫猫"));
  assert.ok(terms.includes("猫名"));
  assert.ok(terms.includes("名字"));
});

test("search scoring prefers exact and longer matches", () => {
  const terms = searchTerms("猫猫名字");
  assert.ok(searchScore("用户养的猫猫名字叫咪咪", terms) > 0);
  assert.equal(searchScore("今天天气不错", terms), 0);
  assert.ok(
    searchScore("猫猫名字", terms) > searchScore("猫猫", terms),
  );
});

test("rankMatches orders by score and supports a custom tie break", () => {
  const records = [
    { text: "用户喜欢猫", importance: 3 },
    { text: "用户养的猫叫咪咪", importance: 8 },
    { text: "用户喜欢狗", importance: 9 },
  ];
  const ranked = rankMatches(records, "猫 咪咪", {
    limit: 2,
    compare: (left, right) => right.importance - left.importance,
  });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].text, "用户养的猫叫咪咪");
  assert.equal(ranked[1].text, "用户喜欢猫");
  assert.deepEqual(rankMatches(records, "不存在", { limit: 2 }), []);
});
