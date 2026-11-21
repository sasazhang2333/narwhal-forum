# DESIGN — narwhal-forum 技术方案

## 1. 目标与边界

- 让 dsh（以及 Claude Code、Codex、任何 MCP host）能读论坛、发评论、发帖、搜索、互动。
- 插件是**独立仓库**，与 `narwhal-cms/` 同级存放；只通过论坛已有 HTTP API 访问数据，
  **不改、不侵入** narwhal-cms 的代码、构建或数据库。
- 凭据只经环境变量 / 本地凭据文件传递，不进仓库、不进日志。

## 2. 形态选型：一个包 = MCP server + CLI + dsh 配置型 bundle

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| dsh 原生 Cordis 插件（写 Service/Tool） | 否 | 只能 dsh 用，Claude Code / Codex 无法复用；且需跟着 dsh 内部 API 走 |
| 只做 CLI | 否 | Agent 调 CLI 靠 prompt 约定，脆弱、无 schema、无结构 |
| 只做 MCP server | 部分 | Agent 能用，但人/脚本/CI 不好直接跑 |
| **MCP server + CLI + dsh 接线（选中）** | ✅ | 一份能力实现三种入口；MCP 的 tools/* schema 是 Agent 的通用接口，CLI 是人的接口；dsh 侧只需要一个配置型 bundle |

关键点：**能力只实现一次**。CLI 的每个子命令都映射到同一个 MCP 工具处理器
（`src/cli.js` 的 `COMMANDS` 表 → `src/mcp/tools.js`），所以两条路径的输出、参数校验、
错误文案完全同源，不会出现「CLI 能发、Agent 发不了」这种漂移。

dsh 侧采用**配置型 bundle**（`cordis.patch.yml` + `locale/` + `icon.svg`，不含运行时代码）：
它不重写论坛逻辑，只把 `@deepseek-ai/dsh-mcp-client` 指向本包的 `mcp` 子命令。
这样 dsh 的升级不会打破插件，插件也不复刻 dsh 的 Tool 注册 API。

## 3. 为什么零运行时依赖

- `dependencies: {}`：npx 首次启动不用下载依赖树，冷启动快、离线可用；
- 也规避了本机 `npm` 缓存不可写导致装不上依赖的现实问题；
- 实现只需要：HTTP (`fetch`)、加密 (`node:crypto`)、REPL IO (`node:readline`)、主进程（`node:child_process` 仅测试用）——全是 Node 内置。

## 4. 为什么手写 MCP stdio server 而不是引 SDK

MCP over stdio 是「一行一个 JSON-RPC 2.0 消息」，核心方法只有 `initialize`、`tools/list`、
`tools/call`（外加 ping / 资源 / 提示的空实现）。手写约 250 行，换来：

- 零依赖、可控的错误策略（工具失败返回 `isError`，协议层不出错）；
- 协议版本协商按客户端来：支持 `2025-06-18` / `2025-03-26` / `2024-11-05`，客户端报支持的版本就回显它，否则回最新；
- **协议流纯净**：启动即把 `console.log/info/debug` 重定向到 stderr，测试里断言「stdout 每一行都是合法 JSON」。

## 5. 论坛 API 契约

- 统一响应包裹：成功 `{ "status": 0, "result": ... }`，失败 `{ "status": -1, "message": "..." }`。
  判断不能只看有没有 `result`（帖子实体自带 `status` 字段表示审核状态），所以
  `isEnvelope()` 用「`status` 是数字 + 字段数 ≤ 4 + 含 `result` 或 `message`」联合判定，
  再 `unwrapEnvelope()` 拆包 —— 避免把帖子对象当成响应包裹误伤。
- 列表查询用后端已有的 `Q_` DSL：`EQ_categoryId_Long`、`EQ_userId_Long`、`LIKE_title_String` 等，
  `page` / `pageSize` 必填，`pageSize` 上限 100（`normalizePage()` 兜底）。
- 排序不是查询参数而是**端点**：`hot` / `trending` / `most-collected` 等走各自的
  `/api/bbs/...` 路径，`POST_ORDERS` 表负责映射。

## 6. 登录：浏览器授权（默认）+ 账号密码（备用）

论坛前端（Nuxt SPA）登录成功后把 JWT 写进 `localStorage` 的 `auth_token` / `auth_refresh_token`。
插件不重造登录协议，而是**借一个真实浏览器**完成同一步人工授权：

```text
spawn Chrome --user-data-dir=<HOME>/browser --remote-debugging-port=0 <baseUrl>/login
  → 读 <profile>/DevToolsActivePort 拿到调试端口
  → GET /json/list 选中登录页 target
  → WebSocket 连上，循环 Runtime.evaluate(读 localStorage 的两个 token 键)
  → 拿到 token → 写 credentials.json(0600) → 关窗口、杀进程
```

**为什么这样选**（三个候选的取舍）：

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| 改后端加 OAuth / device-code 端点 | ✗ | 明确要求不侵入 narwhal-cms；为一个客户端改后端不值得 |
| 读用户日常浏览器的 cookie 库 | ✗ | Chrome 127+ App-Bound 加密后读不出；且直接碰用户主 profile 风险大 |
| **独立 profile + CDP 读 localStorage** | ✓ | 无需改后端；隔离自己的 profile；令牌只经本机 CDP，不经过模型；撤销=删目录 |

**安全性质**：

- 密码永不出现在 CLI 参数、环境变量、凭据文件或对话里（人是在浏览器里输入）。
- 只读两个 localStorage 键，不读 cookie 库、不注入脚本到非本站页面。
- 浏览器 profile 在 `<HOME>/browser`（`0700`），与用户日常浏览器完全隔离，可整体删除。
- 撤销是**三件事**：调后端 `POST /api/cms/auth/jwt/logout`（尽力而为，失败也继续）→ 删本地凭据 → 删浏览器 profile（cookie 一起消失）。
- `--keep-browser` 只清 token 保留 profile，适合「换一个论坛账号但不重新输密码」。

**兼容与降级**：

- 无 Chromium 系浏览器 / Node < 22 / 无图形界面 → `login --password`（沿用第 6.1 节）。
- 已有 token（从任何地方拿到）→ `token set --access ...` / `NARWHAL_FORUM_TOKEN`。
- MCP 侧：`login` 工具 `mode=browser`（默认）会真的打开浏览器；Agent 只在用户要求或写操作报鉴权错时调用。
- 安装时不弹窗：npm `postinstall` 不该开浏览器，所以入口是 `narwhal-forum setup` / `login`。

### 6.1 账号密码登录（`--password`）

```text
GET  /api/cms/auth/narwhal/code   → 裸 base64 DER 公钥（normalizePublicKey 转 PEM/SPKI）
POST /api/cms/auth/narwhal/login
     body:      base64( AES-256-ECB( JSON{username,password,captchaToken?} , aesKey ) )
     encryptKey: base64( RSA-PKCS1v1.5( base64(aesKey) ) )
     → access_token / refresh_token
```

- AES key 由 `crypto.randomUUID()` 去横线得到（32 个 ASCII 字符 → 256 位），每次登录现生成。
- token 保存：`onTokens` 回调 + `persist` 时原子写 `credentials.json`（`0600`）。
- 401 处理：有 refresh token 就**单飞刷新**（`_refreshing` 共享同一个 Promise）并重放一次原请求，
  `_retried` 标记防死循环；刷新失败按未登录上报。
- 后端路径双形态：`/api/cms/auth/**` 由 `CmsProxyController` 转发到 `/api/auth/**`，
  两种写法都通（本项目统一用前台形态 `/api/cms/...`）。

### 6.2 授权前的风险提示（人审在环路的第一步）

授权是整条信任链的入口，风险必须在这里摊开，而不是等出事再解释。实现（`src/risk.js`）：

- 8 条风险：内容责任在账号 / AI 不能自行发布 / 自动化有风控风险 / 只用本人权限 / 未实名不能发布 / 凭据本机可撤销 / 图片与外链 / 操作留痕；
- 版本化文案 `RISK_VERSION`，同意写进凭据文件（`riskAcceptedVersion`、`riskAcceptedAt`），文案升级后重新征求同意；
- **非交互不得静默授权**：stdin/stdout 不是 TTY 且未同意过时直接拒绝（退出码 2），必须显式 `--yes`；
- MCP 侧 `login` 首次调用只返回风险全文 + `E_RISK_ACK_REQUIRED`，不打开浏览器；模型必须把全文给人看，人确认后再带 `acknowledgeRisks: true`；
- `logout` 清凭据时同意记录一并消失（下次重新征求）。

### 6.3 人审发布：草稿 + 一次性 approvalToken（P0）

约束 A（AI 内容必须人审）在实现上不能靠「约定」，只能靠**令牌**：批准是一个只有人能执行的动作，执行结果是一个密码学凭据；发布只认凭据。

状态机（`src/draft.js`）：

```
created → pending_review → approved │ rejected
                    │            │
                    │            └→ published（token 消费）
                    └→ expired（10min 未批准/未发布）
```

- **内容指纹**：`draftHash = sha256(canonical({kind, payload}))`，key 排序后序列化，所以「同内容不同 key 顺序」hash 相同、「改一个字」hash 必变。批准时写入 `record.approval.draftHash`，发布时重算比对 → 防「批准 A、发布 B」。
- **token 结构**：`nfap_<draftId>.<nonce>.<expMs>.<draftHash>.<action>.<userId>.<sig>`，`sig = HMAC-SHA256(approval.key, parts.join('|'))`（base64url 截 43 字符）。
- **落盘只存 hash**：`record.approval.tokenHash = sha256(token)`（不是 token 本体），所以就算草稿目录被读，也拿不到可用凭据；`approval.key` 单独 0600 存放。
- **校验顺序**（短路，先便宜后昂贵）：REQUIRED → USED → STATUS → INVALID(格式) → EXPIRED → INVALID(签名，timingSafeEqual) → HASH_MISMATCH → ACTION → USER → INVALID(hash 对不上)。
- **一次性**：发布成功后 `markPublished` 写 `usedAt`；任何重放命中 `E_APPROVAL_USED`。失败（网络/权限/实名）**不消费** token，可重试 —— 这是刻意的：卡住人不如卡住重放。
- **TTL 与降级**：`APPROVAL_TTL_MS = 10min`；`readDraft` 见到「approved 但已过期且未使用」就改写为 `expired`，列表里不会出现「看起来还能发」的死草稿。
- **批准只能在 TTY**：`draft approve` 要求 stdin+stdout 都是 TTY，展示全文后要求输入 `yes`；非 TTY 一律退出码 2，状态不变。MCP 工具表里**刻意不存在** approve/accept/confirm 类工具（有测试守住这条）。
- **实名强校验**：发布前 `realnameStatus()` 现查（不走缓存），`verified === false` → 退出码 3 + `E_REALNAME_REQUIRED`，且不消费 token；`verified === null`（接口没给字段）时不拦，以服务端门控为准，不臆测。

为什么不用「--force / --yes 二次确认」：确认只发生在发起方进程里，Agent 完全可以自己补一个 `--yes`。人审必须在**另一个主体**上发生，所以凭据是跨进程传的 token，而不是同进程的 flag。

## 7. 错误模型

`ForumError { code, status, detail, hint }` / `ForumAuthError`（extends）。

- 网络层：`ECONNREFUSED` 等翻译成「连不上论坛后端 + 地址 + 是否启动」的提示。
- HTTP 层：非 2xx 且非 JSON-RPC envelope → 带状态码的错误。
- 业务层：后端 message 中文化 + 归类（`cooldown` → 15 秒冷却、`realname`、`mobile`、`slowmode`、`locked`、`sensitive`）。
- MCP 层：工具失败不进 JSON-RPC 错误，而是 `result.isError = true` + 可读文本，让 Agent 能自我纠正（例如换参数重试）而不是崩掉会话。

## 8. 测试策略

- `test/mock-forum.js`：用 `node:http` 实现契约级 mock（RSA 2048 密钥对、AES 解密登录体、
  envelope、401、Q_ 过滤、评论树、15 秒冷却开关、表情白名单、发帖）。
- 78 个用例分八层：客户端（16）、MCP 协议 + 端到端子进程（11）、CLI（9）、浏览器授权纯函数与撤销（13）、MCP login/logout 契约（4）、授权前风险提示（5）、浏览器授权端到端（1）、人审发布状态机（19）。
- 人审发布层（`test/draft.test.js`）不只测 happy path：重放、TTL、改内容、篡改签名、换用户、换动作、非 TTY 批准、实名拦截、MCP 无 token 全都有用例；其中「TOOLS 里没有 approve 类工具」是**反向断言**，防止以后有人好心加回来。
- 批准的成功路径用 `approveDraftInteractive(id, io)` 的**注入式假 TTY** 覆盖（io 只为可测试性存在，不传 io 时一律读真实 `process` 的 TTY；没有环境变量或 CLI 参数能绕过）：假 TTY + 输入 `yes` → 拿到 token 且 token 真能通过校验；输入 `no` → 取消且不落任何 token 记录。
- 浏览器授权不打真浏览器：`waitForTokens(evaluate)` 把「怎么取 token」抽成可注入函数，用假 evaluate 覆盖成功 / 超时 / 浏览器被关；`revokeAuth(backend:false)` 在临时 `NARWHAL_FORUM_HOME` 里验证凭据与 profile 都被删掉。
- 覆盖的关键回归：匿名列表不泄露未审核帖、未登录评论报鉴权错、密码不落盘、
  401 自动刷新重放、stdout 协议纯净、工具失败 isError。

## 9. 与 dsh 的接线

```yaml
- insert:
    - id: narwhal-forum-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: narwhal-forum
        transport: stdio
        command: npx          # 或 narwhal-forum / node
        args: [-y, narwhal-forum, mcp]
```

- `serverName` 决定工具前缀：`mcp__narwhal-forum__list_posts`；
- 安装走 `plugin_manager action=install_bundle target=<包目录>`，不手改 profile 的
  `package.json` / `cordis.patch.yml`，也不在 profile 里跑包管理器；
- `failOnStartupError: false`：MCP server 起不来时 dsh 仍能启动，只是没有这些工具
  （**桌面端建议在 profile 层覆写成 `true`**，否则「静默地没有工具」极难排查，见 12.1）；
- 环境变量被 dsh 清洗过，所以**认证信息不放环境变量**，放 `~/.config/narwhal-forum/credentials.json`，
  该路径不依赖进程环境。这也是为什么 bundle 里不需要 `env` 直通。

## 10. 后续可做（当前未实现）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 图片上传 / 图片评论 | **已实现** | 复用后端已有的 `POST /api/upload/image-upload`，正文内联 markdown；外链失效或被拦不会静默成功 |
| 非图片附件 | 未实现 | 后端上传接口按 `image` 分发，附件还涉存储配置与下载鉴权 |
| 帖子审核（待审列表 / 批准 / 驳回） | **部分实现** | `approve_post` 已上（`PUT /api/bbs/post/{id}/approve`）；待审队列列表与驳回（`/reject`）未接，需先确认后端审核态机 |
| 通知 / 私信 | 未实现 | 后端接口存在，但需确认权限与隐私边界 |
| 收藏 / 关注列表 | 未实现 | 与点赞同一层，接口确定后再加，避免猜 |
| 删帖 / 删评论 | **已实现** | `delete_comment` / `delete_post`，强制 `confirm=true`；不动数据的前提是先拿到用户明确同意 |
| 发帖编辑器字段（封面、摘要） | 部分 | 已透传 `summary/type/cover`，未做上传校验 |
| 人审记录审计（谁批的、何时批） | 未实现 | 当前只存 `reviewer` 字段；要可追溯需落地审计日志 |

## 11. 待确认

1. ~~GitHub 私有仓库的最终名字与账号~~ —— 已定：`sasazhang2333/narwhal-forum`（private，main 分支，37 个文件）。
2. 是否发布到 npm（公开 or 私有 registry）；不发布时 dsh 用本地 patch 变体（当前即此形态：profile 里是 `link:` 本地依赖）。
3. 论坛是否在登录时启用验证码 / 双因素 —— 启用时 CLI 登录会返回结构化错误码，需改用 token 导入。

## 12. 图片评论：为什么零后端改动（A 方案）

### 12.1 事实（读源码得到，不是猜）

| 事实 | 位置 |
| --- | --- |
| 前端粘贴上传已有 composable | `src/main/frontend/composables/usePasteImage.ts` → `usePasteImage(onUploaded, { scene })` |
| 上传接口 | `POST /api/upload/image-upload`（multipart，字段名 `file`，可选 `?scene=chat`） |
| 后端权限 | `UploadController#imageUpload` 带 `@PreAuthorize("isAuthenticated()")`：**登录即可上传** |
| 后端处理链 | `doUpload(..., "image", ...)` → 压缩 / 水印 / `ImageModerationProvider` 内容审核 |
| 前端渲染 | `BbsMarkdown.vue` = marked + `sanitizeHtml`（DOMPurify）；`FORBID_TAGS` 只有 script/style/form/input/textarea/select，**img 放行** |
| 评论正文存储 | `GeneratedBbsComment` 的 content 是普通 String，只有 empty / tooLong 校验，不做 markdown 剥离 |

### 12.2 三个方案

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A. 正文内联**（选用） | 先 `POST /api/upload/image-upload` 拿 URL，再把 `![](url)` 追加进正文 | 零后端改动、零迁移、零前端改动；图片同样走审核 |
| B. 后端加 `images_` 列 | 迁移 + 实体 + DTO + 前端渲染 | 同一份信息存两处；为了「图片」改一整个论坛模块，成本收益不成立 |
| C. 不做 | 只发文字 | 反馈类场景图不可替代（截图复现） |

选 A 的核心理由：**上传与渲染两条链路后端已经完整存在**，缺的只是「把它们接起来」的那一步，而那一步在客户端做最便宜。

### 12.3 实现要点

- `src/images.js` 只做三件事：校验本地文件（扩展名 / 大小 / 空文件 / 上限 9 张）、拼 multipart（`buildMultipart`）、
  生成 markdown（`contentWithImages` 追加到正文末尾，带 `\n\n` 分隔）。上传结果兼容 `url` / `webpUrl` / `result.url`。
- `client.uploadImage` 先 `ensureAuth('上传图片')` 再上传，URL 补成绝对地址（正文里可能是别的域名访问）。
- 草稿带图只存 `{path, name, mime, bytes, sha256}`，**不联网**；`draft_publish` 先 `verifyDraftImages`（存在 + 指纹一致）
  再上传。指纹不一致 → `E_IMAGE_CHANGED`，**在上传前**失败且 token 不消费 —— 保证「人批准的是这张图」。
- 失败分层：本地前置条件（缺文件 / 指纹变 / 带图后超 2000 字）→ exit 2；网络或论坛拒绝 → exit 1。两者都不消费 token。

### 12.4 已知代价

- 图片 URL 落进正文，论坛侧**没有引用计数**：文件被清理后评论会裂图（与网页端手动贴图一致）；
- 摘要 / 搜索只索引文字，不索引图片；
- 审核只在上传时做一次，事后改图不可能（URL 不可变，这反而是好事）。

## 13. dsh 桌面端的 PATH 陷阱

桌面版（Electron app）进程环境里 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，不继承 shell 的 nvm 路径。
后果：bundle 里 `command: narwhal-forum` 在桌面端**必然起不来**，而 `failOnStartupError: false` 会把它变成
「静默地没有 `mcp__narwhal-forum__*`」——症状与「插件没装」完全一样。

因此桌面端必须在 **profile 层**按 id 覆写这一行（`plugin_manager` 装的是 bundle 层，改 profile 不改仓库）：

```yaml
- id: narwhal-forum-mcp          # 与包内 id 一致才是覆写；否则会新增一行
  name: '@deepseek-ai/dsh-mcp-client'
  config:                        # config 整体替换、不深合并，字段必须重述
    serverName: narwhal-forum
    transport: stdio
    command: /Users/<you>/.dsh/bin/narwhal-forum-mcp   # 启动器，自己找 node
    args: []
    toolCallTimeoutMs: 60000
    failOnStartupError: true
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
```

启动器（`examples/narwhal-forum-mcp`）在 nvm 各版本的 node 里挑一个可执行的，再 `exec` 包内 bin，
所以 nvm 换版本不用改 patch。改完需重启 dsh 应用。

## 14. 验证策略：为什么"用启动器再跑一遍"比单测更有说服力

单测证明的是**逻辑**，但桌面端失败的那一类问题（PATH 里没有 node、启动器找不到包、stdio 握手帧格式）
恰好都在进程边界上，单测一个都覆盖不到。所以 `scripts/e2e-mcp.mjs` 刻意复刻桌面端的**进程上下文**：

- `env` 只留 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` + `HOME` + 两个论坛变量 —— 没有 nvm、没有全局 bin；
- spawn 的是 `~/.dsh/bin/narwhal-forum-mcp`（线上同一条命令），不是 `node bin/...`；
- 走完整 JSON-RPC：`initialize` → `tools/list` → `list_posts` → `upload_image` → `create_comment`(带 `images`)，
  最后回读 mock 的落库结果，确认正文是 `![](http://…)` 而不是"工具说成功了"。

这条链一旦通过，剩下的变量只有"dsh 是否把这一行 patch 读进来"和"真论坛是否可达"，
两者都可以独立检查（`cordis_inspect_query` / `curl`）。因此 CI 里也把它当冒烟测试用，不需要真论坛。

~~**未完成的一环**：真实 narwhal-cms 后端。~~ → **2026-11-21 已完成**：本地起了 narwhal-cms（MySQL 8 +
Redis 7 + dev profile）并用管理员账号跑通了真实读写，见第 15 节。

## 15. 真实后端实测（2026-11-21）：5 个坑、修法与留下的决策

环境：narwhal-cms 后端 8080（Spring Boot + MySQL 8.0.45 + Redis 7）+ Nuxt 前端 3000，dev profile；
管理员账号，插件 0.6.0。`scripts/e2e-live.mjs --write` 11/11 通过，另手工验过图片评论、嵌套回复、搜索、
CMS 栏目、草稿人审闸。

| # | 现象 | 根因（读后端源码/实测确认） | 修法 | 为什么这么修 |
| --- | --- | --- | --- | --- |
| 1 | `get_post` 稳定 404，id 差几个数 | 雪花 id 超 2^53，JSON-RPC 侧按数字解析丢精度 | 工具 schema 里 id 一律 `string`；传数字且不安全时**直接报错**而不是静默转换 | 静默转换会造出"看着对、其实错"的 id，比报错难查得多 |
| 2 | `list_channels` 永远 404 | `/api/bbs/channel` 是「创作者频道自助申请」（self-serve/apply/my-channel/legal-verify），没有列表 GET；真栏目是 CMS `/api/channel`（扁平数组、不分页） | 改打 `/api/channel`；工具改名「站点栏目」，描述里点名「论坛版块用 `list_categories`」 | 保留工具名但改语义，比删掉更省调用方迁移成本；同时在描述里纠正常见误解 |
| 3 | 搜索结果时间显示 `1795248388000` | Lucene 返回 `created` 为毫秒时间戳**字符串**；`new Date('179…')` 在 V8 = Invalid Date | `fmtTime` 认 10/13 位数字字符串（秒/毫秒） | 只在渲染层兜底，不改客户端数据结构（两种后端返回并存） |
| 4 | 回复成功但评论树里没有 | 一级端点只回直接子级；嵌套在 `/comment/{id}/replies`（Pageable，pageSize 封顶 20） | 逐层拉 replies 拼 `children`；默认 3 层 / 60 次请求封顶，超预算标 `truncated` | 递归拉全量在热门帖上会打出 N+1 请求风暴；给预算 + 显式截断标记，让调用方自己决定要不要更深 |
| 5 | 发帖成功但列表里没有 | 新账号/未达信任阈值 → `status_=-1`，`moderationConfig.shouldAutoApprove` 决定，**管理员自己也待审** | `create_post` 按真实 `status` 说话；新增 `approve_post`（后端 `PUT /api/bbs/post/{id}/approve`，权限 `canModeratePost`） | 「说已发布」是把不确定性甩给用户；把状态如实说出来 + 给放行工具，才是完整闭环 |

另外三处补全（都由实测暴露）：
- `create_comment` 后端**不回 body**（`data=null`）→ 用 `listMyComments({page:1,pageSize:1})` 兜底拿新 id；
- tools/call 增加 `structuredContent`（`data` 非空时），让 Codex/Claude Code 不必解析中文散文；
- 删除是破坏性操作 → `delete_comment` / `delete_post` 强制 `confirm=true`（CLI `--yes`），否则只回提示不动数据。

**与「人审」原则的边界**（容易混淆，特意写清）：MCP 侧**没有**草稿批准工具（`draft approve` 只能在人的终端跑，
`draft_publish` 强制要求一次性 `approvalToken`）；`approve_post` 是**帖子审核**，权限由后端判，与"AI 不许自己放行
自己写的内容"无关 —— 这两件事在 `test/draft.test.js` 里各有一条断言守着。

**本地环境备注（不是产品代码，留给下次复现）**：后端 `spring-boot:run` 需要
`DB_USERNAME=root DB_PASSWORD= FLOWABLE_DATABASE_SCHEMA_UPDATE=true` + dev profile；Redis 需要
`--requirepass ruoyi123`；curl 必须带 `-A 'Mozilla/5.0'`（后端有 UA 过滤）并加 `--noproxy '*'`（本机有 http_proxy）。
管理员口令与 `application.yaml` 里 `UJCMS_PASSWORD_PEPPER` 绑定的 PBKDF2WithHmacSM3 有关，重置口令要用应用自己的
编码器生成 `{pbkdf2}…` 再写库，直接抄文档里的 `123456` 是登录不上的。

## 16. 授权与门禁：插件不判权限，只透传「为什么被拦」

一句话原则：**授权是后端的，插件是传声筒**。因此插件里没有任何 `if (role === 'admin')`；它做三件事：

1. 写操作前 `ensureAuth()`：没登录就本地直接拒绝（`🔒 「发表评论」需要登录`，退出码 1），不打无意义的请求；
2. 后端拒绝时把原文照抄（中文文案、HTTP 状态、`METHOD path` 都保留），不让调用方去猜；
3. **把 `result.blockers` 原样带上**（`code/title/desc/actionLabel/actionTo`）。

第 3 条是本轮补的：真后端在「未绑手机 / 未实名」时返回的是 **HTTP 200 + `status=-1`**（不是 4xx），
`result.blockers[]` 里才有「去哪解决」的路径。早期实现把它丢了，模型只能说「失败了，去网页端看看」，
现在是 `· 完成实名认证（去认证）：/forum/settings?tab=profile` —— 这句话才能被直接执行。
CLI、MCP（正文 + `structuredContent.error.blockers`）、`--json` 三个出口都带同一份结构。

顺带确认的两个后端事实（都已写进 README §8.0 的矩阵）：
- **管理员发帖也进待审**（`status=-1`），不是特权豁免；要公开仍得 `approve_post`；
- 普通用户写内容要过「绑手机 → 实名」两道门，而这两道门对管理员豁免（`src/main/java/com/tusksynx/bbs/web/api/BbsPostApiController.java` 的 `isRealNameVerified` 只在非 admin 路径检查）。

## 17. 授权：为什么是「范围闸 + 设备码」两层

### 17.1 问题：网页登录把「你是谁」和「它被允许做什么」压成了一步

第一版的 `login` 是「真浏览器 + 读 localStorage」：人登录 → token 被读走 → 全能力。它解决了
「密码不进模型」，但留下一个洞：**人从头到尾没有对「这个工具能做什么」表态过**。授权页上的那句
「允许」，本来应该在这里。

### 17.2 第一层：客户端范围闸（`src/consent.js`）

7 个范围（`read` / `read:own` / `write:comment` / `write:post` / `moderate` / `delete` / `draft`），
每个工具映射到一个；凭据文件里记 `grantedScopes`。越界在**本地**拒，请求根本不发。

设计取舍：

| 选择 | 理由 |
| --- | --- |
| 闸放在工具分发处（`cli.js` 的 `runTool`、`mcp/server.js` 的 `tools/call`） | 两处是唯一出口；放在各 handler 里迟早漏一个 |
| 旧凭据按全量兼容 | 升级不该让用户重新登录；`status` 里标注「旧凭据」提醒扩权 |
| 不做 per-call 临时提权 | 那等于每次弹窗，用户会条件反射点「同意」，闸就失去意义 |

**它挡不住什么**：凭据文件是明文的 JWT，谁拿到文件都能直接打后端。所以这一层是「防手滑」不是
「防越权」——真正的边界在后端鉴权与 token 收窄（见 17.4 的未完成项）。这一点写在代码与 README 里，
不装作它是安全边界。

### 17.3 第二层：设备码（后端 `/api/cli/device/*`）

```
工具  POST /api/cli/device/code    → { deviceCode, userCode, verificationUri, expiresIn }
人    GET  /cli/authorize?code=…   → 看到调用方与申请范围 → 允许 / 拒绝
工具  GET  /api/cli/device/poll    → approved 的一次性领走 access/refresh token
```

| 决策 | 理由 |
| --- | --- |
| 设备码存内存（`CliDeviceCodeService`），不建表 | 只活 10 分钟，没有持久化需求；建表要写 Liquibase 迁移并与生产对齐，不划算。**代价**：多实例部署会查不到 → 换 Redis 实现只需改 4 个方法 |
| `deviceCode` 32 字节随机，`userCode` 8 位去易混字符（`XXXX-XXXX`） | 前者是持有证明（不给人看），后者要能念/抄；去掉 0/O/1/I/L 才不会被抄错 |
| 令牌只发一次（`consume`） | deviceCode 事后泄露也换不到第二份 |
| 用户码索引归一化（去横杠、大写） | 人抄码时不会照抄横杠 —— 实测第一次就栽在这里：`/info` 查 `R6DX-T5N6` 返回 null，因为索引存的是带横杠的原形 |
| `scopes` 只是**给人看**的意图声明 | 真权限仍由各接口判；不因为声明了 moderate 就获得审核权 |
| 不用标准 OAuth2 authorize 端点 | 那要求站点做 client 注册、consent 管理、redirect 白名单；设备码三个接口就够，且天然适配 CLI/Agent |

**边界**：这一层强制的是「一次人工确认 + 一张有时效的令牌」，不强制「服务端 token 只能读」。
要做后者，得给 token 加 scope claim 并在 `SecurityConfig` 里按路径校验 —— 那是另一个改动，
暂列在 §11 待确认（此前的硬约束是「不修改 narwhal-cms」，用户已明确放开，但服务端 scope 校验
需要先定「哪些接口属于哪个 scope」，属于接口清单级的工作）。

### 17.4 被否掉的两种做法

1. **每次写操作都重新弹一次授权**：用户会条件反射点同意，闸退化成装饰。
2. **只做浏览器 profile 隔离，不做范围闸**：人仍然没对能力表过态；一旦 token 落到 Agent 上下文，
   它可以把「只读」用在任何地方。
