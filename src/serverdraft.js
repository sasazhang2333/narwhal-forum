/**
 * 草稿上云（1121）：把「人审」从工具那台机器的终端挪到站点网页。
 *
 * 本地草稿（src/draft.js）的问题不是不安全（它用本地 HMAC 签批准记录），而是：
 * 换台机器就查不到、审理记录只留在那台机器上、同一个团队没法互相复查。
 * 服务端草稿把这些交回站点：工具只拿一个 `DR-xxxxxxxx` 编号，人在网页上点批准，
 * 站点记下 reviewer / 时间 / 内容指纹；工具再去「领取」一次才能发布。
 *
 * 边界（同样重要）：这条链路能保证「没有人在网页上点过批准，工具拿不到可发布的内容」，
 * 但它拦不住「同一个账号自己批自己」—— 服务端只能留痕（reviewer_id / approved_at / payload_hash
 * 供事后核对），不能替人做判断。
 */

/**
 * 拆信封。注意**只看数字 status**：草稿详情自己也有 `status`（"pending"/"approved"…）
 * 和一个 `result` 字段（发布产物），按「有 result 就拆」会把详情拆成 null。
 */
export function unwrap(res) {
  if (!res || typeof res !== 'object') return res;
  if (typeof res.status === 'number' && res.result !== undefined) return res.result;
  return res;
}

/** 站点侧草稿的审理页地址；给了 webBaseUrl 才拼成完整 URL（本地开发 API 与页面不同源）。 */
export function reviewUrlFor(draft, webBaseUrl) {
  const uri = draft.reviewUri || '/cli/draft?code=' + encodeURIComponent(draft.draftCode || '');
  const base = String(webBaseUrl || '').replace(/\/+$/, '');
  return base ? base + uri : uri;
}

/** 提交一条服务端草稿。payload 里的 images 应已经是 URL（本地文件先 uploadImages 再进来）。 */
export async function submitServerDraft(client, opts = {}) {
  const kind = opts.kind;
  if (kind !== 'comment' && kind !== 'post') {
    throw new Error('kind 只能是 comment 或 post');
  }
  const payload = { ...(opts.payload || {}) };
  if (kind === 'comment' && !payload.postId) throw new Error('kind=comment 需要 postId');
  if (kind === 'post' && !payload.title) throw new Error('kind=post 需要 title');
  if (!payload.content || !String(payload.content).trim()) throw new Error('草稿正文不能为空');

  const created = unwrap(await client.createServerDraft({
    kind,
    payload,
    clientName: opts.clientName || undefined,
  }));
  return { ...created, reviewUrl: reviewUrlFor(created, opts.webBaseUrl) };
}

function imageUrls(payload) {
  const raw = Array.isArray(payload.images) ? payload.images : [];
  return raw.map((item) => (typeof item === 'string' ? item : item && item.url)).filter(Boolean);
}

function withImages(content, urls) {
  let out = String(content || '').trim();
  for (const url of urls) {
    if (out.includes(url)) continue;
    out += '\n\n![](' + url + ')';
  }
  return out;
}

/**
 * 领取并发布一条「已批准」的服务端草稿。
 *
 * 顺序是「先领取、再发布」：服务端在领取时把它标成 published，重复领取会被拒 ——
 * 这样同一个批准最多发一次。代价是「领取成功但发布失败」会留下一条发不出去的已领取草稿
 * （人能看到、能重新提一条），比「能发两次」安全。
 */
export async function publishServerDraft(client, code) {
  if (!code) throw new Error('缺少草稿编号（DR-xxxxxxxx）');
  const draft = unwrap(await client.consumeServerDraft(code));
  const payload = draft.payload || {};
  const content = withImages(payload.content, imageUrls(payload));

  let created;
  let kind = draft.kind;
  if (kind === 'comment') {
    created = unwrap(await client.createComment({
      postId: payload.postId,
      content,
      parentId: payload.parentId,
      replyUserId: payload.replyUserId,
      whisper: payload.whisper,
    }));
  } else {
    created = unwrap(await client.createPost({
      title: payload.title,
      content,
      categoryId: payload.categoryId,
      summary: payload.summary,
    }));
  }

  let resultId = created && (created.id !== undefined ? created.id : (created.commentId !== undefined ? created.commentId : created.postId));

  // 评论接口不回 body（后端 Responses.ok(null)），拿不到 id 就回查一次「我的最新评论」。
  // 只为把产物 id 记进草稿留档；查不到也照常回报（null），不影响「已经发出去」。
  // 评论接口回的是 `{status:0, result:null}`，所以这里既可能是 undefined 也可能是 null
  if ((resultId === undefined || resultId === null) && kind === 'comment') {
    try {
      const mine = unwrap(await client.listMyComments({ page: 1, pageSize: 3 }));
      // listMyComments 走的是 normalizePage，拿到的是 {items, page, total…}（不是 content）
      const rows = (mine && (mine.items || mine.content || (mine.result && mine.result.content))) || [];
      const hit = rows.find((row) => row && String(row.postId) === String(payload.postId));
      if (hit && hit.id !== undefined) resultId = hit.id;
    } catch {
      /* 回查失败就当没有 id */
    }
  }

  try {
    await client.reportDraftResult({
      code: draft.draftCode || code,
      resultId: resultId === undefined ? null : resultId,
      result: kind === 'comment' ? '评论已发布' : '帖子已提交',
    });
  } catch {
    /* 回报失败不影响「已经发出去」这个事实，只是少一行留档 */
  }
  return {
    draftCode: draft.draftCode || code,
    kind,
    resultId: resultId === undefined ? null : resultId,
    status: created && created.status,
  };
}
