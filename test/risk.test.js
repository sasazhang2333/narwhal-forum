/** 授权前风险提示：文案契约、同意状态、非交互拦截、CLI 实际行为。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockForum, ACCESS_TOKEN } from './mock-forum.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'narwhal-forum.js');

const { RISK_VERSION, RISK_ITEMS, riskNoticeText, riskAcknowledged } = await import('../src/risk.js');

let mock;
let home;

test.before(async () => {
  mock = await startMockForum();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-risk-'));
});

test.after(async () => {
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args, extraEnv = {}, homeDir = home) {
  const env = { ...process.env, NARWHAL_FORUM_HOME: homeDir, NARWHAL_FORUM_BASE_URL: mock.baseUrl };
  delete env.NARWHAL_FORUM_TOKEN;
  delete env.NARWHAL_FORUM_TOKEN_OVERRIDE;
  delete env.NARWHAL_FORUM_REFRESH_TOKEN;
  delete env.NARWHAL_FORUM_ACCEPT_RISK;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr });
    });
  });
}

test('风险提示覆盖六类关键风险，且带版本号', () => {
  assert.ok(RISK_VERSION >= 1);
  assert.ok(RISK_ITEMS.length >= 6);
  const text = riskNoticeText({ baseUrl: 'http://example.test' });
  for (const item of RISK_ITEMS) {
    assert.ok(text.includes(item.title), '缺条目: ' + item.title);
    assert.ok(text.includes(item.text), '缺正文: ' + item.id);
  }
  assert.ok(text.includes('v' + RISK_VERSION), '文案应带版本号');
  assert.match(text, /内容责任/);
  assert.match(text, /AI 不能自行发布/);
  assert.match(text, /实名/);
  assert.match(text, /撤销/);
  assert.match(text, /http:\/\/example\.test/);
});

test('riskAcknowledged 认版本号，旧版本或空凭据都不算', () => {
  assert.equal(riskAcknowledged(null), false);
  assert.equal(riskAcknowledged({}), false);
  assert.equal(riskAcknowledged({ riskAcceptedVersion: RISK_VERSION - 1 }), false);
  assert.equal(riskAcknowledged({ riskAcceptedVersion: RISK_VERSION }), true);
  assert.equal(riskAcknowledged({ riskAcceptedVersion: RISK_VERSION + 1 }), true);
});

test('narwhal-forum risk 打印全文与当前状态', async () => {
  const r = await run(['risk']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /授权前请先阅读风险提示/);
  assert.match(r.stdout, /尚未同意/);
  const j = JSON.parse((await run(['risk', '--json'])).stdout);
  assert.equal(j.riskVersion, RISK_VERSION);
  assert.equal(j.acknowledged, false);
  assert.ok(Array.isArray(j.items) && j.items.length >= 6);
});

test('非交互环境不给 --yes：先打印风险提示再拒绝，且不写凭据', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-risk-no-'));
  try {
    const r = await run(['login', '--username', 'tester'], { NARWHAL_FORUM_PASSWORD: 'sec' + 'ret-pass' }, fresh);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /授权前请先阅读风险提示/);
    assert.match(r.stderr, /非交互|--yes/);
    assert.equal(fs.existsSync(path.join(fresh, 'credentials.json')), false, '未同意不得写凭据');
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('--yes 记录同意版本；再次授权只显示摘要文案但仍展示全文', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-risk-yes-'));
  try {
    const r = await run(['login', '--username', 'tester', '--yes'], { NARWHAL_FORUM_PASSWORD: 'sec' + 'ret-pass' }, fresh);
    assert.equal(r.code, 0, r.stderr);
    const cred = JSON.parse(fs.readFileSync(path.join(fresh, 'credentials.json'), 'utf8'));
    assert.equal(cred.accessToken, ACCESS_TOKEN);
    assert.equal(cred.riskAcceptedVersion, RISK_VERSION);
    assert.ok(cred.riskAcceptedAt);

    const status = JSON.parse((await run(['auth', 'status', '--json'], {}, fresh)).stdout);
    assert.equal(status.riskAcknowledged, true);
    assert.equal(status.riskVersion, RISK_VERSION);

    const again = await run(['login', '--username', 'tester'], { NARWHAL_FORUM_PASSWORD: 'sec' + 'ret-pass' }, fresh);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /授权前请先阅读风险提示/);
    assert.match(again.stdout, /已同意过/);
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});