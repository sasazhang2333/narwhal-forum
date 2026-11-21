/**
 * 测试用 mock 论坛后端：按 narwhal-cms 的真实契约实现（含 RSA+AES 登录加密），
 * 让「客户端能不能真的登录/读帖/评论」这件事在无后端的环境里也能被验证。
 *
 * 只用 Node 内置模块。
 */
import http from 'node:http';
import crypto from 'node:crypto';

export const ACCESS_TOKEN = 'test-access-token';
export const REFRESH_TOKEN = 'test-refresh-token';
export const EXPIRED_TOKEN = 'expired-token';

/** 与真实后端对齐的门禁响应：status=-1 + result.blockers + message。 */
export function gated(kind, action) {
  const map = {
    realname: { code: 'realname', title: '完成实名认证', desc: '需完成实名认证后' + action, actionLabel: '去认证', actionTo: '/forum/settings?tab=profile' },
    mobile: { code: 'mobile', title: '绑定手机号', desc: '需先绑定手机号' + action, actionLabel: '去绑定', actionTo: '/forum/settings?tab=binding#mobile-binding' },
  };
  const b = { ...map[kind], action };
  return { status: -1, result: { blockers: [b] }, message: b.desc, exception: null };
}

function envelope(result) {
  return { status: 0, result };
}
function failure(message, code = -1) {
  return { status: code, message };
}

function seedPosts() {
  return [
    {
      id: 1,
      title: '欢迎来到 Narwhal 论坛',
      content: '# 欢迎\n\n这是第一帖。',
      summary: '新人必读',
      categoryId: 1,
      categoryName: '公告',
      userId: 7,
      authorName: '管理员',
      created: '2026-01-01T10:00:00Z',
      viewCount: 10,
      commentCount: 1,
      likeCount: 3,
      collectionCount: 1,
      status: 1,
    },
    {
      id: 2,
      title: '如何用 dsh 插件读论坛',
      content: '正文：先装 narwhal-forum，再让 dsh 调 list_posts。',
      categoryId: 2,
      categoryName: '技术',
      userId: 9,
      authorName: '小明',
      created: '2026-02-02T09:30:00Z',
      viewCount: 5,
      commentCount: 0,
      likeCount: 1,
      status: 1,
    },
    {
      id: 3,
      title: '一篇被隐藏的帖子',
      content: '不应该出现在列表里',
      categoryId: 2,
      categoryName: '技术',
      userId: 9,
      authorName: '小明',
      created: '2026-02-03T09:30:00Z',
      status: 0,
    },
    {
      // 待审帖（status=-1）：真实后端里新账号发帖就是这样，批准后才进列表
      id: 900000000000000001,
      title: '待审核：新用户发的帖',
      content: '批准前不该出现在列表里',
      categoryId: 1,
      categoryName: '公告',
      userId: 42,
      authorName: '测试员',
      created: '2026-02-04T09:30:00Z',
      status: -1,
    },
  ];
}

function seedComments() {
  return [
    { id: 100, postId: 1, parentId: 0, content: '第一条评论', userId: 9, userName: '小明', created: '2026-01-02T10:00:00Z', status: 1, children: [] },
    { id: 101, postId: 1, parentId: 100, content: '回复第一条', userId: 7, userName: '管理员', created: '2026-01-02T11:00:00Z', status: 1, children: [] },
  ];
}

export async function startMockForum(options = {}) {
  const state = {
    posts: seedPosts(),
    comments: seedComments(),
    categories: [
      { id: 1, name: '公告', description: '站点公告' },
      { id: 2, name: '技术', description: '技术讨论' },
    ],
    // CMS 栏目：真实后端 /api/channel 返回的是**扁平数组**（不分页），字段有 id/name/alias/site
    channels: [{ id: 1, name: '综合', alias: 'general', depth: 1 }],
    enforceCooldown: false,
    // 门禁：真实后端在「未绑手机 / 未实名」时返回 HTTP 200 + status=-1 + result.blockers
    gateComment: null,   // 'mobile' | 'realname' | null
    scopeDenied: null,   // 设成 scope id 时，写接口回 403 + X-Cli-Scope-Denied（模拟服务端能力闸）
    gatePost: null,
    // 真实后端：新账号/未达信任阈值 → 发帖进待审（status=-1），要审核批准才公开
    autoApprove: true,
    // 草稿上云（真实后端表 tusksynxcms_cli_draft）
    drafts: new Map(),
    lastCommentAt: 0,
    // 设备码授权（/api/cli/device/*）：与真实后端 CliDeviceAuthApiController 同形状
    deviceCodes: new Map(),   // deviceCode -> { deviceCode, userCode, clientName, scopes, status }
    devicePollCount: new Map(),
    requests: [],
    uploads: [],
  };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  function readRawBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  function readBody(req) {
    return readRawBody(req).then((buf) => buf.toString('utf8'));
  }

  /** 极简 multipart 解析：只取第一个文件的 filename / content-type / 字节数。 */
  function parseFirstFile(buf, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
    if (!m) return null;
    const boundary = '--' + (m[1] || m[2]).trim();
    const text = buf.toString('latin1');
    const start = text.indexOf(boundary);
    if (start < 0) return null;
    const headerEnd = text.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) return null;
    const headers = text.slice(start, headerEnd);
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    const bodyStart = headerEnd + 4;
    const nextBoundary = text.indexOf('\r\n' + boundary, bodyStart);
    const bodyEnd = nextBoundary < 0 ? text.length : nextBoundary;
    return {
      field: nameMatch ? nameMatch[1] : null,
      filename: fileMatch ? fileMatch[1] : null,
      contentType: typeMatch ? typeMatch[1].trim() : null,
      bytes: bodyEnd - bodyStart,
    };
  }

  function authed(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(header);
    return Boolean(m && m[1] === ACCESS_TOKEN);
  }

  function decryptLogin(req, body) {
    const encryptKey = String(req.headers['encrypt-key'] || '');
    if (!encryptKey) throw new Error('missing encrypt-key');
    const aesKeyB64 = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(encryptKey, 'base64')).toString('utf8');
    const aesKey = Buffer.from(aesKeyB64, 'base64').toString('utf8');
    const decipher = crypto.createDecipheriv('aes-256-ecb', Buffer.from(aesKey, 'utf8'), null);
    const json = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  }

  function page(items, query) {
    const pageNo = Number(query.get('page') || 1);
    const size = Number(query.get('pageSize') || 20);
    const start = (pageNo - 1) * size;
    const slice = items.slice(start, start + size).map((p) => ({ ...p, content: undefined }));
    return { content: slice, totalElements: items.length, totalPages: Math.max(1, Math.ceil(items.length / size)), number: pageNo - 1, size };
  }

  const server = http.createServer(async (req, res) => {

    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const pathname = url.pathname;
    const method = req.method || 'GET';

    const rawBuf = await readRawBody(req);
    const body = rawBuf.toString('utf8');
    state.requests.push({ method, pathname, query: url.search });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', ...headers });
      res.end(JSON.stringify(payload));
    };
    const unauth = () => send(401, { status: -1, message: 'unauthorized' });

    // ——— 草稿上云（真实后端：CliDraftApiController，/api/cli/draft）———
    // 与真后端同语义：pending → (人审页 review) approved/denied → (工具 consume) published。
    if (method === 'POST' && pathname === '/api/cli/draft') {
      const payload = JSON.parse(body || '{}');
      const kind = payload.kind;
      if (kind !== 'comment' && kind !== 'post') return send(200, failure('kind 只能是 comment 或 post'));
      const draftPayload = payload.payload || {};
      if (!String(draftPayload.content || '').trim()) return send(200, failure('草稿正文不能为空'));
      const draftCode = 'DR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const entry = {
        draftCode,
        kind,
        payload: draftPayload,
        payloadHash: crypto.createHash('sha256').update(kind + '\n' + JSON.stringify(draftPayload)).digest('hex'),
        status: 'pending',
        statusTitle: '待审',
        clientName: payload.clientName || 'unknown-client',
        reviewUri: '/cli/draft?code=' + draftCode,
        expiresIn: 86400,
      };
      state.drafts.set(draftCode, entry);
      return send(200, envelope(entry));
    }
    if (method === 'GET' && pathname === '/api/cli/draft') {
      const status = url.searchParams.get('status');
      const list = [...state.drafts.values()].filter((d) => !status || d.status === status);
      return send(200, envelope({ content: list, total: list.length }));
    }
    const draftRoute = pathname.match(/^\/api\/cli\/draft\/(DR-[0-9A-Z]+)(\/review|\/consume|\/result)?$/);
    if (draftRoute) {
      const entry = state.drafts.get(draftRoute[1]);
      if (!entry) return send(200, failure('草稿不存在或已过期'));
      const action = draftRoute[2] || '';
      if (!action && method === 'GET') return send(200, envelope(entry));
      if (action === '/review' && method === 'POST') {
        const payload = JSON.parse(body || '{}');
        if (entry.status !== 'pending') return send(200, failure('这条草稿当前状态是「' + entry.statusTitle + '」，不能再审批'));
        const approve = ['approve', 'allow'].includes(String(payload.decision || '').toLowerCase());
        entry.status = approve ? 'approved' : 'denied';
        entry.statusTitle = approve ? '已批准' : '已拒绝';
        entry.note = payload.note || null;
        entry.reviewerId = 1;
        entry.approvedAt = new Date().toISOString();
        return send(200, envelope(entry));
      }
      if (action === '/consume' && method === 'POST') {
        if (entry.status !== 'approved') return send(200, failure('这条草稿不是「已批准」状态，不能发布'));
        entry.status = 'published';
        entry.statusTitle = '已发布';
        return send(200, envelope({ draftCode: entry.draftCode, kind: entry.kind, status: 'published', payloadHash: entry.payloadHash, payload: entry.payload }));
      }
      if (action === '/result' && method === 'POST') {
        const payload = JSON.parse(body || '{}');
        entry.resultId = payload.resultId === undefined ? null : payload.resultId;
        entry.result = payload.result || null;
        return send(200, envelope({ draftCode: entry.draftCode, resultId: entry.resultId, result: entry.result }));
      }
      return send(404, failure('not found'));
    }

    // ——— 设备码授权（真实后端：CliDeviceAuthApiController）———
    if (method === 'POST' && pathname === '/api/cli/device/code') {
      // body 在进入路由分支前已被读走（rawBuf），这里不能再去读流 —— 否则等一个已结束的流会挂住
      const payload = JSON.parse(body || '{}');
      const deviceCode = crypto.randomBytes(16).toString('hex');
      const userCode = 'TEST-CODE';
      state.deviceCodes.set(deviceCode, {
        deviceCode, userCode,
        clientName: payload.clientName || 'unknown-client',
        scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
        status: 'pending',
      });
      return send(200, envelope({
        deviceCode, userCode,
        verificationUri: '/cli/authorize?code=' + userCode,
        expiresIn: 600, interval: 1, scopes: payload.scopes || [],
      }));
    }
    if (method === 'POST' && pathname === '/api/cli/device/authorize') {
      // 与真实后端一致：accept 人勾选的 scopes 子集；不传 scopes 表示「全给」
      const payload = JSON.parse(body || '{}');
      // 同一个 mock 里可能残留上一轮的码（userCode 是固定的），只认还没被处理的那条
      const entry = [...state.deviceCodes.values()]
        .filter((e) => e.userCode === payload.userCode)
        .sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1))[0];
      if (!entry || entry.status !== 'pending') {
        return send(200, failure('设备码不存在、已过期或已被使用'));
      }
      if (payload.decision === 'deny') {
        entry.status = 'denied';
        return send(200, envelope({ status: 'denied' }));
      }
      const requested = entry.scopes || [];
      const granted = Array.isArray(payload.scopes)
        ? requested.filter((s) => payload.scopes.includes(s))
        : requested.slice();
      if (!granted.length) {
        return send(200, failure('请至少勾选一项能力，然后再点「允许」'));
      }
      entry.granted = granted;
      entry.status = 'approved';
      return send(200, envelope({ status: 'approved', clientName: entry.clientName, scopes: granted, userCode: entry.userCode }));
    }

    if (method === 'GET' && pathname === '/api/cli/device/poll') {
      const deviceCode = url.searchParams.get('deviceCode');
      const entry = state.deviceCodes.get(deviceCode);
      if (!entry) return send(200, failure('设备码不存在或已过期'));
      if (entry.status === 'pending') {
        const n = (state.devicePollCount.get(deviceCode) || 0) + 1;
        state.devicePollCount.set(deviceCode, n);
        // 第 2 次轮询之前由测试主动 approve
        return send(200, envelope({ status: 'pending', userCode: entry.userCode, clientName: entry.clientName, scopes: entry.granted || entry.scopes, expiresIn: 600, interval: 1 }));
      }
      if (entry.status === 'approved') {
        entry.status = 'consumed';
        return send(200, envelope({
          status: 'approved',
          accessToken: ACCESS_TOKEN,
          refreshToken: REFRESH_TOKEN,
          username: 'admin',
          userId: '1',
          clientName: entry.clientName,
          scopes: entry.granted || entry.scopes,
          userCode: entry.userCode,
        }));
      }
      return send(200, envelope({ status: entry.status, userCode: entry.userCode, clientName: entry.clientName, scopes: entry.scopes, expiresIn: 0, interval: 1 }));
    }

    try {
      if (pathname === '/api/cms/auth/narwhal/code' && method === 'GET') {
        return send(200, envelope({ captchaEnabled: false, type: 'aes-rsa', publicKey: publicKeyPem }));
      }

      if (pathname === '/api/cms/auth/narwhal/login' && method === 'POST') {
        let payload;
        try {
          payload = decryptLogin(req, body);
        } catch (err) {
          return send(200, failure('登录参数解密失败: ' + err.message));
        }
        if (payload.username !== 'tester' || payload.password !== 'secret-pass') {
          return send(200, failure('用户名或密码错误'));
        }
        return send(200, envelope({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }));
      }

      if (pathname === '/api/cms/auth/jwt/refresh-token' && method === 'POST') {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.refreshToken !== REFRESH_TOKEN) return send(200, failure('refresh token 无效'));
        return send(200, envelope({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN }));
      }

      if (pathname === '/api/cms/auth/narwhal/user-info') {
        if (!authed(req)) return unauth();
        const user = { userId: 42, userName: 'tester', nickName: '测试员' };
        if (state.realname !== undefined && state.realname !== null) user.verifiedType = state.realname;
        return send(200, envelope({ user, roles: ['USER'], permissions: ['bbs:comment'] }));
      }

      if (pathname === '/api/upload/image-upload' && method === 'POST') {
        if (!authed(req)) return unauth();
        const file = parseFirstFile(rawBuf, req.headers['content-type']);
        if (!file || !file.filename) return send(400, { status: 400, message: '缺少文件字段 file' });
        if (!/^image\//.test(String(file.contentType || ''))) return send(400, { status: 400, message: '不是图片' });
        const safeName = String(file.filename).replace(/[^A-Za-z0-9._-]/g, '_');
        const fileUrl = '/uploads/mock/' + Date.now() + '-' + safeName;
        state.uploads.push({ ...file, scene: url.searchParams.get('scene') || null, url: fileUrl });
        return send(200, envelope({ url: fileUrl, webpUrl: fileUrl, size: file.bytes }));
      }

      if (pathname === '/api/bbs/post' && method === 'GET') {
        if (!url.searchParams.get('page') || !url.searchParams.get('pageSize')) {
          return send(200, failure('page/pageSize 必填'));
        }
        let items = state.posts.filter((p) => p.status === 1);
        const categoryId = url.searchParams.get('EQ_categoryId_Long');
        if (categoryId) items = items.filter((p) => String(p.categoryId) === String(categoryId));
        const userId = url.searchParams.get('EQ_userId_Long');
        if (userId) items = items.filter((p) => String(p.userId) === String(userId));
        const titleLike = url.searchParams.get('LIKE_title_String');
        if (titleLike) items = items.filter((p) => String(p.title).includes(titleLike));
        return send(200, page(items, url.searchParams));
      }

      if (pathname === '/api/bbs/post/hot' && method === 'GET') {
        const items = state.posts.filter((p) => p.status === 1).slice().reverse();
        return send(200, page(items, url.searchParams));
      }

      if (pathname === '/api/bbs/post/search' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const items = state.posts.filter((p) => p.status === 1 && String(p.title).includes(q));
        return send(200, envelope(page(items, url.searchParams)));
      }

      const postMatch = /^\/api\/bbs\/post\/(\d+)(\/reactions)?$/.exec(pathname);
      if (postMatch) {
        const id = Number(postMatch[1]);
        const post = state.posts.find((p) => p.id === id);
        if (!post || post.status !== 1) return send(404, { status: 404, message: 'not found' });
        if (postMatch[2] && method === 'POST') {
          if (!authed(req)) return unauth();
          if (state.scopeDenied) {
            return send(403, {
              status: 1,
              message: '这个 AI 工具的授权不含「评论与互动」（' + state.scopeDenied + '）：已授予 read。要放宽请在设置页调整权限，保存后即刻生效。',
            }, { 'X-Cli-Scope-Denied': state.scopeDenied });
          }
          const payload = JSON.parse(body || '{}');
          if (!['👍', '❤️', '😂', '🎉', '🤔', '😮', '😢', '🚀'].includes(payload.emoji)) {
            return send(200, failure('不支持的表情'));
          }
          post.likeCount = (post.likeCount || 0) + 1;
          return send(200, envelope({ toggled: 'on', emoji: payload.emoji }));
        }
        if (method === 'GET') {
          post.viewCount = (post.viewCount || 0) + 1;
          return send(200, { ...post });
        }
      }

      // 与真实后端对齐：这一层**只回直接子级**，嵌套回复走下面 /replies
      if (pathname === '/api/bbs/comment' && method === 'GET') {
        const postId = Number(url.searchParams.get('postId'));
        const parentId = Number(url.searchParams.get('parentId') || 0);
        const direct = state.comments
          .filter((c) => c.postId === postId && c.status === 1 && (c.parentId || 0) === parentId)
          .map(({ children, ...rest }) => rest); // 真实后端不回 children，嵌套由调用方拼
        return send(200, direct);
      }

      // 与真实后端对齐：GET /api/bbs/comment/{id}/replies → { content, page }
      if (/^\/api\/bbs\/comment\/\d+\/replies$/.test(pathname) && method === 'GET') {
        const cid = Number(pathname.split('/')[4]);
        const items = state.comments
          .filter((c) => c.status === 1 && (c.parentId || 0) === cid)
          .map(({ children, ...rest }) => rest);
        return send(200, {
          content: items,
          page: { totalElements: items.length, totalPages: 1, number: 1, size: 20 },
        });
      }

      if (pathname === '/api/bbs/comment' && method === 'POST') {
        if (!authed(req)) return unauth();
        if (state.gateComment) return send(200, gated(state.gateComment, '才能评论'));
        const payload = JSON.parse(body || '{}');
        const content = String(payload.content || '').trim();
        if (!content) return send(200, failure('评论内容不能为空'));
        if (content.length > 2000) return send(200, failure('评论内容过长'));
        if (state.enforceCooldown) {
          const now = Date.now();
          if (now - state.lastCommentAt < 15000) return send(200, failure('操作过快，请等待 15 秒后再试'));
          state.lastCommentAt = now;
        }
        const post = state.posts.find((p) => p.id === Number(payload.postId));
        if (!post) return send(200, failure('帖子不存在'));
        const comment = {
          id: 1000 + state.comments.length,
          postId: Number(payload.postId),
          parentId: payload.parentId ? Number(payload.parentId) : 0,
          content,
          userId: 42,
          userName: '测试员',
          created: new Date().toISOString(),
          status: 1,
          children: [],
        };
        state.comments.push(comment);
        post.commentCount = (post.commentCount || 0) + 1;
        return send(200, envelope({ id: comment.id, status: 1 }));
      }

      if (/^\/api\/bbs\/comment\/\d+$/.test(pathname) && method === 'DELETE') {
        if (!authed(req)) return unauth();
        const cid = Number(pathname.split('/')[4]);
        const idx = state.comments.findIndex((c) => c.id === cid);
        if (idx < 0) return send(200, failure('评论不存在'));
        const c = state.comments[idx];
        if (c.userId !== 42) return send(403, { status: 403, message: 'Only the author can delete this comment' });
        state.comments.splice(idx, 1);
        return send(200, envelope({ deleted: cid }));
      }

      if (/^\/api\/bbs\/post\/\d+\/approve$/.test(pathname) && method === 'PUT') {
        if (!authed(req)) return unauth();
        const pid = Number(pathname.split('/')[4]);
        const post = state.posts.find((p) => p.id === pid);
        if (!post) return send(200, failure('帖子不存在'));
        post.status = 1;
        return send(200, envelope({ id: pid, status: 1 }));
      }

      if (/^\/api\/bbs\/post\/\d+$/.test(pathname) && method === 'DELETE') {
        if (!authed(req)) return unauth();
        const pid = Number(pathname.split('/')[4]);
        const idx = state.posts.findIndex((p) => p.id === pid);
        if (idx < 0) return send(200, failure('帖子不存在'));
        state.posts.splice(idx, 1);
        return send(200, envelope({ deleted: pid }));
      }

      if (pathname === '/api/bbs/comment/my' && method === 'GET') {
        if (!authed(req)) return unauth();
        const mine = state.comments.filter((c) => c.userId === 42);
        return send(200, page(mine, url.searchParams));
      }

      if (pathname === '/api/bbs/post' && method === 'POST') {
        if (!authed(req)) return unauth();
        const payload = JSON.parse(body || '{}');
        if (!payload.title || !payload.content || !payload.categoryId) return send(200, failure('缺少必填字段'));
        const post = {
          id: 100 + state.posts.length,
          title: payload.title,
          content: payload.content,
          categoryId: Number(payload.categoryId),
          userId: 42,
          authorName: '测试员',
          created: new Date().toISOString(),
          status: state.autoApprove ? 1 : -1,
        };
        state.posts.push(post);
        return send(200, envelope({ id: post.id, status: post.status }));
      }

      if (pathname === '/api/bbs/category' && method === 'GET') {
        return send(200, page(state.categories, url.searchParams));
      }
      // CMS 栏目列表（真实后端：扁平数组，不分页）
      if (pathname === '/api/channel' && method === 'GET') {
        return send(200, state.channels);
      }

      return send(404, { status: 404, message: 'no route: ' + method + ' ' + pathname });
    } catch (err) {
      return send(500, { status: 500, message: String(err && err.message) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = 'http://127.0.0.1:' + port;

  return {
    server,
    state,
    baseUrl,
    publicKeyPem,
    reset() {
      state.posts = seedPosts();
      state.comments = seedComments();
      state.enforceCooldown = false;
      state.lastCommentAt = 0;
      state.requests = [];
      state.uploads = [];
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
