import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUTBOX_FILE = path.join('data', 'qzone-outbox.json');
const ACTIVE_STATES = new Set(['sending', 'unknown', 'sent']);
const VALID_UGC_RIGHTS = new Set([1, 4, 16, 64, 128]);

function normalizeForComparison(value) {
  return String(value ?? '')
    .replaceAll('\u200b', '')
    .replaceAll('\r\n', '\n')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new TypeError('QQ空间正文必须是字符串');
  }
  const text = value.replaceAll('\r\n', '\n').trim();
  if (!text) {
    throw new TypeError('QQ空间正文不能为空');
  }
  return text;
}

function normalizeImages(images) {
  if (images === undefined || images === null) {
    return [];
  }
  if (!Array.isArray(images)) {
    throw new TypeError('QQ空间图片参数必须是 HTTPS URL 数组');
  }
  return images.map((value, index) => {
    if (typeof value !== 'string') {
      throw new TypeError(`第 ${index + 1} 张图片不是 URL`);
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError(`第 ${index + 1} 张图片不是有效 URL`);
    }
    if (url.protocol !== 'https:') {
      throw new TypeError('QQ空间图片只允许 HTTPS URL；本项目不读取本地文件');
    }
    return url.toString();
  });
}

function mergeConfig(raw = {}) {
  const qzone = {
    enabled: false,
    autoPublish: false,
    headless: false,
    ...(raw.qzone ?? {}),
  };
  const policy = {
    autoActions: true,
    paused: false,
    maxActionsPerHour: 6,
    ...(raw.policy ?? {}),
  };
  const demo = raw.demo === true;
  const maxActionsPerHour = Number(policy.maxActionsPerHour);
  const configuredUgcRight = qzone.ugc_right ?? qzone.ugcRight;
  const ugcRight =
    configuredUgcRight === undefined || configuredUgcRight === null
      ? 4
      : Number(configuredUgcRight);
  return {
    demo,
    qzone: {
      ...qzone,
      ugc_right: ugcRight,
      target_uins: Array.isArray(qzone.target_uins)
        ? qzone.target_uins.map(String)
        : Array.isArray(qzone.targetUins)
          ? qzone.targetUins.map(String)
          : [],
    },
    policy: {
      ...policy,
      maxActionsPerHour:
        Number.isFinite(maxActionsPerHour) && maxActionsPerHour >= 0
          ? Math.floor(maxActionsPerHour)
          : 6,
    },
  };
}

function policyBlockReason(config) {
  if (!config.qzone.enabled) {
    return 'qzone_disabled';
  }
  if (config.demo) {
    return 'demo_mode';
  }
  if (!config.policy.autoActions) {
    return 'auto_actions_disabled';
  }
  if (config.policy.paused) {
    return 'policy_paused';
  }
  if (!config.qzone.autoPublish) {
    return 'auto_publish_disabled';
  }
  return null;
}

function findIdempotencyBlocker(items, fingerprint) {
  return (
    items.find(
      (item) => item?.fingerprint === fingerprint && ACTIVE_STATES.has(item.state),
    ) ?? null
  );
}

function countRecentDispatches(items, now, windowMs) {
  const cutoff = now - windowMs;
  return items.filter((item) => {
    const at = Date.parse(item?.dispatchAt ?? '');
    return Number.isFinite(at) && at >= cutoff;
  }).length;
}

function normalizeTargetUins(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('target_uins 必须是 QQ 号数组');
  }
  return value.map((uin, index) => {
    const normalized = String(uin ?? '').trim();
    if (!/^\d{5,20}$/u.test(normalized)) {
      throw new TypeError(`target_uins 第 ${index + 1} 项不是有效 QQ 号`);
    }
    return normalized;
  });
}

function isAmbiguousDispatchFailure(error) {
  if (error?.dispatched === true) {
    return true;
  }
  if (error?.dispatched === false) {
    return false;
  }
  return (
    !error?.code ||
    new Set([
      'ONEBOT_API_TIMEOUT',
      'ONEBOT_DISCONNECTED',
      'ONEBOT_SEND_FAILED',
      'ECONNRESET',
      'EPIPE',
    ]).has(String(error.code))
  );
}

function redactRecord(record) {
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    state: record.state,
    reason: record.reason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dispatchAt: record.dispatchAt,
    providerId: record.providerId,
    evidence: record.evidence,
  };
}

class QzoneOperationError extends Error {
  constructor(code, message, { dispatched = false } = {}) {
    super(message);
    this.name = 'QzoneOperationError';
    this.code = code;
    this.dispatched = dispatched;
  }
}

export class QzonePublisher {
  constructor({ root, getConfig, logger = console, onebot, onSent } = {}) {
    if (!root) {
      throw new TypeError('QzonePublisher 需要 root');
    }
    if (typeof getConfig !== 'function') {
      throw new TypeError('QzonePublisher 需要 getConfig');
    }
    if (!onebot || typeof onebot.call !== 'function') {
      throw new TypeError('QzonePublisher 需要带 call(action, params) 的 onebot 适配器');
    }
    this.root = root;
    this.getConfig = getConfig;
    this.logger = logger;
    this.onebot = onebot;
    this.onSent = typeof onSent === 'function' ? onSent : null;
    this.outboxPath = path.join(root, OUTBOX_FILE);
    this.queue = Promise.resolve();
    this.lastRecord = null;
    this.stopped = false;
  }

  async login() {
    if (this.stopped) {
      return {
        status: 'stopped',
        message: 'QQ空间发布模块已停止；重新创建实例后可探测 NapCat 登录态。',
      };
    }
    try {
      const response = await this.onebot.call('get_login_info', {});
      const data = response?.data ?? response;
      const userText = data?.user_id ?? data?.uin ?? data?.nickname;
      return {
        status: 'ready',
        message: 'NapCat 已登录，QQ空间发布可调用 send_qzone_msg。',
        accountConfigured: userText !== undefined && userText !== null && String(userText) !== '',
      };
    } catch (error) {
      return {
        status: 'manual_action_required',
        reason: error?.code ?? 'napcat_login_unconfirmed',
        message:
          '未能确认 NapCat 登录态。请打开 NapCat WebUI，按页面指引扫码登录 QQ；本程序不读取 Cookie、不伪造签名，也不处理验证码。',
        detail: String(error?.message ?? error).slice(0, 300),
      };
    }
  }

  async publish(text, options = {}) {
    return this.#enqueue(() => this.#publishNow(text, options));
  }

  async status() {
    let config = null;
    let configError = null;
    try {
      config = await this.#readConfig();
    } catch (error) {
      configError = String(error?.message ?? error);
    }
    let items = [];
    let outboxError = null;
    try {
      items = await this.#loadOutbox();
    } catch (error) {
      outboxError = String(error?.message ?? error);
    }
    return {
      stopped: this.stopped,
      enabled: config?.qzone.enabled ?? false,
      autoPublish: config?.qzone.autoPublish ?? false,
      policy: config
        ? {
            autoActions: config.policy.autoActions,
            paused: config.policy.paused,
            maxActionsPerHour: config.policy.maxActionsPerHour,
          }
        : null,
      configError,
      transport: 'napcat-onebot',
      action: 'send_qzone_msg',
      requirements: {
        napcat: '>= 4.18.18',
        onebotCall: true,
      },
      capabilities: {
        textPublish: true,
        imageUrlPublish: true,
        localFileUpload: false,
      },
      outbox: {
        path: this.outboxPath,
        records: items.length,
        unknown: items.filter((item) => item?.state === 'unknown').length,
        error: outboxError,
      },
      last: redactRecord(this.lastRecord ?? items.at(-1)),
    };
  }

  async stop() {
    this.stopped = true;
    await this.queue.catch(() => {});
    return { status: 'stopped' };
  }

  async #publishNow(text, options) {
    let normalized;
    let images;
    try {
      normalized = normalizeText(text);
      images = normalizeImages(options?.images);
    } catch (error) {
      return {
        status: 'failed',
        reason: 'invalid_publish_input',
        message: error.message,
        retryAllowed: true,
      };
    }
    if (this.stopped) {
      return {
        status: 'failed',
        reason: 'publisher_stopped',
        message: 'QQ空间发布模块已停止。',
        retryAllowed: false,
      };
    }

    let config;
    try {
      config = await this.#readConfig();
    } catch (error) {
      return {
        status: 'failed',
        reason: error?.code ?? 'config_unavailable',
        message: error?.message ?? String(error),
        retryAllowed: true,
      };
    }

    const fingerprint = normalizeForComparison(normalized);
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      fingerprint,
      text: normalized,
      images,
      state: 'draft',
      createdAt: now,
      updatedAt: now,
    };

    let items;
    try {
      items = await this.#loadOutbox();
      items.push(record);
      await this.#saveOutbox(items);
      this.lastRecord = record;
    } catch (error) {
      return {
        status: 'failed',
        reason: 'outbox_unavailable',
        message: `无法持久化 QQ 空间草稿，已停止发布：${error.message}`,
        recordId: record.id,
        retryAllowed: false,
      };
    }

    const duplicate = findIdempotencyBlocker(items.slice(0, -1), fingerprint);
    if (duplicate) {
      return this.#finish(record, 'duplicate', {
        reason: 'idempotency_blocked',
        message: '相同正文已有发送中、成功或结果不明的记录，禁止自动重复发布。',
        blockingRecordId: duplicate.id,
      });
    }

    const blocked = policyBlockReason(config);
    if (blocked) {
      return this.#finish(record, 'blocked', {
        reason: blocked,
        message: '当前配置未允许空间发布；手动与模型发布共用此授权，草稿已保存。',
      });
    }

    const recentDispatches = countRecentDispatches(
      items.slice(0, -1),
      Date.now(),
      60 * 60 * 1000,
    );
    if (recentDispatches >= config.policy.maxActionsPerHour) {
      return this.#finish(record, 'blocked', {
        reason: 'rate_limited',
        message: `过去一小时已尝试 ${recentDispatches} 次，达到上限 ${config.policy.maxActionsPerHour}。`,
      });
    }

    const ugcRight = Number(options?.ugc_right ?? options?.ugcRight ?? config.qzone.ugc_right);
    if (!VALID_UGC_RIGHTS.has(ugcRight)) {
      return this.#finish(record, 'failed', {
        reason: 'invalid_ugc_right',
        message: 'QQ空间可见范围必须是 1、4、16、64 或 128。',
      });
    }
    let targetUins;
    try {
      targetUins = normalizeTargetUins(
        options?.target_uins ?? options?.targetUins ?? config.qzone.target_uins,
      );
    } catch (error) {
      return this.#finish(record, 'failed', {
        reason: 'invalid_target_uins',
        message: error.message,
      });
    }
    if ((ugcRight === 16 || ugcRight === 128) && targetUins.length === 0) {
      return this.#finish(record, 'failed', {
        reason: 'target_uins_required',
        message: '可见范围为 16 或 128 时必须提供 target_uins。',
      });
    }

    record.state = 'sending';
    record.ugc_right = ugcRight;
    record.target_uins = targetUins;
    await this.#updateRecord(record);

    let latestConfig;
    try {
      latestConfig = await this.#readConfig();
    } catch (error) {
      return this.#finish(record, 'failed', {
        reason: error?.code ?? 'config_unavailable',
        message: `发送前重新读取配置失败，已停止：${error?.message ?? error}`,
      });
    }
    const latestBlock = policyBlockReason(latestConfig);
    if (this.stopped || latestBlock) {
      return this.#finish(record, 'blocked', {
        reason: this.stopped ? 'publisher_stopped' : latestBlock,
        message: '发送前检查发现发布已停止或策略已暂停；草稿已保存，尚未调用 OneBot。',
      });
    }

    if (typeof this.onebot.status === 'function') {
      let connection;
      try {
        connection = await this.onebot.status();
      } catch {}
      if (connection && connection.connected === false) {
        return this.#finish(record, 'failed', {
          reason: 'onebot_disconnected',
          message: 'OneBot 当前未连接 NapCat，尚未发送；请连接后重试。',
        });
      }
    }

    record.dispatchAt = new Date().toISOString();
    await this.#updateRecord(record);

    try {
      const response = await this.onebot.call('send_qzone_msg', {
        content: normalized,
        images,
        ugc_right: ugcRight,
        target_uins: targetUins,
      });
      const data = response?.data ?? response;
      const tid = data?.tid;
      if (typeof tid !== 'string' || !tid.trim()) {
        throw new QzoneOperationError(
          'missing_tid',
          'send_qzone_msg 没有返回 tid，无法确认发布成功。',
          { dispatched: true },
        );
      }
      return this.#finish(record, 'sent', {
        reason: null,
        message: 'NapCat 返回说说 tid，QQ空间发布成功。',
        providerId: tid.trim(),
        evidence: 'tid',
      });
    } catch (error) {
      const state = isAmbiguousDispatchFailure(error) ? 'unknown' : 'failed';
      return this.#finish(record, state, {
        reason: error?.code ?? 'napcat_publish_failed',
        message:
          state === 'unknown'
            ? `请求已发送但无法确认发布结果，已停止自动重试：${error?.message ?? error}`
            : `NapCat 发布失败：${error?.message ?? error}`,
      });
    }
  }

  #enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async #readConfig() {
    try {
      return mergeConfig((await this.getConfig()) ?? {});
    } catch (error) {
      throw new QzoneOperationError(
        'config_unavailable',
        `读取 QQ 空间配置失败：${error?.message ?? error}`,
      );
    }
  }

  async #loadOutbox() {
    try {
      const source = await readFile(this.outboxPath, 'utf8');
      return parseOutbox(source);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return this.#loadOutboxBackup();
      }
      if (error instanceof SyntaxError) {
        throw new Error(`发布记录 JSON 已损坏：${error.message}`);
      }
      throw error;
    }
  }

  async #loadOutboxBackup() {
    const directory = path.dirname(this.outboxPath);
    const prefix = `${path.basename(this.outboxPath)}.`;
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const backups = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
      .sort()
      .reverse();
    if (backups.length === 0) {
      return [];
    }
    try {
      return parseOutbox(await readFile(path.join(directory, backups[0]), 'utf8'));
    } catch (error) {
      throw new Error(`发布记录主文件缺失，备份 ${backups[0]} 无法恢复：${error.message}`);
    }
  }

  async #saveOutbox(items) {
    await mkdir(path.dirname(this.outboxPath), { recursive: true });
    const temporary = `${this.outboxPath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify({ version: 1, items }, null, 2)}\n`;
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, this.outboxPath);
      return;
    } catch (originalError) {
      if (process.platform !== 'win32') {
        await rm(temporary, { force: true });
        throw originalError;
      }

      const backup = `${this.outboxPath}.${process.pid}.${Date.now()}.bak`;
      try {
        await rename(this.outboxPath, backup);
      } catch (backupError) {
        await rm(temporary, { force: true });
        if (backupError?.code === 'ENOENT') {
          throw originalError;
        }
        throw new Error(
          `无法锁定旧发布记录，未删除任何记录；请关闭占用文件的程序后重试：${backupError.message}`,
        );
      }

      try {
        await rename(temporary, this.outboxPath);
      } catch (installError) {
        try {
          await rename(backup, this.outboxPath);
        } catch (restoreError) {
          await rm(temporary, { force: true });
          throw new Error(
            `新发布记录写入失败，旧记录保留在 ${backup}，自动恢复失败：${restoreError.message}`,
          );
        }
        await rm(temporary, { force: true });
        throw new Error(`新发布记录写入失败，旧记录已恢复：${installError.message}`);
      }
      await rm(backup, { force: true }).catch(() => {});
    }
  }

  async #updateRecord(record) {
    const items = await this.#loadOutbox();
    const index = items.findIndex((item) => item?.id === record.id);
    record.updatedAt = new Date().toISOString();
    if (index === -1) {
      items.push(record);
    } else {
      items[index] = record;
    }
    await this.#saveOutbox(items);
    this.lastRecord = record;
  }

  async #finish(record, state, result) {
    record.state = state;
    record.reason = result.reason ?? null;
    record.message = result.message ?? null;
    record.providerId = result.providerId ?? null;
    record.evidence = result.evidence ?? null;
    await this.#updateRecord(record);
    if (state === 'sent' && this.onSent) {
      try {
        await this.onSent({ recordId: record.id, providerId: record.providerId });
      } catch (error) {
        this.logger?.warn?.('空间发布成功回调失败', error);
      }
    }
    return {
      status: state,
      reason: record.reason,
      message: result.message,
      recordId: record.id,
      blockingRecordId: result.blockingRecordId,
      providerId: record.providerId ?? undefined,
      evidence: record.evidence ?? undefined,
      retryAllowed: state === 'failed' || state === 'blocked',
    };
  }
}

function parseOutbox(source) {
  const parsed = JSON.parse(source);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed?.version === 1 && Array.isArray(parsed.items)) {
    return parsed.items;
  }
  throw new Error('发布记录结构无效');
}
