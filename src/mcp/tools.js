/**
 * MCP 工具表：唯一的「能力定义」来源。
 *
 * CLI 的 `tools` 命令、MCP 的 tools/list、以及 README 的能力表都由这里派生，
 * 避免「文档写了一套、代码里是另一套」。
 */
import { REACTIONS, POST_ORDERS, flattenComments, countComments } from '../client.js';
import { RISK_VERSION, riskNoticeText, riskAcknowledged, riskConsentPatch } from '../risk.js';
import { patchCredentials, readCredentials } from '../config.js';
import { createDraft, readDraft, listDrafts, removeDraft, verifyApprovalToken, markPublished } from '../draft.js';
import { resolveImageList, verifyDraftImages, summarizeImages, contentWithImages, MAX_IMAGES } from '../images.js';

const S = {
  str: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  int: (description, extra = {}) => ({ type: 'integer', description, ...extra }),
  bool: (description, extra = {}) => ({ type: 'boolean', description, ...extra }),
  images: (description) => ({ type: 'array', items: { type: 'string' }, description, maxItems: MAX_IMAGES }),
};

function obj(props, required = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function author(post) {
  return post.authorName || post.userName || (post.user && (post.user.nickName || post.user.userName)) || (post.userId ? '用户#' + post.userId : '匿名');
}

function renderPostList(page) {
  const lines = [];
  lines.push('帖子列表（order=' + page.order + '，page=' + page.page + '，pageSize=' + page.pageSize + '，共 ' + page.total + ' 条 / ' + page.totalPages + ' 页）');
  if (!page.items.length) {
    lines.push('（本页为空）');
    return lines.join('\n');
  }
  for (const p of page.items) {
    const bits = ['#' + p.id];
    if (p.categoryName || p.categoryId) bits.push('[' + (p.categoryName || '分类#' + p.categoryId) + ']');
    bits.push(String(p.title || '(无标题)'));
    const stats = [];
    if (p.commentCount !== undefined) stats.push('💬' + p.commentCount);
    if (p.viewCount !== undefined) stats.push('👁' + p.viewCount);
    if (p.likeCount !== undefined) stats.push('👍' + p.likeCount);
    if (p.collectionCount !== undefined) stats.push('⭐' + p.collectionCount);
    lines.push('- ' + bits.join(' ') + (stats.length ? '  ' + stats.join(' ') : ''));
    const meta = [author(p)];
    if (p.created) meta.push(fmtTime(p.created));
    if (p.status !== undefined && p.status !== 1) meta.push('status=' + p.status);
    lines.push('    ' + meta.join(' · '));
  }
  return lines.join('\n');
}

function renderPost(post) {
  const lines = [];
  lines.push('# ' + (post.title || '(无标题)'));
  const meta = ['id=' + post.id];
  if (post.categoryName || post.categoryId) meta.push('分类=' + (post.categoryName || post.categoryId));
  meta.push('作者=' + author(post));
  if (post.created) meta.push('发表=' + fmtTime(post.created));
  if (post.viewCount !== undefined) meta.push('浏览=' + post.viewCount);
  if (post.commentCount !== undefined) meta.push('评论=' + post.commentCount);
  if (post.likeCount !== undefined) meta.push('赞=' + post.likeCount);
  lines.push(meta.join(' · '));
  if (post.memberLocked || post.columnLocked) {
    lines.push('');
    lines.push('⚠️ 正文被截断：' + (post.memberLocked ? '会员可见内容' : '专栏付费内容') + '（当前身份无权限）。');
  }
  lines.push('');
  lines.push(post.content || '(正文为空或未返回)');
  return lines.join('\n');
}

function renderComment(item, index) {
  const indent = '  '.repeat(item.depth || 0);
  const head = indent + (index + 1) + '. ' + author(item) + (item.created ? ' · ' + fmtTime(item.created) : '') + '  (id=' + item.id + ')';
  const reply = item.replyUserName ? indent + '   回复 @' + item.replyUserName : null;
  const body = String(item.content || '').split('\n').map((line) => indent + '    ' + line).join('\n');
  return [head, reply, body].filter(Boolean).join('\n');
}

function renderComments(tree, meta = {}) {
  const flat = flattenComments(tree);
  const lines = ['评论（共 ' + flat.length + ' 条' + (meta.postId ? '，postId=' + meta.postId : '') + '）'];
  if (!flat.length) {
    lines.push('（暂无评论）');
    return lines.join('\n');
  }
  flat.forEach((c, i) => lines.push(renderComment(c, i)));
  return lines.join('\n');
}

/**
 * @typedef {{name:string,title:string,description:string,inputSchema:object,handler:(ctx:any,args:any)=>Promise<{text:string,data?:any}>}} ToolDef
 */

/** 所有能力。dsh / Claude Code / Codex 都通过同一张表暴露。 */
function draftFailure(code, message, hint) {
  const err = new Error(message);
  err.name = 'DraftError';
  err.code = code;
  if (hint) err.hint = hint;
  return err;
}

function draftBrief(record) {
  const p = record.payload || {};
  if (record.kind === 'comment') return '评论 → 帖子 #' + p.postId + '：' + String(p.content || '').slice(0, 50);
  return '发帖 → ' + (p.title || '(无标题)') + ' @ 分类 ' + p.categoryId;
}

function renderDraft(record) {
  const p = record.payload || {};
  const lines = ['草稿 ' + record.id + '  [' + record.status + ']', '  类型: ' + record.kind, '  内容指纹: ' + record.hash];
  if (record.kind === 'comment') {
    lines.push('  目标: 帖子 #' + p.postId + (p.parentId ? '，回复评论 #' + p.parentId : ''));
    lines.push('  正文:', String(p.content || ''));
  } else {
    lines.push('  标题: ' + (p.title || ''));
    lines.push('  分类: ' + p.categoryId);
    lines.push('  正文:', String(p.content || ''));
  }
  const images = Array.isArray(p.images) ? p.images : [];
  if (images.length) {
    lines.push('  图片（发布时上传并内联到正文末尾，共 ' + images.length + ' 张）:');
    for (const line of summarizeImages(images)) lines.push('    ' + line);
  }
  if (record.review) lines.push('  审阅: ' + record.review.decision + ' @ ' + record.review.at);
  if (record.approval) lines.push('  批准: ' + record.approval.expiresAt + (record.approval.usedAt ? '（已使用 ' + record.approval.usedAt + '）' : '（未使用）'));
  if (record.status === 'pending_review') lines.push('  待人工批准：人在终端运行 narwhal-forum draft approve ' + record.id);
  return lines.join('\n');
}
export const TOOLS = [
  {
    name: 'status',
    title: '查看插件状态与配置来源',
    description: '查看当前生效的后端地址、是否已登录、凭据来源（环境变量/凭据文件/默认），不发起网络请求、不输出 token 明文。排查「没反应/连不上/未登录」时先调它。',
    inputSchema: obj({}),
    async handler(ctx) {
      const s = ctx.client.status();
      return {
        text: [
          '后端地址: ' + s.baseUrl + '（来源: ' + s.sources.baseUrl + '）',
          '登录状态: ' + (s.authenticated ? '已登录' : '未登录（只读操作可用）'),
          'access token: ' + (s.accessToken || '无'),
          'refresh token: ' + (s.refreshToken || '无'),
          '凭据文件: ' + s.credentialsPath,
          '超时: ' + s.timeoutMs + 'ms',
        ].join('\n'),
        data: s,
      };
    },
  },
  {
    name: 'login',
    title: '网页授权登录（默认）或账号密码登录',
    description: '默认 mode=browser：在你的机器上打开一个独立浏览器窗口，你在里面完成论坛登录，插件从页面里取走 token 并写入本地凭据文件（0600），之后所有调用自动带上。全程不需要把密码交给模型或 dsh。mode=password 时才用用户名/密码（密码只从参数或环境变量读，绝不落盘）。只在需要写操作（评论/发帖/点赞）或读取登录态专属内容时调用；只读公开内容无需登录。撤销授权用 logout。**调用前必须先把风险提示展示给用户并取得明确同意**：首次调用（不带 acknowledgeRisks）不打开浏览器，只返回风险全文与 E_RISK_ACK_REQUIRED；用户看过并同意后，再带 acknowledgeRisks=true 调用。',
    inputSchema: obj({
      mode: S.str('browser=打开浏览器人工授权（默认）；password=账号密码', { enum: ['browser', 'password'], default: 'browser' }),
      timeoutSec: S.int('浏览器模式下等待人工登录的秒数（默认 300）', { minimum: 10, maximum: 1800 }),
      browserPath: S.str('指定浏览器可执行文件（默认自动找 Chrome/Edge/Brave/Chromium）'),
      username: S.str('mode=password 时的用户名'),
      password: S.str('mode=password 时的密码（不落盘，可用环境变量 NARWHAL_FORUM_PASSWORD 代替）'),
      captchaToken: S.str('若后端开启了图形验证码，可传入已获得的校验票据'),
      acknowledgeRisks: S.bool('是否已把风险提示展示给用户并取得明确同意（默认 false：不打开浏览器，只返回风险全文）', { default: false }),
    }),
    async handler(ctx, args) {
      const mode = args.mode || 'browser';
      if (args.acknowledgeRisks !== true) {
        const acked = riskAcknowledged(readCredentials());
        return {
          text: riskNoticeText({ baseUrl: ctx.client.baseUrl, mode }) + '\n' + '\n' +
            (acked
              ? '该账号此前已同意过 v' + RISK_VERSION + '，但仍请把上面的风险提示再看一遍；确认后带 acknowledgeRisks=true 重新调用以打开浏览器。'
              : '以上是授权前的风险提示。请把全文展示给用户，取得明确同意后，再带 acknowledgeRisks=true 重新调用；不要自行假设用户已同意。'),
          data: { ok: false, code: 'E_RISK_ACK_REQUIRED', riskVersion: RISK_VERSION, previouslyAcknowledged: acked },
        };
      }
      patchCredentials(riskConsentPatch());
      if (mode === 'password') {
        const r = await ctx.client.login(args);
        return {
          text: '登录成功：' + r.accessToken + '\n凭据已写入 ' + r.credentialsPath + '（refresh token 可自动续期）。\n风险提示已记录（v' + RISK_VERSION + '）；撤销授权调用 logout。',
          data: r,
        };
      }
      const { browserLogin } = await import('../auth.js');
      const r = await browserLogin({
        baseUrl: ctx.client.baseUrl,
        timeoutMs: (args.timeoutSec || 300) * 1000,
        browserPath: args.browserPath,
        log: (line) => process.stderr.write('[narwhal-forum] ' + line + '\n'),
      });
      ctx.client.setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
      return {
        text: '授权成功（浏览器登录）\n凭据: ' + r.credentialsPath + '\n浏览器 profile: ' + r.profileDir + '\n撤销: 调用 logout，或运行 narwhal-forum logout',
        data: { authenticated: true, authMode: 'browser', profileDir: r.profileDir, credentialsPath: r.credentialsPath },
      };
    },
  },
  {
    name: 'logout',
    title: '撤销授权（退出登录）',
    description: '撤销本机保存的论坛授权：调用后端登出接口 → 删除本地凭据文件 → 删除插件专用的浏览器 profile 目录（其中的登录态与 cookie 一并消失）。用户说「退出登录 / 取消授权 / 撤销授权」时调用。keepBrowser=true 时保留浏览器 profile。',
    inputSchema: obj({
      keepBrowser: S.bool('保留浏览器 profile 目录（默认会一并删除）', { default: false }),
    }),
    async handler(ctx, args) {
      const { revokeAuth } = await import('../auth.js');
      const r = await revokeAuth({ baseUrl: ctx.client.baseUrl, token: ctx.client.token, keepBrowser: args.keepBrowser === true });
      ctx.client.setTokens({ accessToken: null, refreshToken: null });
      return {
        text: [
          '已撤销授权',
          '后端登出: ' + r.backendLogout,
          '本地凭据: ' + (r.tokenRemoved ? '已删除' : '本来就没有'),
          '浏览器 profile: ' + (r.keepBrowser ? '已保留' : r.profileRemoved ? '已删除' : '未删除（' + (r.profileError || '不存在') + '）') + ' (' + r.profileDir + ')',
        ].join('\n'),
        data: r,
      };
    },
  },
  {
    name: 'whoami',
    title: '当前登录用户信息',
    description: '返回当前 token 对应的用户信息、角色与权限。写操作失败（403/字段缺失）时用它确认登录身份是否正确。',
    inputSchema: obj({}),
    async handler(ctx) {
      const me = await ctx.client.whoami();
      const u = me.user || {};
      return {
        text: ['用户: ' + (u.nickName || u.userName || '(未知)') + ' (id=' + (u.userId || '?') + ')',
          '角色: ' + (Array.isArray(me.roles) ? me.roles.join(', ') : me.roles || '无'),
          '权限数: ' + (Array.isArray(me.permissions) ? me.permissions.length : 0)].join('\n'),
        data: me,
      };
    },
  },
  {
    name: 'list_posts',
    title: '列出帖子',
    description: '分页列出论坛帖子，可选按分类/作者过滤，或用 order 切换热榜等专用排序（newest=最新，hot=热门，trending=趋势，unanswered=零回复，most-collected=收藏最多，best-all-time=历史最佳，on-this-day=那年今日）。匿名可用。返回每条帖子的 id/标题/作者/计数，用 id 再调 get_post 看正文。',
    inputSchema: obj({
      page: S.int('页码，从 1 开始', { minimum: 1, default: 1 }),
      pageSize: S.int('每页条数（1-100）', { minimum: 1, maximum: 100, default: 20 }),
      categoryId: S.int('按分类 id 过滤'),
      userId: S.int('按作者 userId 过滤'),
      titleLike: S.str('标题模糊匹配（后端 LIKE）'),
      order: S.str('排序端点', { enum: Object.keys(POST_ORDERS), default: 'newest' }),
    }),
    async handler(ctx, args) {
      const page = await ctx.client.listPosts(args);
      return { text: renderPostList(page), data: { page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages, order: page.order, items: page.items } };
    },
  },
  {
    name: 'get_post',
    title: '读取帖子详情',
    description: '按 id 读取帖子正文（markdown）。会把阅读数 +1；已删除/隐藏的帖子返回 404。需要一并看评论时传 with_comments=true（等价于再调 list_comments）。会员/付费专栏内容会返回截断正文并标注。',
    inputSchema: obj({
      postId: S.int('帖子 id'),
      withComments: S.bool('同时返回完整评论树', { default: false }),
      commentSort: S.str('评论排序（oldest/newest）', { enum: ['oldest', 'newest'], default: 'oldest' }),
    }, ['postId']),
    async handler(ctx, args) {
      const r = await ctx.client.getPost(args.postId, { withComments: args.withComments, commentSort: args.commentSort });
      const parts = [renderPost(r.post)];
      if (r.comments) {
        parts.push('');
        parts.push('---');
        parts.push(renderComments(r.comments, { postId: args.postId }));
      }
      return { text: parts.join('\n'), data: r };
    },
  },
  {
    name: 'list_comments',
    title: '读取帖子评论',
    description: '读取某个帖子的评论树（含嵌套回复，按层级缩进展示），返回 id / 作者 / 时间 / 正文。匿名可用。要回复某条评论时，把它在结果里的 id 作为 create_comment 的 parentId。',
    inputSchema: obj({
      postId: S.int('帖子 id'),
      sort: S.str('排序', { enum: ['oldest', 'newest'], default: 'oldest' }),
    }, ['postId']),
    async handler(ctx, args) {
      const tree = await ctx.client.listComments(args);
      return { text: renderComments(tree, { postId: args.postId }), data: { postId: args.postId, total: countComments(tree), tree } };
    },
  },
  {
    name: 'upload_image',
    title: '上传图片',
    description: '把本机一张图片上传到论坛（POST /api/upload/image-upload，与网页端粘贴上传同一接口），返回可直接写进 markdown 的 URL。需要登录。图片压缩、水印与内容审核都在服务端完成，因此不需要改后端。一般不必单独调用：create_comment / create_post / draft_create 都支持 images 参数，会自动上传并内联。单张上限 10MB，格式限 png/jpg/jpeg/gif/webp/bmp/avif。',
    inputSchema: obj({
      path: S.str('本机图片绝对路径（建议绝对路径）'),
      scene: S.str('上传场景（如 chat）；聊天/私信类内容传 chat 会把文件登记为私密'),
    }, ['path']),
    async handler(ctx, args) {
      const r = await ctx.client.uploadImage(args);
      return {
        text: '已上传：' + r.url + '\n  文件: ' + r.name + '（' + r.bytes + ' B）\n  内联写法: ![](' + r.url + ')',
        data: { url: r.url, name: r.name, bytes: r.bytes, sha256: r.sha256 },
      };
    },
  },
  {
    name: 'create_comment',
    title: '发表评论',
    description: '在指定帖子下发评论；传 parentId 则回复该条评论。需要登录。正文 1-2000 字（含图片 markdown）；同一用户两次评论有 15 秒冷却，目标帖若开启慢速模式或已锁定会被拒绝；命中敏感词直接失败。成功后返回新评论 id。images 传本机图片路径数组时会先上传再把 ![](url) 内联到正文末尾（后端零改动，图片审核在上传时完成）。⚠️ 由 AI 代写或代发的内容必须先走人审：draft_create → 人在终端 draft approve → draft_publish；不要直接调用本工具上线未经人审的内容。',
    inputSchema: obj({
      postId: S.int('帖子 id'),
      content: S.str('评论正文，1-2000 字'),
      parentId: S.int('父评论 id（回复某条评论时传）'),
      replyUserId: S.int('被回复用户 id（后端用于 @ 提示，可选）'),
      whisper: S.bool('是否悄悄话（仅部分版块支持）'),
      images: S.images('本地图片路径（最多 ' + MAX_IMAGES + ' 张），会自动上传并内联为 markdown 图片'),
    }, ['postId']),
    async handler(ctx, args) {
      const r = await ctx.client.createComment(args);
      const id = r && (r.id || (r.result && r.result.id));
      return {
        text: '评论已发表' + (id ? '（id=' + id + '）' : '') + '：postId=' + args.postId + (args.parentId ? '，parentId=' + args.parentId : '') + '。',
        data: r,
      };
    },
  },
  {
    name: 'create_post',
    title: '发表新帖',
    description: '在指定分类下发一篇新帖。需要登录，且账号需满足后端发帖门槛（实名/绑定手机/分类状态）。标题 <=200 字，正文 <=100000 字（含图片 markdown），摘要 <=500 字。images 传本机图片路径数组时会先上传再把 ![](url) 内联到正文末尾。成功返回新帖 id 与状态。⚠️ AI 生成的内容必须人审：先用 draft_create 建草稿，人在终端 draft approve 后，再用 draft_publish 发布。',
    inputSchema: obj({
      categoryId: S.int('分类 id（用 list_categories 查）'),
      title: S.str('标题，<=200 字'),
      content: S.str('正文（markdown），<=100000 字'),
      summary: S.str('摘要，<=500 字'),
      type: S.str('帖子类型（后端定义，如 normal/article）'),
      cover: S.str('封面图 URL'),
      images: S.images('本地图片路径（最多 ' + MAX_IMAGES + ' 张），会自动上传并内联为 markdown 图片'),
    }, ['categoryId', 'title']),
    async handler(ctx, args) {
      const r = await ctx.client.createPost(args);
      const id = r && r.id;
      return { text: '帖子已发布' + (id ? '（id=' + id + '）' : '') + '：' + args.title, data: r };
    },
  },
  {
    name: 'list_categories',
    title: '列出论坛分类',
    description: '列出论坛分类（id / 名称 / 描述），发帖前用它拿 categoryId。匿名可用。',
    inputSchema: obj({
      page: S.int('页码', { minimum: 1, default: 1 }),
      pageSize: S.int('每页条数', { minimum: 1, maximum: 200, default: 50 }),
    }),
    async handler(ctx, args) {
      const r = await ctx.client.listCategories(args);
      const lines = ['分类（共 ' + r.total + ' 个）'];
      for (const c of r.items) lines.push('- #' + c.id + ' ' + (c.name || c.title || '') + (c.description ? ' — ' + c.description : ''));
      return { text: lines.join('\n'), data: r };
    },
  },
  {
    name: 'list_channels',
    title: '列出论坛频道',
    description: '列出论坛频道（id / 名称 / 类型），用于按频道浏览内容。匿名可用。',
    inputSchema: obj({
      page: S.int('页码', { minimum: 1, default: 1 }),
      pageSize: S.int('每页条数', { minimum: 1, maximum: 200, default: 20 }),
    }),
    async handler(ctx, args) {
      const r = await ctx.client.listChannels(args);
      const lines = ['频道（共 ' + r.total + ' 个）'];
      for (const c of r.items) lines.push('- #' + c.id + ' ' + (c.name || c.title || '') + (c.type ? ' [' + c.type + ']' : ''));
      return { text: lines.join('\n'), data: r };
    },
  },
  {
    name: 'search_posts',
    title: '搜索帖子',
    description: '全文搜索帖子（依赖后端 Lucene 索引；索引未建好时后端会返回失败，此时改用 list_posts 的 titleLike 做标题模糊匹配）。',
    inputSchema: obj({
      q: S.str('搜索关键词'),
      categoryId: S.int('限定分类'),
      userId: S.int('限定作者'),
      dateFrom: S.str('起始日期（YYYY-MM-DD）'),
      dateTo: S.str('结束日期（YYYY-MM-DD）'),
      sort: S.str('排序（relevance/newest）', { enum: ['relevance', 'newest'], default: 'relevance' }),
      page: S.int('页码', { minimum: 1, default: 1 }),
      pageSize: S.int('每页条数', { minimum: 1, maximum: 100, default: 10 }),
    }, ['q']),
    async handler(ctx, args) {
      const page = await ctx.client.searchPosts(args);
      return { text: renderPostList(page), data: { total: page.total, items: page.items } };
    },
  },
  {
    name: 'my_comments',
    title: '我的评论',
    description: '列出当前登录用户发过的评论（分页）。需要登录。用于确认刚才的评论是否真的写入成功。',
    inputSchema: obj({
      page: S.int('页码', { minimum: 1, default: 1 }),
      pageSize: S.int('每页条数', { minimum: 1, maximum: 100, default: 20 }),
    }),
    async handler(ctx, args) {
      const page = await ctx.client.listMyComments(args);
      const lines = ['我的评论（共 ' + page.total + ' 条，page=' + page.page + '/' + page.totalPages + '）'];
      for (const c of page.items) {
        lines.push('- #' + c.id + ' postId=' + c.postId + ' · ' + fmtTime(c.created) + ' · ' + String(c.content || '').slice(0, 120).split('\n')[0]);
      }
      return { text: lines.join('\n'), data: { total: page.total, items: page.items } };
    },
  },
  {
    name: 'react_post',
    title: '给帖子发表情',
    description: '给帖子点表情（同一点第二次会取消）。需要登录。可用表情固定为：' + REACTIONS.join(' ') + '。返回 toggled=on/off。',
    inputSchema: obj({
      postId: S.int('帖子 id'),
      emoji: S.str('表情（默认 👍）', { enum: REACTIONS, default: '👍' }),
    }, ['postId']),
    async handler(ctx, args) {
      const r = await ctx.client.react(args);
      const state = r && (r.toggled || r.state);
      return { text: '表情 ' + (args.emoji || '👍') + ' 已' + (state === 'off' ? '取消' : '添加') + '（postId=' + args.postId + '）', data: r };
    },
  },
  {
    name: 'draft_create',
    title: '创建发布草稿（人审第一步）',
    description: '把要发布的内容写成**本地草稿**，不碰后端、也不上线。这是 AI 发布内容的唯一入口：草稿必须由人在自己的终端里运行 `narwhal-forum draft approve <id>` 批准，拿到一次性 approvalToken 之后才能用 draft_publish 发布。MCP 侧没有 approve 工具（故意的）。',
    inputSchema: obj({
      kind: S.str('草稿类型：comment=评论 / post=发帖', { enum: ['comment', 'post'] }),
      postId: S.int('评论目标帖子 id（kind=comment 必填）'),
      content: S.str('正文（评论 1-2000 字；帖子 <=100000 字）'),
      parentId: S.int('回复某条评论时传父评论 id（kind=comment 可选）'),
      replyUserId: S.int('被回复用户 id（可选）'),
      whisper: S.bool('是否悄悄话（仅部分版块支持）'),
      categoryId: S.int('分类 id（kind=post 必填，用 list_categories 查）'),
      title: S.str('标题（kind=post 必填，<=200 字）'),
      summary: S.str('摘要（kind=post 可选，<=500 字）'),
      images: S.images('本地图片路径（最多 ' + MAX_IMAGES + ' 张）。草稿只记本机路径 + sha256，不碰后端；发布时重新校验再上传'),
    }, ['kind', 'content']),
    async handler(ctx, args) {
      const content = String(args.content || '').trim();
      if (!content) throw draftFailure('E_DRAFT_EMPTY', '草稿正文不能为空');
      let payload;
      let images = [];
      try {
        images = resolveImageList(args.images).map((img) => ({ path: img.path, name: img.name, mime: img.mime, bytes: img.bytes, sha256: img.sha256 }));
      } catch (err) {
        throw draftFailure(err.code || 'E_IMAGE', err.message, err.hint);
      }
      if (args.kind === 'comment') {
        if (!args.postId) throw draftFailure('E_DRAFT_ARGS', 'kind=comment 需要 postId');
        payload = { postId: Number(args.postId), content };
        if (args.parentId !== undefined) payload.parentId = Number(args.parentId);
        if (args.replyUserId !== undefined) payload.replyUserId = Number(args.replyUserId);
        if (args.whisper !== undefined) payload.whisper = Boolean(args.whisper);
      } else if (args.kind === 'post') {
        if (!args.title) throw draftFailure('E_DRAFT_ARGS', 'kind=post 需要 title');
        if (args.categoryId === undefined) throw draftFailure('E_DRAFT_ARGS', 'kind=post 需要 categoryId（用 list_categories 查）');
        payload = { title: String(args.title), content, categoryId: Number(args.categoryId) };
        if (args.summary) payload.summary = String(args.summary);
      } else {
        throw draftFailure('E_DRAFT_ARGS', 'kind 只能是 comment 或 post');
      }
      if (images.length) payload.images = images;
      let author = { userId: null, userName: null };
      try {
        const me = await ctx.client.whoami();
        if (me && me.user) author = { userId: me.user.userId === undefined ? null : me.user.userId, userName: me.user.userName || null };
      } catch {
        /* 未登录也能建草稿；发布时会再校验 */
      }
      const record = createDraft({ kind: args.kind, payload, author, baseUrl: ctx.client.baseUrl });
      const lines = [
        '已生成草稿 ' + record.id + '（状态 ' + record.status + '，只存在本机，未上线）',
        '  内容指纹: ' + record.hash.slice(0, 12) + '...',
        '  下一步必须由人完成：在其终端运行',
        '    narwhal-forum draft approve ' + record.id,
        '  终端会展示全文并要求输入 yes，然后打印一次性 approvalToken（10 分钟有效）。',
        '  拿到 token 后再调用 draft_publish（draftId + approvalToken）。没有 token 一律发不出去。',
      ];
      return { text: lines.join('\n'), data: { draftId: record.id, status: record.status, hash: record.hash } };
    },
  },
  {
    name: 'draft_list',
    title: '列出本地草稿',
    description: '列出本机保存的发布草稿及其状态（pending_review 待人工批准 / approved 已批准待发布 / published / rejected / expired）。只读一次磁盘，不访问后端。',
    inputSchema: obj({
      status: S.str('只看某个状态', { enum: ['pending_review', 'approved', 'published', 'rejected', 'expired'] }),
    }),
    async handler(ctx, args) {
      const records = listDrafts({ status: args.status });
      if (!records.length) return { text: '（没有草稿' + (args.status ? '，状态 ' + args.status : '') + '）', data: { total: 0 } };
      const lines = ['草稿（共 ' + records.length + ' 个）'];
      for (const r of records) lines.push('- ' + r.id + '  ' + r.status + '  ' + draftBrief(r));
      return { text: lines.join('\n'), data: { total: records.length, drafts: records.map((r) => ({ id: r.id, status: r.status, kind: r.kind })) } };
    },
  },
  {
    name: 'draft_get',
    title: '查看草稿全文',
    description: '按 id 读取草稿全文与状态（可与 list_posts/get_post 核对目标是否存在）。不访问后端。',
    inputSchema: obj({ draftId: S.str('草稿 id（drf-xxxxxxxx）') }, ['draftId']),
    async handler(ctx, args) {
      const record = readDraft(args.draftId);
      return { text: renderDraft(record), data: record };
    },
  },
  {
    name: 'draft_publish',
    title: '发布已批准的草稿',
    description: '发布一条已被**人**批准的草稿。必须带 approvalToken（由人在终端 `draft approve` 生成，一次性、绑定内容指纹与用户、10 分钟失效）。发布前会用后端实时核验实名状态；未实名直接失败且不消耗 token。AI 不能自己批准、也不能绕过 token 发布。',
    inputSchema: obj({
      draftId: S.str('草稿 id'),
      approvalToken: S.str('人工批准产生的一次性 token（nfap_ 开头）'),
    }, ['draftId', 'approvalToken']),
    async handler(ctx, args) {
      const record = readDraft(args.draftId);
      let userId;
      try {
        const me = await ctx.client.whoami();
        userId = me && me.user ? me.user.userId : undefined;
      } catch {
        userId = undefined;
      }
      const verdict = verifyApprovalToken(record, args.approvalToken, { userId });
      if (!verdict.ok) {
        throw draftFailure(verdict.code, verdict.message, '需要人在其终端运行 narwhal-forum draft approve ' + record.id + ' 取得新的 token；不要自行重试或改用 create_comment / create_post 绕过人审。');
      }
      let realname = { verified: null };
      try {
        realname = await ctx.client.realnameStatus();
      } catch {
        realname = { verified: null };
      }
      if (realname.verified === false) {
        throw draftFailure('E_REALNAME_REQUIRED', '未完成实名认证，不能发布（后端 requireVerifyToPost / requireVerifyToComment 会拦）', realname.hint || '先在站点里完成实名认证（/api/bbs/face/init），token 未被消耗，认证后可重试。');
      }
      const p = record.payload || {};
      // 图片：先校验（文件还在、sha256 与批准时一致），再逐张上传，最后把 markdown 内联进正文。
      let images = [];
      try {
        images = verifyDraftImages(p.images);
      } catch (err) {
        throw draftFailure(err.code || 'E_IMAGE', err.message, err.hint);
      }
      const uploaded = images.length ? await ctx.client.uploadImages(images) : [];
      const content = contentWithImages(p.content, uploaded.map((u) => u.url));
      if (record.kind === 'comment' && content.length > 2000) {
        throw draftFailure('E_DRAFT_TOO_LONG', '带图后评论正文超过 2000 字上限（当前 ' + content.length + ' 字），token 未消费', '删掉几张图或缩短正文后重新批准。');
      }
      let result;
      if (record.kind === 'comment') {
        result = await ctx.client.createComment({ postId: p.postId, content, parentId: p.parentId, replyUserId: p.replyUserId, whisper: p.whisper });
      } else {
        result = await ctx.client.createPost({ title: p.title, content, categoryId: p.categoryId, summary: p.summary, type: p.type, cover: p.cover });
      }
      const resultId = result && (result.id !== undefined ? result.id : result.commentId !== undefined ? result.commentId : result.postId);
      markPublished(record, { resultId: resultId === undefined ? null : resultId });
      const lines = [
        '已发布 ✔（草稿 ' + record.id + '，token 已消费，不可重放）',
        '  结果 id: ' + (resultId === undefined ? '（后端未返回 id）' : resultId),
        ...(uploaded.length ? ['  图片: ' + uploaded.length + ' 张已上传并内联', ...uploaded.map((u, i) => '    ' + (i + 1) + '. ' + u.url)] : []),
        '  实名: ' + (realname.verified === true ? '已实名' : '本地未判定，以服务端结果为准'),
      ];
      return { text: lines.join('\n'), data: { draftId: record.id, kind: record.kind, resultId: resultId === undefined ? null : resultId, result } };
    },
  },
  {
    name: 'draft_discard',
    title: '丢弃草稿',
    description: '删除一条本地草稿（未发布的）。不会影响已经发布出去的内容。',
    inputSchema: obj({ draftId: S.str('草稿 id') }, ['draftId']),
    async handler(ctx, args) {
      const record = readDraft(args.draftId);
      if (record.status === 'published') throw draftFailure('E_DRAFT_STATUS', '草稿已发布，发布的记录建议保留（审计用）；如确实要清掉，请在终端用 draft discard <id> --yes');
      removeDraft(args.draftId);
      return { text: '已删除本地草稿 ' + args.draftId, data: { draftId: args.draftId, removed: true } };
    },
  },];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** MCP tools/list 需要的形状（去掉 handler）。 */
export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: /^(status|whoami|list_|get_|my_|search_)/.test(t.name), destructiveHint: false, openWorldHint: true },
  }));
}
