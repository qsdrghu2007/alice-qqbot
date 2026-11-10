# Alice v0.6.1

本次补丁让群聊普通发言冷却支持按秒配置，并在定时空间设置页增加天气和时间上下文开关。

- `groupChat.cooldownSeconds` 替代 `groupChat.cooldownMinutes`，默认保留原来的 240 秒，可选范围 1..86400 秒。旧 `cooldownMinutes` 会按分钟乘以 60 迁移，避免把原来的 4 分钟误当成 4 秒。
- `autonomy.includeWeather` 和 `autonomy.includeTime` 默认开启，保持原行为。WebUI 可分别关闭；关闭天气时不获取或注入天气，关闭时间时不向生成内容提供日期、星期或时段，但调度和安静时段仍使用当前时间。
- 包版本更新为 `0.6.1`。

按本次发布要求，没有进行任何验证，包括测试、语法检查、`npm run check`、hash 或发布后核对。
