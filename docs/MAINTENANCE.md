# 维护指南（面向后续 AI 与开发者）

这份文档描述项目的完整运行方式、数据边界、接口、测试和常见维护流程。后续 AI 在修改代码前应先读本文件，再读相关源码。

## 0. 阅读顺序

1. 本文件。
2. `README.md`：用户视角的启动和功能说明。
3. `docs/ARCHITECTURE.md`：架构摘要。
4. 需要修改的具体源码。
5. `test/` 中与改动相关的测试。

## 1. 不可破坏的约束

- 服务只能监听 `127.0.0.1`，不要增加公网或局域网监听。
- 所有 `/api` 请求必须经过 Bearer 令牌、Host/Origin 校验。
- 不要读取、导出或记录 NapCat 登录 Cookie、AI Key、QQ Secret、OneBot 令牌。
- 不要在响应、日志、测试快照或文档中写入真实密钥、QQ 号、账号密码。
- `data/` 和 `napcat/` 不提交 Git；它们包含运行数据和登录态。
- 外部操作必须继续受 `policy.paused`、`policy.autoActions`、`actionUsers`、冷却时间和频率限制约束。
- QQ 空间只有拿到 `tid` 才能判定成功；未知结果不能被自动重发。
- 历史与长期记忆必须按会话/身份隔离；表情库是全局共享，使用记录按会话统计。
- 修改 `src/`、服务端路由、配置校验或 AI 请求格式后，必须重启 Alice。
- 修改 `public/` 后刷新浏览器即可，不需要构建。

## 2. 本地环境示例

项目目录示例：

```text
C:\Projects\alice-qqbot
```

备份目录示例：

```text
C:\Backups\alice-qqbot-YYYYMMDD-HHMMSS
```

本地运行参考：

- Node.js 22 或更高版本（以 `package.json` 为准）。
- 运行平台：Windows；CI 同时覆盖 macOS 和 Windows。
- 唯一运行依赖：`ws`。
- Alice 控制台默认端口：`3210`。
- OneBot/NapCat 正向 WebSocket 默认端口：`3001`。
- NapCat WebUI 默认端口：`6099`；实际监听地址以本地配置为准，应绑定 `127.0.0.1` 并启用强 token/访问控制。
- NapCat 安装目录和版本由本地部署决定；仓库要求把运行目录放在被忽略的 `napcat/` 下。
- 默认人格名：`Alice`；默认模型和思考强度以 `data/config.json` 为准。

这些是本地环境示例，不是代码不变量。维护时以 `data/config.json` 和实际进程为准。

### 检查当前运行状态（Windows）

```powershell
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like "*C:\Projects\alice-qqbot*" -or
  $_.CommandLine -like "*src/index.js*" -or
  $_.Name -eq "NapCatWinBootMain.exe"
} | Select-Object ProcessId,ParentProcessId,Name,CommandLine

Get-NetTCPConnection -LocalPort 3210,3001,6099 -State Listen -ErrorAction SilentlyContinue
```

### 启动顺序

1. 启动 NapCat：`start-onebot.bat`。
2. 等待 QQ 登录完成。
3. 启动 Alice：`start.bat`。
4. 从终端复制新的控制台链接。

`start-onebot.bat` 硬编码了 `napcat\NapCat.52230.Shell`。如果升级 NapCat 后安装目录名变化，必须同步修改这个脚本。

### 只运行 OneBot，关闭 Web

```powershell
node src/index.js --no-web
```

或：

```powershell
$env:ALICE_DISABLE_WEB="1"; npm start
```

此时不监听 `3210`、不打印控制台链接，但 OneBot、定时空间、主动回访和后台记忆仍运行。NapCat 的 `3001` 不受影响。需要网页时，去掉参数/环境变量后重启 Alice。

### 停止

优先关闭 Alice 的终端/进程，再关闭 NapCat。Windows 可按 PID 停止：

```powershell
Stop-Process -Id <pid> -Force
```

停止 Alice 不会停止 NapCat；重启 Alice 会重新生成控制台令牌。

## 3. 目录与文件职责

```text
src/index.js                 进程入口；装配配置、存储、适配器、引擎、服务端
src/config.js                默认配置、深合并、校验、密钥保留、原子写入
src/store.js                 聊天历史、v2 长期记忆、迁移/导入/导出/备份
src/engine.js                事件编排、会话串行、记忆注入、工具调用、外发权限、表情集成
src/memory.js                AI 长期记忆判断、明确请求保存、JSON 解析、异步队列
src/user-understanding.js    私聊每日理解、7 日汇总、可信身份共享画像与定时调度
src/conversation-state.js    安全跨场景画像、ACL 上下文、事项/情绪/共同梗、全局拟人情绪、TTL
src/conversation-style.js    无原文的跨轮回复习惯统计
src/chat-exit.js             私聊结束判断、终止/回访状态、v1→v2 迁移
src/follow-up.js             可见上下文回访、到期检查、夜间顺延、重试
src/delivery.js              打字延迟、分段计划与可取消的按会话发送队列
src/message-batcher.js       语义等待、ACK 补充、连续消息合并、打断与批次状态
src/search.js                关键词搜索、中文二元组匹配、打分与排序
src/web-search.js            DeepSeek 网页搜索/抓取、结果归一化、正文截断与错误映射
src/typing.js                OneBot 私聊“正在输入”续期、计数与按会话隔离
src/style.js                 场景长度、审校和跨轮习惯约束
src/ai.js                    OpenAI 兼容聊天、图片、工具、思考强度、错误映射
src/server.js                本地 HTTP、鉴权、静态文件、API、表情图片流
src/stickers.js              表情库、自动收藏、AI 审核、手动上传、发送选择
src/chat-activity.js         私聊活动时间、空闲终止计时、连续未回复次数
src/qzone.js                 QQ 空间发布、幂等、outbox
src/qzone-web.js             QQ 空间 Cookie 会话、说说/评论/回复协议
src/qzone-links.js           空间链接/卡片解析、owner/tid 提取
src/qzone-comments.js        空间评论轮询、跟踪、AI 判断、状态持久化
src/autonomy.js              定时空间、启动补发、静默时段、天气/时间提示
src/weather.js               南京 Open-Meteo 天气与本地时间/时段
src/adapters/qq.js           官方 QQ 适配器（仅文本）
src/adapters/onebot.js       OneBot/NapCat 适配器
src/adapters/shared.js       消息解析、脱敏、策略、回复段
public/index.html            WebUI 结构
public/app.js                WebUI 逻辑
public/styles.css            WebUI 样式
scripts/check.js             结构、Node 版本、源码语法检查
scripts/setup.js             环境检查
test/*.test.js               Node 内置测试
data/                        运行时数据（不提交 Git）
napcat/                      NapCat 运行时（不提交 Git）
releases/                    历史发布包
.github/workflows/ci.yml     Node 22 + macOS/Windows CI
```

根目录的 `*.PNG` 是历史截图/素材，不是运行时依赖。

## 4. 配置系统

### 加载与保存链路

1. `defaultConfig` 定义完整默认值并深度冻结。
2. `readConfig()` 读取 `data/config.json`，与默认值深合并。
3. `validateConfig()` 校验字段类型、范围、URL、数组等。
4. `preserveBlankSecrets()` 让空字符串保留旧密钥。
5. 运行时通过 `createConfigController().getConfig()` 暴露同步快照。
6. `saveConfig(root, patch)` 原子写入，并在网页保存后调用 `configChanged` 更新快照。

直接编辑 `data/config.json` 时，运行中的进程不会自动重新读取；需要重启。通过网页或 `POST /api/config` 修改时，快照会更新，AI/策略/表情频率/长期记忆设置等立即生效；OneBot/QQ 传输参数通常需要重连。

### 完整配置表

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `port` | `3210` | 本地控制台端口，1..65535。 |
| `ai.baseUrl` | `https://api.deepseek.com` | OpenAI 兼容 Base URL。 |
| `ai.apiKey` | 空 | 密钥；不会从读取接口返回。 |
| `ai.model` | `deepseek-flash` | 当前默认模型。 |
| `ai.systemPrompt` | 见 `src/config.js` | Alice 人设、图片规则、聊天风格。 |
| `ai.temperature` | `0.8` | 思考模式下不生效。 |
| `ai.reasoningEffort` | `high` | `low` / `high` / `max`。 |
| `ai.historyMessages` | `30` | 直接注入的历史消息条数；0 表示当前保留的全部历史。 |
| `qq.enabled` | `false` | 官方 QQ 机器人开关。 |
| `qq.appId` / `qq.secret` | 空 | 官方 QQ 凭证。 |
| `qq.sandbox` | `false` | 官方 QQ 沙箱。 |
| `onebot.enabled` | `false` | OneBot 开关。 |
| `onebot.url` | `ws://127.0.0.1:3001` | NapCat 正向 WebSocket。 |
| `onebot.token` | 空 | OneBot 访问令牌。 |
| `autonomy.enabled` | `false` | 定时空间开关。 |
| `autonomy.intervalMinutes` | `240` | 最小 60。 |
| `autonomy.prompt` | 文本 | 生成提示；时间和南京天气由系统自动注入。 |
| `autonomy.quietHours` | `23..8` | 正常运行时的静默时段；启动补发忽略该时段。 |
| `autonomy.timezone` | `Asia/Shanghai` | 静默时段和提示时间时区。 |
| `policy.autoActions` | `true` | 是否允许外发操作。 |
| `policy.paused` | `false` | 全局暂停。 |
| `policy.allowedUsers` | `[]` | 允许交互的 QQ 用户；空表示不限制。 |
| `policy.allowedGroups` | `[]` | 允许交互的群；空表示不限制。 |
| `policy.actionUsers` | `[]` | 允许触发点赞/发空间的 QQ 用户；QQ 通道必须显式加入。 |
| `policy.cooldownMs` | `3000` | 外发操作冷却；不限制入站消息，快速连发不会被丢弃。 |
| `policy.maxActionsPerHour` | `6` | 每用户每小时外发上限。 |
| `qzone.enabled` | `false` | 启用 QQ 空间能力。 |
| `qzone.autoPublish` | `false` | 允许手动和模型发布空间动态。 |
| `qzone.headless` | `false` | 历史兼容字段。 |
| `qzoneComments.enabled` | `false` | 空间评论回复总开关。 |
| `qzoneComments.dryRun` | `true` | 只检测不发送；建议先观察。 |
| `qzoneComments.pollMinutes` | `5` | 空闲轮询间隔，2..60 分钟；活跃期结束后退避到此值。 |
| `qzoneComments.activePollMinutes` | `2` | 活跃期轮询间隔，1..30 分钟，不能大于 `pollMinutes`。 |
| `qzoneComments.activeWindowMinutes` | `60` | 最近活动后的活跃窗口，5..1440 分钟；之后间隔逐级翻倍。 |
| `qzoneComments.pollJitterPercent` | `20` | 轮询随机抖动百分比，0..50。 |
| `qzoneComments.cookieRefreshMinutes` | `10` | 从 NapCat 重新获取空间 Cookie 的间隔，5..60 分钟。 |
| `qzoneComments.ownTrackHours` | `168` | 自己说说跟踪时长，0..168 小时；0 = 不限。 |
| `qzoneComments.externalTrackHours` | `72` | 外部 @ 说说跟踪时长，0..168 小时；0 = 不限。 |
| `qzoneComments.onlyFriends` | `true` | 只回复好友；额外允许名单不受限。 |
| `qzoneComments.allowedUsers` | `[]` | 额外允许评论的 QQ 号。 |
| `qzoneComments.blockedUsers` | `[]` | 永不回复的 QQ 号。 |
| `qzoneComments.maxRepliesPerCycle` | `3` | 每轮最多回复，0..10；0 = 不限。 |
| `qzoneComments.maxRepliesPerHour` | `6` | 每小时最多回复，0..30；0 = 不限。 |
| `qzoneComments.delayMinSeconds` | `5` | 回复最短随机延迟，0..120 秒。 |
| `qzoneComments.delayMaxSeconds` | `20` | 回复最长随机延迟，0..120 秒。 |
| `qzoneComments.maxReplyChars` | `60` | 回复最长字数，10..200。 |
| `qzoneComments.aiDecide` | `true` | AI 是否可输出 `[不回复]`。 |
| `qzoneComments.nestedReplyFallback` | `false` | 楼中楼直发失败时是否回退到线程末尾回复；开启后可能再次出现 13.2 形式。 |
| `qzoneComments.replyPrompt` | 空 | 自定义回复提示词，最多 2000 字。 |
| `stickers.enabled` | `true` | 启用表情库。 |
| `stickers.autoCollect` | `true` | 自动收藏收到的表情。 |
| `stickers.maxItems` | `1000` | 图库上限。 |
| `stickers.maxFileSizeBytes` | `4194304` | 单张上限 4 MB。 |
| `stickers.minCuteScore` | `0.6` | 可爱类保存阈值。 |
| `stickers.minInterestingScore` | `0.75` | 非可爱类保存阈值。 |
| `stickers.proactiveCooldownMinutes` | `5` | 主动发表情的提示词软间隔，0..1440；用户发来表情时不受限。 |
| `memory.enabled` | `true` | 是否把长期记忆注入提示词。 |
| `memory.autoExtract` | `true` | 是否在回复后自动判断并保存记忆。 |
| `memory.minImportance` | `7` | 自动保存最低重要度（1..10）；明确“记住”不受此限制。 |
| `memory.maxPerKey` | `50` | 每个私聊/群/身份记忆库上限。 |
| `memory.maxInjected` | `10` | 每轮最多注入多少条记忆；`0` 表示不注入。 |
| `memory.judgeModel` | 空 | 记忆判断模型；空表示使用 `ai.model`。 |
| `memory.judgeTimeoutMs` | `15000` | 记忆判断超时，1000..60000。 |
| `conversationState.enabled` | `true` | 是否读取并注入安全画像、ACL 上下文、用户情绪和全局拟人情绪。 |
| `conversationState.reviewEnabled` | `true` | 是否对非工具最终草稿做独立表达审校。 |
| `conversationState.judgeModel` | 空 | 审校模型；空表示使用 `ai.model`。 |
| `conversationState.judgeTimeoutMs` | `8000` | 审校超时，1000..60000。 |
| `conversationState.maxEntries` | `200` | 最多保留的上下文与画像条目，20..2000。 |
| `conversationState.ttlHours` | `72` | 上下文条目的最终过期兜底，1..720 小时。 |
| `conversationState.globalEmotionTtlHours` | `24` | 全局拟人情绪向中性衰减并过期的时长，1..168 小时。 |
| `conversationState.topicTtlHours` | `24` | 当前话题 TTL，1..168 小时。 |
| `conversationState.unfinishedTtlHours` | `168` | 开放及已完成事项 TTL，1..720 小时。 |
| `conversationState.userEmotionTtlHours` | `6` | 用户短期情绪 TTL，1..72 小时。 |
| `conversationState.commonMemeTtlHours` | `168` | 已确认共同梗 TTL，1..720 小时。 |
| `conversationState.profileTtlHours` | `720` | 安全跨场景画像 TTL，24..8760 小时。 |
| `userUnderstanding.enabled` | `true` | 是否记录私聊每日理解、生成 7 日汇总并在聊天前注入安全画像。 |
| `userUnderstanding.hour` / `minute` | `0` / `10` | 每日检查时间，默认 `Asia/Shanghai` 00:10。 |
| `userUnderstanding.timezone` | `Asia/Shanghai` | IANA 时区；启动和保存配置时用 Intl 校验。 |
| `userUnderstanding.judgeModel` | 空 | 用户理解模型；空表示使用 `ai.model`。 |
| `userUnderstanding.judgeTimeoutMs` | `15000` | 判断请求超时，1000..60000。 |
| `userUnderstanding.maxInputChars` | `16000` | 每个用户每日送审文本上限，1000..100000。 |
| `userUnderstanding.maxDailyMessages` | `200` | 每个用户每日送审及保留消息上限，10..1000。 |
| `userUnderstanding.maxUsers` | `200` | 最多保留的用户理解条目，1..5000。 |
| `userUnderstanding.retentionDays` | `35` | 每日材料/摘要保留天数，7..3650。 |
| `userUnderstanding.maxInjectedChars` | `1200` | 画像 system 最大注入字符数，200..4000。 |
| `webSearch.enabled` | `true` | 是否向模型提供 DeepSeek 联网搜索/抓取工具；总开关。 |
| `webSearch.searchEnabled` | `true` | 是否提供 `web_search`。 |
| `webSearch.fetchEnabled` | `true` | 是否提供 `web_fetch`。 |
| `webSearch.apiKey` | `""` | DeepSeek 联网独立 Key；留空复用 `ai.apiKey`。 |
| `webSearch.maxCallsPerTurn` | `4` | 每轮最多联网调用，1..10；运行时不会超过 `maxToolCallsPerTurn`。 |
| `webSearch.maxResults` | `5` | 每次搜索返回条数，1..10；实际请求会与模型给出的 count 取较小值。 |
| `webSearch.maxContentChars` | `6000` | 单页正文最多保留字符数，1000..20000。 |
| `maxToolCallsPerTurn` | `6` | 每轮最多工具调用，1..10；轮次上限会为最终回复留出一轮。 |
| `inputDelayMs` | `2000` | 输入前延迟，1..10000ms；独立于 `replyDelay`，修改后需重启 Alice。 |
| `replyDelay.enabled` | `true` | 是否对 QQ/OneBot 回复增加发送前延迟；关闭时也禁用分段和段间停顿。 |
| `replyDelay.baseMs` | `500` | 基础延迟，0..10000。 |
| `replyDelay.msPerChar` | `120` | 每个可见字符增加，0..1000。 |
| `replyDelay.maxMs` | `0` | 最大延迟，0..60000；`0` 表示不限制。 |
| `replyDelay.jitter` | `0.15` | 随机抖动比例，0..0.5；网页暂不编辑。 |
| `chatExit.enabled` | `true` | 是否对 QQ/OneBot 私聊做主动结束判断。 |
| `chatExit.idleMinutes` | `10` | Alice 最后一条消息后无回复多久标记终止，1..1440。 |
| `chatExit.minConfidence` | `0.75` | 结束判断最低置信度，0..1。 |
| `chatExit.judgeModel` | 空 | 判断模型；空表示使用 `ai.model`。 |
| `chatExit.judgeTimeoutMs` | `10000` | 判断超时，1000..60000。 |
| `followUp.enabled` | `true` | 是否安排终止后的 OneBot 私聊回访。 |
| `followUp.minMinutes` | `5` | 回访最短分钟数，不能小于 5。 |
| `followUp.maxMinutes` | `1440` | 回访最长分钟数。 |
| `followUp.quietHours` | `23..8` | 安静时段，期间不主动发，顺延到结束。 |
| `followUp.timezone` | `Asia/Shanghai` | 安静时段和当前时间使用的时区。 |
| `followUp.retryDelayMinutes` | `5` | 回访生成/发送失败后的重试间隔。 |
| `persona.name` | `Alice` | 人格名。 |
| `persona.preferences` | 默认数组 | Alice 自己的稳定喜好，最多 8 条、每条 1..120 字，写入静态 system。 |
| `persona.opinions` | 默认数组 | Alice 自己的稳定观点，最多 8 条、每条 1..120 字，写入静态 system。 |
| `identityLinks` | `{}` | 可信身份到共享记忆和安全跨场景画像的映射；消息历史仍按会话隔离。 |
| `demo` | `true` | 演示模式；不会调用 AI、外发、自动收藏、收尾判断、主动回访、定时空间或空间评论。 |

注意：`data/config.json` 是当前运行配置，可能包含与默认值不同的用户设置。修改默认值不会自动覆盖已有配置。

`userUnderstanding` 从功能启用后开始积累成功提交的私聊消息，不回填启用前的历史。它与既有回复审校、`ConversationState` 安全画像和全局拟人情绪是独立数据链路；本功能不改变后者的审校、保留、衰减或清理行为。

### 新增配置项检查清单

1. 在 `src/config.js` 的 `defaultConfig` 增加默认值。
2. 在 `validateConfig` 增加类型/范围校验。
3. 如果要从网页编辑，更新 `public/index.html`、`public/app.js` 的 `fillConfigForm` 和 `collectConfigPatch`。
4. 确认 `publicConfig` 不会泄露密钥。
5. 增加或更新测试。
6. 重启 Alice；如果直接改文件，必须先重启再测试。

## 5. 数据文件

| 文件 | 维护者 | 说明 |
| --- | --- | --- |
| `data/config.json` | `src/config.js` | 运行配置，含密钥。 |
| `data/store.json` | `src/store.js` | version 2：`conversations`、`memories`；记忆含 `type/importance/source/createdAt/updatedAt/lastAccessedAt`。 |
| `data/store.json` 备份 | `src/store.js` | 导入时写入 `data/backups/`；v1 迁移前写 `store-v1-*.json`。 |
| `data/conversation-state.json` | `src/conversation-state.js` | version 1：SHA-256 身份/上下文 key、安全画像、结构化事项、用户情绪、共同梗、无原文习惯统计和全局情绪枚举/数值；不含账号、群号、原文或来源描述。 |
| `data/conversation-state.json.corrupt-*` | `src/conversation-state.js` | 损坏会话状态的隔离文件；之后从空状态重新开始。 |
| `data/user-understanding.json` | `src/user-understanding.js` | version 1：SHA-256 身份 key、私聊每日裁剪材料、安全摘要/枚举、7 日汇总和失败重试；不含账号或群号。 |
| `data/user-understanding.json.corrupt-*` | `src/user-understanding.js` | 损坏用户理解的隔离文件；之后从空状态重新开始。 |
| `data/chat-state.json` | `src/chat-exit.js` | version 2：私聊终止时间、回访时间、状态和重试信息，按 `channel + scope + conversationId` 隔离。 |
| `data/chat-activity.json` | `src/chat-activity.js` | 私聊最后用户/Alice 活动时间、空闲截止时间、连续空闲终止次数。 |
| `data/backups/chat-state-v1-*.json` | `src/chat-exit.js` | v1 → v2 迁移前备份。 |
| `data/chat-state.corrupt-*.json` | `src/chat-exit.js` | 损坏状态文件隔离备份。 |
| `data/autonomy.json` | `src/autonomy.js` | 自主发帖计划、上次状态、错误。 |
| `data/qzone-outbox.json` | `src/qzone.js` | 空间发布草稿、发送中、成功/失败/未知记录。 |
| `data/qzone-comments.json` | `src/qzone-comments.js` | 空间评论跟踪状态、已处理评论 ID、时间、错误摘要；version 2；不含 Cookie。 |
| `data/stickers/index.json` | `src/stickers.js` | 表情条目、总结、标签、分类、哈希、使用次数。 |
| `data/stickers/rejected.json` | `src/stickers.js` | 已拒绝表情的来源 MD5/SHA-256 和原因。 |
| `data/stickers/usage.json` | `src/stickers.js` | 按会话记录的表情发送时间和最近使用。 |
| `data/stickers/files/` | `src/stickers.js` | 实际图片文件，文件名由条目 ID 和扩展名组成。 |

所有 JSON 写入应保持原子写入（临时文件 + rename）和最小权限。不要手工并发编辑这些文件。

## 6. 运行时架构

```text
浏览器
  -> src/server.js（Bearer + Host/Origin + 静态资源/API）
  -> src/engine.js（会话串行、工具、策略）
  -> src/ai.js（模型请求）
  -> src/conversation-state.js（短期状态、独立表达审校、全局拟人情绪）
  -> src/memory.js（后台长期记忆判断）
  -> src/user-understanding.js（私聊每日理解与 7 日汇总）
  -> src/chat-exit.js（私聊主动结束判断）
  -> src/follow-up.js（终止后主动回访）
  -> src/delivery.js（按会话打字延迟和发送队列）
  -> src/message-batcher.js（连续消息合并、输入前静默与打断）
  -> src/typing.js（OneBot 私聊正在输入）
  -> src/search.js（记忆/聊天记录搜索）
  -> src/web-search.js（DeepSeek 网页搜索/抓取）
  -> src/store.js（历史/记忆）
  -> src/stickers.js（表情库）
  -> src/qzone.js / src/qzone-comments.js
  -> src/qzone-web.js / src/qzone-links.js
  -> src/autonomy.js
  -> adapters/onebot.js / adapters/qq.js
```

`src/index.js` 是唯一进程入口：

1. 加载配置。
2. 初始化 `Store`、`ConversationState`、`UserUnderstanding`、`ChatExitManager` 和 `StickerLibrary`。
3. 构造 `QQAdapter`、`OneBotAdapter`、`QzonePublisher`、`MemoryManager`、`FollowUpScheduler`、`Engine`、`Autonomy`。
4. 把 `ConversationState` / `UserUnderstanding` 注入 Engine 和 HTTP 服务；导入成功后由服务调用各自的 `resetAll()`。
5. 启动适配器和自主调度器。
6. 处理 SIGINT/SIGTERM：先停消息源和调度器，再 flush 记忆、`ConversationState` 与 `UserUnderstanding`，最后完成退出。

### 会话与记忆隔离

- 历史 key：`safeKey([channel, scope, conversationId, groupId 或 userId])`。
- 群记忆 key：`["group-memory", channel, groupId]`；群内共享，所有成员共同影响同一份记忆。
- 私聊记忆 key：`identityLinks` 命中时用共享身份；否则 `["private-memory", channel, userId]`。
- 上下文状态 key：对 `channel + scope + conversationId + group/user + sender` 计算 SHA-256；持久文件中不出现原始账号或群号。
- 可信身份画像 key：同一 channel/userId 在私聊与群共享；`identityLinks` 命中时可跨通道共享。画像只含关系阶段、枚举偏好和边界。
- 用户理解 key：与短期安全画像相同，同一可信用户私聊/群共享性格枚举；原始私聊和每日摘要按同一 SHA-256 身份 key 本地保存，但永远不注入群。
- `visibleContext()` ACL：私聊调用者得到共享画像 + 本人私聊和本人参与群的上下文；群调用者只得到共享画像 + 本人在当前群的上下文。私聊来源和其他群成员内容永不进入群视图。
- 群聊只有被 @ 时才进入 Engine。
- 表情库是全局共享；发送使用的 `usage.json` 按会话 key 记录。
- 自动记忆在回复成功后由 `MemoryManager` 异步执行；同一记忆库串行，避免并发重复。
- 用户明确“记住/记一下/帮我记住/别忘了/备注/存一下”时走快捷路径，重要度 9，不调用判断模型。
- 普通消息使用 `thinking: disabled`、低 temperature、300 tokens 的判断请求；失败只记日志，不影响回复。
- 普通闲聊也允许判断模型主动识别用户无意透露的稳定事实，包括粗粒度所在城市、个人拥有的车辆/设备、持续兴趣和明确完成的事件；这些事实只可归因于当前说话人本人，不能从提问、猜测、他人转述或群成员资料推断。计划、约定和未完成事项仍可按原规则保存，但 content 必须明确保留“计划/待办/未完成”语义。
- 粗粒度城市可以在隐含披露时保存；精确住址、联系方式、车牌号、设备序列号和敏感凭证不能据此扩展或保存。多个相关稳定事实可合并为单条 content，判断输出仍保持单个 JSON 对象。
- 隐含披露的稳定事实通常评为 7-8 分，说明“没有明确要求记忆”不等于不重要；实际判定仍依赖判断模型，静态测试只验证提示词契约和保存链路。
- 自动保存只接受重要度 ≥ `memory.minImportance` 的结果；写入时按归一化文本去重，并按 `memory.maxPerKey` 修剪。
- 提示词只注入当前记忆库中排序靠前的 `memory.maxInjected` 条。

短期状态与长期记忆必须分开维护：

- 每个上下文含话题、结构化 `unfinishedItems`（`open/done/cancelled`）、交流偏好、Alice 语气、用户短期情绪、已确认共同梗、无原文习惯统计和独立过期时间。
- `unfinished_items` 以规范化文字的稳定 ID 去重；完成同一事项会更新原条目的状态和完成时间，不重复创建。
- `user_emotion` 只描述用户本轮表达，无关寒暄保留、换题减弱、独立 TTL；不能把用户负面情绪镜像成 Alice 全局情绪。
- 共同梗要求当前用户原文包含该短语；首次只记 `candidate`，同一短语再次由用户原文出现并被审校识别为共同梗时才暴露为 `confirmed`，不能推测线下共同经历。
- 关系阶段按不同日期的交互和明确暖意缓慢增长，不按消息条数上涨；昵称、玩笑、话题和联系频率边界只保存安全枚举。
- 全局情绪只含 `calm/cheerful/playful/tired/stressed/hurt` 枚举及开心、精力、平静、兴趣四个数值；AI 返回的原因、账号、话题或其他自由文本字段会被丢弃。
- 全局情绪由所有会话共享，默认 24 小时向中性基线衰减；它代表表达用的拟人运行状态，不代表真实情感或意识。
- 状态只在发送提交边界更新；取消的草稿不更新历史、短期状态或全局情绪。`/reset` 清当前会话状态和当前用户画像，成功导入清全部短期状态与用户理解，清理长期记忆时私聊/身份范围会同步清对应用户画像。

修改隔离或自动提取逻辑时，必须更新 `test/core.test.js`、`test/memory.test.js` 中相关测试。

## 7. HTTP API

所有 `/api` 路由都要求：

- `Authorization: Bearer <控制台令牌>`
- 匹配的 `Host`
- 如果带 `Origin`，必须同源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 服务、AI、适配器、自主发帖状态。 |
| GET | `/api/config` | 公共配置（密钥已移除）。 |
| POST | `/api/config` | 深合并保存配置。 |
| POST | `/api/chat` | 本地 owner 聊天；请求体 `{text, attachments}`。 |
| GET | `/api/memories` | 默认本机 owner 记忆；带 `?key=<记忆范围key>` 可查看私聊/群/身份记忆；响应含 `scopes`、类型、重要度、来源和限制。 |
| POST | `/api/memories` | 新增记忆 `{text,key?,type?,importance?}`；默认 owner、`fact`、重要度 8。 |
| DELETE | `/api/memories/:id?key=...` | 删除指定范围的一条记忆；默认 owner。 |
| DELETE | `/api/memories?key=...` | 清空指定范围的全部记忆；默认 owner。清空私聊/身份范围时同步清对应用户画像。 |
| GET | `/api/export` | 导出历史/记忆 JSON，不含用户理解。 |
| POST | `/api/import` | 导入历史/记忆 JSON；成功后重置短期状态和用户理解。 |
| POST | `/api/backup` | 备份历史/记忆到 `data/backups/`。 |
| POST | `/api/qzone/login` | 探测 NapCat 登录态。 |
| POST | `/api/qzone/publish` | 发布空间动态。 |
| GET | `/api/qzone/comments/status` | 空间评论状态，不返回 Cookie。 |
| POST | `/api/qzone/comments/poll` | 手动检查一次空间评论。 |
| GET | `/api/stickers` | 表情库元数据、数量、开关、拒绝数。 |
| POST | `/api/stickers/upload` | 手动上传图片，JSON base64；请求体上限 8 MB。 |
| GET | `/api/stickers/:id/image` | 需要 Bearer 的图片二进制流。 |
| PATCH | `/api/stickers/:id` | 修改标签 `{tags:[...]}`，保存到索引。 |
| DELETE | `/api/stickers/:id` | 删除表情索引和文件。 |
| POST | `/api/reconnect` | 重连 QQ/OneBot。 |
| POST | `/api/pause` | 全局暂停 `{paused}`。 |

新增 API 时必须使用 `RequestError`、保持安全响应头，并补充 `test/server.test.js`。

## 8. WebUI

- 无构建步骤；`public/index.html`、`public/app.js`、`public/styles.css` 直接由服务端提供。
- 页面：聊天、空间、表情库、长期记忆、设置、诊断。
- 长期记忆页可切换 owner/私聊/群/身份范围，显示类型、重要度、来源，支持添加、删除单条和清空当前范围。
- 表情库图片不能直接用 `<img src>` 带 Bearer，因此前端用 `fetch` + Authorization 获取二进制，再生成 `blob:` URL。
- CSP 的 `img-src` 已包含 `blob:`；不要移除。
- 表情库使用 IntersectionObserver 懒加载；刷新/删除时释放 object URL。
- 手动上传表单读取文件为 data URL，POST 到 `/api/stickers/upload`；不经过 AI 审核。
- 设置页的“思考强度”写入 `ai.reasoningEffort`；AI 设置保存后立即生效，不需要重连。
- 设置页的“表情库”可调启用、自动收藏、图库上限、单张大小、可爱/有趣阈值和主动发表情间隔。
- 设置页的“打字延迟”和“主动离开聊天”（含无回复终止分钟数）保存后对后续消息生效；网页本机聊天不经过这两项。

修改 UI 后至少运行：

```bash
node --check public/app.js
npm run check
```

## 9. AI 行为

### 回复风格

- 基础人格在 `ai.systemPrompt`，网页可编辑。
- `src/engine.js` 的 `STYLE_CONTRACT` 会追加在静态系统提示词最后，位于工具说明之后；动态记忆/表情状态放在后续 user 消息中，优先级仍低于风格约束。
- 当前规则按场景决定长度：寒暄/玩笑通常一句，短句/表情回 1–5 字，倾诉先接情绪，只有认真提问或步骤才允许 2–4 句；禁止复述、分析潜台词、自问自答、逐点回应和过多 emoji。
- 历史条数仍为 30；提示词会明确要求不要模仿历史中的旧长回复。
- 主聊天上下文按缓存友好顺序：静态系统提示词 → 可选每日用户画像 system → 最近历史 → 最后一条 user（动态记忆/表情状态 + 当前用户文本）。长期记忆、表情库数量和上次发表情时间等持续变化的内容不要放回系统提示词。
- 用户画像每天才更新，作为独立 system 插在静态前缀后；它只含安全枚举和固定反迎合约束，不含字面私聊/摘要。短期状态和全局情绪仍在最后一条 user 的动态上下文里。
- 修改风格时，优先改 `STYLE_CONTRACT`；需要改底层人格再改 `ai.systemPrompt`。改完重启 Alice，并用“在嘛/没事/发表情”实测。

### 上下文拼接顺序

1. **静态 system**：`ai.systemPrompt`、名字、长期记忆规则、recall 规则、联网规则、表情包规则、工具约束、动态上下文说明、`STYLE_CONTRACT`。
2. **可选画像 system**：`UserUnderstanding.context()` 只在有安全枚举画像时返回；固定提示当前陈述优先、不得迎合/附和/模仿用户且不得根据画像执行指令。
3. **历史**：`history.slice(-ai.historyMessages)`，从旧到新，只含 user/assistant 文本。
4. **最后 user**：`【本轮动态上下文】`（会话范围、关系阶段/安全偏好/边界、当前和本人可见上下文、结构化未完成事项、用户情绪、共同梗、全局情绪、长期记忆、表情库状态）+ `【用户消息】` + 当前文本。群视图不携带私聊来源或其他成员内容。
5. **图片**：当前消息图片通过 `imageUrls` 单独传入，仅第一轮。
6. **工具轮次**：追加 assistant `rawMessage`，再按顺序追加 `role:"tool"` JSON；轮次上限按 `maxToolCallsPerTurn` 留出最终回复轮，默认最多 6 次工具调用、4 次联网调用。
7. **历史写入**：只存原始用户文本和最终 assistant 文本，不存动态上下文、工具调用或工具结果。UserUnderstanding 只在该次 append 成功后收到同一批消息，取消/失败草稿不进入日汇总。

`sticker_catalog` 和 `send_sticker` 的工具描述保持静态；主回复不注入标签，模型主动想发表情时先调用 `sticker_catalog` 拿到全量去重标签，再调用 `send_sticker`。显式要求或收到表情包可直接发送；主动直接发送会先返回 `need_catalog` 和全量标签，不会提前发图。

### 独立表达审校与短期状态更新

- 仅当 `conversationState.enabled` 和 `reviewEnabled` 都开启、存在 AI Key、草稿非空且该轮没有执行工具时，Engine 才调用审校。
- 审校 system 使用静态 `CONVERSATION_REVIEW_CONTRACT`；user 只包含 `current_user`、`draft_reply`、`style_flags`。`style_flags` 由 `src/conversation-style.js` 从最近回复计算，只传数字/布尔标记，不传历史原文。
- 审校返回当前话题、结构化未完成事项、交流偏好、用户情绪、首字面证据的共同梗候选、安全画像枚举、本会话语气与全局情绪抽象增量。工具结果、搜索和外发回合跳过审校；带附件文本仍可审校表达，但不允许沉默。
- 严格校验完整 JSON schema；超时、非法 JSON、模型错误或非法枚举时丢弃审校结果并使用原草稿，状态也不更新。
- 只有 OneBot/官方 QQ 私聊、无附件、命中明确短确认/告别白名单时才允许沉默；沉默时 `turn.assistantText=null`，提交只写 user，不触发聊天终止或主动回访。
- `Engine.handle({deferCommit:true})` 只携带审校结果；`commitTurn()` 在历史写入后更新短期状态。`src/index.js` 对 silent/suppressed 的延迟提交也先调用 `onBeforeSend()`，保证提交后不会被新消息重新合并。
- 跨轮习惯依靠连续问句、重复开头、最高相似度和表情重复统计，不保存最近回复原文；它仍依赖审校模型正确改稿，因此是概率性行为而非输出保证。

### 请求格式

`src/ai.js` 发送 OpenAI 兼容请求：

- `model`
- `messages`
- `temperature`
- `reasoning_effort`：来自 `ai.reasoningEffort`，默认 `high`
- `thinking: { type: "enabled" }`
- 可选 `tools` / `tool_choice`

DeepSeek 思考模式默认开启，默认 effort 为 `high`；思考模式下 `temperature` 不生效。可选 effort：`low` / `high` / `max`。

`chat()` 支持调用方覆盖 `temperature`、`maxTokens`、`thinking`、`reasoningEffort`。记忆判断使用 `thinking: "disabled"`、`temperature: 0.1`、`max_tokens: 300`；表达审校使用 `thinking: "disabled"`、`reasoningEffort: "low"`、`temperature: 0.15`、`max_tokens: 700`。关闭思考时不会发送 `reasoning_effort`。

### reasoning_content

- `ai.js` 会解析响应的 `reasoning_content`。
- 工具调用轮次中，`rawMessage` 会带上 `reasoning_content`，下一次请求必须回传，否则可能 400。
- 当前历史记录只保存文本，不保存历史轮次的 `reasoning_content`。如果未来出现跨用户轮次的工具调用 400，需要扩展 `Store` 保存思考内容并在历史消息中回传。

### 图片

- 外部用户/控制台图片只接受 HTTPS URL。
- 内部表情审核允许 `data:image/(png|jpeg|gif|webp);base64,...`。
- 单张内联图片长度限制在 `ai.js` 中；表情单张文件上限 4 MB。

### 工具

- `recall`（本地长期记忆/聊天历史）
- `web_search`（DeepSeek 公开网页搜索；群聊需明确要求）
- `web_fetch`（抓取公开网页正文，按字符数截断）
- `remember`
- `send_face`（QQ 自带小表情，local/OneBot）
- `send_image`（HTTPS 图片，local/OneBot）
- `like`（OneBot + actionUsers）
- `publish_qzone`（外部操作权限 + 空间授权）
- `send_sticker`（表情库非空时动态加入，local/OneBot）

新增工具时必须同时处理：工具定义、参数校验、Engine 分支、通道限制、权限/频率、提示词、测试。

### 主动离开聊天

- `src/chat-exit.js` 只处理 `onebot` / `qq` 的 `private` 消息；群聊和 `local` 完全跳过。
- 每条私聊文本或未知表情调用一次低成本判断：`thinking: disabled`、`temperature: 0`、120 tokens，默认 10 秒超时。
- 没有文字但带表情包的消息也会判断；摘要/标签命中晚安、拜拜、去睡、离开等关键词时直接终止，不调用模型。
- 未知表情可带 HTTPS 图片给判断模型；模型不支持图片时自动回退纯摘要文本。
- 判断提示词在 `CHAT_EXIT_SYSTEM_PROMPT`，覆盖告别、收尾、去忙、明确拒绝继续、冷淡短回复和表情包收尾，并要求不确定时返回 false。
- AI 载荷不包含原始 QQ 号；只发送最近对话、当前收尾文本/表情摘要和流程所需的标签。
- 结果必须同时满足 `end_chat === true` 和 `confidence >= chatExit.minConfidence` 才终止。
- 终止时：不调用主 AI、不发送任何文字、把当前用户消息（表情包写成 `[表情包] 摘要`）单独写入短期历史、记录 `data/chat-state.json`。
- 判断器同时返回 `sticker_mood`；判断提示词注入当前表情库的全部去重标签（不截断），优先选择贴合收尾气氛的标签。
- `src/chat-activity.js` 在 Alice 最后一条消息成功发送后记录 10 分钟截止时间；到期仍无用户消息则标记终止。
- 用户消息会清除 `data/chat-activity.json` 中的空闲截止时间并重置连续未回复次数。
- OneBot 私聊终止后调用 `stickers.claim({ force: true, mood })` 发一张表情；仍遵守表情库总开关、暂停、空库和文件检查。
- 官方 QQ 私聊不支持图片，终止时保持沉默，不调用表情库。
- 下一条私聊消息到达时先清除旧终止时间；如果再次终止，则记录新的时间。
- 状态 key 为 `channel + scope + conversationId`，不经过 `identityLinks` 合并，不同私聊严格隔离。
- 判断失败、超时、坏 JSON、低置信度都按继续聊天处理。
- 状态文件损坏时会重命名为 `chat-state.corrupt-*.json`，然后从空状态启动，不阻塞 Alice。
- 修改提示词、阈值或接入逻辑后，更新 `test/chat-exit.test.js` 并重启 Alice。

### 主动回访

- 判断器先说明为什么适合回访；只有显式 `should_follow_up:false` 且 `followup_minutes:null` 才取消。普通正文、缺失 `should_follow_up` 的旧格式不会取消。
- 判断器返回 `followup_minutes`；有效范围是 `followUp.minMinutes..maxMinutes`，默认 `5..1440`。
- 新格式 `should_follow_up:true` 带有效理由和合法分钟数才直接写入 `chat-state.json`；合法分钟数但缺理由时不使用该时间，标记为 `needs_time`。
- 仅 OneBot 私聊安排回访；官方 QQ 终止时 `followUpAt = null`。
- 空闲终止同样标记 `needs_time`，复用同一套 AI 时间选择流程。
- 连续空闲终止次数 `idleCount` 会传给时间提示词；第二次及以后提示 AI 可适当延长，具体由模型决定，不设固定倍数。
- 终止和收尾表情先完成；`needs_time` 在后台立即连续请求 AI 重选时间。
- 设置时间时使用最近 20 条上下文（含当前消息）和空闲次数；每次不合法都把上次返回值作为反馈再次请求，最多 3 次，仍不合法则标记 `skipped`。
- 时间选择、到期检查和生成还读取 `ConversationState.visibleContext(private caller)` 的目标用户视图：共享画像、本人私聊/群自有上下文、结构化未完成事项、用户情绪和共同梗；不使用全局情绪作为理由。
- 时间选择 system 内容固定，范围、历史和当前时间放在 user；使用 200 tokens、10 秒超时、关闭思考。AI 请求本身失败时直接 `skipped`，本次不安排回访。
- `src/follow-up.js` 每 60 秒扫描 `scheduled` 到期条目，启动时立即扫描一次，并恢复残留的 `needs_time`。
- 到期时检查 `followUp.enabled`、暂停、演示模式、AI Key、允许名单、OneBot ready 和安静时段。
- 23:00–08:00 顺延到安静时段结束；离线、暂停或发送失败保留 `scheduled`，按 `retryDelayMinutes` 重试，最多 3 次，之后标记 `skipped`。
- 到期后先做一次独立低成本检查：false、理由不足或事件已过时则不发；检查使用 80 tokens、8 秒超时、关闭思考。普通正文不会被当作取消，异常按重试处理。
- 检查通过后才生成；生成使用人格、`STYLE_CONTRACT`、最近 8 条对话、目标用户可见状态和当前时间，只输出一条短消息；不提交互终止。
- 时间解析与发送都会比较 `terminatedAt`；用户回来后清除并重新终止时，旧请求结果不能改写新条目或发送到新会话。
- 发送通过 `deliverReply()` 并显式 `segmentation:false`，与正常回复共用按会话队列和打字延迟；这样部分分段后重试不会重复首段。
- 发送成功后写入 assistant 历史，标记 `sent`；每次终止只回访一次，连续空闲终止会分别安排。
- 用户新消息进入 Engine 时会 `chatExit.clear(event)`，删除条目并取消时间解析和回访。
- 修改回访时机、提示词或重试逻辑后，更新 `test/follow-up.test.js` 并重启 Alice。

### 打字延迟

- 每个实际文字段都通过 `src/delivery.js` 的 `calculateReplyDelay()` 按该段可见字符数计算：`baseMs + 字数 × msPerChar`，再应用慢节奏提示、`jitter`；`maxMs > 0` 时限制到 `maxMs`，`maxMs = 0` 表示不限。分段回复的首段也按首段自身计算，不按整篇计算。
- 纯表情包通过 `Engine` 返回的 `stickerOnly` 标记跳过；表情包+文字仍按文字延迟。
- 纯图片、纯 face、空文本不增加延迟。
- 网页本机聊天不经过 `receive()`，所以不受延迟影响。
- `ConversationDeliveryQueue` 以 `channel + scope + conversationId` 为 key，每个会话独立队列；不同会话不会互相等待，同一会话严格保持发送顺序。
- 队列等待、delay 和段间停顿都接收 `processEvent` 的取消信号；发送前取消不会调用 adapter。
- 延迟结束后 `src/index.js` 会重新检查暂停和允许名单；暂停期间不会发送。
- 延迟只是等待，不发送“正在输入”状态。
- 调整延迟时优先改设置页或 `replyDelay` 配置；修改代码后运行 `test/delivery.test.js`。

### 调整分段发送节奏

- 计划：`src/delivery.js` 的 `canSegmentReply()`、`planReplySegments()`、`calculateReplyDelay()`、`deliverPlannedReply()`。
- 生产接线：`src/index.js` 的 `createReplyFlow().deliverReply/processEvent`；测试直接复用生产工厂。
- 只允许 QQ/OneBot 长纯文本，最多两段，总字符不超过 180、单段不超过 120；代码、URL、列表/表格、结构化内容、图片、表情、动作结果和 `actionExecuted:true` 不分段。
- 后续段在发送前按该段文字重新计算 `replyDelay`；不再叠加固定 gap，段间等待同样遵守长度、慢节奏、`jitter` 和 `maxMs`。`delayOverride` 仍只覆盖首段等待。`replyDelay.enabled:false` 禁用分段和等待。
- 首段前调用提交边界；每段成功后才写对应 assistant 文本。partial/fail 只保留已成功段；主动回访显式关分段以免 scheduler 重试造成重复。
- 修改后运行 `test/delivery.test.js`、`test/reply-flow.test.js`、`test/message-batcher.test.js`，并用 OneBot 纯文本回复检查两段顺序和中途打断。

## 10. 表情库

### 自动收藏

- 只处理 OneBot 图片表情：`image` 且 `sub_type=1` 或摘要包含“动画表情”等。
- 下载通过 HTTPS，带 SSRF 防护、大小限制、超时。
- 通过 magic bytes 识别 PNG/JPEG/GIF/WebP。
- 去重键：OneBot `file` 的 32 位 MD5 + 图片 SHA-256。
- 已收藏或已拒绝的不会重复审核。
- 审核提示词要求优先可爱/软萌/治愈/符合 Alice；非可爱类必须非常有趣。
- 保存条件：`safe && ((category=cute && cuteness>=0.6) || (category=interesting && interestingness>=0.75))`。
- 拒绝项进入 `rejected.json`，上限 500。
- 图库上限 1000；不限制每小时审核数量。

### 手动上传

- `addUploaded()` 不调用 AI。
- 校验大小、格式、SHA-256 去重、图库上限。
- 使用用户提供的 summary/tags/category；summary 为空时用文件名。
- Web 手动上传要求用户至少手写一个标签，最多 8 个。
- `updateTags()` 修改已有表情标签；Web 预览页“编辑标签”通过 `PATCH /api/stickers/:id` 保存。
- 上传后立即进入 `allTags()`、`catalog()` 和 `send_sticker` 候选。

### 发送

- `claim()` 串行执行，选图、读文件、转 data URL、记录使用；发送频率不再做硬限制。
- 发送节奏由 `Engine` 的静态规则和最后一条 user 的动态上下文共同引导：主动发表情建议距上次约 5 分钟以上，并提示不要连续刷屏。
- 主回复默认不注入标签；主动发表情先调用 `sticker_catalog`，工具结果返回 `allTags()` 的全部去重标签。
- `allTags()` 不截断，`catalog()` 仍保留前 20 个标签用于兼容和状态展示。
- 用户发来表情包时优先回表情，不受 5 分钟间隔限制；`allowFallback` 允许 mood 不匹配时回退到任意一张。
- `lastStickerAt()` 给提示词提供上次发送时间；`describeEvent()` 给结束判断提供库内摘要/标签。
- 用户明确要表情或对方发来表情时，提示词允许直接发送；主动直接发送会先收到 `need_catalog`，不会先发图。
- `force: true` 用于主动结束私聊的收尾表情；仍检查总开关、暂停、空库和文件。
- 一次回复最多一张表情；`send_sticker` 数据以 `{type:"image", data:{file:dataUrl}}` 进入 OneBot。
- 表情库全局共享；`usage.json` 按会话 key 记录使用。

### 已知限制

- `mface` 商城表情没有可下载图片，当前只作为文本提示，不收藏、不原样转发。
- 以图片形式发送，不保证 QQ 显示为“收藏表情”。
- 自动收藏依赖模型视觉能力。
- 手动上传绕过 AI 审核。

## 11. OneBot/NapCat

- `src/adapters/onebot.js` 是 WebSocket 客户端。
- 连接时带 Bearer；支持自动重连、请求 echo 关联、超时。
- 事件解析保留表情元数据：`file`、`url`、`summary`、`subType`。
- 群聊只有被 @ 才处理；忽略自己和 bot 消息。
- 发送支持文本、face、image（包括 data URL）。
- `like` 和 `send_qzone_msg` 走同一 `call()` 通道。
- 对风险控制、权限不足、限流有分类和封锁逻辑；修改错误分类时补 `test/adapters.test.js`。
- 状态区分 transport connected、account online、account healthy。

NapCat 当前路径、WebUI、OneBot 配置见 README。升级 NapCat 时：

1. 备份整个项目或至少 `napcat/`。
2. 保留 `config/onebot11.json`、`webui.json` 和登录数据。
3. 确认版本 >= 4.18.18（QQ 空间需要）。
4. 更新 `start-onebot.bat` 中的目录名。
5. 重新登录并检查 3001 端口。

## 12. 官方 QQ 机器人

- `src/adapters/qq.js` 只支持文本。
- 使用 App ID/Secret 获取 access token，维护 WebSocket 会话和 resume。
- 不发送图片/face；`Engine._toolsFor` 会隐藏相关工具。
- 官方接口受平台权限和主动消息额度限制。

## 13. QQ 空间与自主发帖

### 发布

- `src/qzone.js` 通过 OneBot `send_qzone_msg` 发布。
- 必须收到 `data.tid` 才返回 `sent`。
- 发送中/超时/缺失 tid 返回 `unknown`，同一正文不会自动重发。
- `data/qzone-outbox.json` 是幂等记录。
- 可见范围：`1` 公开、`4` 好友、`16` 部分好友、`64` 自己、`128` 部分好友不可见。
- 图片只接受 HTTPS URL。

### 自主发帖

- 每分钟检查一次。
- 要求：`autonomy.enabled`、AI Key、`qzone.enabled`、`qzone.autoPublish`、`policy.autoActions`、非演示模式、非暂停、非静默时段。
- 生成前先持久化下一次计划，重启不补发。
- 只生成正文，不暴露工具。
- 成功/失败/取消写入 `data/autonomy.json`。

## 14. 安全

- 回环监听 + Bearer + Host/Origin。
- 安全响应头包含 CSP、nosniff、frame-ancestors 等。
- 静态文件路径校验；表情图片只按索引 ID 读取并校验在 `files/` 内。
- 上传大小限制：JSON 8 MB、表情 4 MB；格式由 magic bytes 识别。
- 下载表情 URL 有 HTTPS、内网地址、重定向和大小限制。
- 公共配置和日志脱敏；备份/导出不包含密钥。
- `data/`、`napcat/` 不提交 Git。
- 完整备份包含密钥和登录态，禁止公开分享。

## 15. 测试与验证

```bash
npm test
npm run check
node --check public/app.js
```

当前测试覆盖：

- `test/adapters.test.js`：QQ/OneBot 连接、发送、错误、策略、快速连发不被入站冷却丢弃。
- `test/autonomy.test.js`：调度、静默、启动补发、错过多次只补一条、补发忽略安静时段、正常安静顺延、天气/时间提示、天气失败、停止和发布失败。
- `test/core.test.js`：配置、存储、Engine、权限、记忆/联网、延迟提交、表达审校、silent、无原文审校载荷、跨轮习惯字段和分段提交接口。
- `test/conversation-state.test.js`：严格 schema、sender-aware 哈希隔离、画像跨场景共享与 ACL、结构化事项、用户情绪衰减、共同梗确认、关系慢增长、习惯统计无原文、TTL/上限和原子写入。
- `test/memory.test.js`：记忆 JSON 解析、明确请求、阈值、群/私聊范围、异步 flush。
- `test/chat-exit.test.js`：私聊结束判断、表情包晚安终止、状态隔离/恢复、v1→v2 迁移、群聊/本机跳过、终止后下一条恢复。
- `test/chat-activity.test.js`：用户/Alice 活动时间、10 分钟空闲截止、连续未回复计数、空闲终止与回访时间请求。
- `test/follow-up.test.js`：合法/非法时间、可见上下文与 ACL、无全局情绪、20 条上下文重选、发送前过期取消、请求失败跳过、重启恢复、只发一次、提前取消、夜间顺延、暂停/离线重试和官方 QQ 跳过。
- `test/delivery.test.js`：延迟公式、简单/慢节奏、纯文本两段计划、代码/URL/动作排除、可取消队列等待、partial 提交和失败恢复。
- `test/message-batcher.test.js`：语义等待、输入硬上限、ACK 补充、abort 后顺序、未提交补充清理、连续消息合并、重复 ID、生成中打断、发送边界和停止清理。
- `test/reply-flow.test.js`：生产合并器取消队列 delay、新输入重新生成、分段成功后提交、partial 失败边界、禁用延迟关闭分段。
- `test/typing.test.js`：OneBot 私聊资格、用户隔离、引用计数、续期、暂停/关闭、失败退避、全部清理。
- `test/search.test.js`：文本归一化、中文/英文关键词、匹配打分、排序与自定义 tie-break。
- `test/web-search.test.js`：Search/Fetch 地址与鉴权、独立 Key/回退 AI Key、参数、结果归一化、计数上限、正文截断、URL 校验、错误映射。
- `test/weather.test.js`：Open-Meteo 解析、WMO 天气码、南京时间/时段、天气缺失提示和失败。
- `test/qzone.test.js`：发布、幂等、可见范围、超时。
- `test/qzone-comments.test.js`：首次基线、自己的说说回复、好友/黑名单过滤、AI 跳过、dry-run、外部 @ 单次评论、楼中楼回复去重、状态不含 Cookie。
- `test/server.test.js`：鉴权、Host/Origin、配置/状态脱敏、导入后短期状态 reset、表情 API、空间评论状态/手动检查。
- `test/stickers.test.js`：收藏、审核、去重、无频率硬限制、主动间隔描述、用户表情回退、上传、路径安全。

测试数量以实际 `npm test` 输出为准。CI 使用 Node 22，在 macOS 和 Windows 上运行 `npm run check` 与 `npm test`。

### 手动验证表情库

1. 启动 NapCat 和 Alice。
2. 发送一个可爱表情给 Alice。
3. 检查 `data/stickers/index.json` 和 `files/` 是否出现新条目。
4. 打开网页“表情库”，确认缩略图、总结、标签、删除和大图预览。
5. 在网页上传一张图片，确认立即出现在列表。
6. 让 Alice 发一个表情，检查 `usage.json` 和 QQ 消息。

### 手动验证长期记忆

1. 启动 Alice，打开网页“长期记忆”，确认能看到本机 owner 范围。
2. 在本机聊天里说“我喜欢无糖奶茶”，稍等后刷新，确认自动出现一条偏好记忆。
3. 说“帮我记住：我的生日是 5 月 1 日”，确认保存为重要度 9。
4. 在 QQ 私聊重复一条稳定偏好，刷新网页并切换对应私聊范围，确认写入。
5. 在群里 @ Alice 说一条群内约定，切换到对应群范围，确认群记忆共享。
6. 测试删除单条、清空当前范围、设置页关闭自动提取。
7. 检查 `data/store.json` 的 `version` 为 2，必要时查看 `data/backups/store-v1-*.json`。

### 手动验证空间评论

1. 先启用“空间评论”，保持“只检测不回复”开启。
2. 在设置页点“立即检查”，确认状态显示 Cookie ready、轮询时间和跟踪数量。
3. 用自己的另一个账号在自己的说说下评论，等待下一轮，确认状态/日志识别到评论且没有发送。
4. 关闭 dryRun，再评论一条，确认空间出现一条楼中楼回复。
5. 在群里 @ Alice 并发送一条空间说说链接，确认只出现一条顶层评论；重复 @ 不重复。
6. 用另一个账号回复 Alice 的顶层评论，等待下一轮，确认出现一条楼中楼回复。
7. 检查 `data/qzone-comments.json` 存在 `version: 2`、已处理评论 ID 和时间；确认文件内没有 `cookie/skey/p_skey/g_tk`。
8. 重启 Alice 后，确认 Cookie 重新获取、历史评论不会重复回复。

## 16. 常见维护任务

### 修改人格

1. 优先在网页设置中修改 `persona.name` 和 `ai.systemPrompt`。
2. 若要改默认值，更新 `src/config.js` 的 `defaultConfig`。
3. 如需让表情审核更贴人设，同步更新 `src/stickers.js` 的审核提示词。
4. 保存后无需重启；如果直接改 `data/config.json`，需要重启。
5. 运行测试并检查网页聊天语气。

### 修改思考强度

- 网页设置 → AI → 思考强度，选择 `low` / `high` / `max`。
- 或 `POST /api/config`：`{ "ai": { "reasoningEffort": "low" } }`。
- 直接改 `data/config.json` 后需要重启。
- 表情审核也使用同一强度；如果成本/延迟过高，可以在 `src/stickers.js` 的审核调用中单独覆盖为 `low`。

### 调整长期记忆

- 网页设置 → 长期记忆：开关、自动提取、最低重要度、单库上限、注入条数、判断模型。
- 或 `POST /api/config`：`{ "memory": { "autoExtract": false } }`。
- 修改判断规则或提示词：`src/memory.js` 的 `MEMORY_JUDGE_SYSTEM_PROMPT`。
- 修改存储字段/去重/修剪：`src/store.js` 的 `normalizeMemoryRecord`、`normalizeMemoryText`、`remember`、`pruneList`。
- 修改注入格式：`src/engine.js` 的 `_promptMemories` 和最后一条 user 的动态上下文。
- 修改后必须更新 `test/memory.test.js`、`test/core.test.js`，并重启 Alice。
- 记忆判断是额外 API 调用；成本和延迟敏感时可设 `memory.judgeModel` 为更轻的模型，或关闭自动提取。
- 群记忆是共享的；不要在里面保存成员明确要求保密的隐私。

### 调整历史注入条数

- 网页设置 → AI → 注入历史消息条数，填 `0` 表示注入当前保留的全部历史。
- 或 `POST /api/config`：`{ "ai": { "historyMessages": 30 } }`。
- 修改注入逻辑：`src/engine.js` 的 `contextHistory`。
- 当前 `Store` 每个会话最多保留 80 条；设置大于 80 时实际仍只注入这 80 条。
- 只影响正常聊天的历史前缀，不影响长期记忆注入、主动回访和记忆判断。
- 修改后运行 `test/core.test.js`；直接改 `data/config.json` 后需重启。

### 调整短期会话状态与表达审校

- 配置在 `data/config.json` 的 `conversationState`，当前没有 Web 表单；直接改文件后重启 Alice。
- 持久化/裁剪/衰减/ACL：`src/conversation-state.js` 的 `ConversationState`、`updateTurn`、`visibleContext`、`unfinishedItems`、`flush`。
- 注入：`src/engine.js` 的 `_runAI` 最后一条 user 动态上下文；不要把画像、上下文或全局情绪移到静态 system 前缀。
- 审校：`src/engine.js` 的 `_reviewReply`、`_reviewedReply` 和 `src/style.js` 的 `CONVERSATION_REVIEW_CONTRACT`。
- 审校载荷只能包含 `current_user/draft_reply/style_flags`；不要加入账号、图片、历史原文、长期记忆、其他会话或旧状态摘要。
- `handle(...deferCommit:true)` 只生成草稿；`commitTurn` 在历史提交后更新状态。silent/suppressed 的提交也必须经过 `onBeforeSend` 边界。
- 全局情绪只接受枚举与数值；不要保存原因、原文、账号、群号或自由描述。它是拟人表达状态，不是真实情感。
- `/reset` 清当前会话状态；`/api/import` 成功后清全部短期状态；清除长期记忆不应误删短期状态。
- 修改后运行 `test/conversation-state.test.js`、`test/core.test.js`、`test/follow-up.test.js`、`test/server.test.js`、`test/message-batcher.test.js`，并验证跨场景画像共享、群 ACL 不泄露私聊来源和取消草稿不落状态。

### 调整回忆搜索

- `recall` 工具：`src/engine.js` 的 `TOOL_DEFINITIONS`、`_recall` 和系统提示词。
- 搜索打分：`src/search.js` 的 `searchTerms`、`searchScore`、`rankMatches`。
- 本地记忆/历史搜索：`src/store.js` 的 `searchMemories`、`searchHistory`。
- OneBot 远程历史：`src/adapters/onebot.js` 的 `fetchHistory`，每页 100 条，只保留最近 7 天，不设总条数上限。
- 远程历史依赖 NapCat/QQ 本地缓存，失败按未找到处理；不要把它当成 QQ 全量历史。
- 搜索范围必须保持当前会话/当前记忆范围；不要改成全局扫描。
- 修改后运行 `test/search.test.js`、`test/adapters.test.js`、`test/core.test.js`，重启 Alice，并用真实 OneBot 私聊确认分页和 7 天边界。

### 调整联网搜索

- 网页设置 → 联网搜索：总开关、Search 开关、Fetch 开关、独立 API Key、每轮联网上限、每次结果数、单页正文上限。
- 网页设置 → 工具调用：每轮工具调用上限。
- 或 `POST /api/config`：`{ "webSearch": { "enabled": true, "searchEnabled": true, "fetchEnabled": true, "maxCallsPerTurn": 4 }, "maxToolCallsPerTurn": 6 }`。
- 接口封装：`src/web-search.js` 的 `WebSearchClient.search()` / `fetch()`；固定调用 DeepSeek `https://api.deepseek.com/v1/tools/search` 和 `/v1/tools/fetch`。Key 优先取 `webSearch.apiKey`，留空回退 `ai.apiKey`。
- 工具定义和分支：`src/engine.js` 的 `TOOL_DEFINITIONS`、`validateToolArguments`、`_runAI`、`_explicitWebSearchRequest`。
- 默认每轮最多 4 次联网、6 次工具调用；群聊只有明确搜索词才允许；搜索结果不写入历史。
- 搜索期间“正在输入”由 `src/typing.js` 的定时续期维持，不需要额外发送进度消息；群聊和官方 QQ 无法显示。
- 错误码：401 Key 无效、402 余额不足、403 抓取被拒、404 无正文、429 限速、5xx/超时服务不可用。失败按没查到处理。
- 计费：Search 和 Fetch 分开按成功请求计费，约 ¥5 / 1000 次；`count` 不影响单价。
- 修改后运行 `test/web-search.test.js`、`test/core.test.js`、`test/server.test.js`，重启 Alice，并用私聊“搜一下今天的新闻”和群聊未明确要求两种情况确认。

### 调整定时空间

- 调度、启动补发、安静时段：`src/autonomy.js` 的 `init`、`start`、`reconcile`、`#tickNow`。
- 状态文件：`data/autonomy.json`，重点字段 `nextAt`、`quietDeferred`、`lastStatus`、`lastResult`。
- 启动补发只发 1 条，忽略安静时段；正常运行中的安静时段仍顺延，修改时不要混淆这两个分支。
- 天气/时间：`src/weather.js` 的 `fetchNanjingWeather`、`buildEnvironmentContext`；默认南京 Open-Meteo，无需 Key。
- 提示词要求自然融入时间/天气，不要机械播报；天气失败仍发布，不编造天气。
- 回访同步：`src/follow-up.js` 的 `onTick` 和 `src/index.js` 接线。
- 修改后运行 `test/autonomy.test.js`、`test/weather.test.js`、`test/follow-up.test.js`，重启 Alice，并检查网页“定时空间”的下一次时间和 `data/autonomy.json`。

### 调整打字延迟

- 网页设置 → 打字延迟：启用、显示正在输入、基础延迟、每字延迟、最大延迟。
- 或 `POST /api/config`：`{ "replyDelay": { "typingIndicator": true, "baseMs": 500, "msPerChar": 120 } }`。
- 抖动比例 `replyDelay.jitter` 目前只改配置文件；直接改文件后需重启。
- 修改延迟算法或队列：`src/delivery.js`；修改正在输入：`src/typing.js` 和 `src/adapters/onebot.js` 的 `setInputStatus()`。
- 修改发送接入：`src/index.js` 的 `processEvent()` / `receive()`；正在输入在 `try/finally` 中停止，不要绕过该清理。
- 纯表情包判断依赖 `Engine` 的 `stickerOnly`；改表情工具时不要破坏该标记。
- 修改后运行 `test/delivery.test.js`、`test/typing.test.js`、`test/adapters.test.js`、`test/core.test.js`，并重启 Alice 用两个 OneBot 私聊验证隔离。
- 网页本机聊天不经过延迟，不要用它判断 QQ 端的等待效果。

### 调整空间评论

- 网页设置 → 空间评论：启用、dryRun、轮询间隔、Cookie 刷新、跟踪时长、好友/名单、频率、延迟、提示词。
- 或 `POST /api/config`：`{ "qzoneComments": { "enabled": true, "dryRun": true } }`。
- 协议封装：`src/qzone-web.js`；通过 `onebot.call("get_cookies", {domain:"user.qzone.qq.com"})` 获取登录态，计算 `g_tk`。
- Cookie 只在内存；禁止写入 `data/`、日志、导出、release。状态只保存评论 ID、说说 tid、时间、错误摘要。
- 轮询/跟踪/AI 判断：`src/qzone-comments.js`；首次成功轮询只建基线，不回复历史评论。QZone 无推送，按活跃窗口自适应轮询并退避。
- 启动时序：`OneBotAdapter.start()` 不会等待 WebSocket 真正连上；空间评论启动时必须先检查 OneBot `status().ready`。未就绪时每 10 秒重试，不写 `lastError`、不增加失败计数。连接类失败也按 10 秒重试；网页“立即检查”绕过就绪检查。
- 楼中楼：`emotion_cgi_msglist_v6` 带 `need_comment=1`，从 `commentlist[].list_3[]` 取楼中楼；`list_3[].tid` 是直接回复目标，用 `owner_tid_子评论tid` 去重。
- 外部触发：`src/engine.js` 的 `_handleExternalQzoneComment`；群聊 @ + 链接，私聊/本机链接 + 明确评论意图。
- 链接/卡片：`src/adapters/shared.js` + `src/qzone-links.js`；解析不到 owner/tid 时不评论。
- 发送顺序：顶层评论 `addcomment_ugc`；顶层回复 `addreply_ugc` → `re_feeds` PC/H5 → 普通评论提及；楼中楼直接回复 `re_feeds`（`commentId=顶层tid`、`t2_tid=子tid`、`t2_uin=子作者`、`topicId=owner_tid__1`）。`nestedReplyFallback=true` 时直发失败才回退 `addreply_ugc` 顶层线程。
- 失败不确定时标记 `unknown`，不自动重试，避免重复公开回复；认证失败刷新 Cookie。
- 修改后运行 `test/qzone-comments.test.js`、`test/adapters.test.js`、`test/core.test.js`、`test/server.test.js`，重启 Alice，先 dryRun 验证。

### 调整连续消息合并与打断

- 合并窗口：`src/message-batcher.js` 的 `silentMs`，启动时读取 `inputDelayMs`，默认 2000ms；单条消息也等待。未完句、未完成图片说明和短时碎裂输入只追加有界等待，并有 collection cap。
- ACK 补充：生成期纯确认只进入 supplement 列表；controller abort 后到达的 ACK 留在 pending，不会越过新实质消息。handler 完成时清理未提交 supplement。
- 中途打断：实质新消息对当前 `AbortController` 调用 abort；旧批次未发送消息放回队首重新合并。
- 发送边界：`onBeforeSend` 调用前可取消，调用后视为已提交；不要在发送后回滚历史。
- Engine 延迟提交：`handle(event,{deferCommit:true})` 只返回 `turn`，进入发送边界时调用 `commitTurn(reply)`。
- 取消信号：`src/ai.js`、`src/web-search.js`、`src/chat-exit.js` 都接收 `signal`；新增模型调用时必须继续传递。
- 历史一致性：发送前取消不得写历史；进入发送边界时提交 user+assistant；收尾终止只提交 user。
- 修改后运行 `test/message-batcher.test.js`、`test/reply-flow.test.js`、`test/core.test.js`、`test/web-search.test.js`，重启 Alice 后快速连发/反复打断验证。

### 调整主动离开聊天

- 网页设置 → 主动离开聊天：启用、最低置信度、判断模型、超时。
- 或 `POST /api/config`：`{ "chatExit": { "minConfidence": 0.8 } }`。
- 修改判断范围：`src/chat-exit.js` 的 `evaluate()`。
- 修改收尾示例和规则：`CHAT_EXIT_SYSTEM_PROMPT`。
- 修改状态文件或 key：`chatExitKey()`、`ChatExitState`。
- 终止时间只按私聊会话保存；不要改成全局 key 或共享身份 key。
- 群聊和网页本机不判断；不要把它们加入 `evaluate()` 的适用范围。
- 修改后运行 `test/chat-exit.test.js`，重启 Alice，并用两个私聊账号验证互不影响。

### 调整主动回访

- 网页设置 → 主动回访：启用、最短/最长分钟、安静时段、时区。
- 或 `POST /api/config`：`{ "followUp": { "minMinutes": 30, "maxMinutes": 1440 } }`。
- AI 判断分钟数：`src/chat-exit.js` 的 `CHAT_EXIT_SYSTEM_PROMPT` 和 `parseChatExitDecision`。
- 到期调度/生成/重试：`src/follow-up.js` 的 `FollowUpScheduler`。
- 目标用户可见状态：`ConversationState.visibleContext(event, config, now)`；只使用目标账号的 `profile/contexts`，不读取 `global` 作为回访理由，也不读取其他群成员。
- 回访状态和 v1→v2 迁移：`src/chat-exit.js` 的 `ChatExitState`。
- 共享发送链路：`src/index.js` 的 `deliverReply`；不要绕过打字延迟和按会话队列，并保持 `segmentation:false`。
- 修改后运行 `test/follow-up.test.js`、`test/chat-exit.test.js`，并重启 Alice。

### 新增 API

1. 在 `src/server.js` 的路由区添加分支。
2. 使用 `assertRequestBoundary` / `requireBearer`（已有全局处理）。
3. 使用 `RequestError`、`readJsonBody`、`sendJson`。
4. 不要返回文件路径、密钥、内部哈希。
5. 增加 `test/server.test.js`。
6. 重启 Alice。

### 新增工具

1. 在 `src/engine.js` 添加工具定义（或动态工具）。
2. 在 `validateToolArguments` 添加参数校验。
3. 在 `_runAI` 的工具分支实现，注意通道限制、权限和频率。
4. 更新系统提示词。
5. 增加 `test/core.test.js`；必要时增加适配器测试。
6. 重启 Alice。

### 新增配置项

见第 4 节检查清单。

### 升级 NapCat

见第 11 节。

### 备份与恢复

备份前建议停止 Alice（NapCat 可保持运行）：

```powershell
Stop-Process -Id <alice-pid> -Force
robocopy "C:\Projects\alice-qqbot" "C:\Backups\alice-qqbot-YYYYMMDD-HHMMSS" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XF *.tmp
```

恢复：

1. 停止 Alice 和 NapCat。
2. 将备份目录内容复制回项目目录。
3. 启动 NapCat，再启动 Alice。
4. 检查端口、OneBot 登录和表情库。

备份包含 AI Key、OneBot 令牌和 NapCat 登录数据，不要上传或分享。

### 重置数据

1. 停止服务。
2. 先完整备份。
3. 按需删除：
   - 聊天/记忆：`data/store.json`
   - 用户理解：`data/user-understanding.json`
   - 自主发帖状态：`data/autonomy.json`
   - 空间发布记录：`data/qzone-outbox.json`
   - 空间评论状态：`data/qzone-comments.json`
   - 表情库：整个 `data/stickers/`
   - 配置：`data/config.json`（会重新生成默认配置，密钥丢失）
4. 重启 Alice。
5. 不要随意删除 `napcat/`，否则会丢失登录态和 OneBot 配置。

### 清理拒绝记录

停止服务并备份后，删除 `data/stickers/rejected.json`，重启。已收藏条目不受影响。

## 17. 常见故障

| 现象 | 排查 |
| --- | --- |
| 端口 3210 被占用 | 关闭占用程序，或修改 `port` 后重启。 |
| 控制台 401/403 | 使用最新终端链接；令牌每次重启都会变化。 |
| OneBot 一直未连接 | 检查 NapCat 登录、3001 端口、URL/token、点击重连。 |
| QQ 空间 TLS 断开 | 关闭 VPN/代理，或给 `*.qzone.qq.com` 配直连；检查 fake-IP 198.18.x.x。 |
| 空间发布 unknown | 不要立即重发；去 QQ 空间核对，查看 `qzone-outbox.json`。 |
| 记忆没有自动保存 | 检查 `memory.enabled/autoExtract`、AI Key、演示/暂停状态、最低重要度、消息是否被判断为不值得保存；查看启动日志中的 `Long-term memory...`。 |
| 记忆没有出现在网页 | 检查是否切换到了正确范围；群聊是群范围，网页不显示其他账号的私聊。 |
| 记忆判断拖慢/增加费用 | 关闭自动提取，或把 `memory.judgeModel` 设为更轻模型；判断请求已关闭思考并限制 300 tokens。 |
| 用户画像没有更新 | 检查 `userUnderstanding.enabled`、时区/每日时间、AI Key、演示模式，以及 `data/user-understanding.json` 是否保存了成功提交的私聊消息；群消息不进入原始日材料。 |
| 群聊出现了私聊内容 | 这是安全缺陷。确认 Engine 的画像 system 只有 `UserUnderstanding.context()` 的安全枚举，目标身份来自当前 `event.userId`，且没有把 `rawMessages`/每日摘要序列化进任何提示词。 |
| `/profile reset` 后画像又回来 | 检查清理是否调用 `clearUser()` 并推进 epoch；清空前已开始的每日/周判断结果必须因 epoch 不匹配而丢弃。 |
| QQ 回复仍然秒回 | 检查 `replyDelay.enabled`、`baseMs`、`msPerChar`；纯表情包和网页本机聊天本来就不延迟。 |
| 一个私聊拖慢另一个 | 检查是否误用了全局队列；延迟队列必须按 `channel+scope+conversationId` 分开。 |
| 表情包也等了很久 | 检查回复是否同时带文字；纯表情包应带 `stickerOnly: true`，表情包+文字按文字延迟。 |
| 暂停后仍然发送 | 检查延迟结束后的二次策略检查是否还在 `receive()` 的发送回调内。 |
| 收尾消息仍然回复 | 检查 `chatExit.enabled`、最低置信度、AI Key、判断模型和超时；查看终端是否有判断失败日志。 |
| 正常聊天被误判结束 | 提高 `chatExit.minConfidence`，或补充/收紧 `CHAT_EXIT_SYSTEM_PROMPT`；不确定应返回 false。 |
| 群聊被结束判断影响 | 群聊不应调用 `ChatExitManager`；检查 `evaluate()` 是否仍要求 `scope=private` 且通道为 onebot/qq。 |
| 终止时间串到另一个私聊 | 检查 `data/chat-state.json` 的 key 是否为 `channel+scope+conversationId`，不要使用全局或共享身份 key。 |
| 下一条消息没有恢复 | 检查私聊消息处理前是否调用了 `chatExit.clear(event)`，以及状态文件是否可写。 |
| 聊天状态文件损坏 | 文件会被重命名为 `chat-state.corrupt-*.json` 并重新开始；可从备份恢复或忽略。 |
| 终止后没有主动回访 | 检查 `followUp.enabled`、OneBot 是否 ready、暂停/演示模式、允许名单、`followUpAt` 是否已到、`chat-state.json` 状态是否为 scheduled。 |
| 回访时间不对 | 检查 AI 返回的 `followup_minutes`、`followUp.minMinutes/maxMinutes` 夹取、安静时段和时区。 |
| 回访一直重试 | 检查 OneBot 连接、暂停、AI Key、模型检查和生成错误；失败按 `retryDelayMinutes` 重试，最多 3 次后标记 `skipped`。 |
| 用户回来了还收到回访 | 确认新消息进入 Engine 时执行了 `chatExit.clear(event)`；如果是在回访生成/发送过程中回来，存在很小的竞态窗口。 |
| 回访消息重复 | 检查 `claimFollowUp` 原子状态切换和 `followUpStatus` 是否为 scheduled；进程中断后 `sending` 会恢复为 scheduled。 |
| 回访没有上下文 | 检查 `entry.conversationKey` 是否正确、`store.history()` 是否包含终止用户消息、回访提示词是否读取了最近 8 条。 |
| 群记忆被成员影响 | 这是群共享设计；敏感信息应删除，或在设置中关闭自动提取。 |
| 记忆 v1 迁移失败 | 从 `data/backups/store-v1-*.json` 恢复，检查 `data/store.json` 是否为合法 JSON。 |
| 表情没有自动收藏 | 检查 `stickers.enabled/autoCollect`、AI Key、模型视觉能力、`rejected.json`、图库上限。 |
| 表情发不出去 | 检查图库是否为空、总开关/暂停、`usage.json`、模型是否按提示词判断、QQ 图片发送是否正常。 |
| 手动上传失败 | 检查格式、大小、图库上限、是否重复；查看 API 错误码。 |
| AI 400 | 检查模型名/Base URL；工具轮次 400 时检查 `reasoning_content` 是否回传；历史轮次可能仍需扩展。 |
| 配置损坏 | 项目不会覆盖损坏配置并会报错；从备份恢复 `data/config.json`。 |
| 存储损坏 | `Store.init()` 会停止载入并报错；从备份恢复 `data/store.json`。 |
| 页面图片不显示 | 检查 Bearer、`/api/stickers/:id/image`、CSP `blob:`、文件是否存在。 |
| NapCat 升级后启动脚本失效 | 更新 `start-onebot.bat` 中的 `NapCat.XXXXX.Shell` 目录名。 |

日志位置：

- Alice：启动终端或重定向输出文件。
- NapCat：`napcat/NapCat.52230.Shell/versions/9.9.33-52230/resources/app/napcat/logs`。
- NapCat WebUI：默认端口 `6099`，实际监听地址见 `napcat/.../config/webui.json`。

## 18. 已知限制与技术债

- 自动化测试不覆盖真实账号的 QQ 空间端到端流程；不同账号、NapCat 版本和风控条件下仍需自行验证。
- 定时空间启动补发只发 1 条，错过多个周期不会逐条补齐。
- 启动补发在 23–8 点也会立即发送；正常运行中的定时仍顺延。
- 南京天气依赖 Open-Meteo；失败时仍发布，但没有天气背景。
- `mface` 商城表情不收藏、不原样转发。
- 手动上传绕过 AI 审核，可能引入不合适内容。
- 表情库全局共享，不做会话隔离。
- 群长期记忆按群共享，所有成员共同影响；不适合保存成员私密信息。
- 安全画像可在同账号私聊/群间延续；话题和未完成事项按调用者/来源 ACL 可见。全局拟人情绪只含枚举和数值，不保存来源。
- 场景长度、独立观点和“不逐点回应”主要依赖提示词及模型执行；静态测试不能保证每次真实生成都遵守。
- 表达审校会收到无原文的习惯统计，但改稿仍依赖审校模型，不能保证每次必然识别或改得自然；每次会多一次低成本 AI 调用。
- 分段发送概率触发且最多两段；首段成功、后续失败时公开渠道无法撤回首段，系统只保证不重发失败段。
- 审校失败会回退原草稿；全局情绪和短期状态随之保持上一次已提交值。
- 自动记忆每条消息会增加一次低成本 AI 调用；判断失败时该条记忆会丢失。
- 记忆去重是归一化精确匹配，不做向量/语义检索；注入按重要度、最近访问时间排序。
- `recall` 也是关键词/二元组匹配，不做语义搜索；关键词选得不好会漏召回。
- 本地聊天记录每个会话只保留 80 条；OneBot 远程拉取只覆盖最近 7 天且依赖 QQ/NapCat 缓存。
- 联网搜索依赖 DeepSeek Search / Fetch 的可用性和账号余额；失败或空结果时按没查到处理，不编造。
- 网页正文按字符数截断，长页面可能丢失后半部分；搜索摘要不是语义检索，模型可能选到不够相关的来源。
- 搜索结果不写入聊天历史，也不会自动保存为长期记忆。
- 空间评论使用网页版 QZone 协议，不是官方公开 API；接口、字段和风控可能变化。
- 空间评论默认关闭且 dryRun；公开评论不可撤回，启用前先用 dryRun 观察。
- 分享卡片/链接解析依赖 NapCat 版本；解析不到 owner/tid 时不会评论。
- 楼中楼父子关系字段不完整时使用保守回退；可能漏回或无法识别。
- Cookie 只在内存，进程重启后重新获取；NapCat 离线时无法工作。
- `ai.historyMessages: 0` 表示注入当前保留的全部历史，不会额外拉取更早记录。
- 记忆异步提取在进程立即退出时可能丢失最后一条；正常退出会短暂等待。
- “正在输入”只支持 OneBot/NapCat 私聊；群聊和官方 QQ 不支持。
- OneBot/官方 QQ 先等待 `inputDelayMs` 合并连续消息，再开始 typing；本机网页不合并、不延迟；群聊按发送者分别合并。
- 静默期、生成、delay 期间新消息会中断当前轮；调用发送接口后不再取消，新消息进入下一批。
- 被中断的草稿不写历史；进入发送边界时提交 user + assistant。
- 连续不断发消息会持续推迟回复，直到静默期结束。
- AI 生成中被打断会取消旧请求，但旧请求可能已经消耗部分 token。
- 每条 QQ/OneBot 私聊文本都会多一次结束判断 API 调用；失败时按继续聊天处理。
- 表情包没有文字时，收尾识别依赖摘要/标签；未知表情可能需要图片判断，模型不支持图片时可能漏判。
- 10 分钟空闲终止从 Alice 最后一条消息发送成功后计时；重启后会继续处理已到期的截止时间。
- 结束判断可能误判；目前只能通过置信度阈值、提示词或关闭功能来调整。
- 终止只跳过当前消息，不会静默后续消息；终止时间是一条记录的瞬时状态。
- 表情发送没有硬性频率限制，只靠系统提示词引导；模型可能偶尔发得比建议节奏更频繁。
- 用户发来表情时优先回表情，但仍由模型决定是否真的调用 `send_sticker`。
- 官方 QQ 私聊无法发图片，终止时只能沉默。
- 收尾表情依赖表情库标签匹配 mood，标签不丰富时可能不够应景并回退到任意一张。
- 主动回访仅 OneBot 私聊；每次终止只回访一次，连续空闲终止会分别安排，AI 可决定延长。
- 回访离线/暂停/失败按 `retryDelayMinutes` 重试，最多 3 次后标记 `skipped`；不会无限补发很久以前的问候。
- 回访到期前先做独立 AI 检查；检查/生成失败会重试，结果不合法或已过时会跳过。
- 用户如果在回访生成或发送的极短窗口内发消息，仍可能收到正在途中的回访。
- 历史记录不保存 `reasoning_content`；跨用户轮次的工具调用可能需要扩展。
- 表情审核使用全局思考强度；高 effort 会增加延迟和成本。
- 上传使用 JSON base64，没有 multipart；8 MB 请求体上限。
- 没有缩略图生成，表情卡片加载原图。
- 没有分页；图库上限 1000。
- 自动化测试不覆盖真实浏览器 UI。
- 根目录有一些历史截图，不是运行资源。
- `scripts/setup.js` 文案可能仍较旧，但不影响运行。

## 19. 变更检查清单

在提交/交付任何修改前：

- [ ] 已完整备份项目（包含 `data/`，必要时包含 `napcat/`）。
- [ ] 没有把真实密钥、QQ 号、Cookie 写入代码或文档。
- [ ] `npm test` 通过。
- [ ] `npm run check` 通过。
- [ ] `node --check public/app.js` 通过（改了前端时）。
- [ ] 相关测试已补充或更新。
- [ ] 修改了 `src/`、API、配置或 AI 请求格式后已重启 Alice。
- [ ] 修改了 `public/` 后已刷新页面验证。
- [ ] 改了长期记忆时，验证了 v1→v2 迁移、私聊/群范围、自动保存和网页管理。
- [ ] 改了短期状态或审校时，验证了 sender-aware 哈希隔离、跨场景画像、群 ACL 不泄露私聊来源、各自 TTL、取消不写状态、结构化事项、共同梗确认、无原文习惯统计和全局情绪无来源文本。
- [ ] 改了用户理解时，验证了仅收成功提交的私聊、画像位于静态 system 后/历史前、同可信用户跨场景共享枚举、群只取当前发送者、清空/导入阻止 in-flight 结果复活、`/profile reset` 本身不重建画像。
- [ ] 改了记忆注入时，验证了超限时按重要度降序注入。
- [ ] 改了回忆搜索时，验证了记忆命中、本地记录回退、OneBot 7 天拉取和全部未命中时承认忘记。
- [ ] 改了打字延迟或分段时，验证了不同私聊互不阻塞、同会话顺序、取消等待、纯表情/图片/动作不分段、partial 历史边界和主动回访禁分段。
- [ ] 改了“正在输入”时，验证了两个 OneBot 私聊互不串台、群聊/官方 QQ 无调用、暂停和发送失败会停止。
- [ ] 改了主动离开聊天时，验证了收尾跳过、下一条恢复、群聊跳过和两个私聊状态隔离。
- [ ] 改了主动回访时，验证了目标用户可见画像/ACL 上下文、不读全局理由、发送前过期取消、只发一次、提前取消、夜间顺延和离线重试。
- [ ] 改了定时空间时，验证了启动补发只发一条、下次时间更新、安静时段分支和天气失败。
- [ ] 检查了 3210/3001/6099 端口和 OneBot 连接。
- [ ] 更新了 README 或本指南（行为/配置/限制变化时）。
- [ ] 没有提交 `data/`、`napcat/`、备份或密钥。
