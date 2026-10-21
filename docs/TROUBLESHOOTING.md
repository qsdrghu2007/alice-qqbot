# 常见问题

完整维护说明见 `docs/MAINTENANCE.md`。

## 端口被占用

修改 `data/config.json` 的 `port`，或关闭占用 `3210` 的程序。服务只绑定 `127.0.0.1`。修改文件后需要重启 Alice。

## 找不到控制台令牌

令牌只在启动终端打印一次。重启 Alice 后用新链接；浏览器关闭后 `sessionStorage` 也会失效。

如果启动时用了 `--no-web` 或 `ALICE_DISABLE_WEB=1`，控制台本来就不会启动，也不会打印令牌；OneBot 仍在运行。去掉参数/环境变量后重启即可恢复网页。

## OneBot 一直未连接

检查：

1. NapCat 是否已人工登录 QQ。
2. OneBot WebSocket 是否开启，默认 `ws://127.0.0.1:3001`。
3. `data/config.json` 的 `onebot.url` / `onebot.token` 是否与 NapCat 一致。
4. 修改传输配置后，在诊断页点击“重连”。

## QQ 空间 TLS 断开

典型错误：

```text
Client network socket disconnected before secure TLS connection was established
```

常见原因是 VPN/代理的 fake-IP 或分流规则。处理：

1. 关闭 VPN/代理，或把 `*.qzone.qq.com` 配为直连。
2. `ipconfig /flushdns`。
3. 确认 `user.qzone.qq.com` 不再解析到 `198.18.x.x`。
4. 再重试；上次失败若记录为 `failed`，同文重试通常安全。

## 空间发布显示 unknown

请求可能已到达 NapCat，但响应没有 `tid`。不要立即重复发布；先到 QQ 空间核对，再查看 `data/qzone-outbox.json`。系统会对相同正文阻止自动重发。

## 启动后没有补发空间

检查：

- `autonomy.enabled`、`qzone.enabled`、`qzone.autoPublish` 是否开启。
- 是否处于演示模式、暂停、AI Key 缺失或 OneBot 未 ready。
- `data/autonomy.json` 的 `nextAt` 是否已经过期；`quietDeferred` 为 `true` 表示正常安静时段顺延，启动不会当作补发。
- 网页“定时空间”是否显示 `catchUp` / 逾期状态。
- 天气失败不会阻止补发；查看终端是否有 `Autonomy weather failed`。

## 定时空间在半夜补发

这是预期行为：启动时发现已逾期会立即补发，即使处于 23–8 点安静时段。正常运行中的下一次定时仍会顺延，不会半夜发。

## 表情没有自动收藏

检查：

- `stickers.enabled` 和 `stickers.autoCollect`。
- AI Key、模型是否支持图片。
- 表情是否为 OneBot 图片表情（`image` + `sub_type=1` 或“动画表情”摘要）。
- 是否被 AI 拒绝，查看 `data/stickers/rejected.json`。
- 图库是否达到 1000 张上限。
- 下载是否失败（URL 过期、VPN、网络）。

## 表情发不出去

检查：

- 图库是否为空，表情库是否关闭或全局暂停。
- 模型是否按提示词判断当前适合发表情；发送不再有硬性频率拦截。
- 主动发表情会先调用 `sticker_catalog`；如果日志里只有 `need_catalog` 没有 `send_sticker`，说明模型还没完成第二次调用。
- 主动发表情建议间隔约 5 分钟；用户发来表情包时不受此限制，会优先回表情。
- `data/stickers/usage.json` 可查看最近使用记录，但不会阻止发送。
- QQ 图片发送是否正常；表情以图片段发送。
- `mface` 商城表情目前不支持原样转发。

## 主动发表情太频繁

- 5 分钟只是提示词软限制，不会硬拦截；模型仍可能连续发。
- 可调大 `stickers.proactiveCooldownMinutes`，或在表情库页面关闭表情库。
- 用户发来表情时优先回表情，这类回复不受主动间隔限制。

## 手动上传失败

检查格式（PNG/JPEG/GIF/WebP）、大小（默认 4 MB）、图库上限、是否重复，以及是否手动填写了至少一个标签（最多 8 个）。接口错误码：

- `STICKER_DUPLICATE`
- `STICKER_LIBRARY_FULL`
- `STICKER_TOO_LARGE`
- `STICKER_TYPE_UNSUPPORTED`

## AI 返回 400

- 检查 Base URL、模型名和 API Key。
- 工具调用轮次需要回传 `reasoning_content`；当前同一轮工具调用已处理。
- 如果跨用户轮次的工具调用仍 400，需要扩展历史存储以保存思考内容。

## 上下文缓存命中低

- 主聊天应保持：静态系统提示词 → 最近历史 → 最后一条 user（动态记忆/表情状态 + 当前用户文本）。
- 安全画像、ACL 上下文、结构化事项、用户情绪、共同梗和全局情绪放在最后一条 user；不要把长期记忆正文、表情库数量、上次发表情时间、当前时间或用户文本放进 system 前缀。
- 表达审校的 system 保持静态，短 user 请求只含当前文本、草稿和无原文习惯标记；不要为省一次请求把审校内容塞进主聊天 system 前缀。
- 工具列表和 `sticker_catalog`/`send_sticker` 描述尽量保持静态；主回复不再注入标签，需要时由工具返回全量标签。
- 修改 `ai.systemPrompt`、`STYLE_CONTRACT` 或工具 schema 后，缓存会自然失效一次。
- 历史超过 `ai.historyMessages` 后会滚动截断，前缀会变化，这是窗口限制。

## 短期话题、未完成事项或偏好没有延续

- 检查 `data/config.json` 的 `conversationState.enabled/reviewEnabled` 是否为 `true`，以及 `ttlHours` 是否过短。
- 话题和未完成事项按来源 ACL：私聊只能看到本人私聊与本人参与群的自有话题；群只看到本人在当前群的自有话题。安全画像可跨同账号私聊/群共享，但私聊来源不会进入群视图。
- 空 `topic/unfinished/preference` 表示保留旧值；清除必须由审校显式返回字面 `true` 的 `clear_topic/clear_unfinished/clear_preference`。
- 只有进入发送提交边界才更新；被新消息打断的草稿不会留下状态。
- 查看 `data/conversation-state.json` 是否损坏并被隔离为 `conversation-state.json.corrupt-*`。

## 回复审校增加延迟或偶尔没有生效

- 审校只为非工具最终草稿调用一次；工具、联网和外发回合会跳过，这是为了不改写动作结果。
- AI Key/Base URL、`conversationState.judgeModel` 和 `judgeTimeoutMs` 会决定是否成功；失败时使用原稿且不更新状态。
- 审校没有历史原文，只收到连续问句、重复开头、相似度、表情重复等聚合标记；这些标记能提示常见重复习惯，但审校模型仍可能判断失误。
- 关闭 `reviewEnabled` 只用于排障；关闭后不再更新短期话题/事项/偏好和全局情绪。

## 全局情绪看起来串会话

- 这是有意设计：全局情绪由所有会话共享，但只包含抽象枚举和四个数值，不保存账号、群号、原文或来源描述。
- 情绪默认 24 小时向中性衰减；它只影响轻微语气，不代表真实情感或对某个用户的评价。
- 当前只在普通聊天提交时更新；聊天结束、回访、空间任务和工具回合不会更新。
- 成功导入会重置全局情绪；单个私聊的 `/reset` 只清该会话短期状态，不影响共享情绪。

## 用户情绪看起来持续太久

- 用户情绪与全局情绪是两层数据。用户情绪只属于对应 ACL 上下文，默认 6 小时 TTL，无关寒暄会保留、换题会减弱，不会镜像成 Alice 的全局情绪。
- 如果它在群聊中出现，检查是否来自当前发送者在该群的上下文；其他群成员和私聊来源本应被 `visibleContext()` 过滤。

## 终止后没有主动回访

- 只有 OneBot 私聊会安排回访；官方 QQ 和群聊正常不会回访。
- 检查 `followUp.enabled`、暂停状态、演示模式、AI Key、允许名单和 OneBot `ready`。
- 查看 `data/chat-state.json` 的 `followUpStatus`、`followUpAt`、`nextAttemptAt` 和 `lastError`。
- 如果当前是 23:00–08:00，回访会顺延到安静时段结束。
- 用户提前发来任意私聊消息会取消回访。
- 失败/离线/暂停会按 `retryDelayMinutes` 重试，最多 3 次后标记 `skipped`。

## 主动回访时间太晚或太早

- 检查 AI 返回的 `followup_minutes` 是否合理。
- 检查 `followUp.minMinutes`（至少 5）和 `maxMinutes`。
- 夜间顺延受 `followUp.quietHours` 和 `followUp.timezone` 控制。
- AI 没返回有效分钟数时不会使用默认值，而是标记 `needs_time`，后台立即带最近 20 条上下文重选，最多 3 次；请求失败或仍不合法则本次跳过。

## 主动回访一直重试

检查：

- `data/chat-state.json` 是否长期是 `scheduled`，`lastError` 是什么。
- OneBot 是否连接并 `ready`。
- 机器人是否暂停、演示模式或没有 AI Key。
- 模型生成是否超时/返回空文本。
- 发送是否被策略或适配器拒绝。
- 到期检查/生成/发送失败会按 `followUp.retryDelayMinutes` 重试，最多 3 次，之后标记 `skipped`。

## 用户回来了还收到回访

正常流程下，用户新消息会清除状态并取消回访。仍收到可能是：

- 用户消息和回访生成/发送几乎同时发生，存在极短竞态窗口。
- 状态文件没有正确清除，检查 `chatExit.clear()`。
- 另一个进程或旧实例仍在运行。

## 收尾消息仍然回复

检查：

- `chatExit.enabled` 是否为 `true`。
- `chatExit.minConfidence` 是否过高；默认 `0.75`。
- AI Key、判断模型和超时是否正常；判断失败会按继续聊天处理。
- 消息是否包含后续问题或明确继续话题，提示词会返回 false。
- 私聊是否在 QQ/OneBot 通道；群聊和网页本机不会判断。
- 终端是否有“聊天结束判断失败”或“返回了无效 JSON”。

## 10 分钟无回复后没有终止或回访

检查：

- `chatExit.enabled` 和 `chatExit.idleMinutes`；默认 10 分钟。
- 计时从 Alice 最后一条消息成功发送后开始；发送失败不会开始计时。
- 用户发来新消息会重置计时和连续未回复次数。
- `data/chat-activity.json` 是否有该私聊的 `idleDeadline`，以及 `data/chat-state.json` 是否出现 `needs_time`。
- 回访仍要求 OneBot 私聊、AI Key、未暂停；官方 QQ 只标记终止，不安排回访。
- 连续多次未回复时，回访时间由 AI 判断是否延长，可能比第一次更晚。

## 晚安表情没有触发终止

- 表情包没有文字时，优先看摘要和标签是否包含“晚安/拜拜/去睡/离开”等关键词。
- 查看 `data/stickers/index.json` 是否为该表情保存了可读 summary/tags；未知表情可能只有“动画表情”摘要。
- 如果表情有 HTTPS 图片，判断器会尝试让模型看图片；模型不支持图片时会回退到摘要。
- 普通可爱、搞笑、打招呼表情不会因为“是表情包”就终止。

## 终止后没有发收尾表情

- 只有 OneBot 私聊会尝试发图片；官方 QQ 私聊不支持图片，终止时保持沉默是正常行为。
- 检查表情库是否为空、`stickers.enabled` 是否关闭、机器人是否暂停。
- 收尾表情使用 `force: true`；发送已无频率硬限制，但仍受总开关、暂停、空库或文件检查约束。
- 查看终端是否有“发送终止聊天表情失败”或表情文件缺失日志。
- 收尾表情发送失败时不会回退成文字，这是预期行为。

## 收尾表情不够应景

- 判断器会根据当前表情库的全部标签选择 `sticker_mood`；库里标签越丰富，匹配越好。
- 检查 `data/stickers/index.json` 的 tags 是否包含“困倦、小情绪、可爱、呆萌”等标签。
- 可以在表情库预览页点“编辑标签”直接改，保存后立即生效。
- 没有匹配标签时会回退到任意一张可用表情。
- 可以手动上传更贴合收尾气氛的表情，或调整 `src/chat-exit.js` 的 `sticker_mood` 提示。

## 正常聊天被误判结束

- 提高 `chatExit.minConfidence`，例如从 `0.75` 调到 `0.85` 或 `0.9`。
- 检查 `src/chat-exit.js` 的 `CHAT_EXIT_SYSTEM_PROMPT` 是否仍明确要求“不确定返回 false”。
- 在网页关闭“主动离开聊天”，或把 `chatExit.idleMinutes` 调大后重启。
- 删除 `data/chat-state.json` 和 `data/chat-activity.json` 后重启，可清空终止与空闲计时。
- 查看 `data/chat-state.json` 和 `data/chat-activity.json` 确认被记录的私聊范围。

## 下一条消息没有恢复正常

- 私聊消息进入 Engine 时应先执行 `chatExit.clear(event)`。
- 检查 `data/chat-state.json` 是否仍保留该会话 key。
- 确认消息不是群聊或网页本机；它们不参与清除。
- 检查状态文件是否可写；损坏文件会生成 `chat-state.corrupt-*.json`。

## 两个私聊的终止时间串了

`chat-state.json` 的 key 必须是 `channel + scope + conversationId`，且只用于 `scope=private`。不要使用全局 key，也不要用 `identityLinks` 的共享身份 key。QQ 官方和 OneBot 即使同一个人也应分开。

## 回复没有打字延迟

检查：

- `replyDelay.enabled` 是否为 `true`。
- 是否在网页本机聊天里测试；本机聊天不经过 QQ 发送队列，不会延迟。
- 回复是否为空、纯表情包、纯图片或纯 face；这些不增加延迟。
- `replyDelay.baseMs`、`msPerChar`、`maxMs` 是否被设成了很小的值；`maxMs: 0` 表示不限制。
- 修改配置后是否保存；直接改文件需要重启。

## 私聊不显示“正在输入”

检查：

- 该功能只支持 OneBot/NapCat 私聊；群聊没有对应接口，官方 QQ 也不支持。
- OneBot/官方 QQ 会先等待 `inputDelayMs`（默认 2 秒）合并连续消息，再开始显示；刚发完消息时短暂不显示是正常的。
- `replyDelay.typingIndicator` 是否为 `true`，或设置页开关是否开启。
- `policy.paused` 是否为 `true`，该用户是否仍在 `allowedUsers` 中。
- NapCat 是否支持扩展接口 `set_input_status`；当前项目内置版本支持。
- 终端是否有 `typing indicator failed` 的 debug 日志；失败只忽略，不影响回复。
- 两个测试账号互发时，A 的窗口只应出现 A 的私聊输入状态；若串到别人，检查是否误用了群成员 `user_id` 或复用了全局 key。

输入状态停止续期后，QQ 通常会在消息发出时清除。若消息发出后仍长时间停留，先确认 NapCat/QQ 版本行为，不要直接盲发 `event_type: 0` 当作清除；不同来源对该值的含义并不一致。

## 快速连发只回一条或合并没生效

检查：

- 只有 OneBot 和官方 QQ 会合并；网页本机聊天保持即时，不会合并。
- 合并规则是“最后一条消息后等待 `inputDelayMs` 没有新消息”；如果一直在发，会一直推迟。
- 明显未完句会多等最多约 1 秒，并有批次硬上限；纯 ACK 在生成期作为补充保留，abort 后到达的 ACK 会排在引发中断的新消息之后。
- `inputDelayMs`、AI 生成、搜索/抓取、打字 delay 期间的新消息会打断当前轮并重新合并；这是预期行为。
- 发送接口调用后不再中断，新消息属于下一批；已发送的回复无法撤回。
- 查看终端是否有 `inbound skipped: cooldown`。如果出现，说明仍在旧版本：入站消息被 `policy.cooldownMs` 丢弃；当前版本已移除入站冷却，`cooldownMs` 只限制外发操作。
- 查看终端是否有“消息批次处理失败”或 AI 取消相关错误。
- 如果仍然只回一条，检查 `data/store.json` 对应会话最后几条：正常应是一条合并后的 `user` 加一条 `assistant`，不应出现未发送的 assistant 草稿。
- 历史写入发生在发送边界；如果进程在提交后、真正发出前退出，历史可能多一条未送达回复。重启后不要把旧草稿补写回去。
- 修改 `src/message-batcher.js` 的静默时间后需要重启 Alice。

## 分段消息顺序异常或只收到第一段

- 分段只对 QQ/OneBot 长纯文本生效，最多两段；代码、URL、列表/表格、图片/表情、动作结果和回访不分段。
- 后续消息到来会取消尚未开始的 delay 或段间停顿，但已调用 adapter 的首段无法撤回。
- 第二段发送失败时系统保留首段并停止剩余发送，不会重试失败段；查看 `test/reply-flow.test.js` 与 `test/delivery.test.js`。
- 打开配置检查 `replyDelay.enabled`；关闭时整组分段逻辑也关闭。`replyPacing` 只接受文件配置。

## 空间评论不触发或失败

检查：

- 重启后第一次自动轮询曾报“无法从 NapCat 获取空间 Cookie”，点“立即检查”又正常：这是启动时 OneBot 尚未连上的时序问题。现在启动会先等 OneBot ready，未就绪时每 10 秒重试，连接类失败也按 10 秒重试；手动检查仍可立即尝试。
- 设置页“空间评论”是否启用；默认关闭且默认 dryRun。
- `qzone.enabled` 是否为 true，`policy.paused` 是否为 false，`policy.autoActions` 是否允许。
- OneBot 是否在线、NapCat 是否登录；`get_cookies` 是否能返回 `user.qzone.qq.com` 的 `p_skey`。
- 自己的说说：是否在 `ownTrackHours` 内（0 = 不限）；首次轮询只建基线，不会回复历史评论。
- 楼中楼不回复：先确认 Alice 是否回复过该顶层评论；只处理 Alice 参与过的线程。顶层评论需带 `list_3[]` 才能拿到楼中楼目标 `tid`；状态里的“本次:评论/新/回复”应包含楼中楼。若回复又出现在线程末尾而不是目标楼中楼下，检查是否误用了顶层评论 ID。默认楼中楼直发失败不会回退；需要“至少发一条”时可在设置页开启“楼中楼失败时回退”，但会回到线程末尾形式。
- 外部 @：群聊是否 @ 了 Alice 并带空间链接/卡片；私聊/本机是否带链接且说了“评一下/去评论”。
- 分享卡片是否被解析出 owner/tid；解析失败时不会评论。
- 评论者是否满足“好友 + 额外允许名单”，是否在黑名单。
- 是否达到 `maxRepliesPerCycle` 或 `maxRepliesPerHour`（0 = 不限）。
- 回复慢时先看状态里的“轮询:活跃/退避/空闲”和“下次”；QZone 没有新评论推送，只能轮询。可调小 `activePollMinutes`、加大 `activeWindowMinutes`，但过快可能触发风控。
- 是否在等待活跃窗口退避：窗口外会逐步拉长到 `pollMinutes`。
- AI 是否输出 `[不回复]`；外部 @ 必须评论，AI 输出 `[不评论]` 时会按空内容跳过。
- 终端是否有 `空间评论轮询失败`、`外部说说不可访问`、`空间请求超时` 等警告。
- 状态文件 `data/qzone-comments.json` 是否为 version 2、是否损坏；损坏会隔离为 `qzone-comments.corrupt-*.json`。v1 会自动迁移并重新建基线。
- 状态里“已见评论”一直为 0、但空间确实有评论时，看“本次”计数和终端是否有“缺少评论 ID”告警；QZone 评论 ID 字段是 `tid`。
- 公开评论无法撤回；失败不确定时系统标记 `unknown`，不会自动重试，避免重复。

## 一个私聊拖慢另一个

正常情况下不会发生：`ConversationDeliveryQueue` 按 `channel + scope + conversationId` 分开计时。若出现互相等待，检查是否有人把队列改成了全局队列，或把不同会话映射到了同一个 key。同一会话内的消息本来就会按顺序等待。

## 表情包也等很久

- 纯表情包应带 `stickerOnly: true` 并跳过延迟。
- 如果模型同时写了文字，回复不算纯表情包，会按文字长度延迟。
- 检查 `Engine` 的 `stickerOnly` 计算是否被后续修改破坏。

## 暂停后仍然发出延迟消息

延迟结束后必须重新读取策略并检查 `policy.paused`、允许名单。检查 `src/index.js` 的 `receive()` 是否还在延迟队列的 `run` 回调内做二次检查。

## 回复太长、太像小作文

- 检查 `src/engine.js` 的 `STYLE_CONTRACT` 是否还在系统提示词最后。
- 基础人格在 `ai.systemPrompt`，不要在里面重新加入“详细解释”“多表达”之类要求。
- 直接注入的历史条数由 `ai.historyMessages` 控制，默认 30；0 表示注入当前保留的全部历史。如果最近历史里全是旧的长回复，模型会模仿，可以调低条数或清理该会话短期历史（保留长期记忆）。
- 风格约束不截断回复，只通过提示词要求；模型偶发不遵守时，优先加强 `STYLE_CONTRACT` 或清理旧历史，不要直接加硬截断。

## 长期记忆没有自动保存

检查：

- `memory.enabled` 和 `memory.autoExtract` 是否开启。
- 是否处于演示模式、全局暂停或当前会话不在允许名单。
- 消息是否被判断为日常寒暄、临时情绪或重复内容。
- 自动保存要求重要度 ≥ `memory.minImportance`（默认 7）。
- 明确说“记住 / 帮我记住 / 记一下 / 备注”等会走快捷保存，不依赖模型判断。
- 启动终端是否有 `Long-term memory extraction failed`；判断请求失败不会影响回复，但这一条不会保存。
- 每条消息会额外调用一次 AI；确认 AI Key、模型和网络正常。

## AI 说忘了或搜不到过去的事

检查：

- `recall` 只搜索当前记忆范围和当前会话，不会跨私聊、群聊或用户。
- 关键词是否太宽/太偏；工具会做中文二元组匹配，不做语义搜索。
- 本地每个会话只保留最近 80 条；OneBot 会再拉取最近 7 天，但依赖 QQ/NapCat 本地缓存，失败按未找到处理。
- 如果 `recall` 返回 `found: false`，私人往事应直接承认忘记；公开知识或实时信息应改用 `web_search`，网上也没有再承认不知道。若仍然编造，检查 `src/engine.js` 的系统提示词是否被改动。
- 远程历史拉取失败时查看终端是否有“聊天记录搜索失败，按未找到处理”的警告；不影响正常回复。

## 联网搜索没有触发或失败

检查：

- 设置页“联网搜索”总开关是否开启；关闭后模型不会收到 `web_search` / `web_fetch`。Search 或 Fetch 单独关闭时，对应工具也不会提供。
- 当前是否是闲聊、情绪、玩笑或本地记忆能回答的问题；这些按设计不搜索。
- 群聊是否明确说了“搜一下 / 查一下 / 搜索 / 上网查”；群聊未明确要求会被运行时拦截。
- 私聊里模型是否判断“确实不会”；可以明确说“搜一下……”触发。
- `webSearch.apiKey` 或 `ai.apiKey` 是否是有效的 DeepSeek Key；前者优先，留空才复用 AI Key。
- 每轮联网上限默认 4、工具上限默认 6；检查设置页是否被调小。
- HTTP 401：Key 无效；402：余额不足；403：抓取被安全策略拒绝；404：页面没有可提取正文；429：限速；5xx/超时：服务暂时不可用。
- 终端是否有“联网搜索失败，按未找到处理”的警告；失败不会中断回复，AI 应如实说没查到。
- 搜索期间 OneBot 私聊应持续显示“正在输入”；群聊和官方 QQ 没有可用接口，不会显示。
- 搜索结果是摘要而非实时数据库；找不到时可以让 AI 换关键词，或直接抓取具体网页。

## 网页看不到记忆

- 网页按范围管理：本机 owner、QQ 私聊、QQ 群、身份绑定是不同范围。
- 先检查页面顶部的“记忆范围”下拉框，切换到对应账号或群。
- 群记忆在群范围内共享；其他私聊账号的记忆不会显示在本机 owner 下。
- 如果刚聊完，刷新记忆页；异步提取可能比回复稍晚完成。

## 群记忆被其他人影响

这是当前设计：每个群只有一份共享记忆库。需要清理时，在记忆页切换到该群并删除单条或清空当前范围。不要在群里保存成员明确要求保密的隐私；必要时关闭“自动提取”。

## 记忆迁移或备份

- `data/store.json` 从 version 1 升级到 version 2 时，会自动写入 `data/backups/store-v1-*.json`。
- 迁移失败时不要删除原文件；先备份整个 `data/`，检查 JSON 是否合法，再从自动备份恢复。
- 网页“清空当前范围”只删除该记忆库的条目，不删除聊天历史。

## 配置损坏

项目会报错并且不会覆盖损坏配置。停止服务，从备份恢复 `data/config.json`，再重启。

## 存储损坏

`Store.init()` 会停止载入并报错。停止服务，从备份恢复 `data/store.json`，再重启。

## 页面表情图片不显示

检查：

- 是否使用了有效的控制台 token。
- `/api/stickers/:id/image` 是否返回 200。
- 文件是否存在于 `data/stickers/files/`。
- CSP 是否仍包含 `blob:`。
- 浏览器控制台是否有 401/404。

## NapCat 升级后启动脚本失效

`start-onebot.bat` 硬编码了 `napcat\NapCat.52230.Shell`。升级后目录名变化时，需要同步修改脚本。

## 账号需要验证或被限制

在 QQ 或 NapCat 提供的人工流程中处理。项目不会绕过验证、封控或设备确认。暂停外发、降低频率，并只保留本人或明确允许的会话。
