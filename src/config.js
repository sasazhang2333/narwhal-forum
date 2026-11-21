/**
 * 配置与凭据解析。
 *
 * 解析优先级（高 → 低）：
 *   1. 调用方显式传入的参数（CLI flag / MCP 工具参数）
 *   2. 环境变量（适合 CI、容器、一次性使用）
 *   3. 凭据文件 ~/.config/narwhal-forum/credentials.json（由 `login` 写入，权限 0600）
 *   4. 默认值 http://127.0.0.1:8080
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

export const ENV = {
  baseUrl: 'NARWHAL_FORUM_BASE_URL',
  token: 'NARWHAL_FORUM_TOKEN',
  refreshToken: 'NARWHAL_FORUM_REFRESH_TOKEN',
  username: 'NARWHAL_FORUM_USERNAME',
  password: 'NARWHAL_FORUM_PASSWORD',
  home: 'NARWHAL_FORUM_HOME',
  timeoutMs: 'NARWHAL_FORUM_TIMEOUT_MS',
};

/** 配置目录：NARWHAL_FORUM_HOME > $XDG_CONFIG_HOME/narwhal-forum > ~/.config/narwhal-forum */
export function configDir() {
  const home = process.env[ENV.home];
  if (home && home.trim()) return path.resolve(home.trim());
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : path.join(os.homedir(), '.config');
  return path.join(base, 'narwhal-forum');
}

export function credentialsPath() {
  return path.join(configDir(), 'credentials.json');
}

/** 读取凭据文件；不存在或损坏时返回空对象（不抛错，方便首次使用）。 */
export function readCredentials() {
  const file = credentialsPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 原子写入凭据文件，目录 0700、文件 0600（含 token，勿提交）。 */
export function writeCredentials(data) {
  const dir = configDir();
  const file = credentialsPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod，忽略 */
  }
  return file;
}

export function patchCredentials(patch) {
  const current = readCredentials();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    next[k] = v;
  }
  return writeCredentials(next);
}

export function clearCredentials() {
  const file = credentialsPath();
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 归一化 base URL：补 scheme、去尾部斜杠。 */
export function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw;
  return withScheme.replace(/\/+$/, '');
}

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/**
 * 解析最终生效配置。
 * @param {object} overrides CLI/MCP 显式传入的值
 * @returns {{baseUrl:string, token?:string, refreshToken?:string, username?:string, password?:string, timeoutMs:number, configDir:string, credentialsPath:string, sources:object}}
 */
export function resolveConfig(overrides = {}) {
  const stored = readCredentials();
  const sources = {};

  const baseUrl = pick(overrides.baseUrl, process.env[ENV.baseUrl], stored.baseUrl, DEFAULT_BASE_URL);
  sources.baseUrl = overrides.baseUrl ? 'arg' : process.env[ENV.baseUrl] ? 'env' : stored.baseUrl ? 'file' : 'default';

  const token = pick(overrides.token, process.env[ENV.token], stored.accessToken);
  sources.token = overrides.token ? 'arg' : process.env[ENV.token] ? 'env' : stored.accessToken ? 'file' : 'none';

  const refreshToken = pick(overrides.refreshToken, process.env[ENV.refreshToken], stored.refreshToken);
  sources.refreshToken = overrides.refreshToken
    ? 'arg'
    : process.env[ENV.refreshToken]
      ? 'env'
      : stored.refreshToken
        ? 'file'
        : 'none';

  const username = pick(overrides.username, process.env[ENV.username], stored.username);
  const password = pick(overrides.password, process.env[ENV.password], stored.password);
  sources.credentials = username && password ? 'available' : 'none';

  const timeoutMs = Number(pick(overrides.timeoutMs, process.env[ENV.timeoutMs], 30000)) || 30000;

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
    refreshToken,
    username,
    password,
    timeoutMs,
    configDir: configDir(),
    credentialsPath: credentialsPath(),
    sources,
  };
}

/** 只显示首尾若干字符，用于日志/状态输出。 */
export function maskToken(token) {
  if (!token) return null;
  const s = String(token);
  if (s.length <= 12) return '***';
  return s.slice(0, 6) + '***' + s.slice(-4);
}
