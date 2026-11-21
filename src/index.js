/**
 * 公共 API：给 Node 脚本 / 其它工具直接 require/import 用（不经 MCP 也复用同一套能力）。
 *
 *   import { ForumClient } from 'narwhal-forum';
 *   const client = new ForumClient({ baseUrl: 'http://127.0.0.1:8080' });
 *   const page = await client.listPosts({ page: 1, pageSize: 10 });
 */
export { ForumClient, ForumError, ForumAuthError, REACTIONS, POST_ORDERS, normalizePage, flattenComments, countComments, isEnvelope, unwrapEnvelope } from './client.js';
export { TOOLS, TOOL_MAP, toolList } from './mcp/tools.js';
export { ForumMcpServer, startStdioServer, SUPPORTED_PROTOCOLS, SERVER_NAME, SERVER_VERSION } from './mcp/server.js';
export { resolveConfig, readCredentials, writeCredentials, patchCredentials, clearCredentials, configDir, credentialsPath, maskToken, DEFAULT_BASE_URL } from './config.js';
export { browserLogin, revokeAuth, authStatus, applyTokens, findBrowser, browserProfileDir } from './auth.js';
export { main } from './cli.js';
