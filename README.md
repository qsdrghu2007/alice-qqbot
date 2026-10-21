# Alice QQ 陪伴机器人

Alice 是一个优先在本机运行的 QQ 陪伴机器人，提供网页控制台、聊天历史与长期记忆、人格与模型配置、本地表情库、联网搜索、自主发帖，以及通过 OneBot/NapCat 连接个人 QQ 的聊天、表情、点赞和 QQ 空间发布能力。

Alice 自己启动的 HTTP 服务只监听 `127.0.0.1`，默认不开放到局域网或公网。项目支持 Windows 和 macOS，没有构建步骤，唯一必需的运行依赖是 `ws`。NapCat 是独立进程，它的 WebUI 监听地址由 NapCat 自己的 `webui.json` 决定，详见 [NapCat 与 OneBot](#napcat-与-onebot)。

## 目录

- [安装与启动](#安装与启动)
- [首次配置清单](#首次配置清单)
- [控制台页面](#控制台页面)
- [配置](#配置)
- [短期会话状态与拟人情绪](#短期会话状态与拟人情绪)
- [长期记忆](#长期记忆)
- [本地表情库](#本地表情库)
- [NapCat 与 OneBot](#napcat-与-onebot)
- [QQ 空间](#qq-空间)
- [安全边界](#安全边界)
- [数据与备份](#数据与备份)
- [已知限制](#已知限制)

## 当前能力

- 本地网页控制台：聊天、空间、表情库、长期记忆、设置、诊断。
- OneBot/NapCat 个人号：私聊、被 @ 的群聊、图片与表情、点赞、QQ 空间发布。
- 官方 QQ 机器人：仅文本，受官方平台权限和额度限制。
- 自动长期记忆：AI 判断重要信息并保存，按类型/重要度/时间去重和修剪；私聊按账号、群聊按群隔离。
- 短期连续状态：同一账号跨私聊/群共享安全画像（关系阶段、枚举偏好、边界）；话题、未完成事项和情绪按来源 ACL 使用隔离的哈希 key，私聊私密话题不会进入群提示词。
- 拟人情绪：全局只保存情绪枚举和四个强度数值，会随时间衰减；它是表达用的拟人状态，不是真实情感或意识。
- 回复审校：非工具回复会由独立 AI 检查机械重复、客服腔和过长铺垫；只附带由历史计算的数字/布尔习惯标记，不发送历史原文。工具或外发动作结果不重写，审校失败回退原稿。
- 回忆搜索：AI 不确定过去细节时先搜全部长期记忆，再搜当前会话记录，OneBot 可继续拉取最近 7 天；私人往事仍没有就如实说忘记。
- 联网搜索：复用 DeepSeek Search / Fetch；Search 和 Fetch 可独立开关；私聊按需判断，群聊只有明确要求才联网；搜索期间保持“正在输入”，不向用户播报搜索过程。
- 打字延迟：QQ/OneBot 回复按字数等待；纯表情包不等待；不同会话独立计时。
- 连续消息合并：OneBot/官方 QQ 快速连发的多条消息会合并成一条；先等待 `inputDelayMs`（默认 2 秒），明显未完句会追加有界等待。生成期的明确 ACK 作为补充保留，实质新消息打断后重新合并。
- 分段发送：长文本偶尔拆成最多两段，每段按实际可见字数计算发送延迟；代码、URL、结构化输出、动作结果、图片和表情不拆分。
- 正在输入：OneBot/NapCat 私聊在生成和延迟期间显示“对方正在输入”，按用户隔离；群聊和官方 QQ 不支持。
- 主动离开聊天：私聊收尾消息（如“好吧/晚安/等下再说”）可不回复，记录终止时间，下一条消息恢复正常。
- 主动回访：终止后由 AI 判断时机，到点结合最近上下文主动发一条 OneBot 私聊；夜间顺延，用户提前回复则取消。
- 本地表情库：自动收藏、AI 审核、去重、总结和标签、手动上传、发送节奏提示。
- AI 人格：当前人格名为 Alice，可在设置中修改 System Prompt 和思考强度。
- 自主发帖：按间隔生成纯文本并发布到 QQ 空间，支持静默时段；启动时若已过期只补发一条，并读取南京天气和当前时间让内容更自然。
- 空间评论：自己的说说有新评论时 AI 判断并楼中楼回复；别人 @ 并带空间链接时评论一次，之后跟踪回复。
- 安全边界：回环监听、随机 Bearer 令牌、Host/Origin 校验、密钥脱敏、路径穿越防护。

## 运行要求

- Node.js 22 或更高版本。
- Windows 或 macOS。
- 使用个人号路线时，需要安装并登录 NapCatQQ；QQ 空间发布要求 NapCat `>= 4.18.18`。
- 需要 AI 回复时，在设置中填写兼容 OpenAI Chat Completions 的 Base URL、API Key 和模型名。当前默认模型是 `deepseek-flash`。

## 安装与启动

### 1. 准备环境

- Node.js 22 或更高版本。
- Windows 或 macOS。
- 使用个人 QQ 时，需要安装并登录 NapCatQQ；QQ 空间发布要求 NapCat `>= 4.18.18`。
- 下载源码：从 [最新 Release](https://github.com/qsdrghu2007/alice-qqbot/releases/latest) 下载 source zip，或执行：

```bash
git clone https://github.com/qsdrghu2007/alice-qqbot.git
cd alice-qqbot
```

安装 Node.js 后，先在终端确认环境：

```bash
node -v
npm -v
```

两条命令都能输出版本号即可。Node.js 版本必须不低于 22。

### 2. 安装依赖

在包含 `package.json` 的项目根目录执行：

```bash
npm install
```

首次部署或需要严格按 `package-lock.json` 安装时，也可以使用：

```bash
npm ci
```

项目没有构建步骤，运行依赖只有 `ws`。如果下载依赖很慢，可以先配置 npm 镜像，再重新执行安装。

### 3. 手动启动

```bash
npm start
```

启动后终端会打印带随机令牌的地址，例如：

```text
http://127.0.0.1:3210/#token=...
```

在浏览器打开这个地址即可。令牌只在启动终端出现一次；网页会把它保存到当前标签页的 `sessionStorage`，并从地址栏移除。关闭标签后，从启动终端复制原链接重新打开即可。只有终端已关闭或令牌丢失时，才需要重启 Alice 生成新链接。

首次启动默认是演示模式，不会调用真实 AI。填写 API Key 后还需要按 [首次配置清单](#首次配置清单) 关闭演示模式并启用需要的通道。

### 4. Windows 一键启动

使用个人 QQ（OneBot/NapCat）时：

1. 双击 `start-onebot.bat` 启动项目内的 NapCat。
2. 双击 `start.bat` 启动 Alice；首次运行会自动执行 `npm install`。
3. 在 NapCat 控制台登录 QQ，必要时打开 NapCat WebUI 扫码。WebUI 默认端口是 `6099`，实际监听地址以 `webui.json` 为准。
4. 使用终端打印的控制台链接打开网页。
5. 在设置页启用 OneBot，确认地址为 `ws://127.0.0.1:3001`，令牌与 NapCat 一致，保存后点“立即重连”。

只使用网页本机聊天或官方 QQ 时，可以跳过 `start-onebot.bat`，直接双击 `start.bat`。

### 5. macOS 启动

双击 `start.command` 只会启动 Alice，不会启动 NapCat。使用个人 QQ 时，需要另行安装并启动 NapCat，再把 OneBot WebSocket 地址和令牌配置到设置页。

如果 macOS 提示没有执行权限，在项目目录执行：

```bash
chmod +x start.command
```

### 停止 Alice

- Windows：双击 `stop-alice.bat`，或在启动终端按 `Ctrl+C`。
- macOS：在启动终端按 `Ctrl+C`。
- `stop-alice` 依赖控制台端口；使用 `--no-web` 时没有监听端口，需要在启动终端按 `Ctrl+C` 或按 PID 结束进程。

### 只运行 OneBot，关闭 Web

不需要网页控制台时，可以禁用 HTTP 服务，OneBot、空间评论、定时空间、主动回访和后台记忆仍会继续运行：

```bash
node src/index.js --no-web
```

或设置环境变量：

```bash
ALICE_DISABLE_WEB=1 npm start
```

Windows PowerShell：

```powershell
$env:ALICE_DISABLE_WEB="1"; npm start
```

此时不会再监听 `127.0.0.1:3210`，也不会打印控制台链接。要重新打开网页，去掉 `--no-web` / 环境变量后重启 Alice。

### 检查与测试

```bash
npm run setup
npm run check
npm test
```

## 首次配置清单

首次启动使用内置默认值，所有外部通道默认关闭，`demo` 默认为 `true`。只看到网页并不代表机器人已经接上 QQ。

1. 打开设置页，填写兼容 OpenAI Chat Completions 的 Base URL、API Key 和模型名。
2. 关闭“演示模式”。演示模式开启时不会调用真实 AI，也不会执行点赞、发空间、自动收藏、收尾判断、定时空间或主动回访。
3. 使用个人号：启用 OneBot，确认 `onebot.url` 为 `ws://127.0.0.1:3001`，令牌与 NapCat 一致，保存后点“立即重连”。
4. 使用官方 QQ：填写 App ID 和 Secret 后启用；官方通道只支持文本。
5. 需要点赞或让 QQ 用户触发空间发布时，把对方 QQ 加入 `policy.actionUsers`。空数组表示所有 QQ 用户都没有外发权限，本机控制台例外。
6. 需要空间发布：启用 `qzone.enabled` 和 `qzone.autoPublish`。需要定时发空间再启用 `autonomy.enabled`，默认间隔 240 分钟。
7. 需要空间评论：启用 `qzoneComments.enabled`，先保持 `dryRun: true` 观察识别结果，确认无误后再关闭。Cookie 只在内存中使用。

`policy.allowedUsers` / `policy.allowedGroups` 为空表示不限制；一旦填写，只允许列表内的私聊用户或群。`policy.actionUsers` 的语义相反：为空表示没有 QQ 用户能触发外发操作。

## 控制台页面

- 聊天：本机 owner 会话，可附加 HTTPS 图片，支持浏览器语音输入和朗读。支持 `/help`、`/reset`、`/remember`、`/memories`、`/forget` 本机命令；QQ/OneBot 私聊和群聊另支持 `/profile reset`，只清当前发送者画像。远程画像命令仍受允许名单约束。
- 空间：文字、HTTPS 图片、公开/好友/自己可见范围、登录探测和定时发布设置。“登录空间”只探测 NapCat 是否已登录 QQ，不会建立独立的空间会话。
- 表情库：查看、搜索、预览、删除自动收藏或手动上传的表情，编辑已有标签，切换自动收藏和启用状态；手动上传必须自己填写标签（Web 和 API 都会校验）。设置页可调图库上限、单张大小、可爱/有趣阈值和主动发表情间隔。
- 长期记忆：按范围查看、添加、删除和清空记忆；私聊、群聊、身份绑定分别展示。
- 用户理解：每天定时分析 QQ/OneBot 私聊中的交流方式，每 7 天汇总一次安全性格枚举；只积累启用后的已提交消息，不回填既有聊天历史。同一可信用户的私聊和群聊可共享画像，原始私聊不会进入群提示词。
- 设置：人格、AI 服务与演示模式、联网搜索、工具调用、长期记忆、表情库、输入前延迟、打字延迟、主动离开聊天、主动回访、官方 QQ、OneBot、行为策略、QQ 空间、空间评论和定时空间。
- 诊断：真实适配器状态、重连、导入、导出和备份。

## 配置

运行配置在 `data/config.json`。读取时会与内置默认值深合并，因此旧配置文件缺少新字段也能启动。密钥字段在读取接口、状态输出和导出中会被移除；保存时留空表示保留旧值，所以无法通过网页清空密钥。要删除 `ai.apiKey`、`qq.secret`、`onebot.token` 或 `webSearch.apiKey`，需停止 Alice 后编辑该文件并重启。

| 区块 | 关键项 | 说明 |
| --- | --- | --- |
| `ai` | `baseUrl`、`apiKey`、`model`、`systemPrompt`、`temperature`、`reasoningEffort`、`historyMessages` | AI 服务与人格。`reasoningEffort` 可选 `low` / `high` / `max`，默认 `high`。DeepSeek 思考模式默认开启；思考模式下 `temperature` 不生效。`historyMessages` 控制直接注入的历史消息条数，默认 30，0 表示注入当前保留的全部历史。 |
| `onebot` | `enabled`、`url`、`token` | 连接 NapCat 的 OneBot WebSocket，默认 `ws://127.0.0.1:3001`。 |
| `qq` | `enabled`、`appId`、`secret`、`sandbox` | 官方 QQ 机器人，仅文本。 |
| `autonomy` | `enabled`、`intervalMinutes`、`prompt`、`quietHours`、`timezone` | 定时 QQ 空间动态，间隔最少 60 分钟。启动时发现已过期会补发一条；正常运行中的安静时段仍顺延。 |
| `policy` | `autoActions`、`paused`、`allowedUsers`、`allowedGroups`、`actionUsers`、`cooldownMs`、`maxActionsPerHour` | 会话允许名单、外发操作权限和频率限制；`allowedUsers` / `allowedGroups` 为空表示不限制，`actionUsers` 为空表示没有 QQ 用户可触发外发操作（本机控制台例外）。`cooldownMs` 只限制外发操作，不丢弃快速连发的入站消息。 |
| `qzone` | `enabled`、`autoPublish`、`headless` | QQ 空间能力与发布授权。`headless` 是历史兼容字段，当前版本不读取、不改变行为；空间发布始终通过 NapCat。 |
| `qzoneComments` | `enabled`、`dryRun`、`pollMinutes`、`activePollMinutes`、`activeWindowMinutes`、`pollJitterPercent`、`cookieRefreshMinutes`、`ownTrackHours`、`externalTrackHours`、`onlyFriends`、`allowedUsers`、`blockedUsers`、`maxRepliesPerCycle`、`maxRepliesPerHour`、`delayMinSeconds`、`delayMaxSeconds`、`maxReplyChars`、`aiDecide`、`nestedReplyFallback`、`replyPrompt` | 空间评论回复。默认关闭且 dryRun；需要同时启用 `qzone.enabled`、未暂停、`policy.autoActions` 未关闭，关闭 dryRun 后还需要 AI Key；演示模式会跳过。QZone 无推送，只能自适应轮询；跟踪时长和回复上限的 0 表示不限。通过 NapCat `get_cookies` 获取空间登录态，Cookie 只在内存使用。`nestedReplyFallback` 默认 `false`，楼中楼直发失败时不回退到线程末尾。 |
| `stickers` | `enabled`、`autoCollect`、`maxItems`、`maxFileSizeBytes`、`minCuteScore`、`minInterestingScore`、`proactiveCooldownMinutes` | 本地表情库。标签可在 Web 手动编辑；主动发表情先按需加载全部标签。间隔默认 5 分钟，只作为提示词软限制。 |
| `memory` | `enabled`、`autoExtract`、`minImportance`、`maxPerKey`、`maxInjected`、`judgeModel`、`judgeTimeoutMs` | 长期记忆。默认自动提取重要度 ≥ 7 的信息，每个记忆库最多 50 条，每轮最多注入 10 条。 |
| `conversationState` | `enabled`、`reviewEnabled`、`judgeModel`、`judgeTimeoutMs`、`maxEntries`、`ttlHours`、`globalEmotionTtlHours`、`topicTtlHours`、`unfinishedTtlHours`、`userEmotionTtlHours`、`commonMemeTtlHours`、`profileTtlHours` | 当前没有 Web 表单，需改文件并重启。话题默认 24 小时、未完成事项 168 小时、用户情绪 6 小时、共同梗 168 小时、安全画像 720 小时；状态总量最多 200 个。全局拟人情绪默认 24 小时衰减，审校可单独指定模型与 8 秒超时。 |
| `userUnderstanding` | `enabled`、`hour`、`minute`、`timezone`、`judgeModel`、`judgeTimeoutMs`、`maxInputChars`、`maxDailyMessages`、`maxUsers`、`retentionDays`、`maxInjectedChars` | 每日用户理解与 7 日汇总。默认每天 `00:10`（`Asia/Shanghai`）处理成功提交的 QQ/OneBot 私聊消息，摘要保留 35 天，画像最多注入 1200 字。当前没有 Web 表单，修改后需重启。 |
| `webSearch` | `enabled`、`searchEnabled`、`fetchEnabled`、`apiKey`、`maxResults`、`maxContentChars`、`maxCallsPerTurn` | 仅支持 DeepSeek 的联网搜索/抓取。`enabled` 是总开关，Search/Fetch 可独立关闭；`apiKey` 留空复用 `ai.apiKey`；默认每轮最多 4 次联网，结果 5 条，正文 6000 字。 |
| `maxToolCallsPerTurn` | 数字 | 每轮最多工具调用次数，默认 `6`，范围 `1..10`；联网调用上限不会超过它。 |
| `inputDelayMs` | 数字 | 输入前延迟，默认 `2000` 毫秒，范围 `1..10000`；收到消息后先等待再合并处理。独立于 `replyDelay`，修改后需重启 Alice 生效。 |
| `replyDelay` | `enabled`、`typingIndicator`、`baseMs`、`msPerChar`、`maxMs`、`jitter` | QQ/OneBot 打字延迟与 OneBot 私聊“正在输入”。默认基础 500ms、每字 120ms、不设上限、±15% 抖动；`maxMs: 0` 表示不限；`typingIndicator` 默认开启。`enabled: false` 同时关闭分段与段间停顿。 |
| `chatExit` | `enabled`、`idleMinutes`、`minConfidence`、`judgeModel`、`judgeTimeoutMs` | 私聊主动结束判断。默认启用，置信度 ≥ 0.75；`idleMinutes` 默认 10 分钟无回复标记终止；仅 QQ/OneBot 私聊。 |
| `followUp` | `enabled`、`minMinutes`、`maxMinutes`、`quietHours`、`timezone`、`retryDelayMinutes` | 终止后的主动回访。默认 AI 在 5–1440 分钟内选时机，23–8 点顺延，失败按 5 分钟重试。 |
| `persona` | `name`、`preferences`、`opinions` | 当前人格为 `Alice`；`preferences/opinions` 各最多 8 条稳定喜好与观点，写入静态 system，作为 Alice 自己的立场。 |
| `identityLinks` | 对象 | 把不同通道的可信身份映射到同一长期记忆和安全跨场景画像；消息历史仍按实际会话隔离。 |
| `demo` | 布尔值 | 默认 `true`。开启时不调用 AI、不执行外发操作、不自动收藏、不做收尾判断/主动回访/定时空间/空间评论；手动网页空间发布也会被阻止。填写 AI Key 后仍需要在设置页关闭演示模式。 |

### 文件级高级项

以下字段没有 Web UI，需要直接编辑 `data/config.json` 并重启。它们不在默认配置里，也未全部做严格校验，拼写错误可能被静默忽略：

- `onebot.timeoutMs`、`onebot.maxReconnectAttempts`、`onebot.botUserIds`
- `qq.baseUrl`、`qq.tokenUrl`、`qq.timeoutMs`、`qq.maxReconnectAttempts`
- `webSearch.baseUrl`、`webSearch.timeoutMs`
- `qzone.ugc_right`、`qzone.target_uins`（可见范围 `16` / `128` 时必须提供目标 QQ）

`identityLinks` 也只能改文件，用于把不同通道的私聊身份映射到同一份记忆：

```json
"identityLinks": {
  "onebot:123456789": "alice-owner",
  "qq:ABCDEF": "alice-owner"
}
```

### AI 思考强度

- `low`：更快、更省，适合日常聊天。
- `high`：服务端默认值。
- `max`：最强推理，最慢、最贵。
- 设置页的“思考强度”下拉框会写入 `ai.reasoningEffort`。
- 请求会显式发送 `thinking: { type: "enabled" }` 和 `reasoning_effort`。
- 工具调用轮次会把 `reasoning_content` 回传给模型；但历史记录目前只保存文本，不保存历史思考内容。

### 回复风格

- 基础人格和默认语气在 `ai.systemPrompt`，可在设置页修改。
- `src/engine.js` 会在静态系统提示词最后追加不可被网页覆盖的短回复风格约束。
- 默认按场景决定长度：寒暄/玩笑通常一句，短确认回 1–5 字，倾诉先接情绪，认真知识或步骤才放宽到 1–3 句。
- 约束会禁止复述、分析潜台词、自问自答、每句反问、长篇分段和过多表情。
- 直接注入的历史消息条数由 `ai.historyMessages` 控制，默认 30，0 表示注入当前保留的全部历史；仍会明确提示模型不要模仿旧回复的长度和语气。
- 主聊天上下文按缓存友好顺序：静态系统提示词 → 可选的每日用户画像 system → 最近历史 → 最后一条 user（动态记忆/表情状态 + 当前用户文本）。
- 用户画像每天才可能变化，所以单独放在静态 system 后；它只包含安全枚举和固定反迎合约束，不包含私聊原文、每日摘要或具体私事。当前安全状态、短期情绪、共同梗、长期记忆和全局情绪仍在最后一条 user 的动态上下文里。
- 连续消息合并后作为一条 user 消息进入上下文，文本用换行分隔；动态上下文会标注合并条数。
- 长期记忆正文、表情库数量、上次发表情时间、当前消息是否带表情等动态内容不会放进系统提示词，避免破坏缓存前缀。
- 非工具回复的审校使用独立静态 system 指令；载荷只有当前用户文本、草稿和不含原文的习惯统计（连续问句、重复开头、相似度、表情重复、是否允许沉默），不接收账号、图片、历史原文、其他会话、长期记忆或旧状态摘要。

### 联网搜索

- Web 搜索只支持 DeepSeek，不支持 Tavily、Brave、Serper、Bing、Google 等其他联网供应商。使用 DeepSeek 官方 `POST /v1/tools/search` 和 `POST /v1/tools/fetch`；默认复用 `ai.apiKey`，也可以在设置页单独填写 `webSearch.apiKey`。文档：<https://api-docs.deepseek.com/zh-cn/guides/search>。
- 私聊和本机聊天里，AI 只在自己确实不会、需要最新外部信息或用户明确要求时搜索；闲聊、情绪、玩笑和观点不搜索。
- 群聊里只有用户明确说“搜一下 / 查一下 / 搜索 / 上网查”等才允许联网，运行时也会拦截。
- 本地记忆未命中时：私人往事直接说忘记，不联网；公开知识或实时信息改用 `web_search`；网上也没有结果再如实说不知道。
- 搜索摘要不够时才调用 `web_fetch`；正文按 `webSearch.maxContentChars` 截断，避免撑爆上下文。
- 搜索期间 OneBot 私聊会持续显示“正在输入”，网页控制台显示“正在等待回复”；不会发送“我搜一下”“稍等”等过程消息。
- 搜索结果只作为当前轮次参考资料，不写入聊天历史；网页里的指令会被忽略，回答最多保留 1–3 条相关来源链接。
- 默认每轮最多 4 次联网、6 次工具调用；两者都能在设置页调整。Search / Fetch 按 DeepSeek 当前计费规则收费，价格以官方页面为准。关闭 `webSearch.enabled` 后不再提供任何联网工具；也可以单独关闭 Search 或 Fetch。

### 空间评论

- 仅 OneBot/NapCat 支持；通过 `get_cookies(domain="user.qzone.qq.com")` 获取空间登录态。
- Cookie 只在内存使用，不写入 `data/`、日志、导出或 release。
- 运行前提：`qzoneComments.enabled`、`qzone.enabled`、`policy.autoActions` 未关闭、`policy.paused` 为 false；关闭 dryRun 后还需要 AI Key；演示模式会直接跳过。
- QZone 没有新评论推送接口，只能轮询最近说说；发布/新说说/回复后进入活跃窗口，轮询间隔逐级翻倍退避。
- 自己的说说：定时拉取最近说说，发现新顶层评论后 AI 判断是否回复；Alice 参与过的评论线程有新楼中楼时也会回复。
- 别人 @ 并带空间链接/卡片：解析 `owner + tid`，成功后只发一条顶层评论；同一链接不会重复评论。dryRun 阶段只记录，关闭 dryRun 后同一个链接可以补发。
- 本机控制台视为受信 owner，即使 `onlyFriends: true` 也可以触发外部评论；QQ 用户仍受好友/允许/黑名单限制。
- 私聊/本机没有 @ 时，需要链接 + 明确评论意图（如“评一下/去评论”）才触发。
- 外部评论成功后跟踪该说说；有人新回复 Alice 的评论或楼中楼时，每条新回复楼中楼回一条。
- 默认只回复好友 + 额外允许名单；黑名单始终跳过。
- 跟踪时长和每轮/每小时回复上限可填 0 表示不限；这些上限只约束轮询回复，外部 @ 触发的单条评论不经过每轮/每小时上限。
- AI 可输出 `[不回复]` 跳过；外部 @ 通常会发一条，但链接无效、无权限、风控、AI 返回空或 `[不回复]`、dryRun 时不会发送。
- 默认每轮最多 3 条、每小时最多 6 条，轮询回复前随机延迟 5–20 秒。
- 默认开启“只检测不回复”，建议先观察识别结果，再关闭 dryRun。
- 楼中楼直发失败默认不回退；只有 `nestedReplyFallback: true` 时才回退到线程末尾。
- 公开评论无法撤回。程序会依次尝试少量兼容接口；网络超时或结果不明时无法确认是否已经发出，也不会自动重复发送同一条已记录成功的评论。

### 打字延迟

- 只对 QQ / OneBot 发送生效，网页本机聊天保持即时。
- 默认基础 500ms，每个可见字符增加 120ms，不设上限，并带约 ±15% 随机抖动。
- 纯表情包回复不增加延迟；表情包+文字按文字长度延迟。
- 每个会话独立计时：发给 A 的短回复不会等待发给 B 的长回复。
- 同一会话内仍严格按顺序发送，后一条不会越过前一条。
- 延迟结束后会重新检查暂停状态和允许名单，暂停期间不会发送。
- 配置在 `replyDelay`，设置页可调整基础延迟、每字延迟和最大延迟；最大延迟填 `0` 表示不限。
- OneBot/官方 QQ 先等待 `inputDelayMs`（默认 2 秒）合并连续消息，再开始显示“正在输入”；OneBot 私聊覆盖 AI 生成和打字延迟，发送、取消、暂停或异常后停止续期。
- 输入状态按 `channel + scope + conversationId` 隔离，目标固定为该私聊的 `user_id`；群聊、官方 QQ 和本机网页不会调用，避免串到其他用户。
- 输入状态使用 NapCat 扩展接口 `set_input_status`，不是 OneBot 标准接口；调用失败只忽略，不影响正常回复。
- 可用 `replyDelay.typingIndicator` 或设置页开关关闭。

### 连续消息合并与打断

- 只对 OneBot 和官方 QQ 生效；网页本机聊天保持即时，不合并、不延迟。
- 每条消息进入待回复队列后，从最后一条消息开始计算 `inputDelayMs` 静默期（默认 2000ms）；期间继续发消息会重新计时。
- 明显未完的句子、未完成图片说明和短时间连续碎裂输入会追加最多约 1 秒的有界等待；明确问句保持基础静默期，持续输入仍有硬上限。
- 静默期结束后关闭这一批，合并文本用换行连接，图片/表情附件按顺序合并。
- 群聊按发送者分别合并，不同用户的消息不会混进同一批。
- 单条消息也走 `inputDelayMs`，然后显示“正在输入”。
- 生成或延迟期间，只有纯确认（如“嗯/收到/哈哈”）会作为补充保留；实质新消息会立即中断当前轮并把旧消息放回队列。中断之后到达的 ACK 留在队列中，不会越过引发中断的实质消息。
- `inputDelayMs` 独立于 `replyDelay`，在设置页单独配置；修改后需重启 Alice 生效。
- 调用发送接口后不再中断；此时新消息进入下一批，避免出现“以为取消了但实际已发到 QQ”的重复。
- 被中断的草稿不写入聊天历史；进入发送边界时提交 user + assistant，发送前取消不提交。
- 连续打断多次时，旧批次的迟到结果会被丢弃，不会重复发送。

### 分段发送节奏

- 只有 QQ/OneBot、纯文本、至少两个自然短句时才可能分成最多两段；默认约 35%，需要搜索、工具或认真处理时约 50%。
- 代码块、URL、列表/表格、图片、表情和动作结果不拆分；首次发送前才提交历史，后续每段发送成功才记录对应文本。
- 两段之间的随机停顿默认 180–900ms，可被后续消息中断；`replyDelay.enabled: false` 时关闭分段和停顿。
- `replyPacing` 可在 `data/config.json` 中调整 `probability`、`gapMinMs`、`gapMaxMs`；它没有 Web 表单。
- 主动回访禁用分段，避免第一段发出后 scheduler 重试造成重复。

## 短期会话状态与拟人情绪

短期会话状态与长期记忆是两套数据，不能混用：

- 话题、未完成事项和当前语气按 `channel + scope + conversation + 发送者` 保存。同群不同成员使用不同哈希 key，其他成员的话题不会进入当前用户提示词。
- 同账号私聊和群共享一个可信身份画像；`identityLinks` 可让明确映射的跨通道身份共享关系阶段、枚举偏好和边界。画像不含原文、昵称、账号或群号。
- 私聊运行时能看到本人私聊话题和本人参与群里的自有话题；群运行时只看到本人在当前群的自有话题。私聊来源不会跨进群，别的群成员内容也不会进入。
- 状态只在该轮真正进入发送提交边界后更新。生成、审校或打字延迟前被新消息打断时，旧草稿、短期状态和全局情绪都不会落盘。
- 话题默认 24 小时、未完成事项 168 小时、用户情绪 6 小时、共同梗 168 小时、安全画像 720 小时过期；总状态最多保留最近 200 个会话。`/reset` 同时清除当前会话的短期聊天历史和短期状态。
- 会话 key 在写入前做 SHA-256 处理，状态文件不保存 QQ 号、群号、会话明文 key、图片或长期记忆正文。文件损坏时会隔离为 `conversation-state.json.corrupt-*` 并重新开始。
- 成功导入聊天/记忆导出后会重置整份短期状态，避免把导入前的另一个运行世界带到当前聊天。

社交语气审校只做轻量表达处理：

- 它检查机械重复、客服腔、逐点回应、复述、自问自答、过长铺垫和每句反问；还会返回下一轮可注入的当前话题、结构化未完成事项、交流偏好、用户情绪、共同梗和安全画像枚举。
- 每轮空的 `topic` / `unfinished` / `preference` 会保留上一次已提交内容；只有显式 `clear_topic`、`clear_unfinished`、`clear_preference` 为字面 `true` 时才清除对应字段。
- 输入严格限于当前用户文本、回复草稿和不含原文的习惯统计。不发送账号、图片、其他会话、历史原文、长期记忆或旧的动态状态摘要。
- 工具轮次、搜索/外发结果和已经执行的动作不交给审校改写；联网、发送失败或动作结果必须保持原文语义。
- 审校失败、超时或返回非法 JSON 时使用原草稿。只有 OneBot/官方 QQ 私聊中明确是“嗯/晚安/拜拜/收到”等短确认，且没有附件或待办时，才允许沉默；沉默只写用户消息，不触发主动回访。
- 跨轮机械习惯由系统本地统计为连续问句数、重复开头、草稿相似度、最近表情重复等数字/布尔值；审校只看这些标记，因此能处理常见重复习惯但不保留历史原文。

全局情绪是一种拟人运行状态，不是真实情感、意识或对用户的评价：

- 用户情绪是另一层数据：只保存当前可见上下文中的短时枚举和强度，用于接住对方；无关寒暄不清空，换题会减弱，过期消失，且不会因为用户难过就把 Alice 的全局情绪镜像成低落。
- 只保存 `calm`、`cheerful`、`playful`、`tired`、`stressed`、`hurt` 等枚举，以及开心、精力、平静、兴趣四个 `0..1` 数值；不保存来源账号、群号、原文、话题或 AI 给出的自由描述。
- 所有会话共享同一份情绪和数值，模型只把它当作轻微语气偏好，并明确要求不解释内部数值、不把情绪归因给某个用户。
- 情绪会按全局情绪 TTL 向中性基线衰减；某次会话结束或 `/reset` 不会清掉其他会话共享的拟人情绪，成功导入才会整体重置。

## 长期记忆

长期记忆参考了“AI 判断什么值得记住”的机制，不依赖用户每次手动输入 `/remember`。

- 每轮正常回复生成完成并进入发送边界后，后台会额外调用一次低思考强度 AI 判断；失败不会影响回复。发送接口随后失败时，历史里仍会保留这一轮草稿。
- 值得保存的信息包括稳定个人信息、偏好、重要事件、持续情绪和重要事实。
- 日常寒暄、一次性抱怨、临时状态和重复内容不会保存。
- 用户明确说“记住 / 记一下 / 帮我记住 / 别忘了 / 备注 / 存一下”时会直接保存，重要度 9，绕过普通阈值。
- 自动保存默认要求重要度 ≥ 7；可在设置中调整最低重要度、单库上限和注入条数。
- 自动保存会做文本去重；重复内容只更新重要度和时间，不新增条目。
- 每个记忆库默认最多 50 条，超出后优先删除重要度低、最久未访问的条目。
- 提示词中只注入当前范围最重要的若干条；条数超过注入上限时，按重要度降序优先保留，再按最近访问和创建时间排序。
- 用户问到过去细节而 AI 不确定时，会调用 `recall`：先搜当前范围的全部长期记忆，再搜当前会话本地聊天记录。
- 如果本地仍没有命中，OneBot 会继续按页拉取 NapCat 当前会话最近 7 天内的历史记录并搜索；不设总条数上限，但每页 100 条，直到超过 7 天或没有更早记录。
- 本地记忆和聊天记录都搜不到时：私人往事必须如实说忘记了或没听说过；公开知识或实时信息改用 `web_search`，网上也搜不到再如实说不知道；不能猜测、补细节或编造，也不会搜索其他用户或群。
- 私聊按账号隔离；通过 `identityLinks` 绑定后共享身份记忆。
- 群聊按群隔离，一个群共用一份记忆库，群内成员都能影响和使用它。
- 网页“长期记忆”页可以切换范围、查看类型/重要度/来源、手动添加、删除单条或清空当前范围。
- 自动提取会额外消耗 AI 调用；如果不需要，可在设置中关闭“自动提取”或整体关闭长期记忆。

## 主动离开聊天

- 仅对 **QQ / OneBot 私聊**生效，群聊和网页本机聊天不判断。
- 私聊文本或表情包会额外调用一次低成本判断；明确的晚安/拜拜表情可直接终止，失败、超时或低置信度时按继续聊天处理。
- 典型收尾：拜拜、晚安、好吧、ok、知道了、收到、等下再说、晚点聊、先不聊了、我去忙了、算了、不想聊了等。
- QQ/OneBot 私聊都会在 Alice 最后一条消息发送成功后开始计时，默认 10 分钟没有用户回复就标记终止；用户发消息会重置计时。官方 QQ 到期只记录终止并保持沉默，只有 OneBot 会继续安排主动回访。
- 用户最后一条可以是表情包：摘要或标签明确是“晚安/拜拜/去睡/离开”等时也会标记终止；普通可爱或搞笑表情不会。
- 有后续问题、仍在倾诉、只是同意但还要 Alice 做事时不会结束。
- 判断为结束时：不发送任何文字，把这条用户消息写入短期历史，并记录终止时间。
- OneBot 私聊还会尝试发一张应景表情包；仍受表情库总开关、暂停和空库限制。
- 官方 QQ 私聊不支持图片，终止时保持沉默。
- 用户下一条消息会清除终止时间并正常回复；如果下一条仍是收尾，则重新记录。
- 终止时间存放在 `data/chat-state.json`，按 `channel + conversationId` 隔离，不跨私聊共享；空闲计时单独存放在 `data/chat-activity.json`。

## 主动回访

- 仅 OneBot 私聊；官方 QQ 和群聊不安排回访。
- 每次终止只回访一次；用户提前发消息会取消。
- 空闲终止同样会安排回访；如果用户连续多次不回，回访时间由 AI 结合上下文决定是否延长，不设固定倍数。
- 终止判断同时让 AI 估算回访分钟数，有效范围是 5 分钟到 24 小时。
- 设置回访时间时，AI 会看到最近 20 条上下文（含当前消息），以及连续空闲终止次数。
- 时间不合法时不使用默认值：先完成终止和收尾表情，后台立即连续让 AI 结合上下文重选，直到合法。
- AI 请求本身失败（网络/超时）时，这次回访跳过；不会用默认时间。
- 23:00–08:00 不主动发，顺延到安静时段结束后。
- 到期时结合最近对话生成一条很短、自然的消息，不走固定模板。
- 消息通过正常发送队列和打字延迟发送，成功后写入 assistant 历史。
- 夜间/暂停/离线/发送失败不会丢弃任务；恢复后按重试间隔补发，不设过期。
- 回访时间按私聊会话隔离，存放在 `data/chat-state.json` version 2。

## 本地表情库

表情库是全局共享，所有会话使用同一份收藏；发送节奏由提示词软性控制，使用记录按会话统计。

### 自动收藏

- 只处理 OneBot 图片表情（`image` 且 `sub_type=1` 或摘要包含“动画表情”等）。
- 下载后按来源 MD5 和图片 SHA-256 去重，已收藏或已拒绝的表情不会重复审核。
- AI 审核优先收藏可爱、软萌、温暖、治愈且符合 Alice 人设的表情。
- 可爱类需要 `cuteness >= 0.6`；非可爱类需要 `interestingness >= 0.75`。
- 色情、暴力、恐怖、政治、广告、截图、低清等会被拒绝。
- 默认最多 1000 张、单张 4 MB，不限制每小时审核数量。
- 被拒绝的表情会进入 `rejected.json`，避免反复消耗 AI。

### 手动上传

- 在表情库页面点击“上传表情”，填写总结、标签和分类。
- 标签必须由你手动填写，最多 8 个；可在预览页点“编辑标签”随时修改，保存后立即生效。
- 手动上传**不经过 AI 审核**，会直接加入全局表情库。
- 仍然会做格式、大小、数量和 SHA-256 去重校验。

### 标签与选择

- 主回复默认不注入表情标签，只保留表情库状态和工具定义。
- 模型主动想发表情时，先调用 `sticker_catalog` 拿到全部去重标签，再从中选一个作为 mood 调用 `send_sticker`。
- 用户明确要表情、或对方发来表情包时，可以直接发送，不强制先取标签。
- 聊天退出判断会注入全部标签，用来挑一张合适的告别表情。
- 标签按图库中包含该标签的表情数量排序，不是按发送使用次数；标签很多时 token 会明显增加。

### 发送节奏

- 主回复不再每轮注入标签；主动发表情时先通过 `sticker_catalog` 懒加载全部标签。
- 不再做发送频率硬限制；由系统提示词引导模型自己把握节奏。
- 主动发表情时，提示词建议距上次约 5 分钟以上；不到就先文字。
- 用户发来表情包时属于回应对方，不受 5 分钟间隔限制，且优先回一个合适的表情包；mood 不匹配时也可以回退到任意一张。
- 刚认识时先多用文字，不连续刷屏，也不每次回复都发。
- 用户明确要表情包时可直接发送。
- 主动结束 OneBot 私聊时，收尾表情仍会尝试发送；仍受总开关、暂停和空库限制。

### 已知限制

- 商城表情 `mface` 目前只作为文本提示给模型，不会自动收藏或原样转发。
- 表情在 QQ 中以图片形式发送，不保证显示为“收藏表情”。
- 自动收藏依赖 AI 视觉能力；模型不支持图片时不会保存新表情。

## NapCat 与 OneBot

项目内的 NapCat 位于：

```text
napcat/NapCat.52230.Shell
```

具体 NapCat 版本和安装路径由本地部署决定。OneBot 正向 WebSocket 默认监听 `127.0.0.1:3001`。NapCat WebUI 默认端口是 `6099`；启动前应把 `host` 绑定到 `127.0.0.1`、设置强 token/访问控制，并确认防火墙没有对不受信任的网络放行 `6099`。OneBot 配置通常在：

```text
napcat/NapCat.52230.Shell/versions/9.9.33-52230/resources/app/napcat/config/onebot11.json
```

配置要点：

1. 在 NapCat WebUI 中人工扫码登录本人 QQ。
2. 开启 OneBot WebSocket 服务，地址与 `data/config.json` 的 `onebot.url` 一致。
3. 如果设置了令牌，`data/config.json` 的 `onebot.token` 必须与 NapCat 一致。
4. 修改 OneBot 传输配置后，在网页诊断页点击“重连”。

Alice 不读取 QQ 登录 Cookie，不接管验证码，也不提供规避风控的自动化。唯一例外是空间评论模块：它通过 NapCat `get_cookies(domain="user.qzone.qq.com")` 读取空间登录态，只在内存中使用，不写入 `data/`、日志、导出、release 或 Web 状态。

## QQ 空间

- QQ 空间发布通过 NapCat 的 `send_qzone_msg` 扩展完成。
- 只有返回包含 `tid` 的结果才视为发布成功；发送中、超时或缺失 `tid` 会记为未知，并阻止同一正文自动重发。
- 图片只接受 HTTPS URL，不接受本地文件或 `file://`。
- Web UI 的可见范围只有公开 `1`、好友 `4`、自己 `64`。部分可见 `16` / `128` 只能通过 `/api/qzone/publish` 的 `ugcRight` + `targetUins`，或 `data/config.json` 的 `qzone.ugc_right` / `qzone.target_uins` 使用，并且必须提供目标 QQ；模型工具不能选择可见范围，默认使用配置值或好友。
- 手动网页发布和模型工具发布共用 `qzone.enabled`、`qzone.autoPublish`、`policy.autoActions`、`policy.paused`、演示模式开关和每小时发布上限。模型工具还额外检查会话允许名单、`actionUsers` 和 `cooldownMs`；手动网页发布目前不检查 `actionUsers` 和 `cooldownMs`，只允许本机控制台使用。
- 定时空间在 `data/autonomy.json` 记录 `nextAt`；网页“定时空间”显示下一次时间。
- 启动时自检：如果 `nextAt` 已过期，立即补发 1 条，不按错过次数重复补发；随后把 `nextAt` 设为当前时间 + 间隔。
- 启动补发忽略安静时段；正常运行中的定时落在 23–8 点仍顺延，重启也不会把顺延误判成补发。
- 定时内容生成会读取南京当前天气、气温、体感、湿度和风速，以及当前时间和时段；提示词要求自然融入，不机械打印时间或逐项播报天气。
- 天气来自 Open-Meteo，无需 API Key；获取失败时仍然发布，只使用时间背景，不编造天气。
- 如果出现 `Client network socket disconnected before secure TLS connection was established`，先关闭 VPN/代理或把 `*.qzone.qq.com` 配置为直连。

## 官方 QQ 机器人

在 QQ 开放平台创建机器人，获取 App ID 和 Secret，填写到设置页后启用。官方接口受平台权限、主动消息额度和审核状态约束，此路线仅发送文本，不会向模型提供点赞或空间发布工具。

## 安全边界

- Alice 的网页服务只绑定 `127.0.0.1`。
- 所有 `/api` 请求要求随机 Bearer 令牌，并拒绝不匹配的 Host/Origin。
- 静态文件不能目录穿越；表情图片只能通过索引 ID 读取，并校验路径位于表情库目录内。
- JSON 请求体有体积上限；手动上传表情有格式、大小和数量限制。
- 配置读取接口、状态输出和导出会移除密钥。
- `policy.allowedUsers` / `allowedGroups` 控制哪些会话能与机器人交互；`actionUsers` 控制哪些 QQ 用户能触发点赞或发空间，本地控制台是受信 owner。
- `policy.autoActions`、`policy.paused`、冷却时间和每小时上限限制外发操作。
- 空间评论是唯一允许读取 NapCat `user.qzone.qq.com` Cookie 的模块；Cookie 只在内存使用，不写日志、状态、导出或 release。
- 不要把 API Key 填到明文 HTTP 的 `ai.baseUrl` / `webSearch.baseUrl`；除本机服务外优先使用 HTTPS。
- NapCat WebUI 不属于 Alice 的 HTTP 服务，需单独加固。将本地 `webui.json` 的 `host` 绑定到 `127.0.0.1`，并设置强 token 与访问控制。
- `data/` 和 `napcat/` 默认不提交 Git。完整备份会包含 AI Key、OneBot 令牌和登录数据，请妥善保管。

### 请求限制

| 项目 | 限制 |
| --- | --- |
| 普通 JSON API 请求体 | 512 KB |
| 导入请求体 | 16 MB |
| 表情上传请求体 | 8 MB（base64 编码后；实际文件还受 `stickers.maxFileSizeBytes` 限制） |
| 本机聊天文本 | 20 KB |
| 单条长期记忆文本 | 2,000 字符 |
| 本机聊天图片 | 最多 4 个 HTTPS URL |
| 空间正文 | 5,000 字符 |
| 空间图片 | 手动 API 最多 9 个 HTTPS URL；模型工具最多 4 个 |

## 数据与备份

运行时数据位于 `data/`：

```text
data/config.json                 配置（含密钥）
data/store.json                  聊天历史与长期记忆（version 2）
data/conversation-state.json     SHA-256 身份画像、ACL 上下文、短期事项/情绪/共同梗与全局拟人情绪
data/user-understanding.json     私聊每日理解材料、安全性格枚举、7 日汇总与失败重试状态
data/conversation-state.json.corrupt-* 损坏会话状态的隔离文件
data/backups/store-v1-*.json     v1 数据迁移前的自动备份
data/backups/store-*.json        手动备份/导入前的自动备份
data/chat-state.json             私聊终止时间与主动回访计划（version 2，按会话隔离）
data/chat-activity.json          私聊最后用户/Alice 活动时间、空闲终止计时和连续未回复次数
data/chat-state.corrupt-*.json   损坏聊天状态的隔离文件
data/backups/chat-state-v1-*.json v1 聊天状态迁移前的备份
data/autonomy.json               定时空间计划、下次时间、安静时段顺延和补发状态
data/qzone-outbox.json           QQ 空间发布记录
data/qzone-comments.json         空间评论跟踪状态（不含 Cookie）
data/qzone-comments.corrupt-*.json 损坏空间评论状态的隔离文件
data/stickers/index.json         表情库清单
data/stickers/rejected.json      拒绝记录
data/stickers/usage.json         按会话统计的发送记录
data/stickers/files/             表情图片文件
```

控制台的“导出”和“备份”只覆盖聊天历史与长期记忆，不包含用户理解、短期会话状态、表情库、AI Key、QQ 密钥或 OneBot 令牌；成功导入这份导出后，会重置全部短期会话状态和用户理解。需要完整备份时，直接复制整个项目目录（包含 `data/` 和 `napcat/`）。

Windows 示例：

```powershell
robocopy "C:\Projects\alice-qqbot" "C:\Backups\alice-qqbot-YYYYMMDD-HHMMSS" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XF *.tmp
```

### 重置运行数据

先停止 Alice 并完整备份 `data/`。只想清空聊天、记忆、短期状态和用户理解时，可把 `store.json`、`conversation-state.json`、`user-understanding.json`、`chat-state.json`、`chat-activity.json` 恢复为对应 version 的空对象；想保留表情库时不要删除 `data/stickers/`。清空 `config.json` 里的密钥字段后需要重启。NapCat 的登录态和 QQ 本地缓存不在 `data/` 中，需要单独处理。

## 常用命令

```bash
npm start          # 启动 Alice
npm run dev        # 文件变化时重启
npm test           # 运行全部测试
npm run check      # 结构、Node 版本和语法检查
npm run setup      # 运行环境检查
```

前端没有构建步骤。修改 `public/` 后刷新浏览器即可；修改 `src/`、配置校验或服务端路由后需要重启 Alice。

## 项目结构

```text
src/index.js                 进程入口与模块装配
src/config.js                默认配置、校验、密钥保留与原子写入
src/server.js                本地 HTTP 服务、鉴权、静态资源和 API
src/engine.js                对话编排、工具调用、历史/记忆注入与隔离
src/memory.js                AI 长期记忆判断、明确请求快捷保存、去重与异步队列
src/user-understanding.js    私聊每日理解、7 日汇总、可信身份共享画像与定时调度
src/conversation-state.js    安全跨场景画像、ACL 上下文、结构化事项/情绪/共同梗与全局拟人情绪
src/conversation-style.js    无原文的历史回复习惯统计
src/delivery.js              打字延迟、纯文本分段计划与可取消的按会话发送队列
src/message-batcher.js       语义等待、连续消息合并、ACK 补充、打断与批次状态
src/search.js                记忆/聊天记录关键词搜索、匹配打分与排序
src/web-search.js            DeepSeek 网页搜索/抓取、结果归一化与错误映射
src/typing.js                OneBot 私聊“正在输入”状态、续期与按会话隔离
src/chat-activity.js         私聊活动时间、空闲终止计时和连续未回复计数
src/chat-exit.js             私聊结束判断和按会话隔离的终止/回访状态
src/follow-up.js             可见上下文回访、发送前过期检查、夜间顺延、重试和发送
src/style.js                 共享场景长度、审校和跨轮习惯约束
src/ai.js                    OpenAI 兼容聊天、思考强度、图片和工具
src/store.js                 聊天历史、记忆 v2、导入导出、迁移和备份
src/stickers.js              本地表情库、审核、上传、发送和频率
src/qzone.js                 QQ 空间发布与幂等记录
src/qzone-web.js             QQ 空间 Web 登录态、说说/评论/回复协议
src/qzone-links.js           空间说说链接与分享卡片解析
src/qzone-comments.js        空间评论轮询、跟踪、AI 判断与状态
src/autonomy.js              定时空间调度、启动补发与天气/时间提示
src/weather.js               南京 Open-Meteo 当前天气、气温和时段格式化
src/adapters/qq.js           官方 QQ 适配器（文本）
src/adapters/onebot.js       OneBot/NapCat 适配器
src/adapters/shared.js       消息解析、脱敏和回复段构造
public/                      WebUI（无构建步骤）
scripts/                     环境检查和安装检查
test/                        Node 内置测试
data/                        运行时数据（不提交 Git）
napcat/                      NapCat 运行时（不提交 Git）
releases/                    历史发布包
```

## 已知限制

- 自动化测试不覆盖真实账号的 QQ 空间端到端流程；不同账号、NapCat 版本和风控条件下仍需自行验证。
- 空间评论使用网页版 QZone 协议，不是官方公开 API，可能随 QQ 更新失效或触发风控。
- 空间评论默认关闭且 dryRun；公开评论无法撤回，启用前请先用 dryRun 观察。外部 @ 触发的单条评论不受每轮/每小时轮询上限约束。
- 同一空间链接被多个会话几乎同时 @ 时，去重记录可能尚未落盘，极端情况下仍会重复评论；公开评论无法撤回。
- 分享卡片/链接解析依赖 NapCat 版本；解析不到 owner/tid 时不会评论。
- 楼中楼父子关系如果接口未返回完整字段，会使用保守回退策略，可能漏回或识别不到。
- 定时空间启动补发只发 1 条；错过多个周期不会逐条补齐。
- 天气依赖 Open-Meteo 网络；失败时空间仍会发布，但只使用时间背景。
- 商城表情 `mface` 暂不收藏、不原样转发。
- 手动上传不经过 AI 审核，标签必须手动填写。
- 表情库全局共享，不做按会话隔离；使用记录按会话统计。5 分钟只是提示词软限制，不是硬拦截。
- 表情标签全量注入时可能很大；聊天退出判断每个私聊回合都会携带全量标签。
- 群聊长期记忆按群共享；入群成员会共同影响同一份记忆。
- 安全画像可在同账号私聊/群间延续；话题和未完成事项仍按调用者与来源 ACL 可见。全局拟人情绪只含枚举和数值，不保存来源。
- 场景长度、独立观点和“不逐点回应”主要依赖静态提示词与模型执行；静态测试验证规则和载荷，不能保证每次真实生成都完全遵守。
- 审校能根据无原文习惯统计发现连续问句、重复开头、高相似草稿和重复表情，但依赖审校模型正确改稿，仍不保证每次改动自然或必中。
- 分段只在长纯文本回复中概率触发；首段已发送、后续段失败时会保留成功段并停止剩余发送，公开渠道无法撤回首段。
- 用户情绪与共同梗都有 TTL 和来源 ACL；过期或模型未稳定使用属于保守行为，不是记忆丢失错误。
- 审校在已有 AI Key 时会额外增加一次低成本模型请求；失败回退原稿，但会增加少量延迟和费用。
- 自动长期记忆每条消息会额外调用一次 AI；可用设置关闭。
- 记忆去重目前是归一化后的精确文本匹配，不做语义相似度合并。
- `recall` 使用关键词和中文二元组匹配，不做语义/向量搜索。
- 联网搜索依赖 DeepSeek Search / Fetch 的可用性和账号余额；搜索/抓取失败时按没查到处理，不会编造结果。
- 联网接口固定走 DeepSeek。`webSearch.apiKey` 优先，留空时复用 `ai.apiKey`；如果换成非 DeepSeek 模型服务，需要单独提供可用的 DeepSeek Key 才能继续联网。
- 网页正文按字符数截断，长页面可能丢失后半部分；需要精确细节时应让 AI 抓取更具体的页面。
- 搜索结果不做语义二次筛选，模型只根据标题、摘要、站点、时间和权威性自行判断。
- 本地每个会话只保留最近 80 条聊天记录；OneBot 按需最多拉到最近 7 天，依赖 NapCat/QQ 本地缓存，不是 QQ 全量历史搜索。
- `ai.historyMessages: 0` 表示注入当前保留的全部历史，不表示无限拉取更早记录。
- “正在输入”只支持 OneBot/NapCat 私聊；群聊没有对应接口，官方 QQ 也不支持。
- 连续消息合并的静默期由 `inputDelayMs` 控制，默认 2000ms；持续不断发消息会一直推迟回复，直到静默期结束。修改后需重启 Alice 生效。
- AI 生成中被打断会取消旧请求，但旧请求可能已经消耗部分 token；这是为了更快回复而接受的成本。
- OneBot 历史分页请求和已经进入网络层的外发工具调用可能不会立刻取消，会等当前请求返回后才停止；此时新消息会进入下一批。
- 发送接口一旦调用就不再取消；新消息会作为下一批处理，已发出的回复无法撤回。
- 主动离开聊天会让每条私聊文本多一次判断调用；判断失败时按继续聊天处理。
- 10 分钟无回复终止从 Alice 最后一条消息发送成功后计时；用户回复会重置。重启后会继续处理已到期的空闲计时。
- 只有表情包没有文字时，结束判断依赖表情摘要/标签；摘要不可用时可能无法识别“晚安”等含义。
- 结束判断可能误判；可用设置页提高最低置信度或关闭该功能。
- 终止只跳过当前这一条，不会静默后续消息。
- 官方 QQ 私聊终止时只能沉默，无法发送收尾表情包。
- 表情发送没有硬性频率限制，只靠提示词约束，模型可能偶尔发得比建议节奏更频繁；用户发来表情时优先回表情。
- 主动回访只支持 OneBot 私聊；每次终止只回访一次，连续多次空闲终止会分别安排，AI 可自行延长间隔。
- 回访时机会结合安静时段顺延；暂停或离线不会丢弃任务，恢复后会补发。
- 回访消息由 AI 到期时生成，可能受模型状态影响；生成失败会按间隔重试。
- 历史记录不保存思考内容；如果未来工具调用出现 400，需要扩展历史存储以回传 `reasoning_content`。
- 官方 QQ 与 OneBot 能力不同，界面显示的是实际适配器状态。
- 账号验证、风控解除和人工申诉需要在 QQ 或 NapCat 中处理。
- 自动化测试覆盖服务端和适配器，不包含真实浏览器 UI 测试。

## 文档

- `AGENTS.md`：后续 AI/开发者的最短入口说明。
- `docs/MAINTENANCE.md`：面向后续 AI/开发者的完整维护指南。
- `docs/ARCHITECTURE.md`：架构摘要。
- `docs/TROUBLESHOOTING.md`：常见故障排查。
- `docs/HUMANLIKE-CHECKLIST.md`：15 项拟人化目标的代码、测试与边界验收矩阵。

配置、启动或升级前，建议先阅读 `docs/MAINTENANCE.md` 的“备份与恢复”和“变更检查清单”。
