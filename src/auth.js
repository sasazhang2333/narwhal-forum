/**
 * 浏览器授权登录（"像 oil 那样"）：打开一个真实的浏览器窗口让人登录，
 * 登录完成后从页面 localStorage 取走 token，之后 dsh / Claude Code / Codex 都用它。
 *
 * 为什么这样做：
 *   - 论坛前端（Nuxt SPA）登录后把 JWT 存进 localStorage 的 auth_token / auth_refresh_token；
 *   - 论坛没有 OAuth authorize 端点，我们也不该为此改后端，所以用「真实浏览器 + CDP 读 localStorage」
 *     完成同一件事：一次人工授权、无密码落地、可随时撤销。
 *   - 浏览器用独立 profile 目录（configDir/browser），登录态与用户日常浏览器隔离；
 *     撤销授权 = 删除本地 token + 删除这个 profile（cookie 一并消失）。
 *
 * 依赖：只用 Node 内置 spawn / fs / fetch / WebSocket（Node ≥ 22 自带 WebSocket）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { configDir, patchCredentials, clearCredentials, readCredentials } from './config.js';

/** 浏览器候选路径（macOS 绝对路径 + *nix PATH 命令名）。 */
export const BROWSER_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'],
  win32: [
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ],
};

/** 浏览器私有 profile 目录（登录态与 cookie 都在这；删掉即撤销授权）。 */
export function browserProfileDir() {
  const override = process.env.NARWHAL_FORUM_BROWSER_PROFILE;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(configDir(), 'browser');
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function whichAll(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = [];
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

/**
 * 找到可用的 Chromium 系浏览器。
 * 顺序：显式传入 > NARWHAL_FORUM_BROWSER > 平台默认候选 > PATH。
 */
export function findBrowser(explicit) {
  if (explicit && String(explicit).trim()) {
    const p = path.resolve(String(explicit).trim());
    if (!isExecutable(p)) throw new Error('指定的浏览器不可执行: ' + p);
    return p;
  }
  const fromEnv = process.env.NARWHAL_FORUM_BROWSER;
  if (fromEnv && fromEnv.trim()) {
    const p = path.resolve(fromEnv.trim());
    if (!isExecutable(p)) throw new Error('NARWHAL_FORUM_BROWSER 指向的文件不可执行: ' + p);
    return p;
  }
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  for (const candidate of BROWSER_CANDIDATES[platform] || []) {
    if (candidate.includes(path.sep) ? isExecutable(candidate) : false) return candidate;
  }
  const viaPath = whichAll(BROWSER_CANDIDATES[platform] || []);
  if (viaPath.length) return viaPath[0];
  throw new Error(
    '没找到 Chrome / Edge / Brave / Chromium。' +
      '可用 --browser <路径> 指定，或设置 NARWHAL_FORUM_BROWSER。' +
      '（也可以退回密码模式：narwhal-forum login --password --username <u>）',
  );
}

/** Chrome 启动参数：独立 profile + 随机 CDP 端口 + 直接打开登录页。 */
export function buildLaunchArgs(profileDir, targetUrl, extraArgs = []) {
  const base = [
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1080,820',
    '--new-window',
  ];
  return [...base, ...extraArgs, targetUrl];
}

/** 解析 <profile>/DevToolsActivePort：第一行端口，第二行 ws 路径。 */
export function parseDevToolsActivePort(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, wsPath: lines[1] || '' };
}

/** 从 Runtime.evaluate 的返回值里取 token（容错：字符串化 JSON 或对象）。 */
export function extractTokens(value) {
  let data = value;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const accessToken = data.a || data.access_token || data.accessToken;
  if (!accessToken) return null;
  return { accessToken: String(accessToken), refreshToken: (data.r || data.refresh_token || data.refreshToken) || null };
}

export const READ_TOKENS_EXPRESSION =
  "(()=>{try{return JSON.stringify({a:localStorage.getItem('auth_token'),r:localStorage.getItem('auth_refresh_token')})}catch(e){return JSON.stringify({error:String(e)})}})()";

/** 轮询直到拿到 token 或超时；evaluate 可注入，便于测试。 */
export async function waitForTokens(evaluate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300000;
  const intervalMs = opts.intervalMs ?? 1000;
  const now = opts.now || Date.now;
  const started = now();
  let lastError = null;
  while (true) {
    try {
      const tokens = extractTokens(await evaluate(READ_TOKENS_EXPRESSION));
      if (tokens) return tokens;
    } catch (err) {
      lastError = err;
      if (err && err.fatal) throw err;
    }
    if (now() - started >= timeoutMs) {
      const err = new Error('等待登录超时（' + Math.round(timeoutMs / 1000) + ' 秒未完成）');
      err.code = 'LOGIN_TIMEOUT';
      err.hint = '重跑 narwhal-forum login，在打开的窗口里完成登录；或用 narwhal-forum login --password。';
      if (lastError) err.cause = lastError;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readPortFile(profileDir, timeoutMs) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = parseDevToolsActivePort(fs.readFileSync(file, 'utf8'));
      if (parsed) return parsed;
    } catch {
      /* 还没写出来 */
    }
    await delay(120);
  }
  return null;
}

async function listTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('CDP /json/list 失败: HTTP ' + res.status);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

/** 极简 CDP WebSocket 客户端（只用 Node 自带 WebSocket）。 */
async function connectCdp(wsUrl) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    const err = new Error('当前 Node 没有内置 WebSocket，无法驱动浏览器');
    err.hint = '浏览器登录需要 Node ≥ 22（当前 ' + process.version + '）；或改用 narwhal-forum login --password。';
    throw err;
  }
  const ws = new WS(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接浏览器调试端口失败')); }, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    const slot = msg && msg.id && pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message || 'CDP 调用失败'));
    else slot.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    for (const slot of pending.values()) slot.reject(new Error('浏览器窗口已关闭'));
    pending.clear();
  });

  return {
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

function makeEvaluator(cdp) {
  return async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result && result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
    return result && result.result ? result.result.value : undefined;
  };
}

async function closeTarget(port, targetId) {
  try {
    await fetch('http://127.0.0.1:' + port + '/json/close/' + targetId, { signal: AbortSignal.timeout(3000) });
  } catch {
    /* 关不掉就靠 kill 兜底 */
  }
}

function stopChild(child) {
  try {
    if (child && !child.killed) child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/**
 * 打开浏览器让人登录，登录完成后写凭据。
 * @returns {Promise<{accessToken:string, refreshToken:string|null, browser:string, profileDir:string, credentialsPath:string}>}
 */
export async function browserLogin(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('browserLogin 需要 baseUrl');
  const loginPath = opts.loginPath || '/login';
  const loginUrl = baseUrl + (loginPath.startsWith('/') ? loginPath : '/' + loginPath);
  const profileDir = opts.profileDir || browserProfileDir();
  const timeoutMs = opts.timeoutMs ?? 300000;
  const browser = findBrowser(opts.browserPath);
  const log = opts.log || (() => {});

  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const child = spawn(browser, buildLaunchArgs(profileDir, loginUrl, opts.extraArgs || []), { stdio: 'ignore', detached: false });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const portInfo = await readPortFile(profileDir, 20000);
  if (!portInfo) {
    stopChild(child);
    const err = new Error('浏览器没有打开调试端口（可能被已有实例接管）');
    err.hint = '确认没有别的 Chrome 占用同一 profile 目录：' + profileDir + '；或先关闭它再重试。';
    throw err;
  }

  log('浏览器已打开：' + loginUrl);
  log('请在该窗口里完成登录，登录成功后会自动继续（最多等 ' + Math.round(timeoutMs / 1000) + ' 秒）');

  let cdp = null;
  try {
    // 等目标页出现（Chrome 有时先开 about:blank）
    let targets = [];
    const targetDeadline = Date.now() + 10000;
    while (Date.now() < targetDeadline) {
      try {
        targets = await listTargets(portInfo.port);
      } catch {
        targets = [];
      }
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
      await delay(200);
    }
    const page = targets.find((t) => t.type === 'page' && String(t.url || '').startsWith(baseUrl))
      || targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      || targets.find((t) => t.webSocketDebuggerUrl);
    if (!page) throw new Error('没找到可用的浏览器页面目标');

    cdp = await connectCdp(page.webSocketDebuggerUrl);
    const evaluate = makeEvaluator(cdp);

    const tokens = await waitForTokens(async (expression) => {
      if (exited) {
        const err = new Error('浏览器窗口被关闭，登录未完成');
        err.code = 'BROWSER_CLOSED';
        err.fatal = true;
        throw err;
      }
      return evaluate(expression);
    }, { timeoutMs, intervalMs: opts.intervalMs ?? 1000, now: opts.now });

    const file = patchCredentials({
      baseUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || undefined,
      authMode: 'browser',
      browserProfile: profileDir,
      loggedInAt: new Date().toISOString(),
    });

    if (opts.closeAfter !== false) {
      await closeTarget(portInfo.port, page.id);
      stopChild(child);
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      browser,
      profileDir,
      credentialsPath: file,
    };
  } finally {
    if (cdp) cdp.close();
    if (opts.closeAfter !== false) stopChild(child);
  }
}

/**
 * 撤销授权：调用后端登出（尽力而为）→ 删除本地 token → 删除浏览器 profile（cookie 一起消失）。
 */
export async function revokeAuth(opts = {}) {
  const stored = readCredentials();
  const profileDir = opts.profileDir || stored.browserProfile || browserProfileDir();
  const result = { backendLogout: 'skipped', tokenRemoved: false, profileRemoved: false, profileDir };

  const token = opts.token || stored.accessToken;
  const baseUrl = String(opts.baseUrl || stored.baseUrl || '').replace(/\/+$/, '');
  if (token && baseUrl && opts.backend !== false) {
    try {
      const res = await fetch(baseUrl + '/api/cms/auth/jwt/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      result.backendLogout = res.ok ? 'ok' : 'http_' + res.status;
    } catch (err) {
      result.backendLogout = 'error: ' + (err && err.message ? err.message : String(err));
    }
  }

  result.tokenRemoved = clearCredentials();
  if (opts.keepBrowser !== true) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      result.profileRemoved = !fs.existsSync(profileDir);
    } catch (err) {
      result.profileError = err && err.message ? err.message : String(err);
    }
  }
  return result;
}

/** 授权状态（不打印 token 本身）。 */
export function authStatus(opts = {}) {
  const stored = readCredentials();
  const profileDir = opts.profileDir || stored.browserProfile || browserProfileDir();
  return {
    loggedIn: Boolean(opts.token || stored.accessToken),
    authMode: stored.authMode || (stored.accessToken ? 'token' : 'none'),
    loggedInAt: stored.loggedInAt || null,
    hasRefreshToken: Boolean(stored.refreshToken),
    profileDir,
    profileExists: fs.existsSync(profileDir),
    canBrowserLogin: typeof globalThis.WebSocket === 'function',
    nodeVersion: process.version,
    credentialsPath: opts.credentialsPath || null,
  };
}

/** 把 access/refresh token 注入客户端（登录/导入后调用）。 */
export function applyTokens(client, tokens) {
  if (!tokens) return client;
  if (tokens.accessToken) client.token = tokens.accessToken;
  if (tokens.refreshToken) client.refreshToken = tokens.refreshToken;
  return client;
}

export const _internal = { readPortFile, listTargets, connectCdp, makeEvaluator, closeTarget, stopChild, whichAll, isExecutable, delay };
