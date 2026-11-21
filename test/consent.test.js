/**
 * 授权范围（scope）测试：登录时人只给了一部分范围，Agent 就不该越界。
 *
 * 这里既测纯函数，也测真 CLI 的拒绝路径（退出码 + 文案），
 * 因为「被拦住了但退出码还是 0」在脚本里等于没拦。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockForum, ACCESS_TOKEN } from './mock-forum.js';
import {
  SCOPES, ALL_SCOPE_IDS, parseScopeList, checkScope, scopeError, scopeSummary,
} from '../src/consent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'narwhal-forum.js');

test('parseScopeList: all / 子集 / 未知项报错', () => {
  assert.deepEqual(parseScopeList('all'), ALL_SCOPE_IDS);
  assert.deepEqual(parseScopeList(undefined), ALL_SCOPE_IDS);
  assert.deepEqual(parseScopeList('read'), ['read']);
  assert.deepEqual(parseScopeList('write:comment,read'), ['read', 'write:comment'], '按 SCOPES 顺序归一');
  assert.deepEqual(parseScopeList(['read', 'delete']), ['read', 'delete']);
  assert.throws(() => parseScopeList('read,wrtie:comment'), /未知的授权范围/);
  assert.throws(() => parseScopeList('nope'), (e) => e.code === 'E_SCOPE_UNKNOWN');
});

test('checkScope: 未记录范围（旧凭据）按全量放行并标 legacy', () => {
  const info = checkScope('create_post', {});
  assert.equal(info.ok, true);
  assert.equal(info.legacy, true);
  assert.equal(info.need, 'write:post');
});

test('checkScope: 只给 read 时写入类工具被拒', () => {
  const creds = { grantedScopes: ['read'] };
  const write = checkScope('create_comment', creds);
  assert.equal(write.ok, false);
  assert.equal(write.need, 'write:comment');
  assert.equal(checkScope('list_posts', creds).ok, true);
  assert.equal(checkScope('status', creds).ok, true, '状态查询不需要范围');

  const err = scopeError('create_comment', write);
  assert.equal(err.code, 'E_SCOPE_DENIED');
  assert.match(err.message, /当前授权不含「评论与互动」/);
  assert.match(err.message, /已授权范围 = read/);
  assert.match(err.hint, /narwhal-forum login/);
});

test('checkScope: 未知工具不设闸；SCOPES 表与 ALL_SCOPE_IDS 一致', () => {
  assert.equal(checkScope('some_future_tool', { grantedScopes: ['read'] }).ok, true);
  assert.deepEqual(SCOPES.map((s) => s.id), ALL_SCOPE_IDS);
});

test('scopeSummary: 全量 / 子集 / 旧凭据', () => {
  assert.match(scopeSummary(ALL_SCOPE_IDS), /^全部/);
  assert.equal(scopeSummary(['read', 'delete']), 'read, delete');
  assert.match(scopeSummary(null), /旧凭据/);
});

/* ------------------------------------------ 真 CLI：越界必须非零退出 */

let mock;
let home;

test.before(async () => {
  mock = await startMockForum();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-scope-'));
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
    baseUrl: mock.baseUrl,
    accessToken: ACCESS_TOKEN,
    refreshToken: 'REFRESH_TOKEN',
    grantedScopes: ['read'],
    scopesGrantedAt: '2026-01-01T00:00:00.000Z',
  }));
});

test.after(async () => {
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args) {
  const env = { ...process.env, NARWHAL_FORUM_HOME: home, NARWHAL_FORUM_BASE_URL: mock.baseUrl };
  delete env.NARWHAL_FORUM_TOKEN;
  delete env.NARWHAL_FORUM_REFRESH_TOKEN;
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr });
    });
  });
}

test('CLI: 只授权 read 时 new-comment 被拦且退出码 1，没有发出请求', async () => {
  const r = await run(['new-comment', '1', '--content', '不该发出去']);
  assert.equal(r.code, 1);
  assert.match(r.stderr + r.stdout, /当前授权不含「评论与互动」/);
});

test('CLI: 只授权 read 时 posts 正常', async () => {
  const r = await run(['posts', '--page-size', '2']);
  assert.equal(r.code, 0, r.stderr);
});

test('CLI: scope set 能把范围改回来，并写进凭据文件', async () => {
  const r = await run(['scope', 'set', 'all']);
  assert.equal(r.code, 0, r.stderr);
  const creds = JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  assert.deepEqual(creds.grantedScopes, ALL_SCOPE_IDS);
  assert.ok(creds.scopesGrantedAt);
});

test('CLI: scope 命令能展示当前范围', async () => {
  const r = await run(['scope']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /授权范围: 全部|授权范围: read/);
  assert.match(r.stdout, /本次授权范围/);
});
