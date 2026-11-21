# narwhal-forum

Narwhal CMS 论坛（BBS）能力包：**一个零运行时依赖的 Node 包，同时是 MCP server、CLI 和 dsh 插件**。
让 dsh、Claude Code、Codex 以及任何支持 MCP 的工具，都能读帖子、看评论、发评论、发帖、搜索、互动。

- MCP stdio server：`narwhal-forum mcp` —— dsh / Claude Code / Codex 共用的唯一能力面
- CLI：`narwhal-forum posts` / `narwhal-forum new-comment 42 --content 你好` —— 给人或脚本用
- dsh 插件：包内 `cordis.patch.yml` 把上面这个 MCP server 接进 `@deepseek-ai/dsh-mcp-client`

> 默认后端 `http://127.0.0.1:8080`；认证用 token（登录后自动保存到本地凭据文件）。
> 本包只调用论坛已有的 HTTP API，不修改、不依赖 narwhal-cms 的任何内部代码。

---

## 1. 安装

```bash
# 用户级安装（不需要 sudo；~/.local/bin 通常已在 PATH 里）
npm i -g --prefix ~/.local /path/to/narwhal-forum

# 从 npm（发布后）
npm i -g --prefix ~/.local narwhal-forum

# 或者完全不装，直接跑本地包目录
npx --package "$PWD" narwhal-forum --help
```

⚠️ **本机已知问题**：默认 npm 缓存目录归属异常会让 `npm` 命令失败
（`npm error sudo chown -R 501:20 ~/.npm`）。先换一个可写缓存再装：

```bash
export npm_config_cache="$TMPDIR/npmcache"
npm i -g --prefix ~/.local .
```

`npx` 也能直接解析本地包目录 / tarball：

```bash
npx -y narwhal-forum --help                                  # 已发布到 npm
npx --package /path/to/narwhal-forum narwhal-forum --help    # 本地目录
npx --package ./narwhal-forum-0.1.0.tgz narwhal-forum --help # 本地 tarball
```

---

## 2. 30 秒上手

```bash
narwhal-forum status                       # 后端地址、登录状态
narwhal-forum post 42 --comments           # 帖子详情 + 评论树
narwhal-forum search 关键词
narwhal-forum setup                        # 首次：检查后端 + 打开浏览器登录授权（会记住，可撤销）
narwhal-forum auth status                  # 看当前是否已授权、授权方式、profile 位置
narwhal-forum new-comment 42 --content '写点什么'
narwhal-forum whoami
```

---

## 3. 配置

优先级：**命令行参数 > 环境变量 > 凭据文件 > 默认值**。

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `NARWHAL_FORUM_BASE_URL` | 后端地址，如 `http://127.0.0.1:8080` | `http://127.0.0.1:8080` |
| `NARWHAL_FORUM_TOKEN` | access token（读写之外的操作需要它） | — |
| `NARWHAL_FORUM_REFRESH_TOKEN` | refresh token（401 时自动续期） | — |
| `NARWHAL_FORUM_USERNAME` | 登录用户名 | — |
| `NARWHAL_FORUM_PASSWORD` | 登录密码（仅登录时使用，**从不落盘**） | — |
| `NARWHAL_FORUM_BROWSER` | 指定浏览器可执行文件（默认自动找 Chrome / Edge / Brave / Chromium） | — |
| `NARWHAL_FORUM_BROWSER_PROFILE` | 浏览器授权专用的 profile 目录 | `<HOME>/browser` |
| `NARWHAL_FORUM_HOME` | 凭据目录 | `~/.config/narwhal-forum` |
| `NARWHAL_FORUM_TIMEOUT_MS` | 单请求超时 | `30000` |

凭据文件：`~/.config/narwhal-forum/credentials.json`（目录 `0700`、文件 `0600`、原子写）。
只存 baseUrl / token / refreshToken / username / authMode / loggedInAt / browserProfile，**不存密码**。
浏览器授权的登录态另存在 `<HOME>/browser/`（独立 Chrome profile），撤销时整个目录一起删掉。

> 密钥类信息一律走环境变量或 `token set`，不要写进仓库、脚本或文档。

---

## 4. CLI

全局选项：`--base-url --token --refresh-token --timeout --json --debug --help --version`
登录相关：`--password --username --browser <路径> --timeout-sec <秒> --keep-browser`

| 命令 | 说明 | 需要登录 |
| --- | --- | --- |
| `status` | 后端地址、登录状态、凭据来源 | 否 |
| `setup` | 首次接入：检查后端 → 打开浏览器授权 → 打印下一步 | 否 |
| `risk` | 授权前必读的风险提示；每次 `login`/`setup` 也会先打印 | 否 |
| `login` | **网页授权登录**：打开独立浏览器窗口，人工登录后自动取 token（见 4.2） | 否 |
| `login --password` | 退回账号密码登录（RSA+AES 加密传输） | 否 |
| `logout` | **撤销授权**：后端登出 + 删本地凭据 + 删浏览器 profile | 否 |
| `auth status` | 授权状态（是否登录、授权方式、profile 位置） | 否 |
| `token set` / `show` / `clear` | 直接管理 token（适合从浏览器复制） | 否 |
| `whoami` | 当前登录用户 | 是 |
| `posts` | 帖子列表（`--page --page-size --category --order --title-like`） | 否 |
| `post <id>` | 帖子详情（`--comments` 带评论树，`--comment-sort`） | 否 |
| `comments <postId>` | 评论树 | 否 |
| `categories` / `channels` | 论坛分类 / 站点栏目（CMS channel，非版块） | 否 |
| `search <关键词>` | 全文搜索（后端 Lucene） | 否 |
| `my-comments` | 我发过的评论 | 是 |
| `new-comment <postId> --content <文本|-> [--image 图.png]` | 发表评论 / 回复（`--parent` 指定父评论；`--image` 可重复，见 4.4） | 是 |
| `new-post --category <id> --title <t> --content <文本|@file|-> [--image 图.png]` | 发帖 | 是 |
| `upload-image <图.png> [--scene chat]` | 单独上传一张图，返回可写进 markdown 的 URL | 是 |
| `react <postId> [--emoji 👍]` | 表情互动 | 是 |
| `approve-post <postId>` | 批准待审帖（需审核权限：管理员/版主） | 是 |
| `delete-comment <id> --yes` | 删评论（作者/管理员，**不可撤销**，`--yes` 才执行） | 是 |
| `delete-post <postId> --yes` | 删帖（作者/管理员，**不可撤销**，`--yes` 才执行） | 是 |
| `draft <子命令>` | **人审发布**：`new-comment` `new-post` `list` `show` `approve` `reject` `publish` `discard`（见 4.3） | 视子命令 |
| `mcp` | 以 MCP stdio server 运行 | — |
| `tools [--json]` | 列出全部能力及参数 schema | — |
| `call <tool> --json '<参数 JSON>'` | 直接调用任意能力（逃生舱） | 视工具 |

`--content` 支持三种来源：字符串、`@文件路径`、`-`（stdin）。
`--image` 可重复（`--image a.png --image b.png`），也接受逗号分隔；上限 9 张。

```bash
echo '从 stdin 来的正文' | narwhal-forum new-comment 42 --content -
narwhal-forum new-post --category 3 --title '标题' --content @draft.md
narwhal-forum call create_comment --json '{"postId":"101589601795420674","content":"hi"}'
narwhal-forum approve-post 101589950310625794
narwhal-forum delete-post 101589950310625794 --yes
```

退出码：`0` 成功 / `1` 业务或网络错误 / `2` 用法错误（含人审令牌校验失败）/ `3` 未实名，不能发布。加 `--json` 输出机器可读结果。

---

### 4.1 授权前的风险提示（必读）

`login` / `setup` **在打开浏览器之前**会先打印风险提示，并要求你本人确认；非交互环境（CI、被脚本或 Agent 管道调用）没有 `--yes` 一律拒绝授权 —— 不允许「静默授权」。同意会记录版本号，文案升级后会再问一次。

~~~text
$ narwhal-forum login
授权前请先阅读风险提示（v2） — 目标：http://127.0.0.1:8080

  1. 内容责任在账号：通过本工具发出的帖子与评论，在论坛上算你这个账号发的，后果由账号所有者承担。
  2. AI 不能自行发布：写操作最终由发起调用的方触发；动手前请确认内容你本人看过。……
  3. 自动化有风控风险：论坛与 B 站会对高频、模板化、批量互动限流、删评甚至封号。……
  4. 只用你自己的权限：不提供管理端接口、不提供「以他人身份」操作……
  5. 未实名不能发布：后端 requireVerifyToPost / requireVerifyToComment；本工具不代做实名。
  6. 凭据留在本机，可随时撤销：token 与 profile 在本机（0600 / 0700），logout 可撤销。
  7. 图片与外链：外链可能失效、图片可能被拦。
  8. 操作留痕：本机记录写操作的时间、目标与结果。

  同意即表示你已阅读并接受以上风险；不同意可随时 Ctrl+C 退出。
确认已阅读并接受以上风险，输入 yes 继续（其它输入取消）> 
~~~

| 场景 | 行为 |
| --- | --- |
| 交互终端，首次 | 展示全文，必须输入 `yes` |
| 交互终端，已同意过同版本 | 展示全文 + 「已同意过」，回车继续 |
| 非交互，已同意过 | 展示全文，继续（同意是一次性人工行为） |
| 非交互，没同意过 | **拒绝授权**，提示在终端里运行或加 `--yes` |
| `--yes` / `NARWHAL_FORUM_ACCEPT_RISK=1` | 跳过交互（只在你能为发布内容负责时使用），并记录同意 |

MCP 侧同理：`mcp__narwhal-forum__login` 第一次调用**不打开浏览器**，只把风险全文返回给模型，要求它展示给你；只有你确认后带 `acknowledgeRisks: true` 再调用，才会真的打开浏览器。

随时查看完整文案与同意状态：`narwhal-forum risk`（或 `risk --json`）；`auth status` 里也会显示 `riskAcknowledged`。

---

### 4.2 授权登录与撤销（推荐）

`narwhal-forum login` 不问你密码，而是**打开一个浏览器窗口**：你在里面照常用论坛的登录页登录，
插件通过 DevTools 协议只读地取出该页面 `localStorage` 里的 `auth_token` / `auth_refresh_token`，
写入凭据文件后自动关闭窗口。整个过程密码不经过 CLI、不经过 dsh、不经过模型。

```text
$ narwhal-forum login
· 浏览器已打开：http://127.0.0.1:8080/login
· 请在该窗口里完成登录，登录成功后会自动继续（最多等 300 秒）
授权成功（网页登录）
凭据已写入 ~/.config/narwhal-forum/credentials.json（0600，已含 refresh token）
浏览器 profile: ~/.config/narwhal-forum/browser（撤销授权时会一并删除）
撤销方式: narwhal-forum logout
```

| 要点 | 说明 |
| --- | --- |
| 独立 profile | 浏览器用 `--user-data-dir=<HOME>/browser` 启动，和你日常浏览器互不干扰 |
| 只读令牌 | 只 `Runtime.evaluate` 读那两个 localStorage 键，不读 cookie、不读密码框 |
| 一次即可 | token 写入凭据文件，之后 CLI / MCP / 其它工具都用它；refresh token 自动续期 |
| 可撤销 | `narwhal-forum logout`：调后端登出 → 删凭据 → 删 profile（cookie 一起消失） |
| 可保留 | `logout --keep-browser` 只清 token，保留 profile 里的登录态，下次免登录 |
| 无浏览器时 | `login --password` 走账号密码；或 `token set --access <token>` 手工导入 |

**要求**：Node >= 22（内置 `WebSocket` 用来连浏览器调试端口）。低于这个版本 `login` 会直接提示改用 `--password`。

**关于「安装时自动打开浏览器」**：npm 安装不应该在你背后弹窗，所以打开浏览器这一步放在
`setup` / `login` 上。dsh 里装完插件后，第一次用论坛能力前跑一次 `narwhal-forum setup`；
`mcp__narwhal-forum__login` 工具调用时也会打开浏览器（写操作失败提示「需要登录」时让 Agent 调它）。

---

### 4.3 人审发布：AI 写、人批准、再上线

模型/AI 写的内容**不允许自己发出去**。写、批准、发布是三段分离的动作，批准只能发生在**人的终端**里：

```bash
narwhal-forum draft new-comment 42 --content @reply.md    # AI 侧：只落本地草稿，不联网
narwhal-forum draft show drf-1a2b3c4d                     # 人：看全文（含目标帖子）
narwhal-forum draft approve drf-1a2b3c4d                  # 人：TTY 里输入 yes → 打印一次性 token
narwhal-forum draft publish drf-1a2b3c4d --token nfap_…   # 持 token 才能发布
```

- **token 一次性**：用过即废（`E_APPROVAL_USED`），重放不可能；
- **10 分钟有效**（`APPROVAL_TTL_MS`），过期后草稿降级为 `expired`，需重新批准；
- **绑定内容指纹**：批准后改一个字，旧 token 立刻作废（`E_APPROVAL_HASH_MISMATCH`），防「批准 A、发布 B」；
- **绑定动作与用户**：发帖的 token 不能用来发评论（`E_APPROVAL_ACTION` / `E_APPROVAL_USER`）；
- **发布前强校验实名**：`verifiedType=0` 直接拒绝（退出码 `3`），且**不消费 token** —— 实名后同一个 token 还能用；
- **MCP 侧没有批准类工具**：Agent 能建草稿、能读草稿、能拿 token 发布，但 `draft approve` 只在 TTY 里跑，Agent 无权自己批；
- `draft publish` 只认 `--token`，没有 `--yes` / `--force`。

草稿与批准密钥落在 `~/.config/narwhal-forum/`（目录 `0700`、文件 `0600`）：`drafts/<id>.json` 存正文与状态，`approval.key` 存 HMAC 密钥（首次批准时生成）。

### 4.4 图片评论（`--image`）

评论正文是普通字符串，前端用 marked + DOMPurify 渲染（`<img>` 放行），所以**图片不占数据库字段**：
先把图传到论坛的上传接口拿 URL，再以 markdown `![](url)` 内联进正文。这条路径**不需要改 narwhal-cms 一行代码**。

```bash
# 一条评论带两张图（图先上传，再内联）
narwhal-forum new-comment 42 --content '复现步骤见下图' --image ./step1.png --image ./step2.png

# 发帖带图
narwhal-forum new-post --category 3 --title '报个 bug' --content @body.md --image ./shot.png

# 只想先拿一个 URL（比如自己拼正文）
narwhal-forum upload-image ./shot.png --json    # → {"url":"http://…/uploads/2026/11/xxx.webp", …}
```

走的接口就是网页端粘贴上传的那一条：`POST /api/upload/image-upload`（multipart，字段名 `file`，
`@PreAuthorize("isAuthenticated()")`）。**压缩、水印、图片内容审核都在上传时由后端完成**，所以：

| 规则 | 值 | 说明 |
| --- | --- | --- |
| 单张上限 | 10MB | 客户端先挡一层，免得白传 |
| 每条上限 | 9 张 | 再多没有阅读价值 |
| 格式 | png / jpg / jpeg / gif / webp / bmp / avif | 按扩展名推断 Content-Type |
| 审核 | 后端 `ImageModerationProvider` | 命中敏感图直接返回 400，**评论不会发出** |
| 场景 | `--scene chat` | 私信/聊天类内容传 `chat`，文件会被登记为私密 |

草稿带图时，草稿里只存**本地路径 + sha256**（不联网、不上传）；`draft_publish` 会**先重新校验文件指纹**：
文件被删 → `E_IMAGE_MISSING`；内容变了 → `E_IMAGE_CHANGED`。两种情况都在上传前失败，**token 不消费**，
所以「人批准的是这张图，发出去的就必须是这张图」。

> 为什么不做「后端加 `images_` 列」：评论正文已经是 markdown，加列等于把同一份信息存两处，
> 还要改实体、迁移、DTO 与前端渲染；内联方案的渲染路径（`BbsMarkdown.vue`）本来就存在。

---

## 5. 接入各工具

### dsh（插件形式）

```bash
# 1) 先让命令在 PATH 上（三选一）
npm i -g --prefix ~/.local /path/to/narwhal-forum   # 推荐：用户级，无需 sudo
# 或 npm i -g narwhal-forum                        # 已发布到 npm 时

# 2) 装进 dsh：target = 本包绝对目录
plugin_manager action=install_bundle target="/path/to/narwhal-forum"
```

```bash
# 3) 授权一次（会打开浏览器；之后 dsh 里的论坛调用都用这份凭据）
narwhal-forum setup
```

包内 `cordis.patch.yml` 完成接线：`@deepseek-ai/dsh-mcp-client` 以 stdio 拉起
`narwhal-forum mcp`，工具以 `mcp__narwhal-forum__<tool>` 暴露给 Agent。
升级 / 卸载走同一入口（`plugin_manager` 的 set_plugin / remove_bundle），不要手改 profile。

| 你的安装方式 | patch 的 command / args |
| --- | --- |
| `npm i -g --prefix ~/.local .`（默认配置） | `narwhal-forum` / `[mcp]` |
| 已发布到 npm，想用 npx | `npx` / `[-y, narwhal-forum, mcp]` |
| 不装全局，源码直跑 | `node` / `[<包目录>/bin/narwhal-forum.js, mcp]`（见 `examples/cordis.local.patch.yml`） |
| **dsh 桌面端（app）** | 见下面 5.1：桌面进程的 PATH 里没有 node，必须 [REDACTED_STREET_411] |

### 5.1 dsh 桌面端：PATH 里没有 node（必读）

dsh 桌面版（Electron 打包的 app）**不继承你的 shell PATH**，它的进程环境只有
`/usr/bin:/bin:/usr/sbin:/sbin`。可以自己确认：

```bash
ps eww -p $(pgrep -f 'DeepSeek Harness' | head -1) | tr ' ' '\n' | grep '^PATH='
# → PATH=/usr/bin:/bin:/usr/sbin:/sbin
```

于是 `command: narwhal-forum`、`npx`、甚至 `node`（nvm 装的）**全都解析不到**。
而 `failOnStartupError: false` 会让这种失败**静默发生**：[REDACTED_STREET_412]，看起来像「插件没装」。

解法：给它一个绝对路径的启动器（一个 20 行的 sh 脚本，自己找 node，与 nvm 版本解耦）。

```bash
# 1) 安装启动器（仓库自带）
mkdir -p ~/.dsh/bin
cp examples/narwhal-forum-mcp ~/.dsh/bin/narwhal-forum-mcp
chmod +x ~/.dsh/bin/narwhal-forum-mcp

# 2) 在 profile 的 cordis.patch.yml 里按 id 覆写那一行
#    （模板：examples/cordis.desktop.patch.yml）
```

```yaml
- id: narwhal-forum-mcp            # 必须与包内 cordis.patch.yml 的 id 一致，否则是「新增一行」而不是「改这一行」
  name: '@deepseek-ai/dsh-mcp-client'
  config:                          # ⚠️ config 整体替换、不深合并：所有字段都得重述
    serverName: narwhal-forum
    transport: stdio
    command: /Users/<you>/.dsh/bin/narwhal-forum-mcp
    args: []
    toolCallTimeoutMs: 60000
    failOnStartupError: true       # 桌面端建议 true：起不来就报错，而不是静默少一批工具
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
```

改完**重启 dsh 应用**才会生效；重启后 `mcp__narwhal-forum__*` 才会出现在工具列表里。
验证：`cordis_inspect_query` 查 `@deepseek-ai/dsh-mcp-client`，应能看到 `patchId: narwhal-forum-mcp` 这一行；
或者直接让 Agent 调 `mcp__narwhal-forum__status`。

> 不想用启动器也可以写死 node 绝对路径（`command: /Users/<you>/.nvm/versions/node/v24.14.0/bin/node`，
> `args: [<profile>/node_modules/narwhal-forum/bin/narwhal-forum.js, mcp]`），代价是 nvm 换版本时要改这一行。

<details>
<summary>覆写没生效时（重启后仍然没有 <code>mcp__narwhal-forum__*</code>）</summary>

同一 id 的覆写依赖 patch 层的先后顺序。万一版本升级后顺序变了、覆写被 bundle 层盖掉，
就直接**把 bundle 那一行关掉、另起一个 id** —— 这招与顺序无关：

```yaml
# 1) 关掉包自带的那一行（只改 disabled，不动 config）
- id: narwhal-forum-mcp
  disabled: true

# 2) 用另一个 id 插一条等价的
- insert:
    - id: narwhal-forum-mcp-local
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: narwhal-forum
        transport: stdio
        command: /Users/<you>/.dsh/bin/narwhal-forum-mcp
        args: []
        toolCallTimeoutMs: 60000
        failOnStartupError: true
        reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }
```

`serverName` 必须保持不变（它决定工具前缀 `mcp__narwhal-forum__*`），只有 patch 行的 `id` 可以变。
</details>

### Claude Code

```json
{
  "mcpServers": {
    "narwhal-forum": {
      "command": "narwhal-forum",
      "args": ["mcp"],
      "env": { "NARWHAL_FORUM_BASE_URL": "http://127.0.0.1:8080" }
    }
  }
}
```

放在项目 `.mcp.json` 或 `~/.claude.json`。没装全局就把 `command` 换成 `npx`、`args` 换成 `["-y","narwhal-forum","mcp"]`。

### Codex CLI

```toml
[mcp_servers.narwhal-forum]
command = "narwhal-forum"
args = ["mcp"]

[mcp_servers.narwhal-forum.env]
NARWHAL_FORUM_BASE_URL = "http://127.0.0.1:8080"
```

### 任意 MCP host

任何支持 stdio MCP 的客户端：命令 `narwhal-forum`，参数 `mcp`。
协议版本协商支持 `2025-06-18` / `2025-03-26` / `2024-11-05`。

---

## 6. 能力矩阵（MCP 工具与 CLI 同源）

| 工具 | 作用 | 主要参数 | 只读 | 需登录 |
| --- | --- | --- | --- | --- |
| `status` | 配置与登录状态 | — | ✅ | 否 |
| `login` | 网页授权登录（默认）/ 账号密码 | `mode` `timeoutSec` `browserPath` `username?` `password?` `captchaToken?` | ❌ | 否 |
| `logout` | 撤销授权（后端登出 + 删凭据 + 删 profile） | `keepBrowser?` | ❌ | 否 |
| `whoami` | 当前用户 | — | ✅ | 是 |
| `list_posts` | 帖子列表 | `page` `pageSize` `categoryId` `userId` `titleLike` `order` | ✅ | 否 |
| `get_post` | 帖子详情 | `postId` `withComments` `commentSort` | ✅ | 否 |
| `list_comments` | 评论树 | `postId` `sort` | ✅ | 否 |
| `list_categories` | 分类 | `page` `pageSize` | ✅ | 否 |
| `list_channels` | **站点栏目**（CMS channel，非论坛版块） | — | ✅ | 否 |
| `search_posts` | 搜索 | `q` `categoryId` `userId` `dateFrom` `dateTo` `sort` `page` `pageSize` | ✅ | 否 |
| `my_comments` | 我的评论 | `page` `pageSize` | ✅ | 是 |
| `create_comment` | 发表评论 | `postId` `content` `parentId?` `replyUserId?` `whisper?` `images?` | ❌ | 是 |
| `create_post` | 发帖 | `categoryId` `title` `content` `summary?` `type?` `cover?` `images?` | ❌ | 是 |
| `upload_image` | 上传一张图，返回 URL | `path` `scene?` | ❌ | 是 |
| `react_post` | 表情互动 | `postId` `emoji` | ❌ | 是 |
| `approve_post` | 批准待审帖（管理员/版主） | `postId` | ❌ | 是 |
| `delete_comment` | 删评论（作者/管理员，**不可撤销**） | `commentId` `confirm=true` | ❌ | 是 |
| `delete_post` | 删帖（作者/管理员，**不可撤销**） | `postId` `confirm=true` | ❌ | 是 |
| `draft_create` | 落本地草稿（**不发出去**） | `kind` `content` `postId?` `parentId?` `replyUserId?` `whisper?` `categoryId?` `title?` `summary?` `images?` | ❌（不联网） | 否 |
| `draft_list` | 草稿列表 | `status?` | ✅ | 否 |
| `draft_get` | 单条草稿 | `draftId` | ✅ | 否 |
| `draft_discard` | 丢弃草稿 | `draftId` | ❌ | 否 |
| `draft_publish` | 用**人给的一次性 token** 发布 | `draftId` `approvalToken` | ❌ | 是 |

`order` 取值：`newest` `hot` `trending` `unanswered` `following` `most-collected` `best-all-time` `on-this-day`。
`emoji` 白名单：👍 ❤️ 😂 🎉 🤔 😮 😢 🚀。
`images` 是**本地文件路径数组**（最多 9 张）：工具内部先上传再内联 markdown，调用方不需要自己拼 URL。

两个容易踩的点（都在真实后端上验过）：

- **所有 id 都是雪花号**，schema 里一律声明成 `string`。按数字传会被 JSON 的双精度截断
  （`101589601795420674` → `…670`），后端稳定 404。CLI 里照原样贴字符串就行。
- `delete_comment` / `delete_post` 必须带 `confirm=true`（CLI：`--yes`）才执行，
  没带就只回一句「这是不可撤销操作」，不会动数据。

---

## 7. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 连不上论坛后端 | 后端没起或 `NARWHAL_FORUM_BASE_URL` 不对；先 `narwhal-forum status` |
| 这个操作需要登录 | `narwhal-forum login` 或 `token set` |
| 评论太快了，请等 15 秒再发 | 后端限流，等冷却 |
| 需要手机号 / 实名认证 | 后端策略，补齐账号资料后重试 |
| 401 自动刷新后仍失败 | refresh token 过期，重新登录 |
| 没找到 Chrome / Edge / Brave | `--browser <路径>` 或 `NARWHAL_FORUM_BROWSER`；或 `login --password` |
| 等待登录超时（LOGIN_TIMEOUT） | 窗口里没完成登录；重跑 `login`，或加 `--timeout-sec 600` |
| 当前 Node 没有内置 WebSocket | Node < 22，用 `login --password` 或升级 Node |
| `npm error sudo chown ...` | 见第 1 节，换 `npm_config_cache` |

---

## 8. 已知限制

- **已支持**：图片（评论/发帖内联，见 4.4）。
- **未实现**：非图片附件、通知、私信、收藏与关注列表（后端有接口但未纳入本包；`call` 逃生舱可临时补位）。
- **验证边界**（三层，都已跑过）：
  1. **单元/集成**：104 个用例跑在进程内 mock 后端（同一套契约）。
  2. **MCP 端到端**：`npm run test:e2e`（`scripts/e2e-mcp.mjs`）用 dsh 桌面端**实际会 spawn 的那条命令**、在
     `PATH=/usr/bin:/bin:/usr/sbin:/sbin`（没有 node / npx）的干净环境里走完
     initialize → tools/list（23 个）→ `list_posts` → `upload_image` → `create_comment` 带图，并校验 mock 里
     落库的正文确实是 `![](http://…)`。10/10 通过 —— 这一层证明「桌面端 PATH 里没有 node」不再是阻塞。
  3. **真实论坛**：`node scripts/e2e-live.mjs --write` 连真后端（narwhal-cms + MySQL + Redis）跑，**11/11 通过**：
     20+ 工具、雪花 id 以字符串传、`list_posts` / `get_post`（含评论树）/ `list_comments` 读真实数据、
     `create_comment` 写库、`react_post` toggle、`create_post` 返回真实 `status`、待审时 `approve_post` 放行、
     `delete_post` 清理自造的冒烟帖。另手工验过：图片上传 + 带图评论、嵌套回复、搜索、CMS 栏目、草稿人审闸。

### 8.0 权限与门禁实测（2026-11-21，真后端逐项验过）

插件自己不判权限 —— 所有授权都由后端决定，插件只负责把「被拦的原因」和「去哪解决」原样端出来。
下表是三种身份在真实后端上的实际结果（`✅` 通过 / `🚫` 被后端拒绝并给出可执行提示）：

| 操作 | 匿名（未登录） | 普通用户（无角色） | 管理员 |
| --- | --- | --- | --- |
| `list_posts` / `get_post` / `list_comments` / `list_categories` / `list_channels` / `search_posts` | ✅ | ✅ | ✅ |
| `create_comment` | 🚫 `🔒 「发表评论」需要登录`（退出码 1） | ✅（需先绑手机 + 实名，见下） | ✅ |
| `create_post` | 🚫 需要登录 | ✅，但 `status=-1` 待审 | ✅，**同样** `status=-1` 待审 |
| `react_post` | 🚫 需要登录 | ✅ | ✅ |
| `approve_post` | 🚫 需要登录 | 🚫 `No permission`（HTTP 400） | ✅ |
| `delete_comment` | 🚫 需要登录 | ✅ 仅自己的；别人的 🚫 `Only the author can delete this comment` | ✅ 可删任何人的 |
| `delete_post` | 🚫 需要登录 | ✅ 仅自己的；别人的 🚫 `Only the author can delete this post` | ✅ 可删任何人的 |

两道**内容门禁**（普通用户写内容前必须过，管理员豁免）：

1. 未绑手机 → `需先绑定手机号才能评论` + blocker `actionTo=/forum/settings?tab=binding#mobile-binding`；
2. 未实名 → `需完成实名认证后才能评论` + blocker `actionTo=/forum/settings?tab=profile`。

后端的门禁响应是 **HTTP 200 + `status=-1` + `result.blockers[]`**（`{code,title,desc,actionLabel,actionTo,action}`）。
插件把 `blockers` 一路透传：CLI 打成 `· 完成实名认证（去认证）：/forum/settings?tab=profile`，
MCP 的 `isError` 结果正文里附同样的清单、并放进 `structuredContent.error.blockers`，
`--json` 输出顶层带 `blockers`。**被拦时不能只说「失败了」，要给出去哪解决**。

其它已验证的边界：无效 token → `🔒 未登录或登录已过期（HTTP 401）`；评论 15 秒冷却原样透出；
删除不存在的 id → `BbsPost not found. ID = <id>（HTTP 404 …）`；不带 `confirm` 的删除在插件层就被拦下（不碰后端）。

### 8.1 真实后端实测踩到的 5 个坑（都已修，附成因）

这些不是「理论上可能」，是本轮连真后端时**实际把功能跑坏**的东西：

| 现象 | 成因 | 修法 |
| --- | --- | --- |
| `get_post` 稳定 404，id 看着对但不一致 | 雪花 id 超过 2^53，JSON 按数字解析被截断（…674 → …670） | 所有 id 在 schema 里改成 `string`，数字传进来直接报错并给出提示 |
| `list_channels` 永远 404 | `/api/bbs/channel` 在真后端是「创作者频道自助申请」那套（self-serve/apply/my-channel），**没有列表 GET**；真正的栏目列表是 CMS 的 `/api/channel`（扁平数组、不分页） | 改打 `/api/channel`，工具改名为「站点栏目」，并在描述里点名「论坛版块请用 `list_categories`」 |
| 搜索结果时间显示成 `1795248388000` | Lucene 返回的 `created` 是**毫秒时间戳的字符串**，`new Date('1795…')` 在 V8 里是 Invalid Date | `fmtTime` 显式认 10/13 位数字（秒/毫秒） |
| 回复发出去了，评论树里看不见、计数也少 | `GET /api/bbs/comment?postId=&parentId=0` **只回直接子级**，嵌套回复在 `/api/bbs/comment/{id}/replies`（Pageable，pageSize 上限 20） | 逐层拉 replies 拼 `children`（默认 3 层 / 60 次请求封顶，超了标 `truncated`） |
| 发帖成功但列表里没有 | 新账号/未达信任阈值 → 后端给 `status_=-1`（待审），**管理员自己发的也待审**；原来工具无条件说「已发布」 | 按后端真实 `status` 说话（1=已发布，-1=待审并提示用 `approve_post`），并新增 `approve_post` 工具 |

- 浏览器授权把「开浏览器 + 取 token」抽成可注入的取值函数来测，真实弹窗需要人工验证一次。
- **仓库**：GitHub 私有仓 `sasazhang2333/narwhal-forum`（与 narwhal-cms 同级存放，本地目录名同名）。
- **待确认**：是否发布到 npm 私有源（`npx narwhal-forum` 现在需先 `npm i -g`，或用 `npx --package <tarball>`）。
- 论坛若开启验证码 / 双因素登录：**网页授权天然通过**（人就在真浏览器里）；只有 `login --password` 会返回 `CAPTCHA_REQUIRED` / `TWO_FACTOR_REQUIRED`。
- 浏览器授权依赖 Chromium 系浏览器（Chrome / Edge / Brave / Chromium）；Safari / Firefox 不支持，需 `--password` 或 `token set`。

---

## 9. 目录

```text
narwhal-forum/
├── bin/narwhal-forum.js     # CLI 入口（bin 名：narwhal-forum / nf）
├── src/
│   ├── client.js            # 论坛 API 客户端（错误模型、401 刷新重放）
│   ├── auth.js              # 浏览器授权登录 / 撤销 / 状态（CDP 读 token）
│   ├── crypto.js            # RSA + AES 登录加密
│   ├── config.js            # 配置解析 + 凭据文件
│   ├── images.js            # 图片校验 / multipart 拼装 / markdown 内联
│   ├── cli.js               # 命令行
│   ├── index.js             # 库导出
│   └── mcp/
│       ├── server.js        # 手写 MCP stdio JSON-RPC server
│       └── tools.js         # 20 个能力定义与渲染
├── cordis.patch.yml         # dsh 插件接线
├── locale/{en,zh}.json      # dsh 插件文案
├── icon.svg
├── examples/                # Claude Code / Codex / dsh 启动器 / profile 覆写示例
├── scripts/e2e-mcp.mjs      # 端到端：按桌面端真实命令跑一遍 MCP（10 项断言）
└── test/                    # mock 论坛 + 93 个用例（含 multipart 上传端点）
```

## 10. 开发

```bash
npm test          # 等价于 node --test "test/*.test.js"（93 个用例）
npm run test:e2e  # 端到端：用桌面端的启动器跑一遍 MCP（不需要真论坛，会自动起 mock）
npm run mcp       # 本地起 MCP server
```

## License

MIT
