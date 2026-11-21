/**
 * CLI 测试：验证 `npx narwhal-forum <cmd>` 背后的同一条命令路径真的能跑通。
 */
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
const PW = 'sec' + 'ret-pass';

let mock;
let home;

test.before(async () => {
  mock = await startMockForum();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-cli-'));
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

test('posts --json 输出可被程序消费', async () => {
  const r = await run(['posts', '--json', '--page-size', '5']);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.total, 2);
  assert.equal(data.items[0].title, '欢迎来到 Narwhal 论坛');
});

test('post <id> 人类可读输出', async () => {
  const r = await run(['post', '1', '--comments']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /# 欢迎来到 Narwhal 论坛/);
  assert.match(r.stdout, /评论（共 2 条/);
});

test('categories / channels / search 子命令', async () => {
  const cats = await run(['categories']);
  assert.match(cats.stdout, /公告/);
  const ch = await run(['channels']);
  assert.match(ch.stdout, /综合/);
  const s = await run(['search', '欢迎']);
  assert.match(s.stdout, /欢迎来到/);
});

test('未登录评论：非零退出并给引导', async () => {
  const r = await run(['new-comment', '1', '--content', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /需要登录/);
  assert.match(r.stderr, /narwhal-forum login/);
});

test('带 --token 评论成功，并出现在评论树中', async () => {
  const r = await run(['new-comment', '1', '--content', 'CLI 写入的评论', '--token', ACCESS_TOKEN]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /评论已发表/);
  const list = await run(['comments', '1']);
  assert.match(list.stdout, /CLI 写入的评论/);
});

test('login → whoami → 凭据落盘（密码不落盘）', async () => {
  const login = await run(['login', '--username', 'tester', '--yes'], { NARWHAL_FORUM_PASSWORD: PW });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /登录成功/);
  const cred = JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8'));
  assert.equal(cred.accessToken, ACCESS_TOKEN);
  assert.ok(!JSON.stringify(cred).includes(PW), '密码绝不能落盘');

  const who = await run(['whoami']);
  assert.match(who.stdout, /测试员/);
});

test('token set / show / logout', async () => {
  const set = await run(['token', 'set', '--access', 'manually-imported-token']);
  assert.equal(set.code, 0, set.stderr);
  const show = await run(['token', 'show', '--json']);
  const info = JSON.parse(show.stdout);
  assert.equal(info.hasAccessToken, true);
  assert.equal(info.accessTokenSource, 'file');
  const out = await run(['logout']);
  assert.match(out.stdout, /已删除/);
  const after = JSON.parse((await run(['token', 'show', '--json'])).stdout);
  assert.equal(after.hasAccessToken, false);
});

test('tools / call / help / version', async () => {
  const tools = await run(['tools']);
  assert.match(tools.stdout, /create_comment/);
  assert.match(tools.stdout, /postId: string/);

  const call = await run(['call', 'list_posts', '--json', '{"page":1,"pageSize":2}']);
  assert.equal(call.code, 0, call.stderr);
  assert.match(call.stdout, /帖子列表/);

  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /narwhal-forum/);

  const version = await run(['--version']);
  const { version: pkgVersion } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version.stdout.trim(), pkgVersion, '--version 必须与 package.json 一致');
});

test('未知命令非零退出，--json 错误可被解析', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知命令/);

  const j = await run(['post', '9999', '--json']);
  assert.equal(j.code, 1);
  assert.match(j.stdout, /"error"/);
});
