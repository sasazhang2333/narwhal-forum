/**
 * CLI 入口（零依赖，手写参数解析）。
 *
 * 关键设计：CLI 与 MCP 共用同一张工具表（src/mcp/tools.js），
 * 所以「CLI 输出」和「模型看到的输出」永远一致，文档不会漂移。
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { ForumClient, ForumError, ForumAuthError, REACTIONS, POST_ORDERS } from './client.js';
import { clearCredentials, patchCredentials, readCredentials, resolveConfig } from './config.js';
import { createDraft, readDraft, listDrafts, removeDraft, approveDraft, rejectDraft, verifyApprovalToken, markPublished, summarizeDrafts } from './draft.js';
import { submitServerDraft, publishServerDraft } from './serverdraft.js';
import { readFileSync } from 'node:fs';
import { RISK_VERSION, RISK_ITEMS, riskNoticeText, riskSummaryText, riskAcknowledged, riskConsentPatch } from './risk.js';
import { SCOPES, ALL_SCOPE_IDS, parseScopeList, scopeNoticeText, scopeSummary, readGrant } from './consent.js';
import { resolveImageList, verifyDraftImages, summarizeImages, contentWithImages, ImageError } from './images.js';
import { TOOLS, TOOL_MAP } from './mcp/tools.js';

// 版本号只有一个来源：package.json（以前这里写死，结果 --version 和 npm 包版本对不上）
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = [
  'narwhal-forum ' + VERSION + ' — Narwhal CMS 论坛能力包（CLI + MCP server）',
  '',
  '用法: narwhal-forum <command> [options]',
  '',
  '连接与身份:',
  '  status                 查看后端地址（--base-url 或环境变量 NARWHAL_FORUM_BASE_URL）',
  '  setup                  首次接入：检查后端 → 打开浏览器授权 → 打印下一步',
  '  login                  网页授权登录（打开浏览器，登录一次即可）；--password 走账号密码；',
  '                         --device 走设备码（打印一个链接，人在自己浏览器里点「允许」）',
  '                         --no-open 不自动打开浏览器（CI / 远程：只打印链接）',
  '                         --web-url <前端站点地址>（后端与前端不同源时用，本地开发常见）',
  '  logout                 撤销授权：后端登出 + 删除本地凭据 + 删除插件浏览器 profile',
  '  auth status            查看授权状态（是否登录、授权方式、浏览器 profile 位置）',
  '  risk                   授权前必读的风险提示（每次 login/setup 也会先打印）',
  '  scope [set ...]        查看/修改授权范围（read, write:comment, write:post, moderate, delete, draft）',
  '  token set|show|clear   直接管理 token（适合从浏览器复制 access_token）',
  '  whoami                 当前登录用户信息',
  '',
  '只读:',
  '  posts                  列出帖子（--page --page-size --category --order --title-like）',
  '  post <id>              帖子详情（--comments 一并带评论树）',
  '  comments <postId>      评论树',
  '  categories             论坛分类（发帖要的 categoryId）',
  '  channels               站点栏目（CMS channel，不是论坛版块）',
  '  search <关键词>         全文搜索（后端 Lucene）',
  '  my-comments            我发过的评论（需登录）',
  '',
  '写入:',
  '  new-comment <postId> --content <文本|-> [--parent <id>] [--image 图.png ...]   发表评论/回复',
  '  new-post --category <id> --title <t> --content <文本|@文件|-> [--image 图.png ...]   发帖',
  '  upload-image <图.png> [--scene chat]                     先上传图片，拿可直接内联的 URL',
  '  react <postId> [--emoji 👍]                               表情互动',
  '  approve-post <postId>                                     批准待审帖（需审核权限：管理员/版主）',
  '  delete-comment <id> --yes                                 删评论（作者或管理员，不可撤销）',
  '  delete-post <postId> --yes                                删帖（作者或管理员，不可撤销）',
  '',
  '图片: --image 可重复给多张（最多 9 张），发布时自动上传并把 ![](url) 内联到正文末尾；',
  '      草稿模式下只记本机路径 + sha256，发布前重新校验，防止「批准 A 发布 B」。',
  '',
  '集成:',
  '  mcp                    以 MCP stdio 服务器运行（dsh / Claude Code / Codex 用）',
  '  tools [--json]         列出全部能力及其参数 schema',
  '  call <tool> --json <p> 直接调用任意能力（逃生舱，参数为 JSON）',
  '',
  '全局选项: --base-url --web-url --token --refresh-token --timeout --json --debug --help --version',
  '登录相关: --password --username --browser <路径> --timeout-sec <秒> --keep-browser --yes --scope <列表>',
  '',
  '环境变量: NARWHAL_FORUM_BASE_URL, NARWHAL_FORUM_WEB_URL, NARWHAL_FORUM_TOKEN, NARWHAL_FORUM_REFRESH_TOKEN,',
  '          NARWHAL_FORUM_USERNAME, NARWHAL_FORUM_PASSWORD, NARWHAL_FORUM_HOME',
].join('\n');

const GLOBAL_FLAGS = new Set(['base-url', 'token', 'refresh-token', 'username', 'password', 'timeout', 'json', 'debug', 'help', 'version', 'verbose', 'browser', 'timeout-sec', 'keep-browser', 'mode', 'yes', 'accept-risk', 'web-url', 'no-open']);

/** 可重复出现的选项：--image a.png --image b.png → 数组。 */
const MULTI_FLAGS = new Set(['image', 'images']);

/** 写一个 flag，多值选项累积成数组（其余保持单值语义，覆盖式）。 */
function setFlag(flags, key, value) {
  if (!MULTI_FLAGS.has(key)) {
    flags[key] = value;
    return;
  }
  if (flags[key] === undefined) flags[key] = value;
  else if (Array.isArray(flags[key])) flags[key].push(value);
  else flags[key] = [flags[key], value];
}

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        setFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
        i += 1;
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        setFlag(flags, key, true);
        i += 1;
      } else {
        setFlag(flags, key, next);
        i += 2;
      }
      continue;
    }
    positionals.push(arg);
    i += 1;
  }
  return { flags, positionals };
}

function clientFrom(flags) {
  return new ForumClient({
    baseUrl: flags['base-url'],
    token: flags.token,
    refreshToken: flags['refresh-token'],
    username: flags.username,
    password: flags.password,
    timeoutMs: flags.timeout,
  });
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/** 支持 --content 直接给文本、@file 读文件、- 读 stdin。 */
function resolveContent(value) {
  if (value === undefined || value === null || value === true) return undefined;
  const raw = String(value);
  if (raw === '-') return fs.readFileSync(0, 'utf8');
  if (raw.startsWith('@')) return fs.readFileSync(path.resolve(raw.slice(1)), 'utf8');
  return raw;
}

const COMMANDS = {
  posts: { tool: 'list_posts', map: { page: 'page', 'page-size': 'pageSize', category: 'categoryId', user: 'userId', order: 'order', 'title-like': 'titleLike' }, ints: ['page', 'pageSize'] },
  post: { tool: 'get_post', positional: ['postId'], map: { comments: 'withComments', 'comment-sort': 'commentSort' }, ints: [] },
  comments: { tool: 'list_comments', positional: ['postId'], map: { sort: 'sort' }, ints: [] },
  categories: { tool: 'list_categories', map: { page: 'page', 'page-size': 'pageSize' }, ints: ['page', 'pageSize'] },
  channels: { tool: 'list_channels', map: { page: 'page', 'page-size': 'pageSize' }, ints: ['page', 'pageSize'] },
  search: { tool: 'search_posts', positional: ['q'], map: { category: 'categoryId', user: 'userId', 'date-from': 'dateFrom', 'date-to': 'dateTo', sort: 'sort', page: 'page', 'page-size': 'pageSize' }, ints: ['categoryId', 'userId', 'page', 'pageSize'] },
  'my-comments': { tool: 'my_comments', map: { page: 'page', 'page-size': 'pageSize' }, ints: ['page', 'pageSize'] },
  'new-comment': { tool: 'create_comment', positional: ['postId'], map: { content: 'content', parent: 'parentId', 'reply-user': 'replyUserId', whisper: 'whisper', image: 'images' }, ints: [] },
  'new-post': { tool: 'create_post', map: { category: 'categoryId', title: 'title', content: 'content', summary: 'summary', type: 'type', cover: 'cover', image: 'images' }, ints: ['categoryId'] },
  'upload-image': { tool: 'upload_image', positional: ['path'], map: { scene: 'scene' }, ints: [] },
  react: { tool: 'react_post', positional: ['postId'], map: { emoji: 'emoji' }, ints: [] },
  'approve-post': { tool: 'approve_post', positional: ['postId'], ints: [] },
  'delete-comment': { tool: 'delete_comment', positional: ['commentId'], map: { yes: 'confirm' }, ints: [] },
  'delete-post': { tool: 'delete_post', positional: ['postId'], map: { yes: 'confirm' }, ints: [] },
  whoami: { tool: 'whoami' },
  status: { tool: 'status' },
};

async function runTool(command, flags, positionals) {
  const spec = COMMANDS[command];
  const args = {};
  (spec.positional || []).forEach((name, idx) => {
    if (positionals[idx] !== undefined) args[name] = spec.ints.includes(name) ? toInt(positionals[idx]) : positionals[idx];
  });
  for (const [flag, argName] of Object.entries(spec.map || {})) {
    if (flags[flag] === undefined) continue;
    let value = flags[flag];
    if (argName === 'content') value = resolveContent(value);
    if (spec.ints.includes(argName)) value = toInt(value);
    args[argName] = value;
  }
  const tool = TOOL_MAP.get(spec.tool);
  const { checkScope, scopeError, syncGrantedScopes, SCOPE_FREE_TOOLS } = await import('./consent.js');
  const client = clientFrom(flags);
  if (!SCOPE_FREE_TOOLS.has(spec.tool)) {
    // 与服务端对账一次：页面改完的能力下一次命令就生效
    await syncGrantedScopes(client, { force: true });
    const info = checkScope(spec.tool);
    if (!info.ok) throw scopeError(spec.tool, info);
  }
  const out = await tool.handler({ client }, args);
  if (flags.json) {
    process.stdout.write(JSON.stringify(out.data === undefined ? { text: out.text } : out.data, null, 2) + '\n');
  } else {
    process.stdout.write(out.text + '\n');
  }
  return 0;
}

function seconds(flags, fallback) {
  const raw = flags['timeout-sec'];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallback;
}

let riskConsentDone = false;

/** 读一行（交互式确认用）。 */
function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

/**
 * 授权前的风险提示与人审确认。
 *
 * 规则：
 *  - 每次 login / setup 都打印风险提示（已同意过的人看摘要 + 完整版入口）；
 *  - 非交互环境（CI / Agent 管道调用）不得静默授权：未同意过时必须显式 --yes；
 *  - 同意落进凭据文件（riskAcceptedVersion），logout 时一并清除。
 */
async function ensureRiskConsent(flags, ctx) {
  if (riskConsentDone) return 0;
  const acked = riskAcknowledged(readCredentials());
  const out = (s) => process.stdout.write(s + '\n');
  if (acked) {
    out(riskNoticeText({ baseUrl: ctx && ctx.baseUrl }));
    out('');
    out('（你已同意过 v' + RISK_VERSION + '；完整说明随时可看：narwhal-forum risk）');
    out('');
  } else {
    out(riskNoticeText({ baseUrl: ctx && ctx.baseUrl }));
  }
  const auto = flags.yes === true || flags['accept-risk'] === true || process.env.NARWHAL_FORUM_ACCEPT_RISK === '1';
  if (auto) {
    patchCredentials(riskConsentPatch());
    riskConsentDone = true;
    return 0;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    if (acked) { riskConsentDone = true; return 0; }
    process.stderr.write('✗ 授权前需要你本人确认风险提示；当前不是交互终端。' + '\n');
    process.stderr.write('  请在你自己的终端里运行，或确认已阅读后加 --yes（只在你能为发布内容负责时使用）。' + '\n');
    return 2;
  }
  const answer = acked
    ? await askLine('风险提示 v' + RISK_VERSION + ' 已同意过：回车继续，输入 n 取消 > ')
    : await askLine('确认已阅读并接受以上风险，输入 yes 继续（其它输入取消）> ');
  const ok = acked ? answer !== 'n' && answer !== 'no' : answer.toLowerCase() === 'yes';
  if (!ok) {
    process.stderr.write('已取消授权。' + '\n');
    return 2;
  }
  patchCredentials(riskConsentPatch());
  riskConsentDone = true;
  return 0;
}
/** 授权前确认范围：--scope 显式给 → 用它；非交互（脚本/CI）→ 全量；交互 → 展示清单并问一句。 */
async function resolveScopesInteractive(flags) {
  if (flags.scope !== undefined) return parseScopeList(typeof flags.scope === 'string' ? flags.scope : 'all');
  if (flags.yes === true || !process.stdin.isTTY || !process.stdout.isTTY) return [...ALL_SCOPE_IDS];
  process.stdout.write('\n' + scopeNoticeText() + '\n');
  const answer = (await askLine('允许以上全部范围？回车=全部 / 输入 scope 列表（如 read,write:comment）/ n=只读： ')).trim();
  if (!answer) return [...ALL_SCOPE_IDS];
  if (/^(n|no|只读)$/i.test(answer)) return ['read'];
  return parseScopeList(answer);
}

/** 把授权范围写进凭据文件（0600），auth status / status 都能看到。 */
function recordScopes(scopes) {
  patchCredentials({ grantedScopes: scopes, scopesGrantedAt: new Date().toISOString() });
}

async function cmdScope(sub, flags, rest = []) {
  const current = readGrant(readCredentials());
  if (sub === 'set' || flags.set !== undefined) {
    const scopes = parseScopeList(rest.length ? rest : (sub && sub !== 'set' ? sub : flags.set));
    recordScopes(scopes);
    process.stdout.write('授权范围已更新: ' + scopeSummary(scopes) + '\n');
    return 0;
  }
  const lines = ['授权范围: ' + scopeSummary(current ? current.scopes : null)];
  if (current && current.grantedAt) lines.push('授予时间: ' + current.grantedAt);
  lines.push('', scopeNoticeText(current ? current.scopes : null));
  lines.push('', '改范围: narwhal-forum scope set read,write:comment   （或重新 login）');
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function cmdLogin(flags) {
  const client = clientFrom(flags);
  const consent = await ensureRiskConsent(flags, { baseUrl: client.baseUrl });
  if (consent !== 0) return consent;
  // 授权范围：默认全给；也可以 --scope read,write:comment 只给一部分（或交互里选）
  const scopes = await resolveScopesInteractive(flags);
  // 账号密码模式：显式 --password / --mode password，或给了 --username 且有密码来源（兼容旧用法）
  const passwordMode = flags.password !== undefined
    || flags.mode === 'password'
    || Boolean(flags.username && process.env.NARWHAL_FORUM_PASSWORD);
  if (passwordMode) {
    const result = await client.login({
      username: flags.username,
      password: typeof flags.password === 'string' ? flags.password : undefined,
      captchaToken: flags['captcha-token'],
    });
    recordScopes(scopes);
    process.stdout.write((flags.json ? JSON.stringify({ ...result, grantedScopes: scopes }, null, 2) : '登录成功：' + result.accessToken + '\n凭据已写入 ' + result.credentialsPath + '\nrefresh token 会自动续期，access token 默认 30 分钟过期。\n授权范围: ' + scopeSummary(scopes)) + '\n');
    return 0;
  }

  // 设备码授权：人在自己的浏览器里点「允许」，CLI 只拿 8 位用户码 —— 远程/容器里也能用
  if (flags.device === true || flags.mode === 'device') {
    const { deviceLogin } = await import('./auth.js');
    const r = await deviceLogin({
      baseUrl: client.baseUrl,
      webBaseUrl: flags['web-url'] || process.env.NARWHAL_FORUM_WEB_URL || '',
      clientName: 'narwhal-forum@' + VERSION,
      scopes,
      timeoutMs: seconds(flags, 300000),
      // --no-open 优先于 --browser（设备码流程里的「开浏览器」指打开授权页，不是登录用的受控浏览器）
      openBrowser: flags['no-open'] === true ? false : flags.browser !== false,
      log: (line) => process.stderr.write(line ? line + '\n' : '\n'),
    });
    // 授权页允许人勾掉一些能力：以服务端回的授予集为准（拿不到才退回本地申请的范围）
    const granted = Array.isArray(r.scopes) && r.scopes.length ? r.scopes : scopes;
    const credentialsFile = patchCredentials({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      authMode: 'device',
      grantedScopes: granted,
      scopesGrantedAt: new Date().toISOString(),
      loggedInAt: new Date().toISOString(),
    });
    process.stdout.write((flags.json
      ? JSON.stringify({ authenticated: true, authMode: 'device', baseUrl: client.baseUrl, credentialsPath: credentialsFile, username: r.username, grantedScopes: granted }, null, 2)
      : ['授权成功（设备码）',
        '  账号: ' + (r.username || '(未知)'),
        '  凭据已写入 ' + credentialsFile + '（0600，已含 refresh token）',
        '  授权范围: ' + scopeSummary(granted),
        '  撤销方式: 网页「设置 → 账号安全 → 登录设备」里点「移除授权」（立即失效，不影响其它工具或你本人登录）',
        '            本地凭据可用 narwhal-forum logout 删掉'].join('\n')) + '\n');
    return 0;
  }

  const { browserLogin } = await import('./auth.js');
  const r = await browserLogin({
    baseUrl: client.baseUrl,
    timeoutMs: seconds(flags, 300000),
    browserPath: flags.browser,
    log: (line) => process.stderr.write('· ' + line + '\n'),
  });
  recordScopes(scopes);
  const summary = {
    authenticated: true,
    authMode: 'browser',
    baseUrl: client.baseUrl,
    credentialsPath: r.credentialsPath,
    browserProfile: r.profileDir,
    browser: r.browser,
    grantedScopes: scopes,
  };
  process.stdout.write((flags.json
    ? JSON.stringify(summary, null, 2)
    : ['授权成功（网页登录）',
      '凭据已写入 ' + r.credentialsPath + '（0600，已含 refresh token）',
      '浏览器 profile: ' + r.profileDir + '（撤销授权时会一并删除）',
      '授权范围: ' + scopeSummary(scopes),
      '撤销方式: 网页「设置 → 账号安全 → 登录设备」里点「移除授权」（立即失效，不影响其它工具或你本人登录）',
      '          本地凭据可用 narwhal-forum logout 删掉',
      '',
      '下一步: 在 dsh / Claude Code / Codex 里直接调论坛能力（MCP 工具名 mcp__narwhal-forum__*）。'].join('\n')) + '\n');
  return 0;
}

async function cmdLogout(flags) {
  const client = clientFrom(flags);
  const keepBrowser = flags['keep-browser'] === true;
  const { revokeAuth } = await import('./auth.js');
  const r = await revokeAuth({ baseUrl: client.baseUrl, token: client.token, keepBrowser });
  const lines = [
    '已撤销授权',
    '  后端登出: ' + r.backendLogout,
    '  本地凭据: ' + (r.tokenRemoved ? '已删除' : '本来就没有'),
    '  浏览器 profile: ' + (keepBrowser ? '已保留' : r.profileRemoved ? '已删除' : '未删除（' + (r.profileError || '不存在') + '）') + '  ' + r.profileDir,
  ];
  process.stdout.write((flags.json ? JSON.stringify(r, null, 2) : lines.join('\n')) + '\n');
  return 0;
}

async function cmdAuth(sub, flags) {
  const action = sub || 'status';
  if (action !== 'status') {
    process.stderr.write('✗ 用法: narwhal-forum auth status\n');
    return 2;
  }
  const client = clientFrom(flags);
  const { authStatus } = await import('./auth.js');
  const s = authStatus({ token: client.token, credentialsPath: client.cfg.credentialsPath });
  const creds = readCredentials();
  const data = { baseUrl: client.baseUrl, ...s, riskVersion: RISK_VERSION, riskAcknowledged: riskAcknowledged(creds), riskAcceptedAt: creds.riskAcceptedAt || null };
  process.stdout.write((flags.json
    ? JSON.stringify(data, null, 2)
    : Object.entries(data).map(([k, v]) => k + ': ' + v).join('\n')) + '\n');
  return 0;
}

async function cmdSetup(flags) {
  const client = clientFrom(flags);
  const out = (line) => process.stdout.write(line + '\n');
  out('narwhal-forum 首次接入');
  out('  后端: ' + client.baseUrl);
  try {
    const info = await client.getAuthCodeInfo();
    out('  后端可达 ✔' + (info.captchaEnabled ? '（该后端登录需要图形验证码，网页授权会自动处理）' : ''));
  } catch (err) {
    process.stderr.write('✗ 连不上后端: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.stderr.write('  用 --base-url 或环境变量 NARWHAL_FORUM_BASE_URL 指定地址后重试。\n');
    return 1;
  }
  out('');
  out('接下来会先打印风险提示，需要你本人确认后才打开浏览器授权。');
  const code = await cmdLogin(flags);
  if (code !== 0) return code;
  out('');
  out('已完成。dsh 侧确认方式：重启 dsh web 后调用 mcp__narwhal-forum__status；');
  out('其它工具：Claude Code / Codex 里配置 MCP server（见 README「在其它工具里复用」）。');
  return 0;
}

async function cmdRisk(flags) {
  const client = clientFrom(flags);
  const creds = readCredentials();
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      riskVersion: RISK_VERSION,
      acknowledged: riskAcknowledged(creds),
      acceptedAt: creds.riskAcceptedAt || null,
      items: RISK_ITEMS,
    }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(riskNoticeText({ baseUrl: client.baseUrl }) + '\n' + '\n');
  process.stdout.write(riskAcknowledged(creds)
    ? '当前状态：已同意 v' + creds.riskAcceptedVersion + '（' + creds.riskAcceptedAt + '）' + '\n'
    : '当前状态：尚未同意 v' + RISK_VERSION + '（下次 login/setup 会让你确认）' + '\n');
  return 0;
}

/* ---------------------------------------------------------------- 草稿与人审发布 */

function draftSummaryLine(record) {
  const p = record.payload || {};
  const imgs = Array.isArray(p.images) && p.images.length ? '  [图 ' + p.images.length + ']' : '';
  if (record.kind === 'comment') {
    const target = '帖子 #' + p.postId + (p.parentId ? ' 的评论 #' + p.parentId : '');
    return '评论 → ' + target + '：' + String(p.content || '').replace(/\s+/g, ' ').slice(0, 60) + imgs;
  }
  return '发帖 → ' + (p.title || '(无标题)') + ' @ 分类 ' + (p.categoryId === undefined ? '?' : p.categoryId) + imgs;
}

function draftView(record) {
  const lines = [];
  const p = record.payload || {};
  lines.push('草稿 ' + record.id + '  [' + record.status + ']');
  lines.push('  类型: ' + record.kind + '   hash: ' + record.hash.slice(0, 12) + '...');
  lines.push('  作者: ' + (record.author.userId === null ? '-' : record.author.userId) + '/' + (record.author.userName || '-') + '   创建: ' + record.createdAt);
  lines.push('  摘要: ' + draftSummaryLine(record));
  if (record.kind === 'comment') {
    lines.push('  正文:');
    lines.push('  ' + String(p.content || '').split('\n').join('\n  '));
  } else {
    lines.push('  标题: ' + (p.title || ''));
    lines.push('  正文:');
    lines.push('  ' + String(p.content || '').split('\n').join('\n  '));
  }
  const images = Array.isArray(p.images) ? p.images : [];
  if (images.length) {
    lines.push('  图片（发布时上传并内联到正文末尾）:');
    for (const line of summarizeImages(images)) lines.push('    ' + line);
  }
  if (record.review) {
    lines.push('  审阅: ' + record.review.decision + ' @ ' + record.review.at + (record.review.note ? '（' + record.review.note + '）' : ''));
  }
  if (record.approval) {
    lines.push('  批准: 过期于 ' + record.approval.expiresAt + (record.approval.usedAt ? '，已使用 @ ' + record.approval.usedAt : '，未使用'));
  }
  if (record.publish) lines.push('  已发布: ' + record.publish.at + '   结果 id: ' + (record.publish.resultId === null ? '-' : record.publish.resultId));
  return lines.join('\n');
}

async function safeWhoami(client) {
  try {
    const me = await client.whoami();
    return { userId: me.user && me.user.userId !== undefined ? me.user.userId : null, userName: (me.user && me.user.userName) || null };
  } catch {
    return { userId: null, userName: null };
  }
}

async function draftPublish(record, token, flags) {
  const v = verifyApprovalToken(record, token, {});
  if (!v.ok) {
    process.stderr.write('✗ 发布被拒（' + v.code + '）：' + v.message + '\n');
    if (v.code === 'E_APPROVAL_EXPIRED' || v.code === 'E_APPROVAL_USED' || v.code === 'E_APPROVAL_HASH_MISMATCH' || v.code === 'E_DRAFT_STATUS') {
      process.stderr.write('  重新批准: narwhal-forum draft approve ' + record.id + '\n');
    }
    return 2;
  }

  // 注意：flags.token 在这里是 approvalToken（人审令牌），不是论坛 access token，
  // 不能传给 clientFrom，否则会把登录态覆盖掉。
  const client = clientFrom({ ...flags, token: undefined });
  let realname = { verified: null, source: null };
  try {
    realname = await client.realnameStatus();
  } catch (err) {
    realname = { verified: null, source: null, error: err && err.message ? err.message : String(err) };
  }
  if (realname.verified === false) {
    process.stderr.write('✗ 未完成实名认证，不能发布（后端会拦）。\n');
    process.stderr.write('  ' + (realname.hint || '先完成实名认证后重试。') + '\n');
    return 3;
  }
  if (realname.verified === null) {
    process.stderr.write('· 提示：本地无法判定实名状态（' + (realname.error || realname.hint || '字段缺失') + '），以服务端门控为准。\n');
  }

  const p = record.payload || {};
  // 图片：先校验（文件还在、sha256 与批准时一致），再逐张上传，最后把 markdown 内联进正文。
  // 本地前置条件失败（缺文件 / 指纹不一致）算用法错误 exit 2；网络或论坛失败 exit 1。两种都不消费 token。
  let uploaded = [];
  let content = p.content;
  try {
    const images = verifyDraftImages(p.images);
    uploaded = images.length ? await client.uploadImages(images) : [];
    content = contentWithImages(p.content, uploaded.map((u) => u.url));
  } catch (err) {
    const local = err instanceof ImageError || (err && err.name === 'ImageError');
    process.stderr.write('✗ 图片准备失败，token 未消费（有效期内可重试）：' + (err && err.message ? err.message : String(err)) + '\n');
    if (err && err.hint) process.stderr.write('   ' + err.hint + '\n');
    return local ? 2 : 1;
  }
  if (record.kind === 'comment' && content.length > 2000) {
    process.stderr.write('✗ 带图后评论正文超过 2000 字上限（当前 ' + content.length + ' 字），token 未消费\n');
    return 2;
  }
  let result;
  try {
    if (record.kind === 'comment') {
      result = await client.createComment({ postId: p.postId, content, parentId: p.parentId, replyUserId: p.replyUserId, whisper: p.whisper });
    } else {
      result = await client.createPost({ title: p.title, content, categoryId: p.categoryId, summary: p.summary, type: p.type, cover: p.cover });
    }
  } catch (err) {
    process.stderr.write('✗ 发布请求失败，token 未消费（有效期内可重试）：' + (err && err.message ? err.message : String(err)) + '\n');
    return 1;
  }

  const resultId = result && (result.id !== undefined ? result.id : result.commentId !== undefined ? result.commentId : result.postId);
  markPublished(record, { resultId: resultId === undefined ? null : resultId });
  if (flags.json) {
    process.stdout.write(JSON.stringify({ published: true, draftId: record.id, kind: record.kind, resultId: resultId === undefined ? null : resultId, realname }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write([
    '已发布 ✔',
    '  草稿: ' + record.id + '（token 已消费，不可重放）',
    '  结果 id: ' + (resultId === undefined ? '（后端未返回 id）' : resultId),
    ...(uploaded.length ? ['  图片: ' + uploaded.length + ' 张已上传并内联（' + uploaded.map((u) => u.url).join(' ') + '）'] : []),
    '  实名: ' + (realname.verified === true ? '已实名' : '本地未判定，以服务端结果为准'),
  ].join('\n') + '\n');
  return 0;
}

async function cmdDraft(sub, flags, rest) {
  const action = sub || 'help';
  const out = (s) => process.stdout.write(s + '\n');
  const fail = (s) => process.stderr.write('✗ ' + s + '\n');

  if (action === 'help' || flags.help === true) {
    out("草稿与人审发布（AI 不能自行发布）：\n  draft new-comment <postId> --content <文本|@文件|-> [--parent <id>] [--image 图.png ...]\n  draft new-post --category <id> --title <标题> --content <文本|@文件|-> [--summary <摘要>] [--image 图.png ...]\n  draft list [--status pending_review|approved|published|rejected|expired] [--json]\n  draft show <id> [--json]\n  draft approve <id>      只在你的终端里：展示全文 → 输入 yes → 打印一次性 approvalToken（10 分钟）\n  draft reject <id> [--reason <说明>]\n  draft publish <id> --token <approvalToken>    发布前重新校验实名；token 一次性\n  draft discard <id>      删除本地草稿文件\n\n站点侧草稿（人审在网页，站点留档）：new-comment / new-post 后加 --server：\n  draft new-comment <postId> --content <文本> --server [--web-url <前端地址>] [--image 图.png]\n  draft new-post --category <id> --title <标题> --content <文本> --server [--web-url <前端地址>]\n  draft list --server [--status pending|approved|denied|published|expired]\n  draft show DR-xxxxxxxx\n  draft publish DR-xxxxxxxx    人在网页上批准之后才领得到内容（领取一次即失效）");
    return 0;
  }

  const id = rest[0];
  try {
    if (action === 'new-comment' || action === 'new-post') {
      if (action === 'new-comment' && !id) { fail('用法: draft new-comment <postId> --content ...'); return 2; }
      const content = resolveContent(flags.content);
      if (!content) { fail('缺少 --content（支持 文本 / @文件 / - 从 stdin 读）'); return 2; }
      if (action === 'new-post' && !flags.title) { fail('发帖草稿需要 --title'); return 2; }
      if (action === 'new-post' && flags.category === undefined) { fail('发帖草稿需要 --category（用 categories 命令查 id）'); return 2; }
      const client = clientFrom(flags);
      const author = await safeWhoami(client);
      const payload = action === 'new-comment'
        ? { postId: String(id), content: content }
        : { title: String(flags.title), content: content, categoryId: Number(flags.category) };
      if (action === 'new-comment' && flags.parent !== undefined) payload.parentId = String(flags.parent);
      if (action === 'new-post' && flags.summary !== undefined) payload.summary = String(flags.summary);
      const images = resolveImageList(flags.image);
      if (images.length) payload.images = images.map((img) => ({ path: img.path, name: img.name, mime: img.mime, bytes: img.bytes, sha256: img.sha256 }));
      if (flags.server === true) {
        const payloadForServer = { ...payload };
        if (images.length) {
          const uploaded = await client.uploadImages(images);
          payloadForServer.images = uploaded.map((u) => u.url);
        }
        const draft = await submitServerDraft(client, {
          kind: action === 'new-comment' ? 'comment' : 'post',
          payload: payloadForServer,
          clientName: 'narwhal-forum@' + VERSION,
          webBaseUrl: flags['web-url'] || process.env.NARWHAL_FORUM_WEB_URL,
        });
        if (flags.json) { out(JSON.stringify(draft, null, 2)); return 0; }
        out('已提交站点侧草稿 ' + draft.draftCode + '（状态 ' + (draft.statusTitle || draft.status) + '）');
        out('  内容指纹: ' + String(draft.payloadHash || '').slice(0, 12) + '...');
        out('  给人打开的审理页: ' + draft.reviewUrl);
        out('  批准后: narwhal-forum draft publish ' + draft.draftCode);
        return 0;
      }
      const record = createDraft({ kind: action === 'new-comment' ? 'comment' : 'post', payload, author, baseUrl: client.baseUrl });
      if (flags.json) { out(JSON.stringify(record, null, 2)); return 0; }
      out(draftView(record));
      out('');
      out('下一步（必须由人来做）: narwhal-forum draft approve ' + record.id);
      return 0;
    }

    if (action === 'list' && flags.server === true) {
      const client = clientFrom(flags);
      const res = await client.listServerDrafts({ status: typeof flags.status === 'string' ? flags.status : undefined, limit: 50 });
      const list = (res && (res.content || (res.result && res.result.content))) || [];
      if (flags.json) { out(JSON.stringify(list, null, 2)); return 0; }
      if (!list.length) { out('（站点侧没有草稿）'); return 0; }
      out(list.map((d) => d.draftCode + '  ' + String(d.statusTitle || d.status).padEnd(10) + ' ' + d.kind + '  ' + String(d.payloadHash || '').slice(0, 12) + '...').join('\n'));
      return 0;
    }

    if (action === 'list') {
      const records = listDrafts({ status: typeof flags.status === 'string' ? flags.status : undefined });
      if (flags.json) { out(JSON.stringify(records, null, 2)); return 0; }
      if (!records.length) { out('（没有草稿）'); return 0; }
      out(records.map((r) => r.id + '  ' + r.status.padEnd(15) + ' ' + draftSummaryLine(r)).join('\n'));
      return 0;
    }

    if (!id) { fail('用法: draft ' + action + ' <id>'); return 2; }

    if (action === 'show' && /^DR-/i.test(String(id))) {
      const client = clientFrom(flags);
      const raw = await client.getServerDraft(String(id));
      const draft = (raw && raw.result) || raw || {};
      if (flags.json) { out(JSON.stringify(draft, null, 2)); return 0; }
      out('草稿 ' + draft.draftCode + '（' + (draft.statusTitle || draft.status) + '）');
      out('  提交方: ' + (draft.clientName || '未署名'));
      out('  内容指纹: ' + String(draft.payloadHash || ''));
      out('  到期: ' + (draft.expiresAt || '—'));
      out('  内容:');
      for (const [k, v] of Object.entries(draft.payload || {})) {
        if (k === 'images') continue;
        out('    ' + k + ': ' + String(v));
      }
      const imgs = (draft.payload && draft.payload.images) || [];
      if (imgs.length) out('    图片: ' + imgs.length + ' 张');
      return 0;
    }

    if (action === 'show') {
      const record = readDraft(id);
      out(flags.json ? JSON.stringify(record, null, 2) : draftView(record));
      return 0;
    }

    if (action === 'approve') {
      return await approveDraftInteractive(id);
    }

    if (action === 'reject') {
      const record = rejectDraft(id, { reason: typeof flags.reason === 'string' ? flags.reason : null, reviewer: 'tty' });
      out(flags.json ? JSON.stringify(record, null, 2) : '已拒绝 ' + id + (flags.reason ? '（' + flags.reason + '）' : ''));
      return 0;
    }

    if (action === 'publish' && /^DR-/i.test(String(id))) {
      const client = clientFrom(flags);
      const res = await publishServerDraft(client, String(id));
      if (flags.json) { out(JSON.stringify(res, null, 2)); return 0; }
      out('已按站点侧草稿 ' + res.draftCode + ' 发布' + (res.resultId ? '（id=' + res.resultId + '）' : '（后端未回 id）'));
      return 0;
    }

    if (action === 'publish') {
      const token = typeof flags.token === 'string' ? flags.token : null;
      if (!token) { fail('发布需要 --token <approvalToken>（在人的终端里用 draft approve 生成）'); return 2; }
      return await draftPublish(readDraft(id), token, flags);
    }

    if (action === 'discard') {
      const record = readDraft(id);
      if (record.status === 'published' && flags.yes !== true) {
        fail('已发布的草稿记录建议保留（审计用）；确认删除请加 --yes');
        return 2;
      }
      removeDraft(id);
      out('已删除本地草稿 ' + id);
      return 0;
    }

    fail('未知子命令: draft ' + action + '（试 narwhal-forum draft help）');
    return 2;
  } catch (err) {
    if (err && (err.name === 'DraftError' || err.name === 'ImageError')) {
      fail(err.message + (err.hint ? '\n  ' + err.hint : ''));
      return 2;
    }
    throw err;
  }
}
async function cmdToken(sub, flags) {
  const action = sub || 'show';
  if (action === 'set') {
    const access = flags.access || flags.token;
    if (!access) {
      process.stderr.write('✗ token set 需要 --access <token>（浏览器 localStorage 的 auth_token）\n');
      return 2;
    }
    const { writeCredentials, readCredentials: read } = await import('./config.js');
    const next = { ...read(), accessToken: String(access), baseUrl: resolveConfig(flags).baseUrl };
    if (flags.refresh) next.refreshToken = String(flags.refresh);
    const file = writeCredentials(next);
    process.stdout.write('已写入 ' + file + '（0600）\n');
    return 0;
  }
  if (action === 'clear') {
    const removed = clearCredentials();
    process.stdout.write(removed ? '已删除本地凭据\n' : '本地没有凭据文件\n');
    return 0;
  }
  const cfg = resolveConfig(flags);
  const stored = readCredentials();
  const data = {
    baseUrl: cfg.baseUrl,
    credentialsPath: cfg.credentialsPath,
    hasAccessToken: Boolean(cfg.token),
    hasRefreshToken: Boolean(cfg.refreshToken),
    accessTokenSource: cfg.sources.token,
    refreshTokenSource: cfg.sources.refreshToken,
    storedKeys: Object.keys(stored),
  };
  process.stdout.write((flags.json ? JSON.stringify(data, null, 2) : Object.entries(data).map(([k, v]) => k + ': ' + v).join('\n')) + '\n');
  return 0;
}

async function cmdTools(flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })), null, 2) + '\n');
    return 0;
  }
  const lines = ['可用能力（共 ' + TOOLS.length + ' 个；MCP 工具名即 name）:'];
  for (const t of TOOLS) {
    lines.push('');
    lines.push('• ' + t.name + ' — ' + t.title);
    lines.push('  ' + t.description);
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    const required = (t.inputSchema && t.inputSchema.required) || [];
    for (const [key, schema] of Object.entries(props)) {
      lines.push('    - ' + key + ': ' + (schema.type || 'any') + (required.includes(key) ? ' (必填)' : '') + (schema.description ? ' — ' + schema.description : ''));
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function cmdCall(flags, positionals) {
  const name = positionals[0];
  if (!name) {
    process.stderr.write('✗ 用法: narwhal-forum call <tool> --json \'{...}\'\n');
    return 2;
  }
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    process.stderr.write('✗ 未知能力: ' + name + '（用 narwhal-forum tools 查看）\n');
    return 2;
  }
  let args = {};
  if (flags.json !== undefined && typeof flags.json === 'string') args = JSON.parse(flags.json);
  else if (flags.args) args = JSON.parse(String(flags.args));
  const out = await tool.handler({ client: clientFrom(flags) }, args);
  process.stdout.write((flags.raw ? JSON.stringify(out.data) : out.text) + '\n');
  return 0;
}


// 人审批准的唯一入口。io 只为可测试性而存在（注入假 TTY / 假问答）；
// 生产路径不传 io，一律读真实 process 的 TTY 状态，没有任何环境变量或参数能绕过。
export async function approveDraftInteractive(id, io = {}) {
  const isTTY = io.isTTY === undefined
    ? Boolean(process.stdin.isTTY && process.stdout.isTTY)
    : Boolean(io.isTTY);
  const say = typeof io.out === 'function' ? io.out : (s) => process.stdout.write(s + '\n');
  const complain = typeof io.err === 'function' ? io.err : (s) => process.stderr.write('✗ ' + s + '\n');
  const ask = typeof io.ask === 'function' ? io.ask : askLine;

  if (!isTTY) {
    complain('draft approve 只能在人的终端里运行（AI / 脚本 / 管道都不行）——这是人审的唯一入口。');
    return 2;
  }

  const record = readDraft(id);
  say(draftView(record));
  say('');
  const answer = await ask('确认内容无误并批准发布？输入 yes 生成一次性 approvalToken（10 分钟有效）> ');
  if (String(answer).trim().toLowerCase() !== 'yes') {
    complain('已取消批准。');
    return 2;
  }

  const r = approveDraft(id, { reviewer: 'tty' });
  say('');
  say('已批准 ✔');
  say('  approvalToken（只显示这一次，一次性，10 分钟内有效）:');
  say('  ' + r.token);
  say('');
  say('发布: narwhal-forum draft publish ' + id + ' --token <上面的 token>');
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positionals } = parseArgv(argv);
  const command = positionals.shift();
  const rest = positionals;

  if (flags.debug) process.env.NARWHAL_FORUM_DEBUG = '1';
  if (flags.version === true || command === 'version' || command === '-v' || command === '--version') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (!command || command === 'help' || command === '--help' || flags.help === true) {
    process.stdout.write(HELP + '\n');
    return command && command !== 'help' ? 0 : command ? 0 : 0;
  }

  try {
    if (command === 'mcp') {
      const { startStdioServer } = await import('./mcp/server.js');
      const client = clientFrom(flags);
      const { done } = startStdioServer({ client });
      process.stderr.write('[narwhal-forum] MCP stdio server ready (base=' + client.baseUrl + ', auth=' + (client.isAuthenticated ? 'yes' : 'no') + ')\n');
      await done;
      return 0;
    }
    if (command === 'login') return await cmdLogin(flags);
    if (command === 'logout') return await cmdLogout(flags);
    if (command === 'auth') return await cmdAuth(rest[0], flags);
    if (command === 'scope') return await cmdScope(rest[0], flags, rest.slice(1));
    if (command === 'setup') return await cmdSetup(flags);
    if (command === 'risk') return await cmdRisk(flags);
    if (command === 'draft') return await cmdDraft(rest[0], flags, rest.slice(1));
    if (command === 'token') return await cmdToken(rest[0], flags);
    if (command === 'tools') return await cmdTools(flags);
    if (command === 'call') return await cmdCall(flags, rest);

    if (COMMANDS[command]) return await runTool(command, flags, rest);

    process.stderr.write('✗ 未知命令: ' + command + '\n\n' + HELP + '\n');
    return 2;
  } catch (err) {
    const isAuth = err instanceof ForumAuthError;
    const isImage = err instanceof ImageError || (err && err.name === 'ImageError');
    const prefix = isAuth ? '🔒 ' : '✗ ';
    process.stderr.write(prefix + (err && err.message ? err.message : String(err)) + '\n');
    // 有结构化 blockers 就逐条列（带「去哪解决」的路径），比压成一句更有用；否则退回单行 hint。
    if (err && Array.isArray(err.blockers)) {
      for (const b of err.blockers) {
        if (!b || typeof b !== 'object') continue;
        process.stderr.write('   · ' + (b.title || b.code || '待办') + (b.actionLabel ? '（' + b.actionLabel + '）' : '') + (b.actionTo ? '：' + b.actionTo : '') + '\n');
      }
    } else if (err && err.hint) {
      process.stderr.write('   ' + err.hint + '\n');
    }
    if (flags.json && err) process.stdout.write(JSON.stringify({ error: err.name, message: err.message, code: err.code, hint: err.hint, blockers: err.blockers || undefined }, null, 2) + '\n');
    if (err instanceof ForumError && err.detail && flags.verbose) process.stderr.write('   detail: ' + JSON.stringify(err.detail).slice(0, 2000) + '\n');
    return isImage ? 2 : 1;
  }
}

export { HELP, VERSION, COMMANDS, parseArgv, resolveContent, ensureRiskConsent };
