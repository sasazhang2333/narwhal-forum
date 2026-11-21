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
    channels: [{ id: 1, name: '综合', type: 'general' }],
    enforceCooldown: false,
    lastCommentAt: 0,
    requests: [],
  };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
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
    const body = await readBody(req);
    state.requests.push({ method, pathname, query: url.search });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', ...headers });
      res.end(JSON.stringify(payload));
    };
    const unauth = () => send(401, { status: -1, message: 'unauthorized' });

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

      if (pathname === '/api/bbs/comment' && method === 'GET') {
        const postId = Number(url.searchParams.get('postId'));
        const parentId = Number(url.searchParams.get('parentId') || 0);
        const all = state.comments.filter((c) => c.postId === postId && c.status === 1);
        const build = (pid) =>
          all
            .filter((c) => (c.parentId || 0) === pid)
            .map((c) => ({ ...c, children: build(c.id) }));
        return send(200, build(parentId));
      }

      if (pathname === '/api/bbs/comment' && method === 'POST') {
        if (!authed(req)) return unauth();
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
          status: 1,
        };
        state.posts.push(post);
        return send(200, envelope({ id: post.id, status: 1 }));
      }

      if (pathname === '/api/bbs/category' && method === 'GET') {
        return send(200, page(state.categories, url.searchParams));
      }
      if (pathname === '/api/bbs/channel' && method === 'GET') {
        return send(200, page(state.channels, url.searchParams));
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
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
