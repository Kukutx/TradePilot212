# V3 Personal — 独立 Owner Console

此工作台为 **全新 V3 产品能力**，不是 V2 兼容补丁。自托管服务运行后访问 `https://你的域名/owner`；本机默认 `http://localhost:8080/owner`。它可以独立于 ChatGPT／Claude 显示持仓、监控提示、待处理订单及执行人工核准的订单或撤单。

## 安全边界

- 管理员使用 `OWNER_PASSWORD` 登录，HTTPS 会话采用 12 小时有效期、HttpOnly、SameSite=Strict、Secure 的 `__Host-` Cookie。所有敏感 POST 还校验同源 Origin 和 CSRF 令牌。
- 页面没有第三方 JS／CDN，使用 SHA-256 固定 CSP、禁止被其他网站嵌入。不向 AI 聊天发送券商密钥或管理员密码。
- 登录本身**没有交易权限**：Demo 交易还需 `PERSONAL_TRADING_ENABLED=true`、对应券商密钥、逐笔短期确认及本人输入 `PERSONAL_APPROVAL_SECRET`。Live 另需 `PERSONAL_LIVE_TRADING_ENABLED=true` 并输入 `LIVE`。
- 输入的独立授权密钥在浏览器中以 WebCrypto 生成动作＋令牌专用 HMAC。服务端和券商写入端都不会通过此界面收到批准密钥原文。
- 同一环境串行执行一次 Broker 写入；响应未知时不自动重试，而是通过只读工具核对。

## 操作流程

1. 登录并选择 DEMO。查看账户时间、数据来源、今日重点与待处理订单。
2. 输入券商代码／公司名称、方向、订单类型和股数／金额／现金比例／持仓比例／全部可卖。
3. 查看精确草稿，再执行服务器重新校验并取得一次性确认令牌。
4. 核实数量、价格、币种、环境和风险提示，输入独立密钥并仅发送一次。
5. 撤单从已有待处理订单行发起，必须独立确认。
6. 如返回 UNKNOWN 或提交途中服务异常中断，本环境写操作会被**持久化阻止**，不因 120 秒执行锁过期／服务重启而自动解除。先通过 Owner Console 只读核对，再由本人在 Trading 212 官方网页／App 查看订单、实际成交与历史记录。只有在独立确认后，输入 `I CHECKED TRADING 212` 和个人批准密钥完成 `reconcile` 动作，才能解除本地阻止；此步骤不会补单、撤单或重试。

Market、Limit、Stop、Stop-Limit、条件单有效期、可支持的盘前盘后交易均被保留。真实市场单成交价和应用估算价可能不同。

## 个人设置

同一网页可设置语言偏好、默认环境、IANA 时区、每日简报当地小时、变化时才通知、是否包含 Live（仅只读）、是否启用邮件。另有一键创建**缺失**的基础监控规则，不覆盖已有个人阈值。

研究面板调用 ECB 日期明确的参考汇率、SEC 正式申报文件和独立配置的 Twelve Data 报价。这些不会自动写进真实交易订单。

## 生产限制

这是单人自托管 Alpha。设备恶意扩展、服务器入侵、身份盗用仍可能危及账户。当前没有 WebAuthn/passkey 的正式验收，不应把 CSP、CSRF、HMAC 或 GitHub CI 视为生产级金融服务认证。真正 Live 前必须进行真实 Demo 端到端测试、宿主测试、设备与 TLS 审查。

参考：[自动化](AUTOMATION_DELIVERY.md)、[外部数据](EXTERNAL_DATA.md)、[安全](../SECURITY.md)。
