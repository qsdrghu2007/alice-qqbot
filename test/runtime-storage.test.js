// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Store } from "../src/store.js";

async function temporaryStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), "alice-runtime-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await new Store(root).init() };
}

test("concurrent history writes keep order, metadata, and persisted state", async (t) => {
  const { root, store } = await temporaryStore(t);
  const key = JSON.stringify(["private", "onebot", "10001"]);
  const writes = Array.from({ length: 90 }, (_, index) =>
    store.append(key, [
      {
        role: "user",
        content: `消息 ${index}`,
        speakerId: "10001",
        timestamp: `2026-11-10T00:00:${String(index % 60).padStart(2, "0")}Z`,
        groupId: "group-a",
        extra: { preserved: true },
      },
    ]),
  );

  await Promise.all(writes);
  const history = await store.history(key);
  assert.equal(history.length, 80);
  assert.equal(history[0].content, "消息 10");
  assert.equal(history.at(-1).content, "消息 89");
  assert.deepEqual(history.at(-1).extra, { preserved: true });
  assert.equal(history.at(-1).speakerId, "10001");
  assert.equal(history.at(-1).groupId, "group-a");
  assert.match(history.at(-1).timestamp, /^2026-11-10T/);

  const persisted = JSON.parse(
    await readFile(path.join(root, "data", "store.json"), "utf8"),
  );
  assert.equal(persisted.conversations[key].length, 80);
  assert.equal(persisted.conversations[key].at(-1).speakerId, "10001");
});

test("concurrent memory mutations remain isolated and durable", async (t) => {
  const { root, store } = await temporaryStore(t);
  const [first, second] = await Promise.all([
    store.remember("private-a", "用户喜欢猫", { importance: 6 }),
    store.remember("private-b", "用户喜欢狗", { importance: 7 }),
  ]);

  assert.equal((await store.memories("private-a"))[0].id, first.id);
  assert.equal((await store.memories("private-b"))[0].id, second.id);
  assert.equal(await store.forget("private-a", first.id), true);
  assert.equal(await store.forget("private-a", first.id), false);

  const reopened = await new Store(root).init();
  assert.equal((await reopened.memories("private-a")).length, 0);
  assert.equal((await reopened.memories("private-b"))[0].text, "用户喜欢狗");
});
