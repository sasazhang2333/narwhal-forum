/**
 * 授权范围（scope）与「允许/拒绝」闸。
 *
 * 为什么需要这一层：网页授权把「登录」和「授权」合并成了一步 —— 人在专用浏览器窗口里登录完，
 * 插件就把 token 读走了，中间没有「这个工具能做什么」的确认。这里补上那一步：
 *
 *   1. 授权时明确列出范围（读 / 评论 / 发帖 / 审核 / 删除 / 草稿），人可以选择只给一部分；
 *   2. 每个工具都映射到一个范围，调用时先查本地授权记录，越界直接拒绝并说明怎么扩权；
 *   3. 记录写进凭据文件（0600），`auth status` 能看到，重新登录可以改。
 *
 * ⚠️ 边界要说清楚：这是**客户端自律**的闸。token 本身是账号全权令牌，后端不知道我们授予了哪些
 * 范围 —— 因此它拦住的是「Agent 顺手做了你没想到的事」，不是「攻击者拿到文件后越权」。
 * 真正的服务端 scope 需要后端发一层受限 token（见 DESIGN 里「待确认」一节）。
 */
import { readCredentials, patchCredentials } from './config.js';

/** 授权范围表：id 进凭据文件，title/detail 进给人看的说明。 */
export const SCOPES = [
  {
    id: 'read',
    title: '读取公开内容',
    detail: '浏览帖子、评论树、分类、栏目、全文搜索（这些未登录也能看）',
  },
  {
    id: 'read:own',
    title: '读取我的数据',
    detail: '查看当前登录账号（whoami）、我发过的评论',
  },
  {
    id: 'write:comment',
    title: '评论与互动',
    detail: '发表评论/回复、上传图片（含带图评论）、点赞表情',
  },
  {
    id: 'write:post',
    title: '发帖',
    detail: '新建帖子（新账号/未达信任阈值会进待审，不会直接公开）',
  },
  {
    id: 'delete',
    title: '删除',
    detail: '删除自己的帖子或评论（不可撤销；后端会校验作者身份）',
  },
  {
    id: 'draft',
    title: '人审草稿',
    detail: '提交/查看站点侧草稿（draft-*）。即使有它也只能「提交」，批准必须由人在网页上点 —— AI 不能自己批准自己写的内容。',
  },
];

export const ALL_SCOPE_IDS = SCOPES.map((s) => s.id);

/** 工具 → 范围。没列到的工具（status/login/logout/auth 类）不需要授权。 */
export const TOOL_SCOPES = {
  list_posts: 'read',
  get_post: 'read',
  list_comments: 'read',
  list_categories: 'read',
  list_channels: 'read',
  search_posts: 'read',
  whoami: 'read:own',
  my_comments: 'read:own',
  upload_image: 'write:comment',
  create_comment: 'write:comment',
  react_post: 'write:comment',
  create_post: 'write:post',
  delete_comment: 'delete',
  delete_post: 'delete',
  draft_create: 'draft',
  draft_list: 'draft',
  draft_get: 'draft',
  draft_publish: 'draft',
  draft_discard: 'draft',
};

/** 不需要任何范围就能用的工具（授权、撤销、看状态）。 */
export const SCOPE_FREE_TOOLS = new Set(['status', 'login', 'logout', 'whoami', 'auth_status']);

const SCOPE_IDS = new Set(ALL_SCOPE_IDS);

/**
 * 解析用户给的 scope 列表：接受 `all`、逗号分隔的 id、或者数组。
 * 未知 id 直接报错（宁可拦下，也不要静默忽略拼错的范围名 —— 那会让人以为扩了权）。
 */
export function parseScopeList(input) {
  if (input === undefined || input === null || input === '') return [...ALL_SCOPE_IDS];
  if (Array.isArray(input)) return parseScopeList(input.join(','));
  const raw = String(input).trim();
  if (!raw || raw === 'all' || raw === '*') return [...ALL_SCOPE_IDS];
  const out = [];
  const unknown = [];
  for (const piece of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (piece === 'all' || piece === '*') return [...ALL_SCOPE_IDS];
    if (!SCOPE_IDS.has(piece)) unknown.push(piece);
    else if (!out.includes(piece)) out.push(piece);
  }
  if (unknown.length) {
    const err = new Error('未知的授权范围：' + unknown.join(', ') + '（可用：' + ALL_SCOPE_IDS.join(', ') + ' 或 all）');
    err.code = 'E_SCOPE_UNKNOWN';
    throw err;
  }
  return ALL_SCOPE_IDS.filter((id) => out.includes(id));
}

/** 读本地授权记录；旧凭据（没记录过范围）返回 null，由调用方按「全量」兼容处理。 */
export function readGrant(creds) {
  const c = creds || readCredentials();
  const scopes = Array.isArray(c && c.grantedScopes) ? c.grantedScopes.filter((s) => SCOPE_IDS.has(s)) : null;
  if (!scopes || !scopes.length) return null;
  return { scopes, grantedAt: c.scopesGrantedAt || null, legacy: false };
}

/**
 * 查某个工具在当前授权下能不能用。
 * 旧凭据（没有 grantedScopes）按全量放行并标记 legacy —— 升级路径不该让老用户突然不能发帖。
 */
/** 1124：审批类动作永远只能人做 —— 工具最多「发布已由人审批通过的内容」。 */
export const HUMAN_ONLY_TOOLS = new Set(['approve_post']);

/** 人审专属工具的统一拒绝对象。 */
export function humanOnlyError(toolName) {
  const err = new Error(
    '「' + toolName + '」这类审批动作只能由人在网页里完成：' +
    'AI 工具最多发布已由人审批通过的内容，不能自己批准。'
  );
  err.code = 'E_HUMAN_ONLY_APPROVAL';
  err.hint = '要批准待审帖，请在网页后台的待审列表里由人操作（工具侧没有这个能力，勾了也没用）。';
  return err;
}

export function checkScope(toolName, creds) {
  if (HUMAN_ONLY_TOOLS.has(toolName)) {
    return { ok: false, need: 'human-only', grant: readGrant(creds) };
  }
  const need = TOOL_SCOPES[toolName];
  if (!need) return { ok: true, need: null, grant: readGrant(creds) };
  const grant = readGrant(creds);
  if (!grant) {
    return { ok: true, need, grant: null, legacy: true };
  }
  const ok = grant.scopes.includes(need);
  return { ok, need, grant };
}

/** 越界时的错误对象：带上「怎么扩权」，别只甩一句没权限。 */
export function scopeError(toolName, info) {
  if (info.need === 'human-only') return humanOnlyError(toolName);
  const scope = SCOPES.find((s) => s.id === info.need);
  const granted = info.grant ? info.grant.scopes.join(', ') : '（未记录）';
  const err = new Error(
    '当前授权不含「' + (scope ? scope.title : info.need) + '」（' + info.need + '）：' +
    '已授权范围 = ' + granted + '。'
  );
  err.code = 'E_SCOPE_DENIED';
  err.hint = '要扩权可以在网页「设置 → 账号安全 → AI 工具授权」里给这个工具勾上对应能力（保存后下一次请求即生效），'
    + '或者重新授权：narwhal-forum login（dsh 里调用 login 工具带 scopes）。只读内容不需要授权。';
  if (info.need === 'draft') {
    err.hint += ' 注意 draft 是「人审草稿」：有它也只能提交/查看，批准永远要人在网页上点；'
      + '没有它则 draft_create / draft_list / draft_publish 一律被挡。';
  }
  err.scope = info.need;
  err.grantedScopes = info.grant ? info.grant.scopes : [];
  return err;
}

/**
 * 从服务端把「这条 cli 授权当前的能力集」同步回本地凭据。
 *
 * 为什么需要：范围一旦能在页面上随时收窄/放宽（服务端 CliScopeFilter 按 meta.scopes 实时校验），
 * 本地凭据里那份 recorded 就只是缓存 —— 不收窄就会「服务端已收、本地还以为有」，
 * 放宽了又会「服务端已放、本地还在拒」。这一步把它拉回来，于是**页面改完不用重启工具**：
 * 收窄 → 下一次请求被服务端 403；放宽 → 下一次请求就被本地放行。
 *
 * 只对 cli 会话生效（`/api/bbs/me/sessions` 里 `current:true && deviceType==='cli'`）：
 * 真人设备/密码登录没有「授权范围」这回事，不去动它。
 *
 * @returns {Promise<string[]|null>} 变化后的范围；没变化 / 不是 cli 会话 → null
 */
let lastScopeSync = 0;
export async function syncGrantedScopes(client, { force = false, ttlMs = 15000 } = {}) {
  const now = Date.now();
  if (!force && now - lastScopeSync < ttlMs) return null;
  lastScopeSync = now;
  let rows;
  try {
    const result = await client.request('/api/bbs/me/sessions');
    rows = Array.isArray(result && result.list) ? result.list : [];
  } catch {
    return null; // 拉不到就按本地缓存走，不因为一次网络抖动把工具锁死
  }
  const current = rows.find((r) => r && r.current === true && String(r.deviceType || '') === 'cli');
  if (!current) return null;
  const remote = String(current.scopes || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => SCOPE_IDS.has(x));
  if (!remote.length) return null;
  const local = (readCredentials() || {}).grantedScopes;
  const same = Array.isArray(local) && local.length === remote.length && local.every((x) => remote.includes(x));
  if (same) return null;
  patchCredentials({ grantedScopes: ALL_SCOPE_IDS.filter((id) => remote.includes(id)) });
  return remote;
}

/** 给人看的范围清单（授权前展示 / auth status 用）。 */
export function scopeNoticeText(scopes) {
  const list = scopes && scopes.length ? scopes : ALL_SCOPE_IDS;
  const lines = ['本次授权范围（可只给其中一部分）：'];
  for (const s of SCOPES) {
    if (!list.includes(s.id)) continue;
    lines.push('  · ' + s.title + '（' + s.id + '）：' + s.detail);
  }
  const missing = ALL_SCOPE_IDS.filter((id) => !list.includes(id));
  if (missing.length) lines.push('  未授予：' + missing.join(', '));
  return lines.join('\n');
}

/** 一行摘要（status / auth status 用）。 */
export function scopeSummary(scopes) {
  if (!scopes || !scopes.length) return '未记录（旧凭据，按全量处理）';
  if (scopes.length === ALL_SCOPE_IDS.length) return '全部（' + ALL_SCOPE_IDS.join(', ') + '）';
  return scopes.join(', ');
}

export const _internal = { SCOPE_IDS };