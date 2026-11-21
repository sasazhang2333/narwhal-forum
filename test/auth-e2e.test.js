/** 浏览器授权端到端：真的拉起 Chromium（headless），从页面 localStorage 取 token。
 *  没有 Chromium 的机器自动跳过，保证 CI 可跑。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-auth-e2e-'));
process.env.NARWHAL_FORUM_HOME = tmpHome;

const { findBrowser, browserLogin, browserProfileDir } = await import('../src/auth.js');
const { readCredentials } = await import('../src/config.js');

/** 重试删除：Chromium 退出后仍在写 profile，force 也压不住 ENOTEMPTY。 */
function rmQuiet(dir) {
  for (let i = 0; i < 10; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch {
      // 还在写，睡一下再试
    }
  }
}

let browser = null;
try { browser = findBrowser(); } catch { browser = null; }

test('浏览器授权端到端：打开登录页 → 读到 token → 写入凭据', { skip: browser ? false : '本机没有 Chromium 系浏览器' }, async () => {
  const page = '<!doctype html><meta charset="utf-8"><title>login</title><script>setTimeout(()=>{localStorage.setItem("auth_token","e2e-access");localStorage.setItem("auth_refresh_token","e2e-refresh")},150)</script>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  try {
    const r = await browserLogin({
      baseUrl,
      timeoutMs: 30000,
      browserPath: browser,
      extraArgs: ['--headless=new', '--disable-gpu', '--no-sandbox'],
      log: () => {},
    });
    assert.equal(r.accessToken, 'e2e-access');
    assert.equal(r.refreshToken, 'e2e-refresh');
    const stored = readCredentials();
    assert.equal(stored.accessToken, 'e2e-access');
    assert.equal(stored.authMode, 'browser');
    assert.ok(stored.browserProfile);
  } finally {
    server.close();
    // Chromium 关窗后还会往 profile 里写几百毫秒，立刻 rm 会 ENOTEMPTY
    rmQuiet(browserProfileDir());
    rmQuiet(tmpHome);
  }
});
