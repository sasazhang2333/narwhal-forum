import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockForum, ACCESS_TOKEN, REFRESH_TOKEN, EXPIRED_TOKEN } from './mock-forum.js';
import { ForumClient, ForumAuthError, ForumError, flattenComments, isEnvelope } from '../src/client.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-test-'));
process.env.NARWHAL_FORUM_HOME = HOME;

let mock;
test.before(async () => {
  mock = await startMockForum();
});
test.after(async () => {
  await mock.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});
test.beforeEach(() => {
  mock.reset();
  fs.rmSync(path.join(HOME, 'credentials.json'), { force: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NARWHAL_FORUM_') && key !== 'NARWHAL_FORUM_HOME') delete process.env[key];
  }
});

function anon() {
  return new ForumClient({ baseUrl: mock.baseUrl, persist: false });
}

test('匿名可以列帖子，且看不到隐藏帖', async () => {
  const page = await anon().listPosts({ page: 1, pageSize: 20 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((p) => p.id !== 3), 'status!=1 的帖子不应出现');
  assert.equal(page.items[0].content, undefined, '列表项正文应被后端剥离');
});

test('分类过滤与 titleLike 走 Q_ 查询 DSL', async () => {
  const page = await anon().listPosts({ page: 1, pageSize: 20, categoryId: 2 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, 2);
  const hit = await anon().listPosts({ page: 1, pageSize: 20, titleLike: 'dsh' });
  assert.equal(hit.total, 1);
});

test('order 切换到专用端点（hot）', async () => {
  const page = await anon().listPosts({ page: 1, pageSize: 20, order: 'hot' });
  assert.equal(page.order, 'hot');
  assert.equal(page.items[0].id, 2, 'hot 端点返回逆序');
});

test('读帖子详情返回正文并累加浏览数', async () => {
  const client = anon();
  const { post } = await client.getPost(1);
  assert.equal(post.title, '欢迎来到 Narwhal 论坛');
  assert.match(post.content, /欢迎/);
  assert.equal(post.viewCount, 11);
});

test('getPost withComments 一并返回评论树', async () => {
  const { comments, commentsMeta } = await anon().getPost(1, { withComments: true });
  const flat = flattenComments(comments);
  assert.equal(flat.length, 2);
  assert.equal(commentsMeta.total, 2);
  assert.equal(flat[1].depth, 1, '回复应带层级');
});

test('分类 / 频道 / 搜索', async () => {
  const client = anon();
  const cats = await client.listCategories();
  assert.equal(cats.items.length, 2);
  const channels = await client.listChannels();
  assert.equal(channels.items.length, 1);
  const found = await client.searchPosts({ q: '欢迎' });
  assert.equal(found.total, 1);
});

test('未登录发表评论：抛 ForumAuthError 并给引导', async () => {
  await assert.rejects(() => anon().createComment({ postId: 1, content: 'hi' }), (err) => {
    assert.ok(err instanceof ForumAuthError);
    assert.match(err.hint, /login/);
    return true;
  });
});

test('登录（RSA+AES 加密）→ whoami → 评论成功', async () => {
  const client = new ForumClient({ baseUrl: mock.baseUrl, username: 'tester', password: 'secret-pass', persist: true });
  const login = await client.login();
  assert.equal(login.authenticated, true);
  assert.ok(!login.accessToken.includes('test-access-token'), '输出应打码');

  const credFile = path.join(HOME, 'credentials.json');
  const stored = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  assert.equal(stored.accessToken, ACCESS_TOKEN);
  assert.equal(stored.refreshToken, REFRESH_TOKEN);
  assert.ok(!JSON.stringify(stored).includes('secret-pass'), '密码绝不能落盘');

  const me = await client.whoami();
  assert.equal(me.user.userId, 42);

  const created = await client.createComment({ postId: 1, content: '来自 CLI 的评论' });
  assert.equal(created.id, 1002);

  const tree = await client.listComments({ postId: 1 });
  assert.equal(flattenComments(tree).length, 3);
});

test('回复评论带 parentId', async () => {
  const client = new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: ACCESS_TOKEN });
  const created = await client.createComment({ postId: 1, content: '回复 100', parentId: 100, replyUserId: 9 });
  assert.equal(created.id, 1002);
  const tree = await client.listComments({ postId: 1 });
  const root = tree.find((c) => c.id === 100);
  assert.ok(root.children.some((c) => c.id === created.id));
});

test('评论长度与空内容在客户端就被拦下', async () => {
  const client = new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: ACCESS_TOKEN });
  await assert.rejects(() => client.createComment({ postId: 1, content: '   ' }), /不能为空/);
  await assert.rejects(() => client.createComment({ postId: 1, content: 'x'.repeat(2001) }), /2000/);
});

test('冷却错误被翻译成人话', async () => {
  mock.state.enforceCooldown = true;
  const client = new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: ACCESS_TOKEN });
  await client.createComment({ postId: 1, content: '第一次' });
  await assert.rejects(() => client.createComment({ postId: 1, content: '第二次' }), (err) => {
    assert.ok(err instanceof ForumError);
    assert.match(err.hint, /15 秒/);
    return true;
  });
});

test('401 时自动用 refresh token 续期并重放', async () => {
  const client = new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: EXPIRED_TOKEN, refreshToken: REFRESH_TOKEN });
  const me = await client.whoami();
  assert.equal(me.user.userId, 42);
  assert.equal(client.token, ACCESS_TOKEN, '续期后应换成新 token');
});

test('表情互动：白名单校验 + toggle 结果', async () => {
  const client = new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: ACCESS_TOKEN });
  const r = await client.react({ postId: 1, emoji: '🎉' });
  assert.equal(r.toggled, 'on');
  await assert.rejects(() => client.react({ postId: 1, emoji: '💩' }), /不支持的表情/);
});

test('发帖：字段校验 + 成功返回 id', async () => {
  const client = new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: ACCESS_TOKEN });
  await assert.rejects(() => client.createPost({ categoryId: 1, title: '', content: 'x' }), /标题/);
  await assert.rejects(() => client.createPost({ title: 't', content: 'x' }), /categoryId/);
  const created = await client.createPost({ categoryId: 1, title: '新帖', content: '正文' });
  assert.ok(created.id > 0);
});

test('信封识别不会误伤带 status 字段的实体', () => {
  assert.equal(isEnvelope({ status: 0, result: {} }), true);
  assert.equal(isEnvelope({ status: -1, message: 'x' }), true);
  assert.equal(isEnvelope({ id: 1, status: 1, title: 't', content: 'c' }), false);
});

test('连不上后端时给出可执行提示', async () => {
  const client = new ForumClient({ baseUrl: 'http://127.0.0.1:9', persist: false, timeoutMs: 800 });
  await assert.rejects(() => client.listPosts({ page: 1, pageSize: 1 }), (err) => {
    assert.match(err.message, /无法连接论坛后端/);
    assert.match(err.hint, /BASE_URL/);
    return true;
  });
});

/* ---------------------------------------------- 评论树：一级 + /replies 两层端点 */

test('listComments 会自己去拉嵌套回复（一级端点只回直接子级）', async () => {
  const tree = await anon().listComments({ postId: 1 });
  assert.equal(tree.length, 1, '一级只有 seed 里的 id=100');
  assert.equal(tree[0].id, 100);
  assert.ok(Array.isArray(tree[0].children), '必须挂了 children');
  assert.equal(tree[0].children.length, 1, '回复 101 应被拼进 children');
  assert.equal(tree[0].children[0].id, 101);
  assert.ok(
    mock.state.requests.some((r) => String(r.pathname).includes('/api/bbs/comment/100/replies')),
    '应该请求过 /comment/100/replies，实际: ' + JSON.stringify(mock.state.requests.map((r) => r.pathname))
  );
  assert.equal(flattenComments(tree).length, 2, '展平后应是 2 条');
});

test('withReplies=false 时只拉一级，不多打请求', async () => {
  const tree = await anon().listComments({ postId: 1, withReplies: false });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children, undefined);
  assert.ok(!mock.state.requests.some((r) => String(r.pathname).includes('/replies')), '不应请求 /replies');
});

/* ------------------------------------------- 门禁 blockers（HTTP 200 + status=-1） */

test('createComment 被门禁拦下：ForumError 带 blockers 与可执行 hint', async () => {
  const { ForumClient, ForumError } = await import('../src/client.js');
  const client = new ForumClient({ baseUrl: mock.baseUrl, token: ACCESS_TOKEN, persist: false });
  mock.state.gateComment = 'mobile';
  try {
    await assert.rejects(
      () => client.createComment({ postId: 1, content: '手机号门禁' }),
      (err) => {
        assert.ok(err instanceof ForumError);
        assert.match(err.message, /需先绑定手机号/);
        assert.equal(err.blockers.length, 1);
        assert.equal(err.blockers[0].code, 'mobile');
        assert.match(err.hint, /\/forum\/settings\?tab=binding/);
        return true;
      }
    );
  } finally {
    mock.state.gateComment = null;
  }
});

/* ------------------------------------------- 凭据热重载（CLI 登录后不重启宿主也能恢复） */

test('refresh 被踢时重读磁盘凭据并重试一次（MCP 进程不必重启）', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ForumClient } = await import('../src/client.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-reload-'));
  const prev = process.env.NARWHAL_FORUM_HOME;
  process.env.NARWHAL_FORUM_HOME = home;
  try {
    // 磁盘上是「刚刚 CLI login 过」的新凭据
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
      baseUrl: mock.baseUrl,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    }));

    // 进程里握着的是旧的（启动时快照的）凭据
    const client = new ForumClient({
      baseUrl: mock.baseUrl,
      token: 'stale-token-from-startup',
      refreshToken: 'stale-refresh',
      persist: false,
    });
    const me = await client.whoami();
    assert.equal(me.user.userName, 'tester', '应已用磁盘上的新 token 重试成功');
    assert.equal(client.token, ACCESS_TOKEN);
  } finally {
    if (prev === undefined) delete process.env.NARWHAL_FORUM_HOME;
    else process.env.NARWHAL_FORUM_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 1121：服务端能力闸的 403 不能被当成「登录过期」——那会把用户带去重新登录，而真正该做的是去设置页勾回来。
test('403 + X-Cli-Scope-Denied → ForumError(E_SCOPE_DENIED)，不是 ForumAuthError', async () => {
  const forum = await startMockForum();
  try {
    forum.state.scopeDenied = 'write:comment';
    const client = new ForumClient({ baseUrl: forum.baseUrl, token: ACCESS_TOKEN });
    await assert.rejects(
      () => client.react({ postId: 1, emoji: '👍' }),
      (err) => {
        assert.ok(!(err instanceof ForumAuthError), '不能是 ForumAuthError');
        assert.equal(err instanceof ForumError, true);
        assert.equal(err.code, 'E_SCOPE_DENIED');
        assert.equal(err.scope, 'write:comment');
        assert.match(err.message, /授权不含/);
        assert.match(err.hint, /设置 → 账号安全 → AI 工具授权/);
        return true;
      }
    );
  } finally {
    await forum.close();
  }
});
