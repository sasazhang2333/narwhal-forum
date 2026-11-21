/**
 * 设备码授权（/api/cli/device/*）的单元测试。
 *
 * 覆盖三件事：
 *   1. 正常流程：打印/返回用户码 → 人在网页点允许 → 轮询拿到 token（只拿一次）；
 *   2. 拒绝：网页上点「拒绝」，插件必须报错且不写任何凭据；
 *   3. 过期/已使用：给出可操作的提示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockForum, ACCESS_TOKEN, REFRESH_TOKEN } from './mock-forum.js';
import { deviceLogin } from '../src/auth.js';

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor 超时');
}

test('deviceLogin：人点允许后拿到 token，且同一个设备码只能换一次', async () => {
  const forum = await startMockForum();
  try {
    const lines = [];
    const pending = deviceLogin({
      baseUrl: forum.baseUrl,
      clientName: 'narwhal-forum@test',
      scopes: ['read', 'write:comment'],
      openBrowser: false,
      intervalMs: 15,
      timeoutMs: 5000,
      log: (line) => lines.push(line),
    });

    await waitFor(() => forum.state.deviceCodes.size > 0);
    const [deviceCode] = [...forum.state.deviceCodes.keys()];
    forum.state.deviceCodes.get(deviceCode).status = 'approved';

    const result = await pending;
    assert.equal(result.accessToken, ACCESS_TOKEN);
    assert.equal(result.refreshToken, REFRESH_TOKEN);
    assert.equal(result.username, 'admin');
    assert.equal(result.authMode, 'device');
    assert.deepEqual(result.scopes, ['read', 'write:comment']);
    assert.equal(forum.state.deviceCodes.get(deviceCode).status, 'consumed', '换完必须标记已用');

    // 提示里必须给出给人看的 URL 与用户码 —— 远程机器上就靠这两行
    const text = lines.join('\n');
    assert.match(text, /\/cli\/authorize\?code=/);
    assert.match(text, /TEST-CODE/);
  } finally {
    forum.server.close();
  }
});

test('deviceLogin：网页上点拒绝 → 报错，不发 token', async () => {
  const forum = await startMockForum();
  try {
    const pending = deviceLogin({
      baseUrl: forum.baseUrl, openBrowser: false, intervalMs: 15, timeoutMs: 5000, log: () => {},
    });
    await waitFor(() => forum.state.deviceCodes.size > 0);
    const [deviceCode] = [...forum.state.deviceCodes.keys()];
    forum.state.deviceCodes.get(deviceCode).status = 'denied';

    await assert.rejects(pending, /拒绝/);
  } finally {
    forum.server.close();
  }
});

test('deviceLogin：设备码过期 → 报错并提示重新发起', async () => {
  const forum = await startMockForum();
  try {
    const pending = deviceLogin({
      baseUrl: forum.baseUrl, openBrowser: false, intervalMs: 15, timeoutMs: 5000, log: () => {},
    });
    await waitFor(() => forum.state.deviceCodes.size > 0);
    const [deviceCode] = [...forum.state.deviceCodes.keys()];
    forum.state.deviceCodes.get(deviceCode).status = 'expired';

    await assert.rejects(pending, (err) => {
      assert.match(err.message, /过期/);
      assert.match(err.hint, /login --device/);
      return true;
    });
  } finally {
    forum.server.close();
  }
});
