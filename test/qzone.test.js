import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { QzonePublisher } from '../src/qzone.js';

const roots = [];

async function createRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'qqbot-qzone-'));
  roots.push(root);
  return root;
}

async function readOutbox(root) {
  return JSON.parse(await readFile(path.join(root, 'data', 'qzone-outbox.json'), 'utf8'));
}

function makeConfig(overrides = {}) {
  return {
    qzone: {
      enabled: true,
      autoPublish: true,
      headless: false,
      ugc_right: 1,
      ...(overrides.qzone ?? {}),
    },
    policy: {
      autoActions: true,
      paused: false,
      maxActionsPerHour: 6,
      ...(overrides.policy ?? {}),
    },
  };
}

function onebotWith(handler) {
  return {
    calls: [],
    async call(action, params) {
      this.calls.push({ action, params });
      return handler(action, params);
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('disabled policy persists the complete draft before blocking', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'unexpected' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig({ qzone: { enabled: false } }),
    onebot,
  });

  const result = await publisher.publish('今天的草稿');
  const stored = await readOutbox(root);

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'qzone_disabled');
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].text, '今天的草稿');
  assert.equal(stored.items[0].state, 'blocked');
  assert.equal(onebot.calls.length, 0);
});

test('demo mode blocks publishing and never dispatches to NapCat', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'unexpected' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => ({ ...makeConfig(), demo: true }),
    onebot,
  });

  const result = await publisher.publish('演示模式不应发布');
  const stored = await readOutbox(root);

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'demo_mode');
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].state, 'blocked');
  assert.equal(onebot.calls.length, 0);
});

test('NapCat action is called with the confirmed payload and tid confirms success', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({
    status: 'ok',
    retcode: 0,
    data: { tid: 'tid-123' },
  }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.publish('NapCat 原生发布');
  const stored = await readOutbox(root);

  assert.equal(result.status, 'sent');
  assert.equal(result.providerId, 'tid-123');
  assert.equal(onebot.calls.length, 1);
  assert.equal(onebot.calls[0].action, 'send_qzone_msg');
  assert.deepEqual(onebot.calls[0].params, {
    content: 'NapCat 原生发布',
    images: [],
    ugc_right: 1,
    target_uins: [],
  });
  assert.equal(stored.items[0].state, 'sent');
  assert.equal(stored.items[0].evidence, 'tid');
});

test('onSent runs only for a confirmed successful publish', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'tid-hook' } }));
  let sent = 0;
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
    onSent: async () => {
      sent += 1;
    },
  });

  assert.equal((await publisher.publish('联动测试')).status, 'sent');
  assert.equal(sent, 1);
  assert.equal((await publisher.publish('联动测试')).status, 'duplicate');
  assert.equal(sent, 1);

  const failingRoot = await createRoot();
  const failing = new QzonePublisher({
    root: failingRoot,
    getConfig: () => makeConfig(),
    onebot: onebotWith(async () => {
      throw new Error('network down');
    }),
    onSent: async () => {
      sent += 1;
    },
  });
  assert.notEqual((await failing.publish('失败测试')).status, 'sent');
  assert.equal(sent, 1);
});

test('publication defaults to friends and requires explicit 1 for public visibility', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'tid-friends' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => ({
      qzone: { enabled: true, autoPublish: true, headless: false },
      policy: { autoActions: true, paused: false, maxActionsPerHour: 6 },
    }),
    onebot,
  });

  assert.equal((await publisher.publish('好友可见')).status, 'sent');
  assert.equal(onebot.calls[0].params.ugc_right, 4);

  assert.equal(
    (await publisher.publish('明确公开', { ugc_right: 1 })).status,
    'sent',
  );
  assert.equal(onebot.calls[1].params.ugc_right, 1);
});

test('only HTTPS image URLs are forwarded; local files and file URLs are rejected', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'tid-image' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.publish('图文动态', {
    images: ['https://example.com/a.png'],
  });
  assert.equal(result.status, 'sent');
  assert.deepEqual(onebot.calls[0].params.images, ['https://example.com/a.png']);

  const local = await publisher.publish('本地图片', {
    images: ['file:///tmp/a.png'],
  });
  assert.equal(local.status, 'failed');
  assert.equal(local.reason, 'invalid_publish_input');
  assert.equal(onebot.calls.length, 1);
});

test('an unconfirmed result becomes unknown and blocks automatic repeat', async () => {
  const root = await createRoot();
  let sendCalls = 0;
  const onebot = onebotWith(async () => {
    sendCalls += 1;
    const error = new Error('socket hang up');
    error.dispatched = true;
    throw error;
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const first = await publisher.publish('结果可能已经提交');
  const second = await publisher.publish('结果可能已经提交');
  const stored = await readOutbox(root);

  assert.equal(first.status, 'unknown');
  assert.equal(first.retryAllowed, false);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.reason, 'idempotency_blocked');
  assert.equal(sendCalls, 1);
  assert.equal(stored.items[0].state, 'unknown');
  assert.equal(stored.items.length, 2);
});

test('a failure before dispatch may be retried but still creates a durable record', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => {
    const error = new Error('NapCat is offline');
    error.code = 'ONEBOT_API_ERROR';
    throw error;
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.publish('服务未启动');
  const stored = await readOutbox(root);

  assert.equal(result.status, 'failed');
  assert.equal(result.retryAllowed, true);
  assert.equal(stored.items[0].state, 'failed');
});

test('a disconnected OneBot preflight fails without writing a dispatch', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => {
    throw new Error('must not be called');
  });
  onebot.status = () => ({ connected: false });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.publish('连接尚未建立');
  const stored = await readOutbox(root);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'onebot_disconnected');
  assert.equal(onebot.calls.length, 0);
  assert.equal(stored.items[0].dispatchAt, undefined);
});

test('an OneBot timeout after dispatch is unknown and cannot auto retry', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => {
    const error = new Error('OneBot timed out');
    error.code = 'ONEBOT_API_TIMEOUT';
    throw error;
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.publish('超时可能已发布');
  assert.equal(result.status, 'unknown');
  assert.equal(result.retryAllowed, false);
});

test('a pause discovered after the sending checkpoint prevents dispatch', async () => {
  const root = await createRoot();
  let configReads = 0;
  const onebot = onebotWith(async () => ({ data: { tid: 'must-not-send' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => {
      configReads += 1;
      return makeConfig({
        policy: { paused: configReads >= 2 },
      });
    },
    onebot,
  });

  const result = await publisher.publish('即将暂停');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'policy_paused');
  assert.equal(onebot.calls.length, 0);
  const stored = await readOutbox(root);
  assert.equal(stored.items[0].dispatchAt, undefined);
});

test('failed dispatch attempts still count toward the hourly limit', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => {
    const error = new Error('NapCat rejected the action');
    error.code = 'ONEBOT_API_ERROR';
    throw error;
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig({ policy: { maxActionsPerHour: 1 } }),
    onebot,
  });

  assert.equal((await publisher.publish('失败一')).status, 'failed');
  const second = await publisher.publish('失败二');
  assert.equal(second.status, 'blocked');
  assert.equal(second.reason, 'rate_limited');
});

test('successful identical text is never published twice', async () => {
  const root = await createRoot();
  let sendCalls = 0;
  const onebot = onebotWith(async () => {
    sendCalls += 1;
    return { data: { tid: 'tid-once' } };
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  assert.equal((await publisher.publish('完全相同')).status, 'sent');
  assert.equal((await publisher.publish('完全相同')).status, 'duplicate');
  assert.equal(sendCalls, 1);
});

test('a retained backup still blocks duplicate text when the main file is missing', async () => {
  const root = await createRoot();
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'qzone-outbox.json.1.2.bak'),
    JSON.stringify({
      version: 1,
      items: [
        {
          id: 'prior',
          fingerprint: '备份中的正文',
          text: '备份中的正文',
          state: 'sent',
          providerId: 'tid-prior',
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  let sendCalls = 0;
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot: onebotWith(async () => {
      sendCalls += 1;
      return { data: { tid: 'must-not-send' } };
    }),
  });

  const result = await publisher.publish('备份中的正文');
  assert.equal(result.status, 'duplicate');
  assert.equal(result.blockingRecordId, 'prior');
  assert.equal(sendCalls, 0);
});

test('concurrent identical calls are serialized and only one is dispatched', async () => {
  const root = await createRoot();
  let sendCalls = 0;
  const onebot = onebotWith(async () => {
    sendCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { data: { tid: 'tid-concurrent' } };
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const [first, second] = await Promise.all([
    publisher.publish('并发同文'),
    publisher.publish('并发同文'),
  ]);
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'duplicate');
  assert.equal(sendCalls, 1);
});

test('stop immediately marks the publisher stopped and cancels queued work', async () => {
  const root = await createRoot();
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const onebot = onebotWith(async (_action, params) => {
    if (params.content === '第一项') {
      await firstGate;
    }
    return { data: { tid: `tid-${params.content}` } };
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const first = publisher.publish('第一项');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = publisher.publish('第二项');
  const stopping = publisher.stop();
  assert.equal(publisher.stopped, true);
  releaseFirst();

  assert.equal((await first).status, 'sent');
  assert.equal((await second).status, 'failed');
  assert.equal((await second).reason, 'publisher_stopped');
  await stopping;
  assert.equal(onebot.calls.length, 1);
});

test('hourly dispatches are limited across different texts', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'tid-rate' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig({ policy: { maxActionsPerHour: 1 } }),
    onebot,
  });

  assert.equal((await publisher.publish('第一条')).status, 'sent');
  const second = await publisher.publish('第二条');
  assert.equal(second.status, 'blocked');
  assert.equal(second.reason, 'rate_limited');
});

test('a zero hourly limit blocks every dispatch', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'not-called' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig({ policy: { maxActionsPerHour: 0 } }),
    onebot,
  });

  const result = await publisher.publish('不应发送');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'rate_limited');
  assert.equal(onebot.calls.length, 0);
});

test('an invalid configured visibility is rejected instead of becoming public', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'not-called' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig({ qzone: { ugc_right: 999 } }),
    onebot,
  });

  const result = await publisher.publish('不能误发公开');
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'invalid_ugc_right');
  assert.equal(onebot.calls.length, 0);
});

test('partial visibility requires target_uins', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'not-called' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.publish('部分好友可见', { ugc_right: 16 });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'target_uins_required');
  assert.equal(onebot.calls.length, 0);
});

test('malformed target_uins is rejected instead of falling back', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => ({ data: { tid: 'not-called' } }));
  const publisher = new QzonePublisher({
    root,
    getConfig: () =>
      makeConfig({
        qzone: { ugc_right: 16, target_uins: ['123456789'] },
      }),
    onebot,
  });

  const result = await publisher.publish('名单参数错误', {
    target_uins: '123456789',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'invalid_target_uins');
  assert.equal(onebot.calls.length, 0);
});

test('login returns manual NapCat guidance instead of creating a browser', async () => {
  const root = await createRoot();
  const onebot = onebotWith(async () => {
    throw new Error('not logged in');
  });
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot,
  });

  const result = await publisher.login();
  assert.equal(result.status, 'manual_action_required');
  assert.match(result.message, /NapCat WebUI/);
  assert.match(result.message, /扫码/);
  assert.equal(publisher.context, undefined);
});

test('status is redacted and advertises the supported QZone capabilities', async () => {
  const root = await createRoot();
  const publisher = new QzonePublisher({
    root,
    getConfig: () => makeConfig(),
    onebot: onebotWith(async () => ({ data: { tid: 'unused' } })),
  });

  const status = await publisher.status();
  assert.equal(status.transport, 'napcat-onebot');
  assert.equal(status.requirements.napcat, '>= 4.18.18');
  assert.equal(status.enabled, true);
  assert.deepEqual(status.policy, {
    autoActions: true,
    paused: false,
    maxActionsPerHour: 6,
  });
  assert.equal(status.capabilities.textPublish, true);
  assert.equal(status.capabilities.imageUrlPublish, true);
  assert.equal(status.capabilities.localFileUpload, false);
});
