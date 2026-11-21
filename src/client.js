/**
 * narwhal-cms 论坛 API 客户端（零依赖，只用 Node 内置 fetch）。
 *
 * 设计要点：
 *  - 统一响应信封：{ status: 0, result: ... }，status !== 0 视为业务失败。
 *    但 BbsPost / BbsComment 自身也带数字 status 字段，因此信封判定必须严格（键少 + 有 result/message）。
 *  - 401 自动用 refresh token 续期一次并重放请求。
 *  - 写操作前用 ensureAuth() 给出人能看懂的引导，而不是抛 401 原文。
 */
import { resolveConfig, patchCredentials, maskToken } from './config.js';
import { buildEncryptedLogin } from './crypto.js';

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '😮', '😢', '🚀'];

/** 列表排序：/api/bbs/post 的 sort 参数后端并未消费，只认这些专用端点。 */
export const POST_ORDERS = {
  newest: '/api/bbs/post',
  hot: '/api/bbs/post/hot',
  trending: '/api/bbs/post/trending',
  unanswered: '/api/bbs/post/unanswered',
  following: '/api/bbs/post/following',
  'most-collected': '/api/bbs/post/most-collected',
  'best-all-time': '/api/bbs/post/best-all-time',
  'on-this-day': '/api/bbs/post/on-this-day',
};

export class ForumError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ForumError';
    this.code = extra.code;
    this.status = extra.status;
    this.detail = extra.detail;
    this.hint = extra.hint;
  }
}

export class ForumAuthError extends ForumError {
  constructor(message, extra = {}) {
    super(message, extra);
    this.name = 'ForumAuthError';
  }
}

/** 判断是否为统一响应信封（status + result/message，且键很少）。 */
export function isEnvelope(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  if (typeof json.status !== 'number') return false;
  const keys = Object.keys(json);
  if (keys.length > 4) return false;
  return 'result' in json || 'message' in json;
}

/** 解信封：成功返回 result，失败抛 ForumError。非信封原样返回。 */
export function unwrapEnvelope(json) {
  if (!isEnvelope(json)) return json;
  if (json.status === 0) return json.result !== undefined ? json.result : null;
  const message = json.message || ('接口返回失败（status=' + json.status + '）');
  throw new ForumError(message, { code: json.status, detail: json.result });
}

function buildQuery(query) {
  const params = new URLSearchParams();
  if (!query) return params;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

/** 论坛错误码 -> 人能看懂的提示。 */
function explain(message) {
  const m = String(message || '');
  if (/cooldown|频率|太快|慢一[点些]|15\s*秒/.test(m)) return '发评论过于频繁：同一用户两次评论之间有 15 秒冷却，稍等再发。';
  if (/realname|实名/.test(m)) return '该操作要求实名认证，请先在论坛网页端完成实名。';
  if (/mobile|手机/.test(m)) return '该操作要求绑定手机号，请先在论坛网页端绑定。';
  if (/slowmode|慢速模式/.test(m)) return '该帖开启了慢速模式，需要等待更久。';
  if (/locked|已锁/.test(m)) return '该帖已被锁定，不能再回复。';
  if (/sensitive|敏感/.test(m)) return '内容命中敏感词，被后端拒绝。';
  return undefined;
}

export class ForumClient {
  /**
   * @param {object} options baseUrl / token / refreshToken / username / password / timeoutMs / persist / onTokens
   */
  constructor(options = {}) {
    const cfg = resolveConfig(options);
    this.cfg = cfg;
    this.baseUrl = cfg.baseUrl;
    this.token = cfg.token || null;
    this.refreshToken = cfg.refreshToken || null;
    this.username = cfg.username;
    this.password = cfg.password;
    this.timeoutMs = cfg.timeoutMs;
    this.persist = options.persist !== false;
    this.onTokens = typeof options.onTokens === 'function' ? options.onTokens : null;
    this._refreshing = null;
  }

  get isAuthenticated() {
    return Boolean(this.token);
  }

  url(pathname, query) {
    const u = new URL(pathname, this.baseUrl + '/');
    const params = buildQuery(query);
    for (const [k, v] of params.entries()) u.searchParams.append(k, v);
    return u;
  }

  async #raw(pathname, opts = {}) {
    const { method = 'GET', query, body, auth = true, headers = {}, rawBody, contentType } = opts;
    const u = this.url(pathname, query);
    const finalHeaders = { Accept: 'application/json', ...headers };
    if (auth && this.token) finalHeaders.Authorization = 'Bearer ' + this.token;

    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
      if (contentType) finalHeaders['Content-Type'] = contentType;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      finalHeaders['Content-Type'] = contentType || 'application/json';
    }

    let res;
    try {
      res = await fetch(u, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err && err.name === 'TimeoutError' ? ('请求超时（' + this.timeoutMs + 'ms）') : (err && err.message) || String(err);
      throw new ForumError('无法连接论坛后端 ' + this.baseUrl + '：' + reason, {
        hint: '确认服务已启动，或用 baseUrl / ' + 'NARWHAL_FORUM_BASE_URL 指向正确地址。',
      });
    }
    return res;
  }

  async #decode(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { __raw: text.slice(0, 500) };
    }
  }

  async #finish(res, ctx = {}) {
    const json = await this.#decode(res);
    if (res.status === 401 || res.status === 403) {
      throw new ForumAuthError(
        '未登录或登录已过期（HTTP ' + res.status + '）',
        { status: res.status, detail: json, hint: '运行 narwhal-forum login，或设置 NARWHAL_FORUM_TOKEN / NARWHAL_FORUM_REFRESH_TOKEN。' }
      );
    }
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || res.statusText || ('HTTP ' + res.status);
      throw new ForumError(msg + '（HTTP ' + res.status + ' ' + (ctx.method || 'GET') + ' ' + ctx.path + '）', {
        status: res.status,
        detail: json,
        hint: explain(msg),
      });
    }
    try {
      return unwrapEnvelope(json);
    } catch (err) {
      if (err instanceof ForumError) {
        err.hint = err.hint || explain(err.message);
        throw err;
      }
      throw err;
    }
  }

  /** 统一请求入口：401 时刷新一次并重放。 */
  async request(pathname, opts = {}) {
    const ctx = { method: opts.method || 'GET', path: pathname };
    let res = await this.#raw(pathname, opts);
    if (res.status === 401 && opts.auth !== false && this.refreshToken && !opts._retried) {
      try {
        await this.refresh();
      } catch (err) {
        throw new ForumAuthError('access token 已过期且刷新失败：' + err.message, {
          hint: '重新运行 narwhal-forum login。',
        });
      }
      res = await this.#raw(pathname, { ...opts, _retried: true });
    }
    return this.#finish(res, ctx);
  }

  #rememberTokens(tokens) {
    this.token = tokens.accessToken || null;
    this.refreshToken = tokens.refreshToken || this.refreshToken;
    if (this.onTokens) this.onTokens(tokens);
    if (this.persist) {
      try {
        patchCredentials({
          baseUrl: this.baseUrl,
          accessToken: this.token || undefined,
          refreshToken: this.refreshToken || undefined,
        });
      } catch {
        /* 凭据落盘失败不影响本次调用 */
      }
    }
  }

  /** GET /api/cms/auth/narwhal/code */
  async getAuthCodeInfo() {
    const info = await this.request('/api/cms/auth/narwhal/code', { auth: false });
    const flat = info && info.result && typeof info.result === 'object' ? info.result : info || {};
    return {
      captchaEnabled: Boolean(flat.captchaEnabled),
      type: flat.type,
      publicKey: flat.publicKey,
      twoFactorEnabled: Boolean(flat.twoFactorEnabled || flat.twoFactorRequired),
      raw: info,
    };
  }

  /**
   * 登录并记住 token。
   * @param {object} opts username / password / captchaToken / deviceToken / extra
   */
  async login(opts = {}) {
    const username = opts.username || this.username;
    const password = opts.password || this.password;
    if (!username || !password) {
      throw new ForumAuthError('缺少用户名或密码', {
        hint: '传 --username/--password，或设置 NARWHAL_FORUM_USERNAME / NARWHAL_FORUM_PASSWORD。密码不会写入凭据文件。',
      });
    }

    const code = await this.getAuthCodeInfo();
    if (code.captchaEnabled && !opts.captchaToken) {
      throw new ForumError('该后端启用了登录验证码，CLI 无法自动识别图形验证码', {
        code: 'CAPTCHA_REQUIRED',
        hint: '先在浏览器登录一次，然后用 narwhal-forum token set 导入 access_token/refresh_token；或传入 --captcha-token（若你是从别处拿到的校验票据）。',
      });
    }

    const payload = { username, password };
    if (opts.captchaToken) payload.captchaToken = opts.captchaToken;
    if (opts.deviceToken) payload.deviceToken = opts.deviceToken;
    if (opts.extra && typeof opts.extra === 'object') Object.assign(payload, opts.extra);

    const { body, encryptKey } = buildEncryptedLogin(payload, code.publicKey);
    const result = await this.request('/api/cms/auth/narwhal/login', {
      method: 'POST',
      auth: false,
      rawBody: body,
      contentType: 'text/plain;charset=utf-8',
      headers: { 'encrypt-key': encryptKey },
    });

    const flat = result || {};
    if (flat.twoFactorRequired) {
      throw new ForumError('该账号开启了两步验证，CLI 暂不支持', {
        code: 'TWO_FACTOR_REQUIRED',
        detail: flat,
        hint: '请在浏览器完成两步验证后，用 narwhal-forum token set 导入 token。',
      });
    }
    const accessToken = flat.access_token || flat.accessToken;
    const refreshToken = flat.refresh_token || flat.refreshToken;
    if (!accessToken) {
      throw new ForumError('登录响应里没有 access_token', { detail: flat });
    }
    this.#rememberTokens({ accessToken, refreshToken });
    return {
      authenticated: true,
      accessToken: maskToken(accessToken),
      refreshToken: maskToken(refreshToken),
      baseUrl: this.baseUrl,
      credentialsPath: this.cfg.credentialsPath,
    };
  }

  /** POST /api/cms/auth/jwt/refresh-token（单飞，避免并发重复刷新） */
  async refresh() {
    if (!this.refreshToken) {
      throw new ForumAuthError('没有 refresh token，无法续期', { hint: '运行 narwhal-forum login。' });
    }
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const result = await this.request('/api/cms/auth/jwt/refresh-token', {
        method: 'POST',
        auth: false,
        body: { refreshToken: this.refreshToken, browser: true },
      });
      const flat = result || {};
      const accessToken = flat.accessToken || flat.access_token || flat.token;
      const refreshToken = flat.refreshToken || flat.refresh_token;
      if (!accessToken) throw new ForumAuthError('刷新响应里没有 accessToken', { detail: flat });
      this.#rememberTokens({ accessToken, refreshToken });
      return { accessToken: maskToken(accessToken) };
    })().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  /** 直接注入 token（浏览器授权 / token set 后调用），默认落盘。 */
  setTokens(tokens = {}) {
    this.#rememberTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return this;
  }

  /** 调用后端登出（POST /api/cms/auth/jwt/logout）。失败不抛，返回原因。 */
  async logout() {
    if (!this.token) return { ok: false, reason: 'not_logged_in' };
    try {
      await this.request('/api/cms/auth/jwt/logout', { method: 'POST', body: {} });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err && err.code ? err.code : String(err && err.message ? err.message : err) };
    }
  }

  ensureAuth(action) {
    if (this.isAuthenticated) return;
    throw new ForumAuthError('「' + (action || '该操作') + '」需要登录', {
      hint: '运行 narwhal-forum login（会打开浏览器，登录一次即可），或设置 NARWHAL_FORUM_TOKEN。只读操作（列表/详情/评论）无需登录。',
    });
  }

  /** GET /api/cms/auth/narwhal/user-info */
  async whoami() {
    const result = await this.request('/api/cms/auth/narwhal/user-info');
    const flat = result || {};
    const user = flat.user || flat;
    return {
      user: {
        userId: user.userId,
        userName: user.userName || user.username,
        nickName: user.nickName || user.nickname,
        avatar: user.avatar,
        email: user.email,
      },
      roles: flat.roles,
      permissions: flat.permissions,
    };
  }

  /** GET /api/bbs/post：page / pageSize 必填，categoryId / userId / status 走 Q_ 查询 DSL。 */
  async listPosts(opts = {}) {
    const order = opts.order && POST_ORDERS[opts.order] ? opts.order : 'newest';
    const path = POST_ORDERS[order] || POST_ORDERS.newest;
    const page = Number(opts.page) || 1;
    const pageSize = Math.min(Number(opts.pageSize) || 20, 100);
    const query = { page, pageSize };
    if (opts.categoryId !== undefined && opts.categoryId !== null) query.EQ_categoryId_Long = opts.categoryId;
    if (opts.userId !== undefined && opts.userId !== null) query.EQ_userId_Long = opts.userId;
    if (opts.status !== undefined && opts.status !== null) query.EQ_status_Integer = opts.status;
    if (opts.titleLike) query.LIKE_title_String = opts.titleLike;
    if (opts.excludeUserId !== undefined && opts.excludeUserId !== null) query.NotIn_userId_Long = opts.excludeUserId;
    if (opts.extraQuery && typeof opts.extraQuery === 'object') Object.assign(query, opts.extraQuery);

    const result = await this.request(path, { query });
    return normalizePage(result, order);
  }

  /** GET /api/bbs/post/{id}，可选附带评论树。 */
  async getPost(id, opts = {}) {
    if (!id) throw new ForumError('缺少帖子 id');
    const post = await this.request('/api/bbs/post/' + encodeURIComponent(id));
    const out = { post, comments: undefined, commentsMeta: undefined };
    if (opts.withComments) {
      const tree = await this.listComments({ postId: id, sort: opts.commentSort || 'oldest' });
      out.comments = tree;
      out.commentsMeta = { total: countComments(tree) };
    }
    return out;
  }

  /** GET /api/bbs/comment → 评论树（children 嵌套）。 */
  async listComments(opts = {}) {
    if (!opts.postId) throw new ForumError('缺少 postId');
    const result = await this.request('/api/bbs/comment', {
      query: {
        postId: opts.postId,
        parentId: opts.parentId === undefined ? 0 : opts.parentId,
        sort: opts.sort || 'oldest',
      },
    });
    return Array.isArray(result) ? result : [];
  }

  /** GET /api/bbs/comment/{commentId}/replies → 分页平铺。 */
  async listReplies(commentId, opts = {}) {
    return this.request('/api/bbs/comment/' + encodeURIComponent(commentId) + '/replies', {
      query: { page: Number(opts.page) || 1, pageSize: Number(opts.pageSize) || 5, sort: opts.sort || 'oldest' },
    });
  }

  /** GET /api/bbs/comment/my（需要登录） */
  async listMyComments(opts = {}) {
    this.ensureAuth('查看我的评论');
    const result = await this.request('/api/bbs/comment/my', {
      query: { page: Number(opts.page) || 1, pageSize: Number(opts.pageSize) || 20 },
    });
    return normalizePage(result, 'newest');
  }

  /** POST /api/bbs/comment —— 这是「发表评论」的核心能力。 */
  async createComment(opts = {}) {
    this.ensureAuth('发表评论');
    const postId = opts.postId;
    const content = typeof opts.content === 'string' ? opts.content.trim() : '';
    if (!postId) throw new ForumError('缺少 postId');
    if (!content) throw new ForumError('评论内容不能为空');
    if (content.length > 2000) throw new ForumError('评论内容超过 2000 字上限（当前 ' + content.length + ' 字）');

    const body = { postId, content };
    if (opts.parentId !== undefined && opts.parentId !== null) body.parentId = opts.parentId;
    if (opts.replyUserId !== undefined && opts.replyUserId !== null) body.replyUserId = opts.replyUserId;
    if (opts.whisper !== undefined) body.whisper = Boolean(opts.whisper);

    return this.request('/api/bbs/comment', { method: 'POST', body });
  }

  /** POST /api/bbs/post —— 发帖（写操作，需要登录）。 */
  async createPost(opts = {}) {
    this.ensureAuth('发帖');
    const title = typeof opts.title === 'string' ? opts.title.trim() : '';
    const content = typeof opts.content === 'string' ? opts.content.trim() : '';
    if (!title) throw new ForumError('缺少标题 title');
    if (title.length > 200) throw new ForumError('标题超过 200 字上限');
    if (!content) throw new ForumError('缺少正文 content');
    if (content.length > 100000) throw new ForumError('正文超过 100000 字上限');
    if (opts.categoryId === undefined || opts.categoryId === null) throw new ForumError('缺少 categoryId（用 categories 命令查）');
    if (opts.summary && String(opts.summary).length > 500) throw new ForumError('摘要超过 500 字上限');

    const body = { title, content, categoryId: opts.categoryId };
    if (opts.summary) body.summary = opts.summary;
    if (opts.type) body.type = opts.type;
    if (opts.cover) body.cover = opts.cover;
    return this.request('/api/bbs/post', { method: 'POST', body });
  }

  /** GET /api/bbs/post/search（依赖后端 Lucene） */
  async searchPosts(opts = {}) {
    const q = typeof opts.q === 'string' ? opts.q.trim() : '';
    if (!q) throw new ForumError('缺少搜索关键词 q');
    const result = await this.request('/api/bbs/post/search', {
      query: {
        q,
        categoryId: opts.categoryId,
        userId: opts.userId,
        dateFrom: opts.dateFrom,
        dateTo: opts.dateTo,
        sort: opts.sort,
        page: Number(opts.page) || 1,
        pageSize: Math.min(Number(opts.pageSize) || 10, 100),
      },
    });
    return normalizePage(result, 'newest');
  }

  /** GET /api/bbs/category */
  async listCategories(opts = {}) {
    const result = await this.request('/api/bbs/category', {
      query: { page: Number(opts.page) || 1, pageSize: Math.min(Number(opts.pageSize) || 50, 200) },
    });
    if (Array.isArray(result)) return { items: result, total: result.length };
    const items = arrayFrom(result);
    return { items, total: result && (result.totalElements ?? result.total) ? result.totalElements ?? result.total : items.length };
  }

  /** GET /api/bbs/channel */
  async listChannels(opts = {}) {
    const result = await this.request('/api/bbs/channel', {
      query: { page: Number(opts.page) || 1, pageSize: Math.min(Number(opts.pageSize) || 20, 200) },
    });
    if (Array.isArray(result)) return { items: result, total: result.length };
    const items = arrayFrom(result);
    return { items, total: result && (result.totalElements ?? result.total) ? result.totalElements ?? result.total : items.length };
  }

  /** POST /api/bbs/post/{id}/reactions —— 表情互动（toggle）。 */
  async react(opts = {}) {
    this.ensureAuth('表情互动');
    const emoji = opts.emoji || '👍';
    if (!REACTIONS.includes(emoji)) {
      throw new ForumError('不支持的表情：' + emoji + '（可用：' + REACTIONS.join(' ') + '）');
    }
    if (!opts.postId) throw new ForumError('缺少 postId');
    return this.request('/api/bbs/post/' + encodeURIComponent(opts.postId) + '/reactions', {
      method: 'POST',
      body: { emoji },
    });
  }

  /** 只读状态：不触发网络请求，不泄露 token 明文。 */

  /**
   * 实名状态（发布前强校验用，**不看缓存**）。
   *
   * 后端判定条件：verifiedType != null && verifiedType > 0（1=个人实名，2=企业认证）。
   * 该字段目前从已知可用的 user-info 里读；若后端没返回，返回 verified=null（未知），
   * 由调用方标注「以服务端门控为准」，不臆测为已实名或未实名。
   */
  async realnameStatus() {
    const raw = await this.request('/api/cms/auth/narwhal/user-info');
    const user = (raw && raw.user) || raw || {};
    const vt = user.verifiedType ?? user.verifyType ?? (raw && raw.verifiedType);
    const flag = user.realNameVerified ?? user.isRealNameVerified ?? (raw && raw.realNameVerified);
    let verified = null;
    if (vt !== undefined && vt !== null && String(vt).trim() !== '') {
      verified = Number(vt) > 0;
    } else if (typeof flag === 'boolean') {
      verified = flag;
    }
    return {
      verified,
      verifiedType: vt === undefined ? null : vt,
      source: '/api/cms/auth/narwhal/user-info',
      hint: verified === false
        ? '未实名不能发布（后端 requireVerifyToPost / requireVerifyToComment）；先完成实名：POST /api/bbs/face/init（前端入口在账号安全页）'
        : verified === null
          ? '后端 user-info 未返回 verifiedType，无法在客户端判定；以服务端门控为准'
          : null,
    };
  }
  status() {
    return {
      baseUrl: this.baseUrl,
      authenticated: this.isAuthenticated,
      accessToken: maskToken(this.token),
      refreshToken: maskToken(this.refreshToken),
      hasUsername: Boolean(this.username),
      hasPassword: Boolean(this.password),
      timeoutMs: this.timeoutMs,
      configDir: this.cfg.configDir,
      credentialsPath: this.cfg.credentialsPath,
      sources: this.cfg.sources,
    };
  }
}

function arrayFrom(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.content)) return result.content;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.records)) return result.records;
  if (Array.isArray(result.items)) return result.items;
  return [];
}

/** 把 Spring Page / 裸数组 / {content,page} 统一成 {items,page,pageSize,total,totalPages}。 */
export function normalizePage(result, order) {
  if (Array.isArray(result)) {
    return { items: result, page: 1, pageSize: result.length, total: result.length, totalPages: 1, order, raw: undefined };
  }
  const r = result || {};
  const meta = r.page && typeof r.page === 'object' ? r.page : r;
  const items = arrayFrom(r);
  return {
    items,
    page: num(meta.number) + 1 || num(r.page) || 1,
    pageSize: num(meta.size) || num(r.pageSize) || items.length,
    total: num(meta.totalElements) ?? num(r.totalElements) ?? num(r.total) ?? items.length,
    totalPages: num(meta.totalPages) ?? num(r.totalPages) ?? 1,
    order,
  };
}

function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 评论树拍平（depth 表示层级，便于模型阅读）。 */
export function flattenComments(tree, depth = 0, out = []) {
  for (const c of tree || []) {
    const children = Array.isArray(c.children) ? c.children : [];
    out.push({ ...c, depth, childCount: children.length });
    if (children.length) flattenComments(children, depth + 1, out);
  }
  return out;
}

export function countComments(tree) {
  let n = 0;
  for (const c of tree || []) {
    n += 1 + countComments(Array.isArray(c.children) ? c.children : []);
  }
  return n;
}
