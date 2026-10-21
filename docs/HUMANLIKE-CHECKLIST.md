# 拟人化 15 项验收矩阵

本文件只记录当前镜像 `codex/alice-humanlike` 已实现的行为和可复核证据。运行层证据来自 Node 测试；语气、长度、自然程度最终仍受真实模型影响，不能由静态测试保证每次生成都完全符合。

共同约束：

- 缓存：静态 system 前缀、历史、最后一条动态 user 保持分离；画像、ACL 上下文、记忆和表情状态只进入最后一条 user。
- 隔离：消息历史、消息合并、发送队列和回访状态仍按实际会话；跨场景共享只经过 `ConversationState.visibleContext()` 的安全画像与来源 ACL。
- 审校：只发送当前用户文本、草稿和无原文数字/布尔习惯统计，不发送账号、图片、历史原文或其他会话。
- 全局情绪不保存账号、原文或原因；用户情绪是独立的上下文状态，不镜像成全局情绪。

| ID | 目标 | 实际行为与代码位置 | 测试证据 | 边界与如实说明 |
| --- | --- | --- | --- | --- |
| HM-01 | 场景长度 | `src/style.js` `STYLE_CONTRACT` 按寒暄、倾诉、知识/步骤、收尾分档；`src/engine.js` `_runAI` 把约束稳定放在静态 system 末尾。 | `test/core.test.js`: `engine appends the short-reply style contract after other prompt sections`。 | 运行时是提示词约束，不是字符串截断；真实模型仍可能偶尔过长。 |
| HM-02 | 暂时不接话 | `src/engine.js` `_silenceAllowed` 限定 QQ/OneBot 私聊、无附件的明确短确认；`_reviewedReply` 只有审校 `silence` 与白名单同时成立才沉默；提交边界仍记录 user。 | `test/core.test.js`: `silence is limited to explicit acknowledgements and rejects unsafe text`、`review updates state only in commitTurn...`。 | 群聊、本机、附件、问题、求助、危险信号和动作回合不能 silence；AI 审校失败回退原草稿。 |
| HM-03 | 语义等待 | `src/message-batcher.js` `calculateInputSilence` 对未完标点、连接词、未完成图片说明和短时碎裂输入增加 300–1000ms 有界等待；明确问句保持基础静默；`_schedule` 有总上限。 | `test/message-batcher.test.js`: `unfinished input waits slightly longer...`、`input timing handles image captions...`、`a hard collection cap prevents endless waiting...`、`bounded in-memory burst habit...`。 | 规则判断语义线索并限制等待，不保证真正理解每一句；burst 习惯只保存最近会话内计数，不保存文本。 |
| HM-04 | 补充与换题 | `src/message-batcher.js` `isExplicitAcknowledgement` 把生成期纯 ACK 放进 `supplements`；实质消息 abort 当前轮并 requeue。abort 后的 ACK 留在 pending，`getSupplements`/`markSupplementsCommitted` 把已关注补充写入历史。 | `test/message-batcher.test.js`: `only explicit acknowledgement forms...`、`acks arriving after an abort stay behind...`、`an acknowledgement during drafting...`、`uncommitted supplements are cleared...`。 | ACK 白名单是保守规则；非 ACK 都按新输入中断，宁可重算也不把换题误当补充。 |
| HM-05 | 短期话题 | `src/conversation-state.js` `updateTurn` 保存 `topic` 与独立 `topicUpdatedAt/topicExpiresAt`；`projectConversation` 过 TTL 后隐藏；`src/engine.js` `visibleContext` 把当前及本人可见话题放进动态 user。 | `test/conversation-state.test.js`: `trusted person identity shares safe profile...`、`irrelevant chat preserves short state...`、`conversation state enforces ttl...`；`test/core.test.js`: `review updates state only in commitTurn...`。 | 话题按发送者和来源 ACL 可见；私聊来源不会进入群，同群其他成员看不到该用户上下文。 |
| HM-06 | 未完成事项 | `src/conversation-state.js` `normalizeUnfinishedItem`、`updateTurn`、`unfinishedItems` 保存稳定 ID、`open/done/cancelled`、创建/完成/过期时间；`src/follow-up.js` `_visibleContext` 将 `unfinishedItems` 注入时间选择、到期检查和生成。 | `test/conversation-state.test.js`: `unfinished items are structured, deduplicated, completable...`；`test/follow-up.test.js`: `invalid times are re-asked...`、`follow-up reads only the target conversation's structured short state`。 | 完成同一事项会更新原条目而非重复新增；其他成员事项不进入目标用户视图。 |
| HM-07 | 有理由才回访 | `src/chat-exit.js` 解析显式 `should_follow_up:false` 并写入 `followUpStatus=skipped`；`src/follow-up.js` 对无自然由头、拒绝联系或理由不足返回 false；缺失新字段的旧合法分钟仍兼容。 | `test/chat-exit.test.js`: `a strict explicit decline cancels follow-up...`；`test/follow-up.test.js`: `time resolver can explicitly cancel...`、`follow-up prompt lets AI extend...`。 | 判断依赖 AI 语义和保守规则；不支持官方 QQ/群聊回访。 |
| HM-08 | 过时任务取消 | `src/follow-up.js` `FOLLOW_UP_CHECK_SYSTEM_PROMPT` 在发送前要求判断事件是否完成、撤销或不再合适；`_process` 在 `should_send_now=false` 时标记 `not_worth_or_stale` 且不发送。结构状态与最近对话冲突时以最近对话为准。 | `test/follow-up.test.js`: `due follow-up is skipped when the independent check says it is stale`、`late check results are discarded after the user returns`、`plain text from a check is retried...`。 | “过时”是发送前一次 AI 检查，不是定时数据库；检查失败走有界重试，不把普通正文当取消。 |
| HM-09 | 稳定喜好与观点 | `src/config.js` `persona.preferences/opinions` 保存 Alice 自己的最多各 8 条稳定喜好与观点；`src/engine.js` 将它们写进静态 system，要求作为 Alice 自己的立场表达；`src/conversation-state.js` 的用户 `profile.preferences/boundaries` 另存安全枚举。 | `test/core.test.js`: `config deep merge...` 校验 persona 默认数组、`engine appends the short-reply style contract...`；`test/conversation-state.test.js`: `trusted person identity shares safe profile...`、`relationship changes by distinct interaction...`。 | 配置是真实稳定状态并进入 system；真实生成仍可能偶尔不表达立场或不同意。 |
| HM-10 | 慢关系与接受偏好 | `src/conversation-state.js` `updateTurn` 仅在跨日首次交互增加关系、明确暖意有 6 小时间隔；`relationshipLabel` 输出“刚开始熟悉/有一定熟悉感/比较熟悉”；边界偏好持久化。 | `test/conversation-state.test.js`: `relationship changes by distinct interaction and explicit boundaries, not message count, and profile storage is bounded`。 | 不按消息数量刷熟；画像是表达背景，不是现实承诺或对亲密的索取。 |
| HM-11 | 延续用户情绪 | `src/conversation-state.js` `normalizeUserEmotion`、`projectUserEmotion`、`updateTurn` 保存短时用户情绪；默认 6 小时 TTL、衰减、换题乘 0.45；`src/engine.js` 和 `src/follow-up.js` 只把它作为用户状态。 | `test/conversation-state.test.js`: `user emotion persists through unrelated chat, decays, weakens on topic change, and never mirrors into global mood`。 | 采用抽象枚举/强度，不推断原因；不会把用户低落直接写成 Alice 的全局低落。 |
| HM-12 | 共同梗 | `src/conversation-state.js` `common_meme` 必须由当前用户原文逐字出现；首次保存为 `candidate`，同一短语再次由用户原文出现并被审校识别为共同梗时更新为 `confirmed`；`projectConversation` 只暴露 confirmed 且未过期项。 | `test/conversation-state.test.js`: `common memes require current user evidence and only expose after a second-context confirmation`；`test/follow-up.test.js`: `...structured short state`。 | 不会虚构线下共同经历；未确认候选不会作为“已确证共同梗”注入。 |
| HM-13 | 不必面面俱到 | `src/style.js` 明确禁止逐点回应、复述、总结和资料清单；审校契约同样删除逐点客服式回应；`src/engine.js` 只把必要画像/上下文放入动态 user。 | `test/core.test.js`: `engine appends the short-reply style contract after other prompt sections`、`review updates state only in commitTurn...`。 | 这是提示词与审校策略；信息型问题仍需完整关键条件，无法用固定字数保证自然。 |
| HM-14 | 打字节奏与偶尔分条 | `src/delivery.js` `planReplySegments` 只对 QQ/OneBot 长纯文本按概率拆最多两段；`src/index.js` `createReplyFlow` 发送前锁轮、成功段后提交，后续每段按该段实际可见字数、共享抖动和上限计算延迟；代码/URL/动作/媒体不分段；回访强制单段。 | `test/delivery.test.js`: `reply planning creates at most two natural sentences...`、`cancelled queued work returns immediately without letting later work bypass the active head...`；`test/reply-flow.test.js`: `each segment waits by its own text with shared jitter, cap, and slow pacing`、`segmented sends keep the first delivered segment...`、`disabled reply delay disables segmentation...`；`test/message-batcher.test.js` 的 ACK/补丁顺序测试。 | 分段是概率行为且最多两段；首段发出后不可撤回，后续失败只保留已成功段。 |
| HM-15 | AI 机械习惯判断 | `src/conversation-style.js` `buildStyleFlags` 本地计算连续问句、重复开头、草稿相似度、表情重复；`src/engine.js` `_reviewReply` 只把 `style_flags` 和当前文本/草稿发给独立审校 AI；`src/conversation-state.js` 持久化数字/布尔统计，不存历史原文。 | `test/conversation-state.test.js`: `cross-turn style metrics persist only aggregate numbers and booleans`；`test/core.test.js`: `review updates state only in commitTurn...` 校验载荷键；`test/message-batcher.test.js`: `bounded in-memory burst habit...`。 | 审校 AI 可能误判或改得不自然；统计能提示常见重复，但不能保证识别所有语义习惯。 |

## 验证命令

```bash
npm test
npm run check
node --check public/app.js
```

测试通过代表代码路径、状态存储、ACL、取消/提交边界和提示词载荷符合预期；不代表真实模型每次说话都达到主观语气目标。
