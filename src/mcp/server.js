/**
 * 手写的 MCP stdio 服务器（JSON-RPC 2.0，换行分隔）。
 *
 * 为什么不用 @modelcontextprotocol/sdk：
 *  - 本包的核心卖点是零运行时依赖 → npx 秒起、离线可控、不会被依赖链拖垮；
 *  - 我们只需要 initialize / tools/list / tools/call / ping，协议面很小；
 *  - stdio 传输就是「一行一条 JSON」，没有握手加密等复杂度。
 * 协议版本：优先回显客户端请求的版本（若受支持），否则回 2025-06-18。
 */
import readline from 'node:readline';
import { TOOL_MAP, toolList } from './tools.js';
import { ForumClient } from '../client.js';

export const SERVER_NAME = 'narwhal-forum';
export const SERVER_VERSION = '0.4.0';
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/** 注入给模型的服务器级说明（dsh-mcp-client 会作为提示文本注入，上限 32768 字节）。 */
export const INSTRUCTIONS = [
  'narwhal-forum：读写 Narwhal CMS 论坛的 MCP 服务器。',
  '典型流程：list_posts 找帖 → get_post 读正文（可同时带评论）→ create_comment 评论/回复。',
  '只读操作（status/whoami/list_*/get_post/list_comments/list_categories/list_channels/search_posts）无需登录。',
  '写操作（create_comment/create_post/react_post/my_comments）需要登录：优先用 login 工具，或在环境里提供 NARWHAL_FORUM_TOKEN。',
  '环境变量：NARWHAL_FORUM_BASE_URL、NARWHAL_FORUM_TOKEN、NARWHAL_FORUM_REFRESH_TOKEN、NARWHAL_FORUM_USERNAME、NARWHAL_FORUM_PASSWORD。',
  '约束：评论 1-2000 字且两次之间有 15 秒冷却；标题 <=200 字，正文 <=100000 字。',
  '排序只认 order 参数（newest/hot/trending/...），后端列表端点不接受任意 sort 值。',
].join('\n');

const MAX_TEXT = 200000;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message, data) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: data === undefined ? { code, message } : { code, message, data } };
}

function clip(text) {
  const s = String(text);
  if (s.length <= MAX_TEXT) return s;
  return s.slice(0, MAX_TEXT) + '\n\n…（输出过长已截断，共 ' + s.length + ' 字符；请缩小 page 或调小 pageSize）';
}

export class ForumMcpServer {
  constructor(options = {}) {
    this.client = options.client || new ForumClient(options);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.initialized = false;
    this.clientInfo = null;
  }

  /** 处理单条 JSON-RPC 消息；通知返回 null。 */
  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      if (typeof method !== 'string') return isNotification ? null : fail(id, -32600, 'Invalid Request: method 必须是字符串');

      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
          this.clientInfo = (params && params.clientInfo) || null;
          this.initialized = true;
          this.log('initialize from', this.clientInfo && this.clientInfo.name, 'protocol', protocolVersion);
          return ok(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: 'Narwhal Forum' },
            instructions: INSTRUCTIONS,
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'logging/setLevel':
          return null;
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: toolList() });
        case 'tools/call': {
          const name = params && params.name;
          const args = (params && params.arguments) || {};
          const tool = TOOL_MAP.get(name);
          if (!tool) throw new RpcError(-32602, 'Unknown tool: ' + String(name), { available: [...TOOL_MAP.keys()] });
          this.log('tools/call', name);
          try {
            const out = await tool.handler({ client: this.client, config: this.client.cfg }, args);
            const payload = {
              content: [{ type: 'text', text: clip(out.text) }],
              isError: false,
            };
            return ok(id, payload);
          } catch (err) {
            const text = [err && err.message ? err.message : String(err), err && err.hint ? '👉 ' + err.hint : null]
              .filter(Boolean)
              .join('\n');
            return ok(id, { content: [{ type: 'text', text: clip(text) }], isError: true, _meta: { errorName: err && err.name, code: err && err.code } });
          }
        }
        case 'resources/list':
          return ok(id, { resources: [] });
        case 'resources/templates/list':
          return ok(id, { resourceTemplates: [] });
        case 'prompts/list':
          return ok(id, { prompts: [] });
        case 'shutdown':
          return ok(id, null);
        default:
          return isNotification ? null : fail(id, -32601, 'Method not found: ' + method);
      }
    } catch (err) {
      if (err instanceof RpcError) return isNotification ? null : fail(id, err.code, err.message, err.data);
      this.log('handler error', err && err.stack);
      return isNotification ? null : fail(id, -32603, 'Internal error: ' + (err && err.message ? err.message : String(err)));
    }
  }

  /** 处理一行原始输入（可能是批量数组）。返回要写回的行数组。 */
  async handleLine(line) {
    const text = String(line).trim();
    if (!text) return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return [JSON.stringify(fail(null, -32700, 'Parse error: ' + err.message))];
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) return [JSON.stringify(fail(null, -32600, 'Invalid Request: empty batch'))];
      const responses = [];
      for (const item of parsed) {
        const res = await this.handle(item);
        if (res) responses.push(res);
      }
      return responses.length ? [JSON.stringify(responses)] : [];
    }
    const res = await this.handle(parsed);
    return res ? [JSON.stringify(res)] : [];
  }
}

/**
 * 启动 stdio 服务。stdout 只写协议帧，日志一律走 stderr。
 * @returns {{server: ForumMcpServer, close: () => void, done: Promise<void>}}
 */
export function startStdioServer(options = {}) {
  const server = new ForumMcpServer(options);
  const debug = /^(1|true|yes)$/i.test(process.env.NARWHAL_FORUM_DEBUG || '');
  const write = (s) => process.stdout.write(s + '\n');

  // 防止任何第三方/误用 console.log 污染协议流
  console.log = (...args) => process.stderr.write('[narwhal-forum] ' + args.join(' ') + '\n');
  console.info = console.log;
  console.debug = console.log;
  if (debug) server.log = (...args) => process.stderr.write('[narwhal-forum] ' + args.join(' ') + '\n');

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue
      .then(async () => {
        const lines = await server.handleLine(line);
        for (const out of lines) write(out);
      })
      .catch((err) => {
        process.stderr.write('[narwhal-forum] fatal: ' + (err && err.stack ? err.stack : String(err)) + '\n');
        write(JSON.stringify(fail(null, -32603, 'Internal error')));
      });
  });

  const done = new Promise((resolve) => {
    rl.on('close', () => {
      queue.then(resolve, resolve);
    });
  });

  const close = () => {
    try {
      rl.close();
    } catch {
      /* ignore */
    }
  };

  process.on('SIGINT', () => {
    close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    close();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write('[narwhal-forum] uncaught: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  });

  return { server, close, done };
}
