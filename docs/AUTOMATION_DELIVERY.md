# V3 Personal 自动简报与通知交付

## 默认安全行为

邮件发送、每日自动简报与 Live 账户自动研究**默认关闭**。OWNER Console `/owner` 可以保存 IANA 时区、当地小时 0–23、默认账户、只在重要变化时发信、是否包括 Live、是否开启邮件等偏好。设置只修改自托管状态，不会使 AI 自动下单。

报告保存在 `v3:daily-report:`，包括来源、当地日期、关注事项、触发次数和邮件投递状态。每日使用独立租约去重，避免并发 Worker 重复提交；邮件投递超时不自动重发。仅使用有效真实账户读取；Demo/sample 数据不会伪装成真实提醒。

## Cloudflare Workers

`wrangler.jsonc` 使用每小时一次的 UTC Cron `0 * * * *`。只有当当前时区时间匹配用户保存的简报小时，才执行一次当日只读分析；不匹配时不访问券商。启用简报后，生成报告并按邮件偏好决定是否通知。

关闭简报时，继续保留原有**工作日 UTC 07:00** 的只读监控规则扫描；改成每小时 Cron 不意味着原有券商请求被增至每小时一次。

## Node / Docker

本地服务器本身不会暗中运行永不停止的监控循环。用户可以通过 OS cron/systemd Task Scheduler 每小时启动一次 `pnpm monitor:once`。该脚本会检查当地简报时间和日期去重。

Linux 示例，路径应由本人调整：

```cron
0 * * * * cd /absolute/private/path/TradePilot212 && /absolute/path/to/pnpm monitor:once
```

保留持久化的 `.data/` 与私密环境配置；不要对外开放 Docker 明文 HTTP，不要把密钥打进 Docker 镜像。

## 可选 Resend 邮件

1. 在 Resend 验证你的个人发件域名。
2. 仅在自托管 Secret 配置 `NOTIFY_PROVIDER=resend`、`RESEND_API_KEY`、`NOTIFY_FROM` 和 `NOTIFY_TO`。没有配置时不会发送。
3. 再在 `/owner` 设置里手动开启每日简报与邮件；默认“仅变化时通知”。
4. 邮件只包含有限的风险分类名称与演示/真实账户环境标签，不传完整持仓、交易 API 密钥或可执行交易链接。
5. 每日环境独立 `Idempotency-Key`，网络不明不自动重试。核实 Resend 的投递日志之后才考虑人工处理。

官方 API: https://github.com/resend/resend-openapi

**区别：** 本地风险事件被保存，并不等于已经发出手机推送。此版本提供的是可选 Resend 邮件，暂未集成 ChatGPT／Claude 原生推送或系统移动通知；这些均需实际账户与平台支持，不能凭 CI 宣称完成。
