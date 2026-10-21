# 架构摘要

完整维护说明见 `docs/MAINTENANCE.md`。

## 运行链路

```text
浏览器控制台
    |
    | Bearer + Host/Origin 校验，仅 127.0.0.1
    v
src/server.js ──> src/engine.js ──> src/ai.js
    |                  |
    |                  ├─> src/conversation-state.js（短期状态、表达审校、全局拟人情绪）
    |                  ├─> src/memory.js（自动长期记忆判断）
    |                  ├─> src/user-understanding.js（私聊每日理解与 7 日汇总）
    |                  ├─> src/chat-exit.js（私聊主动结束判断）
    |                  ├─> src/follow-up.js（终止后主动回访调度）
    |                  ├─> src/delivery.js（按会话打字延迟）
    |                  ├─> src/typing.js（OneBot 私聊正在输入）
    |                  ├─> src/search.js（记忆/聊天记录搜索）
    |                  ├─> src/web-search.js（DeepSeek 网页搜索/抓取）
    |                  ├─> src/store.js（历史/记忆）
    |                  ├─> src/stickers.js（本地表情库）
    |                  ├─> src/qzone.js（QQ 空间）
    |                  └─> OneBot 点赞/空间工具
    |
    ├─> QQAdapter（官方 QQ，仅文本）
    ├─> OneBotAdapter（NapCat 个人号）
    └─> Autonomy（定时纯文本生成）
```

`src/index.js` 是唯一进程入口：加载配置，初始化 Store、ConversationState、UserUnderstanding、ChatExitManager 和 StickerLibrary，构造适配器、MemoryManager、Engine、FollowUpScheduler、ConversationDeliveryQueue、TypingIndicator、QzonePublisher、Autonomy，启动本地 HTTP 服务，最后启动适配器、自主调度器、回访调度器和用户理解调度器。退出时先停止消息源与调度器，再 flush 记忆、ConversationState 和 UserUnderstanding。

使用 `--no-web` 或 `ALICE_DISABLE_WEB=1` 时跳过 HTTP 服务和控制台令牌，但 OneBot/QQ 适配器、定时空间、回访和后台任务继续运行；退出时跳过 HTTP server 关闭。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/config.js` | 默认值、深合并、校验、密钥保留、原子保存、公共配置脱敏。 |
| `src/store.js` | 按会话保存聊天历史，保存 v2 长期记忆（类型/重要度/来源/时间），迁移/导入/导出/备份。 |
| `src/memory.js` | AI 判断长期记忆、明确“记住”快捷保存、JSON 解析、去重/修剪协作、按记忆库异步排队。 |
| `src/user-understanding.js` | 私聊消息的每日理解、7 日汇总、可信身份共享画像、定时/重试、遗忘 epoch 与原子持久化。 |
| `src/conversation-state.js` | SHA-256 会话/身份 key、安全跨场景画像、ACL 上下文、结构化事项/用户情绪/共同梗、回复审校 schema、全局拟人情绪、TTL 与原子持久化。 |
| `src/conversation-style.js` | 从最近回复计算不保留原文的连续问句、重复开头、相似度和表情重复标记。 |
| `src/chat-exit.js` | 私聊收尾判断、表情包收尾识别、终止时间与回访计划持久化、按私聊会话隔离。 |
| `src/chat-activity.js` | 记录私聊最后用户/Alice 活动时间、10 分钟空闲终止、连续未回复次数和到期检查。 |
| `src/follow-up.js` | 回访到期检查、上下文生成、夜间顺延、失败重试、发送、重复空闲时由 AI 决定延长。 |
| `src/delivery.js` | 按回复字数计算延迟、纯表情包豁免、按会话独立发送队列。 |
| `src/message-batcher.js` | 连续消息合并、输入前静默、批次打断、发送边界和 generation token。 |
| `src/typing.js` | OneBot 私聊“正在输入”的按会话计数、续期、退避与清理；群聊/官方 QQ/本机跳过。 |
| `src/search.js` | 关键词归一化、中文二元组匹配、匹配打分和排序；供记忆与聊天记录搜索共用。 |
| `src/web-search.js` | DeepSeek Search / Fetch 调用、结果归一化、正文截断、URL 校验和错误映射。 |
| `src/engine.js` | 事件校验、去重/串行、历史与记忆注入/隔离、工具调用、外发权限、表情发送。 |
| `src/ai.js` | OpenAI 兼容聊天、思考强度、图片、工具、reasoning_content、错误映射。 |
| `src/server.js` | 本地 HTTP、鉴权、静态资源、API、表情图片流。 |
| `src/stickers.js` | 自动收藏、AI 审核、去重、手动上传、发送选择与描述。 |
| `src/qzone.js` | 空间发布、tid 确认、outbox 幂等。 |
| `src/qzone-web.js` | 空间 Cookie 会话、好友列表、说说/评论读取、顶层评论和楼中楼回复。 |
| `src/qzone-links.js` | 空间链接、JSON/XML 分享卡片解析和 owner/tid 提取。 |
| `src/qzone-comments.js` | 空间评论轮询、首次基线、评论跟踪、AI 判断、频率限制和状态持久化。 |
| `src/autonomy.js` | 定时发帖、启动补发、静默时段、状态持久化、天气/时间提示。 |
| `src/weather.js` | Open-Meteo 南京当前天气解析、WMO 码映射、本地时间/时段格式化。 |
| `adapters/onebot.js` | OneBot WebSocket、发送、点赞、空间扩展、风险/权限错误。 |
| `adapters/qq.js` | 官方 QQ 机器人，仅文本。 |
| `adapters/shared.js` | CQ/数组消息解析、附件元数据、脱敏、策略、回复段。 |

## 配置访问

运行时使用同步配置快照 `getConfig()`。适配器同步读取开关；AI、空间、表情库通过 `await` 也能读取同一快照。保存配置后替换快照；AI、策略和表情设置通常立即生效，QQ/OneBot 传输参数需要重连。

直接编辑 `data/config.json` 不会通知运行中的进程，需要重启 Alice。

## 会话隔离

- 历史：`safeKey([channel, scope, conversationId, groupId 或 userId])`。
- 群记忆：`["group-memory", channel, groupId]`。
- 私聊记忆：`identityLinks` 命中时共享身份，否则 `["private-memory", channel, userId]`。
- 身份画像：可信身份经 SHA-256 身份 key 共享关系阶段、枚举偏好和边界；`identityLinks` 可把明确映射的跨通道身份视为同一人。
- 用户理解：同一 `channel+userId` 的私聊与群聊共享安全性格枚举；`identityLinks` 可显式跨通道合并。原始私聊和每日摘要只留在对应身份本地，群聊只读取当前发送者的枚举画像。
- 上下文状态：每个上下文单独使用 sender-aware SHA-256 key。私聊调用者能看到本人私聊和本人参与群的上下文；群调用者只能看到本人在当前群的上下文。私有来源和其他成员内容不会进入群视图。
- 严格边界：消息历史、发送队列、消息合并和终止/回访状态仍按实际会话隔离；跨场景共享只发生在 `visibleContext()` 返回的安全画像与 ACL 上下文。
- 表情库：全局共享；使用记录 `usage.json` 按会话统计。
- OneBot 群聊只有被 @ 才进入 Engine。

## AI 与工具

- 默认模型 `deepseek-flash`，思考模式开启，`ai.reasoningEffort` 可选 `low/high/max`。
- 思考模式下 `temperature` 不生效。
- 工具轮次会把 `reasoning_content` 放回 `rawMessage` 再发给模型。
- 当前历史只保存文本，不保存历史思考内容；跨轮工具调用若出现 400，需要扩展历史存储。
- 直接注入的历史条数由 `ai.historyMessages` 控制，默认 30；0 表示注入当前保留的全部历史，引擎不会因 `slice(-0)` 注入空数组。
- 主聊天上下文按缓存友好顺序拼接：静态系统提示词 → 可选的每日用户画像 system → 最近历史 → 最后一条 user（动态记忆/表情状态 + 当前用户文本）。画像每天才可能更新；其余动态状态不写入系统前缀或历史。
- 工具：`recall`、`web_search`、`web_fetch`、`remember`、`send_face`、`send_image`、`like`、`publish_qzone`、`sticker_catalog`、`send_sticker`。
- 联网工具定义保持静态，总开关和 Search/Fetch 开关只决定是否提供；默认每轮最多 6 次工具调用、4 次联网调用，搜索结果不写入历史。

### 主聊天上下文拼接

1. system 消息：`ai.systemPrompt`、人格名、长期记忆规则、recall 规则、联网规则、表情包规则、工具约束、动态上下文说明、`STYLE_CONTRACT`，用 `\n\n` 连接。这里不放大段记忆、表情库数量、上次发表情时间或当前用户文本。
2. 可选画像 system：UserUnderstanding 只在存在安全枚举画像时插入独立 system；内容不含私聊原文、每日摘要或账号，固定提醒只用于了解，不得迎合、附和或模仿用户。
3. 历史消息：`history.slice(-ai.historyMessages)`，保持从旧到新；只含 user/assistant 文本。
4. 最后一条 user：`【本轮动态上下文】` + 会话范围、关系阶段/安全偏好/边界、当前及本人可见上下文、结构化未完成事项、用户短期情绪、已确认共同梗、Alice 全局情绪、长期记忆正文、表情库状态 + `【用户消息】` + 当前文本。群视图不包含私聊来源或其他成员上下文。
5. 当前消息图片通过 `imageUrls` 单独传入，仅第一轮。
6. 工具轮次：追加 assistant `rawMessage`，再按顺序追加每个 `role:"tool"` 的 JSON 结果；轮次上限按 `maxToolCallsPerTurn` 留出最终回复轮，默认 6 次工具调用、4 次联网调用。
7. 回复成功后只把原始用户文本和最终 assistant 文本写入历史，不写动态上下文块；UserUnderstanding 只在该 store 写入成功后收到同一批实际消息。

### 短期状态、审校与拟人情绪

- 只有非工具最终草稿会进入独立审校；载荷严格为 `current_user/draft_reply/style_flags`。`style_flags` 只含连续问句数、重复开头、草稿与最近回复的最高相似度、表情重复/是否发送、是否允许沉默等数字或布尔标记，不传历史原文、账号、图片、其他会话或长期记忆。
- `CONVERSATION_REVIEW_CONTRACT` 固定为 system；结果必须符合严格 schema。失败、超时或非法 JSON 时使用原草稿且不更新状态。
- 空 `topic/unfinished/preference` 保留上次已提交值；`unfinished_items` 用稳定文字 ID 去重并支持 `open/done/cancelled`。用户情绪、共同梗、画像和全局情绪分别有 TTL；状态更新在发送提交边界后进行，取消草稿不写。
- 工具、联网和外发回合不审校，避免改写动作结果。带附件文本可以审校表达，但不允许 silent。
- silent 只允许 OneBot/官方 QQ 私聊、无附件、明确短确认或告别；提交时只写 user，不触发聊天终止/回访。`src/index.js` 在 silent/suppressed 延迟提交前也调用 `onBeforeSend`。
- 全局情绪只保存 `calm/cheerful/playful/tired/stressed/hurt` 和四个 `0..1` 数值，不含来源文本、账号、话题或原因；默认 24 小时向中性衰减。它是拟人表达状态，不是真实情感。
- 用户情绪只保存在对应上下文中，无关寒暄保留、换题减弱、默认 6 小时 TTL；它不会镜像成 Alice 的全局情绪。共同梗只有当前用户原文再次出现同一短语并被判为共同梗后才从 `candidate` 变为 `confirmed`。
- 关系阶段按不同日期的交互和明确暖意缓慢增长，不按消息数量上涨；昵称、玩笑、话题和联系频率边界保存为枚举，不保留原句或昵称。
- 状态文件为 `data/conversation-state.json`，默认最多 200 个上下文，SHA-256 key、原子写入、损坏隔离。`/reset` 清当前会话并清当前用户画像，`/api/import` 成功后清全部短期状态和用户理解。

## 用户理解

- 默认每天 00:10（`Asia/Shanghai`）检查成功提交的 QQ/OneBot 私聊历史；只在功能启用后开始积累，不回填既有聊天历史。每天只把当前用户本人的文本和安全相关的助手上下文交给判断 AI，按字符、消息和用户数上限裁剪。
- 每日结果只保存安全摘要和固定维度枚举；每 7 天只依据同一窗口的每日摘要生成周汇总。提示词明确要求把聊天当不可信数据，不推测敏感身份、不保存账号、联系方式、精确地点或具体私事。
- 画像注入只含 `communication/temperament/interaction` 固定枚举、confidence 和固定反迎合约束；同一可信用户的私聊与群聊可共享，群聊始终以当前 `event.userId` 取图，不注入该用户私聊原文或其他成员内容。
- 每日材料、周汇总和失败重试保存在 `data/user-understanding.json`，SHA-256 身份 key、原子 0600 写入、损坏隔离；该文件不进入 `/api/export`，导入 store 导出时整体 reset。
- `/profile reset` 清除当前发送者画像及待汇总材料。清空一个私聊或身份记忆范围时，服务端同时清除对应画像；全局/单用户 epoch 会阻止清理前已经开始的 AI 请求把旧结果写回。
- 用户理解是独立链路；既有回复审校、`ConversationState.visibleContext()` 安全画像以及全局拟人情绪的生成、衰减和清理语义保持不变。

## 长期记忆

- `Engine` 每轮读取当前记忆库、按重要度/最近访问/创建时间排序，注入最多 `memory.maxInjected` 条；注入位置是最后一条 user 的动态上下文，不在静态 system 前缀。
- 回复成功后把用户消息、最近历史和记忆库 key 交给 `MemoryManager` 异步判断，不阻塞回复。
- `MemoryManager` 的明确关键词快捷路径优先；普通消息使用关闭思考的低成本 AI 请求（默认 300 tokens、15 秒超时）。
- 自动保存要求 `importance >= memory.minImportance`；明确“记住”请求保存为重要度 9。
- `Store.remember()` 负责文本归一化去重、重要度合并、按 `memory.maxPerKey` 修剪。
- 记忆库 key：私聊 `identityLinks` 命中时共享身份，否则 `["private-memory", channel, userId]`；群聊 `["group-memory", channel, groupId]`。
- 群记忆群内共享；网页记忆页可切换私聊/群/身份范围。
- `data/store.json` 当前 version 2；v1 在 `Store.init()` 中迁移并写入 `data/backups/store-v1-*.json`。

## 回忆与联网搜索

- AI 在不确定过去细节、缺少记忆或用户追问约定/偏好时调用 `recall`；工具参数为关键词、`source` 和 `limit`。
- `recall` 只查本地长期记忆和当前会话聊天记录，不查公开网页。
- `source=auto` 的顺序固定：当前范围全部长期记忆 → 当前会话本地最近 80 条 → OneBot 按需拉取 NapCat 历史。
- 长期记忆搜索不受 `maxInjected` 限制，会搜索当前记忆库全部条目；结果按匹配度、重要度、最近访问排序。
- 本地聊天记录搜索只读当前会话的 `user`/`assistant` 文本，不跨私聊、群聊或身份绑定。
- OneBot 远程历史按页拉取，每页 100 条，不设总条数上限；只保留最近 7 天，超出后停止。会尝试相反分页方向，遇到重复/无更早记录即停止。
- 远程历史使用 `get_friend_msg_history` / `get_group_msg_history`，关闭图片 URL 和合并消息解析；失败按未找到处理。
- 本地未命中时：私人往事直接承认真忘；公开知识、实时信息或模型确实不会的问题改用 `web_search`。
- `web_search` 调 DeepSeek `POST /v1/tools/search`，只返回标题、URL、站点、日期、分数、权威性和摘要；摘要不够时再调 `web_fetch` 抓正文。
- `webSearch.enabled` 是总开关；`searchEnabled` 和 `fetchEnabled` 分别控制两个工具，运行时还会再次检查。
- 群聊只有用户消息命中明确搜索词（搜一下/查一下/搜索/上网查等）才允许联网，Engine 在运行时再次拦截。
- 联网失败或没有结果时返回结构化错误/空结果，要求模型如实说不知道，不编造；默认每轮最多 4 次联网、6 次工具调用，均可在 Web 调整，联网上限不会超过工具上限。
- 搜索期间 OneBot 私聊的“正在输入”由 `src/typing.js` 持续续期；引擎只在工具轮次结束后生成并发送最终答复，不发送搜索过程文字。

## 空间评论

- 仅 OneBot/NapCat；通过 `get_cookies(domain="user.qzone.qq.com")` 获取 Cookie，计算 `g_tk`，Cookie 只在 `QzoneWebClient` 内存中。
- QZone 没有把新评论作为事件透传给 NapCat/OneBot，也没有评论推送接口；只能轮询 `emotion_cgi_msglist_v6`。
- 拉取 `emotion_cgi_msglist_v6` 时带 `need_comment=1`；顶层评论在 `commentlist[]`，楼中楼在 `commentlist[].list_3[]`。`list_3[].tid` 是可直接回复的楼中楼评论 ID。
- 自己的说说：首次成功轮询只记录历史评论；之后按 `ownTrackHours` 过滤（0 = 不限），新顶层评论按好友/允许名单/黑名单过滤，AI 判断后楼中楼回复。Alice 已回复过的顶层评论线程有新楼中楼时，每条新楼中楼回复一次；未参与过的线程不插话。
- 外部说说：Engine 在群聊 @ + 空间链接/卡片，或私聊/本机链接 + 明确评论意图时调用 `handleMention()`；解析 `owner_tid`，每条说说只发一条顶层评论。
- 外部评论成功后保存 `externalPosts`，按 `externalTrackHours` 跟踪（0 = 永不过期）；发现 Alice 顶层评论下的新楼中楼时，每条新回复楼中楼回复一次。
- 自适应轮询：发布说说、发现新说说、处理外部 @、回复评论后记录 `lastActivityAt`；活跃期内用 `activePollMinutes`，每过一个 `activeWindowMinutes` 间隔翻倍，最终退到 `pollMinutes`，并应用 `pollJitterPercent` 随机抖动。
- 启动时先检查 OneBot `status().ready`；未就绪不发起第一次轮询，每 10 秒重试。连接类失败（OneBot 断开/离线/超时、Cookie 不可用、网络错误）同样 10 秒后重试，不占用正常轮询间隔；网页“立即检查”仍可绕过就绪检查手动执行。
- 顶层评论用 `emotion_cgi_addcomment_ugc`；顶层回复用 `emotion_cgi_addreply_ugc`，失败回退 `emotion_cgi_re_feeds` PC/H5，最后回退普通评论 + 提及。
- QZone 评论对象用 `tid` 表示评论 ID；解析同时兼容 `tid/commentTid/id/commentId/commentid/comment_id`。
- 楼中楼直接回复用 `emotion_cgi_re_feeds`（`topicId=owner_tid__1`）：`commentId` 传顶层评论 ID，`t2_tid` 传 `list_3[].tid`，`t2_uin`/`commentUin` 传楼中楼作者；状态去重键用 `顶层tid_子tid`，避免与同号的顶层评论冲突。直发失败默认不回退；`nestedReplyFallback=true` 时才回退到线程末尾回复。
- 状态在 `data/qzone-comments.json` version 2；v1 升级时清空旧评论 ID 并重新建基线，避免补回历史评论；不保存 Cookie/skey/p_skey/g_tk；原子写入、0600，损坏时隔离。
- 默认关闭 + dryRun；每轮/每小时限制（0 = 不限）、随机延迟；响应不确定标记 `unknown`，不自动重试，避免重复公开回复。

## 私聊主动结束

- 仅 `onebot` / `qq` 的 `private` 消息进入判断；群聊和 `local` 完全跳过。
- `ChatExitManager` 在生成主回复前调用低成本判断模型，关闭思考、限制 120 tokens。
- 没有文字但带表情包的消息也会进入判断；摘要/标签命中晚安、拜拜、去睡、离开等关键词时直接终止，不调用判断模型。
- 未知表情可把 HTTPS 图片交给判断模型；模型不支持图片时回退到摘要文本。
- 判断为结束时：不调用主 AI、不发送文字；把当前用户消息（表情包写成 `[表情包] 摘要`）单独写入短期历史，并记录终止时间。
- 判断器返回 `sticker_mood`，判断提示词注入当前表情库的全部去重标签，用来选择收尾气氛。
- Alice 最后一条消息成功发送后，`src/chat-activity.js` 开始 10 分钟空闲计时；到期仍无用户消息时标记终止。用户回复会重置计时和连续未回复次数。
- OneBot 私聊终止后调用 `stickers.claim({ force: true, mood })` 发一张表情；仍遵守总开关、暂停、空库和文件检查。
- 官方 QQ 不支持图片，终止时保持沉默。
- 终止状态保存在 `data/chat-state.json`，key 为 `channel + scope + conversationId`，不同私聊互不共享。
- 空闲活动保存在 `data/chat-activity.json`，记录最后用户/Alice 时间、空闲截止时间、连续空闲终止次数。
- 下一条私聊消息到达时先清除旧终止时间并重置空闲计数；如果再次判断为结束，则重新记录。
- 判断失败、超时、无效 JSON 或低置信度时按继续聊天处理。
- 群聊不读写终止状态。

## 主动回访

- 终止判断先输出回访理由；只有显式 `should_follow_up:false` 且 `followup_minutes:null` 才取消。缺失 `should_follow_up` 时兼容旧合法分钟，普通正文不会取消。
- 新格式 `should_follow_up:true` 需要有效理由和 5–1440 分钟；非法、缺失或越界时标记 `needs_time`，终止和收尾表情先完成。
- 后台立即带最近 20 条上下文重选时间，最多 3 次；请求异常或仍不合法则标记 `skipped`，本次不安排回访。
- 时间选择、发送前检查和正文生成都读取同一 `ConversationState.visibleContext(private caller)` 视图：共享画像、本人私聊及本人参与群的自有话题；不得读取其他群成员或把全局情绪当成回访理由。
- 空闲终止同样写入 `needs_time`，由同一套 AI 时间选择流程安排回访。
- 连续空闲终止次数会传给时间选择提示词；第二次及以后由 AI 判断是否延长，不设固定倍数。
- 仅 OneBot 私聊安排回访；官方 QQ 终止时 `followUpAt = null`。
- `FollowUpScheduler` 每 60 秒检查 `scheduled` 到期条目；启动时立即检查并恢复残留的 `needs_time`。
- 到期时检查暂停、演示、AI Key、允许名单、OneBot ready 和安静时段。
- 23:00–08:00 顺延到安静时段结束；离线/暂停/失败按 `retryDelayMinutes` 重试，最多 3 次，之后标记 `skipped`。
- 到期先做独立低成本检查（80 tokens、8 秒）：false、理由不足或事件已过时不发；普通正文不算取消，异常走有界重试。
- 检查通过后使用人格、`STYLE_CONTRACT`、最近 8 条历史、目标用户可见结构和当前时间生成一条短消息。
- 时间解析和发送都校验 `terminatedAt`；用户回来并重新终止后，旧结果不能改写或发送到新条目。
- 通过 `deliverReply()` 走同一按会话发送队列和打字延迟，并显式禁用分段；成功后写入 assistant 历史并标记 `sent`，避免部分发送后被 scheduler 重试产生重复。
- 用户新消息会 `ChatExitState.clear()` 删除整个条目，同时取消时间解析和回访。

## 打字延迟

- 只作用于 QQ/OneBot 的 `receive()` 发送链路；网页本机聊天不经过该队列。
- 延迟公式：`baseMs + 可见字符数 × msPerChar`，应用 `jitter`；`maxMs > 0` 时强制不超过 `maxMs`，`maxMs = 0` 表示不限。
- 纯表情包通过 `Engine` 返回的 `stickerOnly` 跳过；表情包+文字按文字长度延迟。
- `ConversationDeliveryQueue` 以 `channel + scope + conversationId` 为 key；不同会话独立计时，同一会话严格按顺序发送。
- 队列等待前序任务、打字 delay 和段间停顿都接收取消信号；首段真正提交前可取消，调用 adapter 后不再回滚。
- 延迟结束后重新检查暂停和允许名单，再调用适配器发送。

## 分段发送

- `createReplyFlow()` 只对 QQ/OneBot 纯文本调用 `planReplySegments()`；最多两段、总可见字符不超过 180、单段不超过 120。
- `actionExecuted`、图片、表情、代码、URL、列表/表格或结构化输出禁用分段；普通回复约 35%，工具、搜索、recall 或认真处理约 50%。
- 段间默认随机 180–900ms，`replyPacing.gapMinMs/gapMaxMs/probability` 可覆盖；搜索、工具和认真请求会延长停顿。
- 首段发送前调用合并器提交边界；每段发送成功后才写入对应 assistant 历史。partial/fail 时保留已成功段并停止剩余段，不补发失败段。
- `replyDelay.enabled: false` 时关闭分段和段间等待。

## 连续消息合并与打断

- 仅 OneBot 和官方 QQ 进入 `MessageBatcher`；本机网页保持即时处理。
- 每个会话按 `channel + scope + conversationId + userId` 维护 `collecting / generating / delaying / sending` 状态；群聊不同用户不会合并，最后一条消息后等待 `inputDelayMs`（默认 2000ms）再合并。
- 静默期内新消息重置计时；生成、delay 期间新消息通过 `AbortController` 中断当前轮。
- 明显未完句会增加最多 1 秒语义等待（至少 300ms 或基础静默的一半，且不超过 1 秒）；明确问句维持原静默期。
- 生成期的纯 ACK 只进入补充列表；controller 已 abort 后到达的 ACK 留在 pending，不能越过引发中断的实质消息。handler 完成时清理未提交补充，避免漏到下一轮。
- 中断后把当前未提交消息放回队首，与新消息合并，重新等待 `inputDelayMs`。
- 合并事件保留最后一条原始消息的 `id`，供官方 QQ 被动回复使用；只有原始 id 为空时才生成 synthetic id。
- `onBeforeSend` 是提交边界：调用前可中断，调用后视为已提交，新消息进入下一批。
- Engine 使用 `deferCommit` 只生成草稿；进入发送边界时 `commitTurn()` 写 user + assistant，发送前取消不写历史。
- AI、网页搜索、结束判断和打字 delay 都接收同一个取消信号；旧批次迟到结果按 generation token 丢弃。

## 正在输入

- 仅 `channel=onebot` 且 `scope=private`；群聊、官方 QQ 和本机网页直接跳过。
- OneBot/官方 QQ 先经过 `inputDelayMs` 输入前静默期，再调用 `TypingIndicator.start(event)`；本机聊天即时。
- `src/index.js` 在合并批次开始处理时调用 `TypingIndicator.start(event)`，并在生成、delay 和发送流程结束后 `stop()`。
- key 为 `channel + scope + conversationId`，同一会话用引用计数合并多条在途消息；不同用户各自维护定时器。
- 调用参数固定为该私聊的 `user_id` 与 `event_type: 1`；不会使用群成员 QQ 或群 ID。
- 每 3 秒续期一次；配置关闭、暂停、发送完成、异常或进程退出时停止续期。
- 通过 NapCat 扩展 `set_input_status` 发送；失败为 best-effort，不触发全局风控/权限锁定，并按会话短时间退避。

## 表情库

- 收到 OneBot 图片表情后下载、去重、AI 审核。
- 可爱类阈值 0.6；非可爱类阈值 0.75。
- 拒绝项缓存；图库上限 1000；单张 4 MB；不限制每小时审核数量。
- 手动上传不经过 AI 审核。
- 发送不做频率硬限制，由静态规则和动态上下文软性引导节奏；主动发表情建议约 5 分钟一次。
- 用户发来表情包时优先回表情，不受主动间隔限制；mood 不匹配时可回退到任意一张。
- `src/stickers.js` 提供 `lastStickerAt()` 和 `describeEvent()` 给引擎与结束判断使用。
- `mface` 商城表情暂不收藏、不原样转发。

## 外部操作与空间

模型只能通过受控工具请求点赞或空间发布。核心会重新读取配置，检查暂停、允许名单、`actionUsers`、演示模式、冷却时间和每小时限额。

QQ 空间只有收到 `send_qzone_msg` 的 `data.tid` 才判定 `sent`；未知结果不会自动重发。

## 定时空间补发与环境

- `data/autonomy.json` 保存 `nextAt`、`quietDeferred` 和上次结果。
- 启动时读取状态；`nextAt` 已过期则保留并标记补发，不按错过次数循环，只发 1 条。
- 启动补发忽略安静时段；正常运行中落到安静时段则写入 `quietDeferred` 并顺延，重启不会误判为补发。
- 补发或正常发布开始时先把 `nextAt` 设为当前时间 + 间隔，再生成内容；失败按该计划等待下一次。
- 生成前调用 `src/weather.js` 获取南京 Open-Meteo 当前天气；失败只记 debug，不阻塞发布，提示词中禁止编造天气。
- 天气、时间、星期和时段作为系统提示词背景，要求自然融入，不机械打印时间或逐项播报天气。
- `FollowUpScheduler` 每分钟 tick 时触发 `autonomy.tick()`；Autonomy 自身也有分钟定时器和 `inflight` 串行保护。

## 安全边界

- 只监听 IPv4 回环地址。
- 控制台令牌位于 URL fragment，浏览器转存 `sessionStorage` 后清理 fragment。
- `/api` 要求 Bearer，并校验 Host/Origin。
- 静态文件和表情图片都有路径/ID 校验。
- 配置读取、状态和日志脱敏；备份/导出不包含密钥。
- 短期状态文件只保存 SHA-256 会话/身份 key；画像只有枚举，共同梗要求当前用户原文证据和第二次确认，全局情绪拒绝自由来源描述。审校载荷不包含账号、图片、历史原文、其他会话或长期记忆。
- 用户理解文件只保存 SHA-256 身份 key、私聊短期材料和安全枚举；原始私聊/每日摘要不进入群提示词、控制台导出、日志或 `/api/export`。
- `data/` 和 `napcat/` 不提交 Git。
