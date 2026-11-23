/**
 * 草稿上云（1121）：/api/cli/draft 的服务端草稿。
 *
 * 这条链路的关键不是「能不能存」，而是**没有人在网页上点过批准，工具就领不到内容**。
 * 所以这里刻意用两条线：工具侧只能提交/读/领取，批准只发生在「人」那一侧（这里用一次
 * 直接打接口的调用模拟人在网页上点按钮）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockForum, ACCESS_TOKEN } from './mock-forum.js';
import { TOOLS } from '../src/mcp/tools.js';
import { ForumClient } from '../src/client.js';

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'narwhal-forum.js');

let mock;
let home;

test.before(async () => {
  mock = await startMockForum();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-serverdraft-'));
  await run(['token', 'set', '--access', ACCESS_TOKEN]);
});

test.after(async () => {
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args, extraEnv = {}) {
  const env = { ...process.env, NARWHAL_FORUM_HOME: home, NARWHAL_FORUM_BASE_URL: mock.baseUrl };
  delete env.NARWHAL_FORUM_TOKEN;
  delete env.NARWHAL_FORUM_REFRESH_TOKEN;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr });
    });
  });
}

/** 人在网页上点「批准/拒绝」——工具侧没有这个入口，这里直接打接口模拟。 */
async function humanReview(code, decision, note) {
  const res = await fetch(mock.baseUrl + '/api/cli/draft/' + code + '/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ACCESS_TOKEN },
    body: JSON.stringify({ decision, note }),
  });
  return res.json();
}

test('draft new-comment --server：拿到 DR- 编号与给人打开的审理页', async () => {
  const r = await run(['draft', 'new-comment', '1', '--content', '站点侧草稿正文', '--server', '--web-url', 'http://web.local']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /DR-[0-9A-F]{8}/);
  assert.match(r.stdout, /http:\/\/web\.local\/cli\/draft\?code=DR-/);
  assert.match(r.stdout, /内容指纹/);
});

test('没批准就发布：领不到内容，也不产生任何评论', async () => {
  const created = await run(['draft', 'new-comment', '1', '--content', '未批准的', '--server', '--json']);
  const draft = JSON.parse(created.stdout);
  const before = mock.state.comments.length;

  const r = await run(['draft', 'publish', draft.draftCode]);
  assert.notEqual(r.code, 0, '未批准的草稿不该发布成功');
  assert.match(r.stderr + r.stdout, /不是「已批准」状态/);
  assert.equal(mock.state.comments.length, before, '失败时不该写入任何评论');
});

test('批准之后才发得出去，且只能发一次（领取即失效）', async () => {
  const created = await run(['draft', 'new-comment', '1', '--content', '人工批准后发布', '--server', '--json']);
  const draft = JSON.parse(created.stdout);

  const reviewed = await humanReview(draft.draftCode, 'approve');
  assert.equal(reviewed.result.status, 'approved');

  const before = mock.state.comments.length;
  const pub = await run(['draft', 'publish', draft.draftCode]);
  assert.equal(pub.code, 0, pub.stderr);
  assert.equal(mock.state.comments.length, before + 1, '批准后的草稿应当真的发出评论');
  assert.equal(mock.state.comments.find((c) => c.content.includes('人工批准后发布')) !== undefined, true);
  assert.equal(mock.state.drafts.get(draft.draftCode).status, 'published');
  assert.equal(mock.state.drafts.get(draft.draftCode).resultId !== undefined, true, '发布后要回报产物 id');
  assert.equal(mock.state.lastCommentDraftCode, draft.draftCode,
    '1124: 发布时要把 draftCode 一起发给 create，服务端才能据此跳过待审');

  const again = await run(['draft', 'publish', draft.draftCode]);
  assert.notEqual(again.code, 0, '同一条批准不能发两次');
  assert.equal(mock.state.comments.length, before + 1, '第二次不该再写一条');
});

test('被拒绝的草稿发不出去', async () => {
  const created = await run(['draft', 'new-comment', '1', '--content', '会被拒绝的', '--server', '--json']);
  const draft = JSON.parse(created.stdout);
  const reviewed = await humanReview(draft.draftCode, 'deny', '不合适');
  assert.equal(reviewed.result.status, 'denied');

  const r = await run(['draft', 'publish', draft.draftCode]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /不是「已批准」状态/);
});

test('draft list --server / draft show DR- 能读到站点侧草稿', async () => {
  const created = await run(['draft', 'new-post', '--category', '1', '--title', '站点侧帖子草稿', '--content', '正文', '--server', '--json']);
  const draft = JSON.parse(created.stdout);

  const list = await run(['draft', 'list', '--server']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, new RegExp(draft.draftCode));

  const show = await run(['draft', 'show', draft.draftCode]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /站点侧帖子草稿/);
  assert.match(show.stdout, /待审/);
});

test('本地草稿仍然是默认路径（不加 --server 不碰后端）', async () => {
  const before = mock.state.drafts.size;
  const r = await run(['draft', 'new-comment', '1', '--content', '本地草稿', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const record = JSON.parse(r.stdout);
  assert.match(record.id, /^drf-/);
  assert.equal(mock.state.drafts.size, before, '默认不该把草稿交给站点');
});


/* ---------------------------------------------------------------- MCP 侧 */

function mcpCtx() {
  return { client: new ForumClient({ baseUrl: mock.baseUrl, token: ACCESS_TOKEN }), clientName: 'narwhal-forum@test' };
}

test('MCP draft_create mode=server：返回 draftCode + reviewUrl，且默认仍是本地草稿', async () => {
  const server = await TOOL_MAP.get('draft_create').handler(mcpCtx(), {
    kind: 'comment', postId: 1, content: 'MCP 服务端草稿', mode: 'server',
  });
  assert.match(server.data.draftCode, /^DR-/);
  assert.match(server.text, /给人打开的审理页/);
  assert.equal(server.data.status, 'pending');

  const local = await TOOL_MAP.get('draft_create').handler(mcpCtx(), { kind: 'comment', postId: 1, content: 'MCP 本地草稿' });
  assert.match(local.data.draftId, /^drf-/);
  assert.equal(local.data.draftCode, undefined);
});

test('MCP draft_publish draftCode：未批准 → 报错且不产生评论；批准后 → 发出并回报 id', async () => {
  const created = await TOOL_MAP.get('draft_create').handler(mcpCtx(), {
    kind: 'comment', postId: 1, content: 'MCP 待批草稿', mode: 'server',
  });
  const code = created.data.draftCode;

  await assert.rejects(
    () => TOOL_MAP.get('draft_publish').handler(mcpCtx(), { draftCode: code }),
    (err) => {
      assert.equal(err.code, 'E_DRAFT_PUBLISH');
      return true;
    },
  );

  await humanReview(code, 'approve');
  const before = mock.state.comments.length;
  const out = await TOOL_MAP.get('draft_publish').handler(mcpCtx(), { draftCode: code });
  assert.equal(mock.state.comments.length, before + 1);
  assert.match(out.text, /已按站点侧草稿/);
  assert.equal(mock.state.drafts.get(code).status, 'published');
});
