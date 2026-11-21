/** MCP 层：login/logout 工具的契约（不真的开浏览器，只校验 schema 与本地副作用）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-auth-mcp-'));
process.env.NARWHAL_FORUM_HOME = tmpHome;

const { TOOL_MAP, TOOLS } = await import('../src/mcp/tools.js');
const { writeCredentials, credentialsPath } = await import('../src/config.js');
const { browserProfileDir } = await import('../src/auth.js');

function stubClient() {
  return {
    baseUrl: 'http://127.0.0.1:8080',
    token: 'acc',
    refreshToken: 'ref',
    setTokens(tokens) {
      this.token = tokens.accessToken || null;
      this.refreshToken = tokens.refreshToken || null;
    },
  };
}

test('login 工具默认走 browser 模式，并声明 mode 枚举', () => {
  const tool = TOOL_MAP.get('login');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.mode.default, 'browser');
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['browser', 'password']);
  assert.deepEqual(tool.inputSchema.required, []);
});


const { RISK_VERSION } = await import('../src/risk.js');

test('login 工具未确认风险时不打开浏览器，只返回风险全文', async () => {
  const tool = TOOL_MAP.get('login');
  assert.equal(tool.inputSchema.properties.acknowledgeRisks.default, false);
  const out = await tool.handler({ client: stubClient() }, {});
  assert.equal(out.data.code, 'E_RISK_ACK_REQUIRED');
  assert.equal(out.data.riskVersion, RISK_VERSION);
  assert.equal(out.data.ok, false);
  assert.match(out.text, /授权前请先阅读风险提示/);
  assert.match(out.text, /acknowledgeRisks=true/);
  assert.match(out.text, /内容责任|实名/);
});
test('logout 工具出现在工具表里（撤销授权）', () => {
  assert.ok(TOOL_MAP.get('logout'));
  assert.ok(TOOLS.some((t) => t.name === 'logout'));
});

test('logout 后果：token 清空、凭据与 profile 删除', async () => {
  writeCredentials({ baseUrl: 'http://127.0.0.1:8080', accessToken: 'acc', authMode: 'browser' });
  const profile = browserProfileDir();
  fs.mkdirSync(profile, { recursive: true });
  const client = stubClient();
  const out = await TOOL_MAP.get('logout').handler({ client }, {});
  assert.match(out.text, /已撤销授权/);
  assert.equal(client.token, null);
  assert.equal(fs.existsSync(credentialsPath()), false);
  assert.equal(fs.existsSync(profile), false);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
