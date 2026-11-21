/**
 * P0 人审发布状态机测试：AI 不能自行发布。
 *
 * 覆盖：内容指纹 / token 一次性 / TTL / 篡改 / 批准后改稿 / CLI 非 TTY 拒绝批准 /
 *       发布必须带 token / 发布前实名强校验 / MCP 侧没有 approve 工具 / 端到端写入 mock 论坛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockForum, ACCESS_TOKEN } from './mock-forum.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-draft-'));
process.env.NARWHAL_FORUM_HOME = HOME;

const draft = await import('../src/draft.js');
const { ForumClient } = await import('../src/client.js');
const { TOOL_MAP, TOOLS } = await import('../src/mcp/tools.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'narwhal-forum.js');

let mock;
test.before(async () => {
  mock = await startMockForum();
});
test.after(async () => {
  await mock.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

function runCli(args) {
  const env = { ...process.env, NARWHAL_FORUM_HOME: HOME, NARWHAL_FORUM_BASE_URL: mock.baseUrl, NARWHAL_FORUM_TOKEN: ACCESS_TOKEN };
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr });
    });
  });
}

function newCommentDraft(content, postId) {
  return draft.createDraft({
    kind: 'comment',
    payload: { postId: postId || 1, content: content || '这是一条草稿' },
    author: { userId: 42, userName: 'tester' },
  });
}

/* ---------------------------------------------------------------- 状态机本身 */

test('内容指纹对 payload 敏感、对 key 顺序不敏感', () => {
  const a = draft.draftHash('comment', { postId: 1, content: 'hi' });
  const b = draft.draftHash('comment', { content: 'hi', postId: 1 });
  const c = draft.draftHash('comment', { postId: 1, content: 'hi!' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('批准 → token 可校验；重放被拒（一次性）', () => {
  const rec = newCommentDraft('一次性 token 测试');
  const { token } = draft.approveDraft(rec.id);
  assert.match(token, /^nfap_drf-[0-9a-f]{8}\./);
  const approved = draft.readDraft(rec.id);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(draft.verifyApprovalToken(approved, token, { userId: 42 }), { ok: true });
  draft.markPublished(approved, { resultId: 1 });
  const after = draft.readDraft(rec.id);
  const again = draft.verifyApprovalToken(after, token, { userId: 42 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'E_APPROVAL_USED');
});

test('token 过期即失效（TTL 由批准时写入）', () => {
  const rec = newCommentDraft('过期测试');
  const { token } = draft.approveDraft(rec.id, { ttlMs: -1000 });
  const back = draft.readDraft(rec.id);
  const v = draft.verifyApprovalToken(back, token, { userId: 42 });
  assert.equal(v.ok, false);
  assert.ok(['E_APPROVAL_EXPIRED', 'E_DRAFT_STATUS'].includes(v.code), v.code);
});

test('批准后改内容 → 旧 token 作废（防批准 A 发布 B）', () => {
  const rec = newCommentDraft('原始内容');
  const { token } = draft.approveDraft(rec.id);
  const record = draft.readDraft(rec.id);
  const tampered = { ...record, hash: draft.draftHash('comment', record.payload) };
  tampered.payload = { ...record.payload, content: '被换掉的内容' };
  tampered.hash = draft.draftHash('comment', tampered.payload);
  tampered.status = 'approved';
  const v = draft.verifyApprovalToken(tampered, token, { userId: 42 });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'E_APPROVAL_HASH_MISMATCH');
});

test('篡改签名 / 换用户 / 未批准 都被拒', () => {
  const rec = newCommentDraft('签名测试');
  const unapproved = draft.readDraft(rec.id);
  assert.equal(draft.verifyApprovalToken(unapproved, 'nfap_a.b.c.d.e.f.g', {}).code, 'E_APPROVAL_REQUIRED');
  const { token } = draft.approveDraft(rec.id);
  const approved = draft.readDraft(rec.id);
  const parts = token.split('.');
  const badSig = parts.slice(0, 6).join('.') + '.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefde';
  assert.equal(draft.verifyApprovalToken(approved, badSig, {}).code, 'E_APPROVAL_INVALID');
  assert.equal(draft.verifyApprovalToken(approved, token, { userId: 7 }).code, 'E_APPROVAL_USER');
  assert.equal(draft.verifyApprovalToken(approved, null, {}).code, 'E_APPROVAL_REQUIRED');
});

test('MCP 工具表里没有「草稿」批准类工具（草稿放行只能发生在人的终端）', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('draft_create'));
  assert.ok(names.includes('draft_publish'));
  // 注意区分两种 approve：
  //   · draft 的 approve（拿一次性 approvalToken）—— MCP 侧**故意没有**，只能在人的终端跑；
  //   · 帖子审核的 approve_post —— 那是版主/管理员动作，权限由后端 canModeratePost 判，
  //     和「AI 不许自己放行自己写的内容」这条闸无关。
  assert.ok(!names.some((n) => /draft/i.test(n) && /approve|accept/i.test(n)), 'MCP 不应暴露 draft 批准工具，实际: ' + names.join(','));
  assert.ok(names.includes('approve_post'), '帖子审核批准工具应当存在（版主用）');
  const publish = TOOLS.find((t) => t.name === 'draft_publish');
  assert.ok(publish.inputSchema.required.includes('approvalToken'), 'draft_publish 必须强制要求 approvalToken');
});

/* ---------------------------------------------------------------- CLI 契约 */

test('draft new-comment 落本地草稿，不碰后端', async () => {
  const r = await runCli(['draft', 'new-comment', '1', '--content', 'CLI 建的草稿', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const record = JSON.parse(r.stdout);
  assert.equal(record.status, 'pending_review');
  // 雪花 ID 必须是字符串：后端主键约 1e17，超过 2^53，按数字传会丢精度（真实环境实测踩到）。
  assert.equal(record.payload.postId, '1');
  assert.equal(typeof record.payload.postId, 'string');
  assert.match(r.stderr, /$|/);
});

test('draft approve 非 TTY 一律拒绝，且状态不变', async () => {
  const rec = newCommentDraft('非 TTY 批准测试');
  const r = await runCli(['draft', 'approve', rec.id]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /只能在人的终端里运行/);
  assert.equal(draft.readDraft(rec.id).status, 'pending_review');
});

test('draft publish 不带 token → 拒绝', async () => {
  const rec = newCommentDraft('无 token 发布测试');
  const r = await runCli(['draft', 'publish', rec.id]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /approvalToken/);
});

test('draft publish 用 --yes 之类也绕不过（没有这个参数）', async () => {
  const rec = newCommentDraft('绕过测试');
  const r = await runCli(['draft', 'publish', rec.id, '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /approvalToken/);
});

test('端到端：人批准 → CLI 发布 → 评论真的进了论坛；重放失败', async () => {
  const rec = newCommentDraft('端到端：人批准后发布');
  const { token } = draft.approveDraft(rec.id, { reviewer: 'tty' });
  const before = mock.state.comments.length;
  const r = await runCli(['draft', 'publish', rec.id, '--token', token, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.published, true);
  assert.ok(out.resultId);
  assert.equal(mock.state.comments.length, before + 1);
  assert.equal(draft.readDraft(rec.id).status, 'published');
  const again = await runCli(['draft', 'publish', rec.id, '--token', token]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /E_APPROVAL_USED|E_DRAFT_STATUS/);
});

test('发布前强校验实名：verifiedType=0 → exit 3 且不写入、token 不消费', async () => {
  mock.state.realname = 0;
  try {
    const rec = newCommentDraft('未实名发布测试');
    const { token } = draft.approveDraft(rec.id);
    const before = mock.state.comments.length;
    const r = await runCli(['draft', 'publish', rec.id, '--token', token]);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /实名/);
    assert.equal(mock.state.comments.length, before);
    const after = draft.readDraft(rec.id);
    assert.equal(after.status, 'approved');
    assert.equal(after.approval.usedAt, null);
  } finally {
    mock.state.realname = 1;
  }
});

test('实名通过后同一个 token 仍可用（未消费）', async () => {
  mock.state.realname = 1;
  const rec = newCommentDraft('实名后重试');
  const { token } = draft.approveDraft(rec.id);
  const r = await runCli(['draft', 'publish', rec.id, '--token', token]);
  assert.equal(r.code, 0, r.stderr);
});

/* ---------------------------------------------------------------- MCP 侧 */

function mcpCtx() {
  return { client: new ForumClient({ baseUrl: mock.baseUrl, token: ACCESS_TOKEN }) };
}

test('MCP draft_publish 没有 token → isError E_APPROVAL_REQUIRED', async () => {
  const created = await TOOL_MAP.get('draft_create').handler(mcpCtx(), { kind: 'comment', postId: 1, content: 'MCP 草稿' });
  const draftId = created.data.draftId;
  await assert.rejects(
    () => TOOL_MAP.get('draft_publish').handler(mcpCtx(), { draftId }),
    (err) => {
      assert.equal(err.code, 'E_APPROVAL_REQUIRED');
      assert.match(err.hint, /draft approve/);
      return true;
    },
  );
  assert.equal(draft.readDraft(draftId).status, 'pending_review');
});

test('MCP 端到端：draft_create → 人批准 → draft_publish 写入成功', async () => {
  const created = await TOOL_MAP.get('draft_create').handler(mcpCtx(), { kind: 'comment', postId: 1, content: 'MCP 端到端评论' });
  const draftId = created.data.draftId;
  const { token } = draft.approveDraft(draftId, { reviewer: 'tty' });
  const before = mock.state.comments.length;
  const out = await TOOL_MAP.get('draft_publish').handler(mcpCtx(), { draftId, approvalToken: token });
  assert.match(out.text, /已发布/);
  assert.equal(mock.state.comments.length, before + 1);
  assert.equal(draft.readDraft(draftId).status, 'published');
});

test('MCP draft_get / draft_list 能读到草稿', async () => {
  const rec = newCommentDraft('列表可见');
  const list = await TOOL_MAP.get('draft_list').handler(mcpCtx(), {});
  assert.ok(list.data.total >= 1);
  const got = await TOOL_MAP.get('draft_get').handler(mcpCtx(), { draftId: rec.id });
  assert.match(got.text, new RegExp(rec.id));
  assert.match(got.text, /待人工批准/);
});

/* ------------------------------------------------ 批准路径（注入假 TTY） */

const { approveDraftInteractive } = await import('../src/cli.js');

test('批准路径：假 TTY + 输入 yes → 草稿变 approved 且 token 真的能校验', async () => {
  const rec = newCommentDraft('批准路径待发正文');
  const lines = [];
  const code = await approveDraftInteractive(rec.id, {
    isTTY: true,
    ask: async () => 'yes',
    out: (s) => lines.push(String(s)),
  });
  assert.equal(code, 0);

  const text = lines.join('\n');
  assert.match(text, /approvalToken/);
  assert.match(text, /只显示这一次/);

  const after = draft.readDraft(rec.id);
  assert.equal(after.status, 'approved');
  assert.ok(after.approval && after.approval.tokenHash, '只落 hash，不落 token 本体');
  assert.equal(after.approval.tokenHash.includes('nfap_'), false);

  const token = (text.match(/nfap_[A-Za-z0-9_.\-]+/) || [])[0];
  assert.ok(token, '批准时必须把 token 打印出来');
  const v = draft.verifyApprovalToken(after, token, {});
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('批准路径：输入不是 yes → 取消，状态不变，不发 token', async () => {
  const rec = newCommentDraft('这是一条带图片的评论');
  const lines = [];
  const code = await approveDraftInteractive(rec.id, {
    isTTY: true,
    ask: async () => 'no',
    out: (s) => lines.push(String(s)),
  });
  assert.equal(code, 2);
  assert.equal(lines.join('\n').includes('nfap_'), false);
  const after = draft.readDraft(rec.id);
  assert.equal(after.status, 'pending_review');
  assert.ok(!after.approval, '取消后不应写入任何 token 记录');
});

test('批准路径：注入 isTTY=false 一律拒绝（没有任何环境变量能绕过）', async () => {
  const rec = newCommentDraft('不该被批准');
  const code = await approveDraftInteractive(rec.id, {
    isTTY: false,
    ask: async () => 'yes',
    out: () => {},
  });
  assert.equal(code, 2);
  assert.equal(draft.readDraft(rec.id).status, 'pending_review');
});
