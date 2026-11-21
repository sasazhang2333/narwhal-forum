/**
 * 授权前的风险提示。
 *
 * 设计要求（产品/信任安全评审结论）：
 *  - 风险必须在「授权的那一刻」就摆到人面前，而不是藏在文档里；
 *  - 同意是可记录的（版本号 + 时间），但不代替每次授权时的展示；
 *  - 非交互环境（CI / 被 Agent 调用）不得静默授权，必须显式 --yes。
 */

/** 文案版本：改文案就 +1，已同意的用户会重新看到一次。 */
export const RISK_VERSION = 2;

export const RISK_ITEMS = [
  {
    id: 'responsibility',
    title: '内容责任在账号',
    text: '通过本工具发出的帖子与评论，在论坛上算你这个账号发的，后果由账号所有者承担。',
  },
  {
    id: 'ai-publish',
    title: 'AI 不能自行发布',
    text: '写操作最终由发起调用的方（你或你的 Agent）触发：动手前请确认内容你本人看过。规划中的「草稿 + 人工批准」机制上线后，未获人工批准的内容将无法发布。',
  },
  {
    id: 'automation-risk',
    title: '自动化有风控风险',
    text: '论坛与 B 站会对高频、模板化、批量互动限流、删评甚至封号。请低频、人工触发；不要用它做批量刷评/刷赞。',
  },
  {
    id: 'least-privilege',
    title: '只用你自己的权限',
    text: '本工具只使用当前登录账号的权限，不提供管理端接口、不提供「以他人身份」操作、不接受伪造身份字段；越权请求会被后端拒绝。',
  },
  {
    id: 'realname',
    title: '未实名不能发布',
    text: '按平台合规要求，未完成实名认证的账号不能发帖/评论（后端 requireVerifyToPost / requireVerifyToComment）。本工具不会代做实名，也不会绕过校验。',
  },
  {
    id: 'credentials',
    title: '凭据留在本机，可随时撤销',
    text: 'token 与浏览器 profile 存在本机（0600 / 0700），不经过模型上下文、不写日志；任何时候运行 narwhal-forum logout 即可撤销（后端登出 + 删凭据 + 删 profile）。',
  },
  {
    id: 'images',
    title: '图片与外链',
    text: '图片评论依赖外链可达与内容审核：外链可能失效、图片可能被拦。不要引用来源不明或侵犯他人权利的图。',
  },
  {
    id: 'audit',
    title: '操作留痕',
    text: '本机会记录写操作的时间、目标与结果，便于事后追溯；不要用本工具做你无法承担责任的事。',
  },
];

/** 完整的风险提示文本（CLI 直接打印，MCP 原样返回给调用方）。 */
export function riskNoticeText({ baseUrl, mode } = {}) {
  const lines = [];
  lines.push('授权前请先阅读风险提示（v' + RISK_VERSION + '）' + (baseUrl ? ' — 目标：' + baseUrl : ''));
  lines.push('');
  RISK_ITEMS.forEach((item, i) => {
    lines.push('  ' + (i + 1) + '. ' + item.title + '：' + item.text);
  });
  lines.push('');
  if (mode === 'password') {
    lines.push('  注意：账号密码模式会把密码交给本进程（不落盘、不上传），但仍请你本人操作。');
    lines.push('');
  }
  lines.push('  同意即表示你已阅读并接受以上风险；不同意可随时 Ctrl+C 退出。');
  return lines.join('\n');
}

/** 一行摘要：已同意过的人再授权时看这个，不用重读全文。 */
export function riskSummaryText() {
  return '风险提示 v' + RISK_VERSION + '：内容责任在账号 / AI 不能自行发布 / 自动化有风控风险 / 只用本人权限 / 未实名不能发布 / 凭据本机可撤销（完整说明：narwhal-forum risk）';
}

/** 是否已同意当前版本（版本升级后需要重新同意）。 */
export function riskAcknowledged(credentials) {
  if (!credentials || typeof credentials !== 'object') return false;
  const v = Number(credentials.riskAcceptedVersion);
  return Number.isFinite(v) && v >= RISK_VERSION;
}

/** 记录同意（写进凭据文件，随 logout 一起清掉）。 */
export function riskConsentPatch(now = new Date()) {
  return {
    riskAcceptedVersion: RISK_VERSION,
    riskAcceptedAt: now.toISOString(),
  };
}

export default { RISK_VERSION, RISK_ITEMS, riskNoticeText, riskSummaryText, riskAcknowledged, riskConsentPatch };
