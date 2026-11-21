#!/usr/bin/env node
/**
 * 端到端验证：用 dsh 桌面端**实际会执行的同一条命令**跑一遍 MCP。
 *
 * 为什么需要它：桌面进程的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 所以 bundle 里的 `command: narwhal-forum` 起不来；线上真正跑的是
 * examples/narwhal-forum-mcp 那个启动器。这个脚本就 spawn 启动器，
 * 在一个干净的 env 里（PATH 只有系统目录、没有 nvm）走完
 * initialize → tools/list → 读 → 上传图片 → 带图评论。
 *
 * 用法：
 *   node scripts/e2e-mcp.mjs                     # 默认用 ~/.dsh/bin/narwhal-forum-mcp
 *   NARWHAL_FORUM_LAUNCHER=/path/to/launcher node scripts/e2e-mcp.mjs
 *   node scripts/e2e-mcp.mjs --keep-mock         # 保留 mock 论坛，便于手工再看
 *
 * 退出码：0 全部通过 / 1 有断言失败。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockForum } from '../test/mock-forum.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = process.env.HOME || tmpdir();
const LAUNCHER = process.env.NARWHAL_FORUM_LAUNCHER || path.join(HOME, '.dsh/bin/narwhal-forum-mcp');
const KEEP = process.argv.includes('--keep-mock');

// 1x1 透明 PNG（70 B）：足够让「是不是图片」和 multipart 都跑通
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail && detail.stack ? detail.stack.split('\n')[0] : detail) });
}

/** 一次 JSON-RPC 调用（每行一个 JSON，服务端按行读）。 */
function rpc(child, pending, id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

async function main() {
  const mock = await startMockForum();
  const home = await mkdtemp(path.join(tmpdir(), 'nf-e2e-'));
  const pngPath = path.join(home, 'shot.png');
  await writeFile(pngPath, PNG);

  // 与桌面端同构的环境：PATH 只有系统目录，没有任何 node / npx
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME,
    NARWHAL_FORUM_BASE_URL: mock.baseUrl,
    NARWHAL_FORUM_HOME: home,
  };

  const login = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/narwhal-forum.js'), 'login', '--username', 'tester', '--password', 'secret-pass', '--accept-risk', '--json'], { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  check('CLI 登录（账号密码）', login.code === 0, login.code + ' ' + (login.err || '').slice(0, 200));

  const child = spawn(LAUNCHER, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  const call = (id, method, params) => rpc(child, pending, id, method, params);

  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'narwhal-forum-e2e', version: '0' } });
    check('MCP initialize', init && init.serverInfo && init.serverInfo.name === 'narwhal-forum', JSON.stringify(init && init.serverInfo));

    const tools = await call(2, 'tools/list', {});
    const names = (tools.tools || []).map((t) => t.name);
    check('tools/list 返回 20+ 个能力', names.length >= 20, names.length + ' :: ' + names.join(','));
    check('包含 upload_image', names.includes('upload_image'), '');
    const cc = (tools.tools || []).find((t) => t.name === 'create_comment');
    check('create_comment 支持 images', cc && cc.inputSchema && cc.inputSchema.properties && cc.inputSchema.properties.images, '');

    const list = await call(3, 'tools/call', { name: 'list_posts', arguments: { page: 1, pageSize: 3 } });
    const listText = list.content[0].text;
    check('list_posts 读到帖子', listText.length > 20, listText.split('\n')[0]);

    const up = await call(4, 'tools/call', { name: 'upload_image', arguments: { path: pngPath } });
    check('upload_image 拿到 URL', /uploads\/mock/.test(up.content[0].text), up.content[0].text.split('\n')[0]);

    const postId = mock.state.posts[0].id;
    const cm = await call(5, 'tools/call', { name: 'create_comment', arguments: { postId, content: 'E2E 图片评论', images: [pngPath] } });
    const saved = (mock.state.comments || []).find((c) => String(c.content).includes('E2E 图片评论'));
    check('create_comment 成功', Boolean(saved), cm.content[0].text.split('\n')[0]);
    check('评论正文内联 markdown 图片', saved && /!\[\]\(http/.test(String(saved.content)), saved ? String(saved.content).slice(0, 160) : '没找到评论');
    check('图片上传端点被调用两次（显式 + 自动）', mock.state.uploads.length >= 2, 'uploads=' + mock.state.uploads.length);
  } finally {
    child.kill();
    if (!KEEP) await mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok  ' : ' FAIL ') + r.name + (r.detail ? '  → ' + r.detail : ''));
  console.log('');
  console.log(failed.length ? '✗ ' + failed.length + '/' + results.length + ' 项失败' : '✓ ' + results.length + '/' + results.length + ' 项通过');
  if (stderr.trim()) console.log('（启动器 stderr）' + stderr.trim().split('\n').slice(0, 3).join(' | '));
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
