/**
 * MCP 协议层测试：真起一个子进程，按 JSON-RPC 走完整握手 + 工具调用。
 * 这验证的是「dsh / Claude Code 通过 stdio 用起来」的那条路径本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockForum, ACCESS_TOKEN } from './mock-forum.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'narwhal-forum.js');

class Stdio {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.waiters = new Map();
    this.stderr = '';
    this.raw = [];
    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => {
      this.raw.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new Error('stdout 出现非 JSON 行（协议被污染）: ' + line.slice(0, 200));
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      for (const item of batch) {
        if (item && item.id !== undefined && this.waiters.has(item.id)) {
          const { resolve } = this.waiters.get(item.id);
          this.waiters.delete(item.id);
          resolve(item);
        }
      }
    });
    proc.stderr.on('data', (c) => {
      this.stderr += c.toString();
    });
  }

  call(method, params, id) {
    const requestId = id === undefined ? this.nextId++ : id;
    const payload = { jsonrpc: '2.0', id: requestId, method };
    if (params !== undefined) payload.params = params;
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      this.waiters.set(requestId, { resolve });
      setTimeout(() => {
        if (this.waiters.has(requestId)) {
          this.waiters.delete(requestId);
          reject(new Error('MCP 响应超时: ' + method + ' / stderr=' + this.stderr));
        }
      }, 8000);
    });
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  sendRaw(text) {
    this.proc.stdin.write(text + '\n');
  }

  async tool(name, args = {}) {
    const res = await this.call('tools/call', { name, arguments: args });
    const text = res.result && Array.isArray(res.result.content) ? res.result.content.map((c) => c.text || '').join('') : '';
    return { res, text, isError: Boolean(res.result && res.result.isError) };
  }
}

let mock;
let home;
let stdio;

test.before(async () => {
  mock = await startMockForum();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-mcp-'));
  stdio = new Stdio(spawn(process.execPath, [BIN, 'mcp'], {
    env: { ...process.env, NARWHAL_FORUM_HOME: home, NARWHAL_FORUM_BASE_URL: mock.baseUrl, NARWHAL_FORUM_TOKEN: ACCESS_TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
});

test.after(async () => {
  try {
    stdio.proc.kill();
  } catch {
    /* ignore */
  }
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('initialize 握手：协议版本 / capabilities / serverInfo / instructions', async () => {
  const res = await stdio.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-test', version: '0.0.1' },
  });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.ok(res.result.capabilities.tools, '必须声明 tools 能力');
  assert.equal(res.result.serverInfo.name, 'narwhal-forum');
  assert.ok(res.result.instructions.length > 50, 'instructions 应给模型操作提示');
  stdio.notify('notifications/initialized');
});

test('旧协议版本被降级到我们支持的最新版', async () => {
  const res = await stdio.call('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.ok(['2025-06-18', '2025-03-26', '2024-11-05'].includes(res.result.protocolVersion));
});

test('tools/list 暴露完整能力表且 schema 合法', async () => {
  const res = await stdio.call('tools/list');
  const tools = res.result.tools;
  assert.ok(tools.length >= 13, '至少 13 个能力，实际 ' + tools.length);
  const names = tools.map((t) => t.name);
  for (const required of ['list_posts', 'get_post', 'list_comments', 'create_comment', 'create_post', 'react_post']) {
    assert.ok(names.includes(required), '缺少能力 ' + required);
  }
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 10, t.name + ' 的 description 太短');
  }
  const comment = tools.find((t) => t.name === 'create_comment');
  assert.deepEqual(comment.inputSchema.required, ['postId', 'content']);
});

test('tools/call status：不泄露明文 token', async () => {
  const { text, isError } = await stdio.tool('status');
  assert.equal(isError, false);
  assert.match(text, /后端地址/);
  assert.ok(!text.includes(ACCESS_TOKEN), '不应输出明文 token');
});

test('tools/call list_posts：匿名读列表', async () => {
  const { text, isError } = await stdio.tool('list_posts', { page: 1, pageSize: 10 });
  assert.equal(isError, false);
  assert.match(text, /欢迎来到 Narwhal 论坛/);
});

test('tools/call get_post：读正文 + 评论树', async () => {
  const { text, isError } = await stdio.tool('get_post', { postId: 1, withComments: true });
  assert.equal(isError, false);
  assert.match(text, /# 欢迎来到 Narwhal 论坛/);
  assert.match(text, /第一条评论/);
  assert.match(text, /回复第一条/);
});

test('tools/call create_comment：带 token 时真的写入', async () => {
  const { text, isError } = await stdio.tool('create_comment', { postId: 1, content: '来自 MCP 的评论' });
  assert.equal(isError, false, text);
  assert.match(text, /评论已发表/);
  const after = await stdio.tool('list_comments', { postId: 1 });
  assert.match(after.text, /来自 MCP 的评论/);
});

test('工具失败以 isError 返回（而不是打爆 JSON-RPC）', async () => {
  const { res, isError } = await stdio.tool('get_post', { postId: 9999 });
  assert.equal(isError, true);
  assert.equal(res.result.content[0].type, 'text');
  assert.match(res.result.content[0].text, /404|not found/);
});

test('未知工具 → -32602 且列出可用能力', async () => {
  const res = await stdio.call('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(res.error.code, -32602);
  assert.ok(Array.isArray(res.error.data.available));
});

test('ping / 未知方法 / 批量请求 / 解析错误', async () => {
  const pong = await stdio.call('ping');
  assert.deepEqual(pong.result, {});

  const nf = await stdio.call('no/such/method');
  assert.equal(nf.error.code, -32601);

  const batchId = 900;
  stdio.sendRaw(JSON.stringify([
    { jsonrpc: '2.0', id: batchId, method: 'ping' },
    { jsonrpc: '2.0', id: batchId + 1, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]));
  const batch = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('批量响应超时')), 5000);
    const check = () => {
      const parsed = stdio.raw.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
      const found = parsed.find((p) => Array.isArray(p) && p.some((x) => x && x.id === batchId));
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    };
    const interval = setInterval(check, 50);
    timer.unref?.();
    setTimeout(() => clearInterval(interval), 6000).unref?.();
  });
  assert.equal(batch.length, 2, '通知不应产生响应');
  assert.ok(batch.some((x) => x.id === batchId + 1));

  stdio.sendRaw('{not json');
  await new Promise((r) => setTimeout(r, 300));
  const parseErr = stdio.raw.map((l) => JSON.parse(l)).find((m) => m && m.error && m.error.code === -32700);
  assert.ok(parseErr, '必须回 -32700 Parse error');
});

test('stdout 每一行都是合法 JSON（协议流未被日志污染）', () => {
  for (const line of stdio.raw) {
    assert.doesNotThrow(() => JSON.parse(line), '污染行: ' + line.slice(0, 120));
  }
});
