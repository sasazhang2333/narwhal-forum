/**
 * 浏览器授权登录的单元测试。
 *
 * 不打真实浏览器：把「拿 token 的方式」抽成可注入的 evaluate，
 * 这里用假 evaluate 覆盖成功/超时/异常三条路径；
 * 撤销授权用临时 NARWHAL_FORUM_HOME + 假后端（backend:false）验证副作用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-auth-test-'));
process.env.NARWHAL_FORUM_HOME = tmpHome;

const {
  parseDevToolsActivePort,
  buildLaunchArgs,
  extractTokens,
  waitForTokens,
  READ_TOKENS_EXPRESSION,
  findBrowser,
  browserProfileDir,
  revokeAuth,
  authStatus,
  applyTokens,
} = await import('../src/auth.js');
const { writeCredentials, readCredentials, credentialsPath } = await import('../src/config.js');

test('parseDevToolsActivePort 解析端口与 ws 路径', () => {
  assert.deepEqual(parseDevToolsActivePort('42222\n/devtools/browser/abc\n'), { port: 42222, wsPath: '/devtools/browser/abc' });
  assert.deepEqual(parseDevToolsActivePort('1234'), { port: 1234, wsPath: '' });
  assert.equal(parseDevToolsActivePort(''), null);
  assert.equal(parseDevToolsActivePort('not-a-port\n'), null);
});

test('buildLaunchArgs 用独立 profile + 随机调试端口 + 目标地址', () => {
  const args = buildLaunchArgs('/tmp/profile', 'http://127.0.0.1:8080/login');
  assert.ok(args.includes('--user-data-dir=/tmp/profile'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.equal(args[args.length - 1], 'http://127.0.0.1:8080/login');
});

test('extractTokens 容错解析（字符串 JSON / 对象 / 无效）', () => {
  assert.deepEqual(extractTokens('{"a":"acc","r":"ref"}'), { accessToken: 'acc', refreshToken: 'ref' });
  assert.deepEqual(extractTokens({ access_token: 'acc' }), { accessToken: 'acc', refreshToken: null });
  assert.equal(extractTokens('{"a":null,"r":null}'), null);
  assert.equal(extractTokens('not json'), null);
  assert.equal(extractTokens(undefined), null);
});

test('waitForTokens 在拿到 token 后立刻返回', async () => {
  let calls = 0;
  const tokens = await waitForTokens(async (expr) => {
    assert.equal(expr, READ_TOKENS_EXPRESSION);
    calls += 1;
    return calls < 3 ? '{"a":null}' : '{"a":"acc","r":"ref"}';
  }, { timeoutMs: 5000, intervalMs: 1 });
  assert.deepEqual(tokens, { accessToken: 'acc', refreshToken: 'ref' });
  assert.equal(calls, 3);
});

test('waitForTokens 超时抛 LOGIN_TIMEOUT', async () => {
  let fake = 0;
  const now = () => (fake += 700);
  await assert.rejects(
    () => waitForTokens(async () => '{"a":null}', { timeoutMs: 1400, intervalMs: 1, now }),
    (err) => {
      assert.equal(err.code, 'LOGIN_TIMEOUT');
      assert.match(err.hint, /narwhal-forum login/);
      return true;
    },
  );
});

test('waitForTokens 透传 fatal 错误（浏览器被关掉）', async () => {
  const fatal = Object.assign(new Error('浏览器窗口被关闭，登录未完成'), { fatal: true });
  await assert.rejects(() => waitForTokens(async () => { throw fatal; }, { timeoutMs: 5000, intervalMs: 1 }), /浏览器窗口被关闭/);
});

test('findBrowser 优先使用显式路径，坏路径直接报错', () => {
  assert.equal(findBrowser(process.execPath), process.execPath);
  assert.throws(() => findBrowser('/definitely/not/here/chrome'), /不可执行/);
});

test('browserProfileDir 跟随 NARWHAL_FORUM_HOME', () => {
  const dir = browserProfileDir();
  assert.equal(dir, path.join(tmpHome, 'browser'));
  const prev = process.env.NARWHAL_FORUM_BROWSER_PROFILE;
  process.env.NARWHAL_FORUM_BROWSER_PROFILE = path.join(tmpHome, 'custom-profile');
  try {
    assert.equal(browserProfileDir(), path.join(tmpHome, 'custom-profile'));
  } finally {
    if (prev === undefined) delete process.env.NARWHAL_FORUM_BROWSER_PROFILE;
    else process.env.NARWHAL_FORUM_BROWSER_PROFILE = prev;
  }
});

test('revokeAuth 删除凭据与浏览器 profile（backend:false 不联后端）', async () => {
  writeCredentials({ baseUrl: 'http://127.0.0.1:8080', accessToken: 'acc', refreshToken: 'ref', authMode: 'browser' });
  const profile = browserProfileDir();
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'Cookies'), 'x');

  const r = await revokeAuth({ baseUrl: 'http://127.0.0.1:8080', backend: false });
  assert.equal(r.backendLogout, 'skipped');
  assert.equal(r.tokenRemoved, true);
  assert.equal(r.profileRemoved, true);
  assert.equal(fs.existsSync(profile), false);
  assert.equal(fs.existsSync(credentialsPath()), false);
});

test('revokeAuth keepBrowser 保留 profile 但仍清 token', async () => {
  writeCredentials({ baseUrl: 'http://127.0.0.1:8080', accessToken: 'acc', authMode: 'browser' });
  const profile = browserProfileDir();
  fs.mkdirSync(profile, { recursive: true });
  const r = await revokeAuth({ baseUrl: 'http://127.0.0.1:8080', backend: false, keepBrowser: true });
  assert.equal(r.profileRemoved, false);
  assert.equal(fs.existsSync(profile), true);
  assert.equal(fs.existsSync(credentialsPath()), false);
});

test('authStatus 反映登录态与授权方式', () => {
  const anon = authStatus();
  assert.equal(anon.loggedIn, false);
  assert.equal(anon.authMode, 'none');

  writeCredentials({ baseUrl: 'http://127.0.0.1:8080', accessToken: 'acc', refreshToken: 'ref', authMode: 'browser', loggedInAt: '2026-11-21T10:00:00.000Z' });
  const authed = authStatus();
  assert.equal(authed.loggedIn, true);
  assert.equal(authed.authMode, 'browser');
  assert.equal(authed.hasRefreshToken, true);
  assert.equal(authed.loggedInAt, '2026-11-21T10:00:00.000Z');
  assert.equal(typeof authed.canBrowserLogin, 'boolean');
  assert.equal(readCredentials().accessToken, 'acc');
});

test('applyTokens 把 token 注入客户端', () => {
  const client = { token: null, refreshToken: null };
  applyTokens(client, { accessToken: 'acc', refreshToken: 'ref' });
  assert.equal(client.token, 'acc');
  assert.equal(client.refreshToken, 'ref');
  applyTokens(client, null);
  assert.equal(client.token, 'acc');
});

test('cleanup', () => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
