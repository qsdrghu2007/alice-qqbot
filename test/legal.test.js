// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
import assert from "node:assert/strict";
import test from "node:test";

import {
  LegalConfigurationError,
  PROJECT_VERSION,
  resolveSourceUrl,
  sourceReply,
  validateSourceUrl,
} from "../src/legal.js";
import { Engine } from "../src/engine.js";
import { defaultConfig } from "../src/config.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageVersion = require("../package.json").version;

function configured(overrides = {}) {
  const config = structuredClone(defaultConfig);
  config.ai.apiKey = "test-key";
  config.demo = false;
  return {
    ...config,
    ...overrides,
    policy: { ...config.policy, ...(overrides.policy ?? {}) },
  };
}

function event(overrides = {}) {
  return {
    id: `legal-${Math.random()}`,
    channel: "onebot",
    scope: "private",
    userId: "10001",
    conversationId: "10001",
    text: "/source",
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("source URLs require a public absolute HTTPS host without credentials", () => {
  assert.equal(
    validateSourceUrl("https://github.com/example/project"),
    "https://github.com/example/project",
  );
  for (const invalid of [
    "javascript:alert(1)",
    "http://github.com/example/project",
    "https://user:pass@example.com/source",
    "https://localhost/source",
    "https://127.0.0.1/source",
    "https://[::1]/source",
    "https://192.168.1.10/source",
    "/local/source",
  ]) {
    assert.throws(() => validateSourceUrl(invalid), LegalConfigurationError);
  }
  assert.equal(
    resolveSourceUrl("https://code.example/alice", {}),
    "https://code.example/alice",
  );
});

test("source command reports the package version", () => {
  assert.equal(PROJECT_VERSION, packageVersion);
  assert.match(
    sourceReply("https://code.example/alice"),
    new RegExp(`Source code for Alice ${packageVersion.replaceAll(".", "\\.")}`),
  );
});

test("source and license commands obey ACL, work while paused, and never call AI", async () => {
  let aiCalls = 0;
  const engine = new Engine({
    getConfig: async () =>
      configured({
        policy: {
          paused: true,
          allowedUsers: ["10001"],
          allowedGroups: ["20002"],
        },
      }),
    store: {},
    services: {
      legalSourceUrl: "https://code.example/alice/tree/v0.4.0",
      chat: async () => {
        aiCalls += 1;
        throw new Error("AI must not be called");
      },
    },
  });

  const source = await engine.handle(event());
  assert.match(source.text, /https:\/\/code\.example\/alice\/tree\/v0\.4\.0/);
  assert.equal(source.transient, true);

  const license = await engine.handle(event({ id: "license-ok", text: "/license" }));
  assert.match(license.text, /Alice Noncommercial and Commercial Revenue-Sharing License/);
  assert.match(license.text, /at most 3 authorized users/);
  assert.match(license.text, /prior written consent/);
  assert.match(license.text, /No AGPL-3\.0 fallback/);
  assert.match(license.text, /License texts are included/);
  assert.match(license.text, /without warranty/);
  assert.match(license.text, /Source code: https:\/\/code\.example/);

  const help = await engine.handle(event({ id: "help-ok", text: "/help" }));
  assert.match(help.text, /\/source/);
  assert.match(help.text, /\/license/);

  const blocked = await engine.handle(
    event({ id: "blocked", userId: "10002", conversationId: "10002" }),
  );
  assert.equal(blocked.suppressed, true);
  assert.equal(aiCalls, 0);
});
