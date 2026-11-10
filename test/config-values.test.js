// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bytesToMib,
  mibToBytes,
  resolveRuntimeCapabilities,
  resolveRuntimeModeInfo,
} from "../public/config-values.js";

test("sticker MiB UI uses a stable three-decimal value and byte boundary", async () => {
  assert.equal(mibToBytes(4), 4 * 1024 * 1024);
  assert.equal(mibToBytes(8), 8 * 1024 * 1024);
  assert.equal(bytesToMib(mibToBytes(0.001)), 0.001);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /id="stickerMaxFileSizeMib"[^>]+min="0\.001"[^>]+max="8"[^>]+step="0\.001"/u,
  );
});

test("runtime capability parsing defaults to full and follows basic mode", () => {
  assert.deepEqual(resolveRuntimeCapabilities(), {
    basicMode: false,
    space: true,
    stickers: true,
    proactivePrivateMessages: true,
    review: true,
    userUnderstanding: true,
    externalActions: true,
  });
  const basic = resolveRuntimeCapabilities({
    runtimeCapabilities: {
      basicMode: true,
      space: true,
      stickers: true,
      proactivePrivateMessages: true,
      review: true,
      userUnderstanding: true,
      externalActions: true,
    },
  });
  assert.deepEqual(basic, {
    basicMode: true,
    space: false,
    stickers: false,
    proactivePrivateMessages: false,
    review: false,
    userUnderstanding: false,
    externalActions: false,
  });
});

test("runtime mode info falls back to capabilities and preserves source", () => {
  assert.deepEqual(resolveRuntimeModeInfo(), { mode: "basic", source: "default" });
  assert.deepEqual(
    resolveRuntimeModeInfo({
      runtimeModeInfo: { mode: "full", source: "config" },
      runtimeCapabilities: { basicMode: false },
    }),
    { mode: "full", source: "config" },
  );
  assert.deepEqual(
    resolveRuntimeModeInfo({
      runtimeMode: { mode: "basic", source: "environment" },
      runtimeCapabilities: { basicMode: true },
    }),
    { mode: "basic", source: "environment" },
  );
  assert.deepEqual(
    resolveRuntimeModeInfo({ runtimeCapabilities: { basicMode: true } }),
    { mode: "basic", source: "runtime" },
  );
});

test("basic mode keeps settings editable while locking immediate external actions", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(
    app,
    /disableFor\("(?:space|stickers|proactivePrivateMessages)", \[\s*"#settings/gu,
  );
  assert.match(
    app,
    /setCapabilityRootDisabled\(\s*elements\.qzoneCommentsPollButton,\s*!capabilities\.externalActions,\s*\);/u,
  );
  assert.match(html, /设置可以保存，但[^<]+不会在当前模式执行/u);
  assert.match(html, /id="runtimeModeButton"/u);
  assert.match(app, /runtimeModeButton\.addEventListener\("click", toggleRuntimeMode\)/u);
});

test("import UI and server share the 10 MiB limit", async () => {
  const [server, app, readme] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(server, /const MAX_IMPORT_BYTES = 10 \* 1024 \* 1024;/u);
  assert.match(app, /导入文件不能超过 10 MiB。/u);
  assert.match(readme, /\| 导入请求体 \| 10 MiB \|/u);
});
