# AGENTS.md

给后续 AI/开发者的入口说明。

## 先读

1. `README.md`
2. `docs/MAINTENANCE.md`（完整维护指南）
3. `docs/ARCHITECTURE.md`
4. `docs/TROUBLESHOOTING.md`

## 必须遵守

- 不要提交 `data/`、`napcat/`、备份目录或任何密钥。
- 修改前先完整备份项目；`data/` 含 AI Key、OneBot 令牌和表情库。
- 服务只监听 `127.0.0.1`，所有 `/api` 请求必须保留 Bearer、Host/Origin 校验。
- 不要读取或输出 NapCat Cookie、QQ 凭证、AI Key、真实账号信息。
- 唯一例外：`qzoneComments` 模块可通过 OneBot `get_cookies(domain="user.qzone.qq.com")` 读取空间登录态；只允许在内存中使用，绝不写入 `data/`、日志、导出、release 或 Web 状态。
- 修改 `src/`、API、配置校验或 AI 请求格式后，必须重启 Alice。
- 修改 `public/` 后刷新浏览器即可，不需要构建。

## 常用命令

```bash
npm test
npm run check
node --check public/app.js
npm start
```

Windows 启动顺序：先 `start-onebot.bat`，再 `start.bat`。控制台令牌在启动终端打印，每次重启都会变化。

## 当前关键事实

- 人格：Alice。
- 默认模型：`deepseek-flash`。
- 思考强度：`ai.reasoningEffort`，可选 `low` / `high` / `max`，网页可切换。
- 回复风格：`src/engine.js` 末尾的 `STYLE_CONTRACT` 强制短回复；基础人格在 `ai.systemPrompt`。直接注入的历史条数由 `ai.historyMessages` 控制，默认 30，0 表示注入当前保留的全部历史；仍提示模型不要模仿旧风格。
- 上下文顺序：静态系统提示词 → 最近历史 → 最后一条 user（动态记忆/表情状态 + 当前用户文本）；动态状态不要放回系统前缀。
- 打字延迟：`src/delivery.js`；仅 QQ/OneBot，按字数计时，纯表情包跳过，不同会话独立队列。
- 延迟配置：`replyDelay.enabled/typingIndicator/baseMs/msPerChar/maxMs/jitter`，设置页可调基础延迟、每字延迟、最大延迟和“正在输入”开关。
- 连续消息合并：`src/message-batcher.js`；仅 OneBot/官方 QQ，按会话+发送者合并，最后一条消息后等待 `inputDelayMs`（默认 2000ms）再开始 typing；单条也等待；网页本机不合并。`policy.cooldownMs` 只限制外发，不得丢弃入站消息。`inputDelayMs` 独立于 `replyDelay`，修改后需重启 Alice。
- 打断规则：静默期、AI 生成、搜索/抓取、结束判断、打字 delay 期间来新消息都立即中断当前轮，保留未回复消息并重新等待 `inputDelayMs`；调用 `adapter.send` 后不再中断，新消息进入下一批。
- 历史一致性：`Engine.handle(event,{signal,deferCommit:true})` 只生成草稿；进入发送边界时 `Engine.commitTurn(reply)` 写 user+assistant；发送前取消的草稿不写历史。
- 正在输入：`src/typing.js` + NapCat `set_input_status`；仅 OneBot 私聊，在 `inputDelayMs` 合并静默期结束后开始，按 `channel+scope+conversationId` 隔离；群聊/官方 QQ 跳过。
- 主动离开聊天：`src/chat-exit.js`；仅 QQ/OneBot 私聊，判断为收尾时跳过当前文字回复并记录 `data/chat-state.json`，下一条消息清除状态并正常回复。没有文字但摘要/标签是晚安、拜拜、去睡、离开等表情包也会终止。
- 空闲终止：`src/chat-activity.js`；Alice 最后一条消息发送成功后计时，默认 10 分钟无回复标记终止；用户回复重置。活动时间和连续未回复次数存 `data/chat-activity.json`。
- 收尾表情：OneBot 终止后用 `stickers.claim({force:true, mood})` 发一张表情，不发任何文字；官方 QQ 不支持图片，保持沉默。
- 主动回访：`src/follow-up.js`；终止判断返回 `followup_minutes`，有效范围 5–1440 分钟，23–8 点顺延；仅 OneBot 私聊，每次终止只回访一次，用户提前回复会清除状态。空闲终止复用同一流程；连续未回复次数会交给 AI，由它决定是否延长。
- 回访时间非法：先终止并发表情，后台立即连续带最近 20 条上下文让 AI 重选，直到合法；AI 请求失败则本次跳过，不用默认值。
- 回访状态：`data/chat-state.json` version 2；离线/暂停/发送失败按 5 分钟重试，不设过期；到期结合实际上下文生成短消息，走同一打字延迟/发送队列。
- 结束判断配置：`chatExit.enabled/idleMinutes/minConfidence/judgeModel/judgeTimeoutMs`；群聊和网页本机不生效。
- 定时空间：`src/autonomy.js`；`data/autonomy.json` 记录 `nextAt` 和 `quietDeferred`。启动时若已过期，立即补发 1 条并记录下次时间；错过多次也只补 1 条。
- 空间评论：`src/qzone-comments.js` + `src/qzone-web.js`；只处理自己说说和明确 @ 的空间链接。顶层评论和楼中楼都从 `emotion_cgi_msglist_v6` 的 `commentlist[].list_3[]` 获取；楼中楼用子评论 `tid` 直接走 `emotion_cgi_re_feeds` 回复。自己的说说在 Alice 参与过的线程有新楼中楼时回复，外部 @ 只发一条顶层评论并跟踪对 Alice 评论的新回复。
- 空间评论配置：`qzoneComments.enabled/dryRun/pollMinutes/activePollMinutes/activeWindowMinutes/pollJitterPercent/cookieRefreshMinutes/ownTrackHours/externalTrackHours/onlyFriends/allowedUsers/blockedUsers/maxRepliesPerCycle/maxRepliesPerHour/delayMinSeconds/delayMaxSeconds/maxReplyChars/aiDecide/nestedReplyFallback/replyPrompt`。跟踪时长和回复上限的 0 表示不限；`nestedReplyFallback` 默认 false，直发失败不回退到线程末尾。
- 空间评论无推送接口，只能轮询；发布/新说说/回复后进入活跃窗口，间隔逐级翻倍退避到 `pollMinutes`。
- 空间评论状态：`data/qzone-comments.json` version 2，不保存 Cookie；v1 会自动迁移并重新建基线，损坏时隔离为 `qzone-comments.corrupt-*.json`。
- 定时空间安静时段：启动补发忽略 23–8 点；正常运行中的定时仍顺延，重启不会误补。
- 天气/时间：`src/weather.js` 使用 Open-Meteo 读取南京当前天气、气温、体感、湿度、风速；提示词要求自然融入，不机械播报。天气失败仍发布，不编造天气。
- 回访 tick：FollowUpScheduler 每分钟触发 `autonomy.tick()` 和 `IdleExitScheduler.tick()`；空间检查、空闲终止和回访检查同步，失败不影响回访。
- 控制台：`127.0.0.1:3210`；可用 `node src/index.js --no-web` 或 `ALICE_DISABLE_WEB=1` 关闭 Web，OneBot/定时空间/回访继续运行。
- OneBot：`127.0.0.1:3001`。
- NapCat WebUI：默认端口 `6099`，实际监听地址见 `webui.json`；当前 `host` 为 `::`，建议改为 `127.0.0.1` 并启用强 token/访问控制。
- NapCat 目录：`napcat/NapCat.52230.Shell`。
- 表情库：全局共享；主动发表情约 5 分钟软间隔，用户发来表情时优先回且不受间隔限制；主回复默认不注入标签，主动发表情先调 `sticker_catalog` 取全量标签，再调 `send_sticker`；用户明确要表情或收到表情包可直接发。标签可在 Web 编辑，手动上传必须手写标签。聊天退出判断注入全量标签。
- 历史：按会话隔离。
- 长期记忆：私聊按账号、群聊按群隔离；群记忆群内共享。
- 自动记忆：`src/memory.js` 在回复成功后异步判断并保存，失败不影响回复；明确“记住”请求直接保存。
- 记忆配置：`memory.enabled`、`autoExtract`、`minImportance`、`maxPerKey`、`maxInjected`、`judgeModel`、`judgeTimeoutMs`。
- 记忆注入顺序：重要度降序 → 最近访问 → 创建时间，之后截取 `maxInjected`。
- 回忆搜索：`recall` 工具由 `src/search.js`、`src/store.js` 和 `src/adapters/onebot.js` 协作；先搜当前范围长期记忆，再搜当前会话本地最近 80 条，OneBot 再按页拉取最近 7 天历史；私人往事仍无结果时要求 AI 如实说忘记，不编造。
- 联网搜索：`src/web-search.js` 调用 DeepSeek `/v1/tools/search` 和 `/v1/tools/fetch`；`webSearch.apiKey` 优先，留空复用 `ai.apiKey`；`src/engine.js` 提供 `web_search` / `web_fetch` 工具。
- 联网规则：私聊/本地由 AI 按需判断，闲聊不搜索；群聊只有用户明确说“搜一下/查一下”等才允许，运行时也拦截；默认每轮最多 4 次联网、6 次工具调用；搜索结果不写入历史。
- 搜索兜底：本地记忆未命中时，私人往事直接说忘记；公开知识/实时信息改用 `web_search`，网上也没有再如实说不知道。
- 搜索体验：搜索期间保持“正在输入”（仅 OneBot 私聊），不发送“我搜一下/稍等”等过程消息，拿到结果后才生成最终答复。
- 搜索配置：`webSearch.enabled`（总开关）、`searchEnabled`、`fetchEnabled`、`apiKey`、`maxResults`、`maxContentChars`、`maxCallsPerTurn`，以及顶层 `maxToolCallsPerTurn`；默认开启、5 条、6000 字、4 次联网、6 次工具。
- 记忆存储：`data/store.json` version 2；v1 启动时自动迁移并备份到 `data/backups/`。

## 修改后检查

- [ ] 已备份。
- [ ] `npm test` 通过。
- [ ] `npm run check` 通过。
- [ ] 改了前端时 `node --check public/app.js` 通过。
- [ ] 已重启 Alice 并检查 3210/3001 端口。
- [ ] 已更新 README 或 `docs/MAINTENANCE.md`（行为/配置变化时）。
- [ ] 没有把密钥或运行数据写入代码/文档。
