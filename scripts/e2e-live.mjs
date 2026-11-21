#!/usr/bin/env node
/**
 * 真实后端冒烟测试（不是 mock）。
 *
 * 和 scripts/e2e-mcp.mjs 的分工：
 *   - e2e-mcp.mjs   用 mock 论坛，验证「dsh 桌面端启动器 + MCP 协议 + 图片评论」这条链路，
 *                   不需要真后端、不需要登录，CI 里能跑。
 *   - e2e-live.mjs  这里，连**真实** narwhal_cms 后端，验证「读 / 评论 / 点赞」在真实数据上成立，
 *                   尤其是**雪花 ID 必须以字符串传**这条规律（按数字传会丢精度、后端 404）。
 *
 * 前提：已登录（`narwhal-forum login`，或在 dsh 里调过 login 工具），
 *      并且 NARWHAL_FORUM_BASE_URL 指向后端（默认 http://localhost:8080）。
 *
 * ⚠️ 默认只读。加 --write 才会真的发一条评论 + 点一个表情（会写进真实库）。
 *
 * 用法：
 *   node scripts/e2e-live.mjs                     # 只读冒烟
 *   node scripts/e2e-live.mjs --write             # 连写一起（评论 + 点赞）
 *   node scripts/e2e-live.mjs --post 101589601…   # 指定帖子 id（默认取列表第一条）
 *
 * 退出码：0 全通过 / 1 有失败 / 2 环境不满足（未登录、后端不可达、没有帖子可测）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WRITE = process.argv.includes('--write');
const postArgIdx = process.argv.indexOf('--post');
const POST_ARG = postArgIdx > 0 ? process.argv[postArgIdx + 1] : null;
const BASE = process.env.NARWHAL_FORUM_BASE_URL || 'http://localhost:8080';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}

function rpc(child, pending, id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

/** tools/call 的返回值：正文在 content[0].text，结构化数据在 structuredContent。 */
async function call(child, pending, nextId, name, args) {
  const r = await rpc(child, pending, nextId.id++, 'tools/call', { name, arguments: args });
  if (r && r.isError) throw new Error(name + ' 失败: ' + (r.content && r.content[0] && r.content[0].text));
  return r;
}

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/narwhal-forum.js'), 'mcp'], {
    env: { ...process.env, NARWHAL_FORUM_BASE_URL: BASE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  const nextId = { id: 1 };

  try {
    await rpc(child, pending, nextId.id++, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e-live', version: '1.0.0' },
    });
    const list = await rpc(child, pending, nextId.id++, 'tools/list', {});
    const names = list.tools.map((t) => t.name);
    check('tools/list 返回 20+ 个工具', names.length >= 20, names.length + ' 个');
    check('postId 在 schema 里是 string（雪花 ID 不能按数字传）',
      list.tools.find((t) => t.name === 'get_post').inputSchema.properties.postId.type === 'string');

    // 1) 列表
    const posts = await call(child, pending, nextId, 'list_posts', { page: 1, pageSize: 5, order: 'newest' });
    const page = posts.structuredContent;
    check('list_posts 连上真实后端', Boolean(page) && typeof page.total === 'number', '总数 ' + (page && page.total));
    let postId = POST_ARG || (page && page.items && page.items[0] && page.items[0].id);
    if (!postId) {
      console.error('\n✗ 后端没有可读的帖子，先用 narwhal-forum new-post 或网页发一条再跑。');
      process.exitCode = 2;
      return;
    }
    postId = String(postId);
    check('帖子 id 是字符串（17 位雪花号）', /^\d{15,19}$/.test(postId), postId);

    // 2) 详情（这里就是按数字传会 404 的那一步）
    const detail = await call(child, pending, nextId, 'get_post', { postId, withComments: true });
    const post = detail.structuredContent && detail.structuredContent.post;
    check('get_post 用字符串 id 读到了正文', Boolean(post && post.title), post && post.title);

    // 3) 评论树
    const comments = await call(child, pending, nextId, 'list_comments', { postId });
    check('list_comments 可读', Boolean(comments.structuredContent), '共 ' + (comments.structuredContent && comments.structuredContent.total) + ' 条');

    if (!WRITE) {
      console.log('（只读模式：跳过 create_comment / react_post；加 --write 才会写真实库）');
    } else {
      const body = '联调冒烟测试评论 ' + new Date().toISOString() + '（scripts/e2e-live.mjs --write 生成）';
      const created = await call(child, pending, nextId, 'create_comment', { postId, content: body });
      const newId = created.structuredContent && (created.structuredContent.id || created.structuredContent.commentId);
      check('create_comment 写入了真实库', Boolean(newId), 'comment id=' + newId);

      const reacted = await call(child, pending, nextId, 'react_post', { postId, emoji: '👍' });
      check('react_post 可用', Boolean(reacted.structuredContent), JSON.stringify(reacted.structuredContent));

      // 审核链路：发帖 → （待审就批准）→ 删掉自己造的这条，别在真实库里留垃圾
      const draft = await call(child, pending, nextId, 'create_post', {
        categoryId: 1,
        title: '联调冒烟帖 ' + new Date().toISOString(),
        content: 'scripts/e2e-live.mjs --write 生成，跑完自删。',
      });
      const madeId = draft.structuredContent && draft.structuredContent.id;
      const madeStatus = draft.structuredContent && draft.structuredContent.status;
      check('create_post 返回真实 status', Boolean(madeId), 'id=' + madeId + ' status=' + madeStatus);
      if (madeStatus === -1) {
        const approved = await call(child, pending, nextId, 'approve_post', { postId: String(madeId) });
        check('approve_post 批准了待审帖', !approved.isError, approved.content && approved.content[0] && approved.content[0].text);
      }
      if (madeId) {
        const removed = await call(child, pending, nextId, 'delete_post', { postId: String(madeId), confirm: true });
        check('delete_post 清掉了冒烟帖', !removed.isError, removed.content && removed.content[0] && removed.content[0].text);
      }
    }
  } catch (err) {
    check('整体流程', false, err.message);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

await main();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exitCode = 1;