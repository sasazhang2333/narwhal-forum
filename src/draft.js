/**
 * 草稿与人审发布状态机（P0 的核心约束：AI 不能自行发布）。
 *
 * 状态机：
 *   pending_review --approve--> approved --publish(一次性 token)--> published
 *          |                          |
 *          +--reject--> rejected      +--(TTL 过期)--> expired
 *
 * 不变量：
 *  1. 批准只能在**人的终端**里发生（CLI 校验 TTY；MCP 不暴露 approve 工具）。
 *  2. 发布只接受 approvalToken，不接受 --yes / force 之类的开关。
 *  3. token 绑定 draftHash + action + userId + 过期时间，一次性使用（消费后置 usedAt）。
 *  4. 草稿在批准后若被改成另一个 hash，原 token 立即失效（防「批准 A 发布 B」）。
 *
 * 存储：<configDir>/drafts/<id>.json（0600），签名密钥 <configDir>/approval.key（0600，首次批准时生成）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';

export const DRAFT_STATUS = {
  PENDING: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PUBLISHED: 'published',
  EXPIRED: 'expired',
};

/** 批准后 token 的有效期：10 分钟（够人复核一遍内容，又不至于长期可重放）。 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export const DRAFT_KINDS = ['comment', 'post'];

function draftsDir() {
  return path.join(configDir(), 'drafts');
}

function draftFile(id) {
  if (!/^drf-[0-9a-f]{8}$/.test(String(id || ''))) {
    throw new DraftError('草稿 id 格式不对（应为 drf-xxxxxxxx）', { code: 'E_DRAFT_ID', id });
  }
  return path.join(draftsDir(), id + '.json');
}

export class DraftError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'DraftError';
    this.code = extra.code || 'E_DRAFT';
    this.draftId = extra.draftId;
    this.hint = extra.hint;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }
}

/** 稳定序列化：key 递归排序，保证同一内容永远是同一个 hash。 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** 内容指纹：只覆盖 kind + payload，批准后改一个字 hash 就变。 */
export function draftHash(kind, payload) {
  return crypto.createHash('sha256').update(canonical({ kind, payload })).digest('hex');
}

function writeDraft(record) {
  ensureDir(draftsDir());
  const file = draftFile(record.id);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return file;
}

export function newDraftId(random = crypto.randomBytes(4)) {
  return 'drf-' + random.toString('hex');
}

function nowIso(now) {
  return new Date(now || Date.now()).toISOString();
}

/** 新建草稿：只落本地，不碰后端。 */
export function createDraft(input = {}, opts = {}) {
  const kind = input.kind;
  if (!DRAFT_KINDS.includes(kind)) {
    throw new DraftError('草稿类型只能是 ' + DRAFT_KINDS.join(' / ') + '，收到 ' + kind, { code: 'E_DRAFT_KIND' });
  }
  const payload = input.payload || {};
  const author = input.author || {};
  const now = opts.now || Date.now();
  const record = {
    id: input.id || newDraftId(),
    kind,
    payload,
    hash: draftHash(kind, payload),
    status: DRAFT_STATUS.PENDING,
    author: { userId: author.userId ?? null, userName: author.userName ?? null },
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    baseUrl: input.baseUrl || null,
    review: null,
    approval: null,
    publish: null,
    history: [{ at: nowIso(now), event: 'created' }],
  };
  writeDraft(record);
  return record;
}

export function readDraft(id) {
  const file = draftFile(id);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new DraftError('找不到草稿 ' + id + '（可能在别的 NARWHAL_FORUM_HOME 下）', { code: 'E_DRAFT_NOT_FOUND', draftId: id });
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new DraftError('草稿文件损坏：' + file, { code: 'E_DRAFT_CORRUPT', draftId: id });
  }
  // 过期降级：approved 但 token 过期且从未用过 → expired（可见、不可发布）
  if (record.status === DRAFT_STATUS.APPROVED && record.approval && !record.approval.usedAt) {
    if (Date.parse(record.approval.expiresAt) < Date.now()) {
      record.status = DRAFT_STATUS.EXPIRED;
      record.updatedAt = nowIso();
      record.history = (record.history || []).concat([{ at: nowIso(), event: 'expired' }]);
      writeDraft(record);
    }
  }
  return record;
}

export function saveDraft(record) {
  record.updatedAt = nowIso();
  writeDraft(record);
  return record;
}

export function listDrafts(opts = {}) {
  let names = [];
  try {
    names = fs.readdirSync(draftsDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const record = readDraft(name.replace(/\.json$/, ''));
      if (opts.status && record.status !== opts.status) continue;
      out.push(record);
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function removeDraft(id) {
  const file = draftFile(id);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 新增/替换草稿内容（只允许在未批准时改；改后 hash 重算，旧 token 作废）。 */
export function updateDraftContent(id, payload, opts = {}) {
  const record = readDraft(id);
  if (record.status !== DRAFT_STATUS.PENDING && record.status !== DRAFT_STATUS.EXPIRED) {
    throw new DraftError('草稿当前状态是 ' + record.status + '，不能再改内容；请新建草稿', {
      code: 'E_DRAFT_STATUS',
      draftId: id,
    });
  }
  record.payload = { ...record.payload, ...payload };
  record.hash = draftHash(record.kind, record.payload);
  record.status = DRAFT_STATUS.PENDING;
  record.approval = null;
  record.review = null;
  record.history = (record.history || []).concat([{ at: nowIso(opts.now), event: 'edited' }]);
  return saveDraft(record);
}

function secretPath() {
  return path.join(configDir(), 'approval.key');
}

/** 本机签名密钥：首次批准时生成，0600，只留在本机。 */
export function approvalSecret() {
  const file = secretPath();
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return Buffer.from(s, 'hex');
  } catch {
    /* 不存在则下面生成 */
  }
  ensureDir(configDir());
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString('hex') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  return secret;
}

function sign(secret, parts) {
  return crypto.createHmac('sha256', secret).update(parts.join('|')).digest('base64url').slice(0, 43);
}

/**
 * 批准草稿（只应由人的终端调用）：生成一次性 approvalToken。
 * MCP 侧不暴露此函数背后的 approve 工具。
 */
export function approveDraft(id, opts = {}) {
  const record = readDraft(id);
  if (record.status !== DRAFT_STATUS.PENDING) {
    throw new DraftError('草稿当前状态是 ' + record.status + '，不能批准（只有 pending_review 可批准）', {
      code: 'E_DRAFT_STATUS',
      draftId: id,
    });
  }
  const now = opts.now || Date.now();
  const nonce = crypto.randomBytes(12).toString('base64url');
  const expiresAt = new Date(now + (opts.ttlMs || APPROVAL_TTL_MS)).toISOString();
  const action = record.kind === 'post' ? 'create_post' : 'create_comment';
  const userId = record.author && record.author.userId != null ? String(record.author.userId) : 'anonymous';
  const expMs = String(Date.parse(expiresAt));
  const parts = [record.id, nonce, expMs, record.hash, action, userId];
  const sig = sign(approvalSecret(), parts);
  const token = 'nfap_' + parts.join('.') + '.' + sig;

  record.status = DRAFT_STATUS.APPROVED;
  record.review = { at: nowIso(now), decision: 'approve', reviewer: opts.reviewer || 'tty', note: opts.note || null };
  record.approval = {
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    action,
    draftHash: record.hash,
    userId,
    issuedAt: nowIso(now),
    expiresAt,
    usedAt: null,
  };
  record.history = (record.history || []).concat([{ at: nowIso(now), event: 'approved', expiresAt }]);
  saveDraft(record);
  return { record, token, expiresAt };
}

export function rejectDraft(id, opts = {}) {
  const record = readDraft(id);
  if (record.status !== DRAFT_STATUS.PENDING && record.status !== DRAFT_STATUS.APPROVED) {
    throw new DraftError('草稿当前状态是 ' + record.status + '，不能拒绝', { code: 'E_DRAFT_STATUS', draftId: id });
  }
  const now = opts.now || Date.now();
  record.status = DRAFT_STATUS.REJECTED;
  record.review = { at: nowIso(now), decision: 'reject', reviewer: opts.reviewer || 'tty', note: opts.reason || null };
  record.approval = null;
  record.history = (record.history || []).concat([{ at: nowIso(now), event: 'rejected', note: opts.reason || null }]);
  saveDraft(record);
  return record;
}

/**
 * 校验 approvalToken（不消费）。任一条件不满足都返回结构化原因，调用方决定怎么报错。
 */
export function verifyApprovalToken(record, token, opts = {}) {
  const now = opts.now || Date.now();
  const fail = (code, message) => ({ ok: false, code, message });
  if (!token) return fail('E_APPROVAL_REQUIRED', '发布必须提供人工批准生成的一次性 approvalToken（在终端里运行 draft approve 获取）');
  if (!record.approval) return fail('E_APPROVAL_REQUIRED', '该草稿还没有被批准过');
  if (record.approval.usedAt) return fail('E_APPROVAL_USED', '这个 approvalToken 已经用过了（一次性）；请重新批准');
  if (record.status !== DRAFT_STATUS.APPROVED) {
    return fail('E_DRAFT_STATUS', '草稿状态是 ' + record.status + '，只有 approved 才能发布');
  }
  const parts = String(token).split('.');
  if (!String(token).startsWith('nfap_') || parts.length !== 7) return fail('E_APPROVAL_INVALID', 'approvalToken 格式不对');
  const tokenNonce = parts[1];
  const tokenExp = parts[2];
  const tokenHash = parts[3];
  const tokenAction = parts[4];
  const tokenUser = parts[5];
  const sig = parts[6];
  const expMs = Number(tokenExp);
  if (!Number.isFinite(expMs) || expMs < now) return fail('E_APPROVAL_EXPIRED', 'approvalToken 已过期（有效期 10 分钟），请重新批准');
  const expect = sign(approvalSecret(), [record.id, tokenNonce, tokenExp, tokenHash, tokenAction, tokenUser]);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail('E_APPROVAL_INVALID', 'approvalToken 签名不匹配（可能被改过或来自另一台机器）');
  if (tokenHash !== record.hash) return fail('E_APPROVAL_HASH_MISMATCH', '草稿内容在批准后被改过，原 token 作废；请重新批准');
  if (tokenAction !== record.approval.action) return fail('E_APPROVAL_ACTION', 'approvalToken 绑定的动作与草稿类型不一致');
  if (opts.userId != null && String(opts.userId) !== tokenUser) {
    return fail('E_APPROVAL_USER', 'approvalToken 绑定的用户与当前登录用户不一致');
  }
  const tokenDigest = crypto.createHash('sha256').update(String(token)).digest('hex');
  if (record.approval.tokenHash !== tokenDigest) return fail('E_APPROVAL_INVALID', 'approvalToken 与草稿记录不匹配');
  return { ok: true };
}

/** 发布成功后消费 token：一次性，之后任何重放都会被 E_APPROVAL_USED 挡住。 */
export function markPublished(record, opts = {}) {
  const now = opts.now || Date.now();
  record.status = DRAFT_STATUS.PUBLISHED;
  if (record.approval) record.approval.usedAt = nowIso(now);
  record.publish = { at: nowIso(now), resultId: opts.resultId ?? null, result: opts.result ?? null };
  record.history = (record.history || []).concat([{ at: nowIso(now), event: 'published', resultId: opts.resultId ?? null }]);
  return saveDraft(record);
}

/** 供 MCP doctor / status 用：一眼看出还剩多少可发布草稿。 */
export function summarizeDrafts() {
  const all = listDrafts();
  const byStatus = {};
  for (const d of all) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  return { total: all.length, byStatus, dir: draftsDir() };
}
