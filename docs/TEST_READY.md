# TradePilot 212 V3 Personal — 测试候选版本验收清单

状态：**代码层面 Test Candidate，尚未完成真实券商及 AI 宿主验收，不是 Live 生产就绪。**

构建分支：`rewrite/v3-personal-full`；Draft PR #13。旧版 `main` 不受影响。V3 不支持 V2 OAuth、存储结构、工具名或 MCP 旧协议，所有有效业务能力已在新的 V3 契约中重建。

## 自动化门槛（代码层面）

GitHub Actions 工作流 `.github/workflows/ci.yml` 应同时显示 **validate** 和 **docker-smoke** 成功：

- 冻结 pnpm lockfile 安装、严格 TypeScript、Vitest 全套回归、Widget/Node 双构建；
- MCP 2026-07-28 发现与工具调用、OAuth CIMD/PKCE、权限隔离、刷新令牌轮换；
- Demo/Live 隔离、人工 HMAC 确认、一次性 token、未知 POST/DELETE 不重试；
- UNKNOWN 执行前生成持久化记录，**即使超时、重启或短期锁结束也阻止新写入**；本人在 Owner Console 只读核对并输入专用批准证明／确认短语后才能解除；
- 同名多交易所标的不得自动选择某一市场；券商成功响应缺少有效订单 ID 必须视为 UNKNOWN；不安全的 int64 JSON 数字不得变成错误订单 ID；
- 端到端模拟 Owner Console 登录、SameSite/HttpOnly/CSP/CSRF、防冒名确认、只读通知与官方数据来源；
- Node 真实 HTTP 进程和 **Docker 正式镜像**用纯合成凭据启动，确认 `/health` 正常、`/owner` 可读、未登录的私人 API 返回 401；
- `pnpm audit --prod` 无已知漏洞、`pnpm release:check` 无泄密、Cloudflare Wrangler dry-run 成功。

以上条件通过仅代表**代码／模拟环境测试候选**，不代表真实券商、ChatGPT、Claude、邮箱或行情供应商已接受或正常运行。

## 第一阶段：无密钥本地验证

在独立测试目录中使用新生成的 V3 配置（绝不覆盖旧 V2 部署）：

```bash
pnpm install --frozen-lockfile
pnpm setup
pnpm doctor
pnpm check
pnpm smoke
pnpm audit --prod
pnpm release:check
pnpm dev
```

确认 `DATA_SOURCE=sample`，`PERSONAL_TRADING_ENABLED=false`，`PERSONAL_LIVE_TRADING_ENABLED=false`。浏览器访问 `http://localhost:8080/owner`，用本地管理员密码登录。检查手机／桌面宽度、登录、退出、今日重点、研究卡片、语种、时区和无法使用时的提示。模拟数据**必须始终显示为 synthetic/sample**，不得伪装真实报价。

若使用 Docker，在隔离测试机器上构建并运行，确认仅使用合成密钥、容器私有卷及反向代理 TLS。

## 第二阶段：真实 Trading 212 Demo 只读测试

由你本人在**私有配置文件/Secrets**中输入 Demo 只读 API Key/Secret，设置 `DATA_SOURCE=trading212`，继续保持两个交易开关关闭。

逐项核对真实 Demo 账户摘要、币种、持仓、平均成本、可交易股数、部分成交、待处理与历史订单（包括分页），以及官方接口限流行为。比较 Trading 212 网页／App 与 V3 的余额、数量及时间。真实 API 错误必须显示错误，不得回退到 synthetic。

测试 SEC、ECB、Twelve Data 时，分别校验它们的来源日期、账户权限、延迟、费率和订阅许可；供应商的研究数据**不等于 Trading 212 可成交价格**。

## 第三阶段：ChatGPT / Claude 交互测试

连接**你自己的可信任** HTTPS MCP 地址或支持的 Secure MCP Tunnel。

- ChatGPT：测试现代 OAuth/PKCE 授权，基础只读工具，今日重点结构化数据，标准 MCP App、可用的 Intelligent UI、侧边栏／会话面板提示是否由实际宿主支持；
- Claude：测试它实际可用的 MCP 版本、OAuth、标准 MCP Apps 和回退到纯文本/结构化结果；**不加入旧协议兼容层**；
- 在各自支持的桌面／移动端测试权限拒绝、失去连接、横竖屏、深浅色、键盘／屏幕阅读器及全屏切换；
- 如果宿主禁止高风险写操作，使用**独立 `/owner`**，而不是降低安全验证或绕过宿主权限。

## 第四阶段：经本人明确授权的 Demo 交易验收

只在上述只读测试通过后，使用单独有写入权限的 **Demo** API Key，并明确设置 `PERSONAL_TRADING_ENABLED=true`。继续确保 `PERSONAL_LIVE_TRADING_ENABLED=false`。

由本人决定是否测试、何时测试和具体数量与标的，不使用 CI 或 AI 自动下单。按券商支持情况检验四类订单、取消、盘前盘后、有效期、限价／触发价、数量／金额/百分比换算、相同名称不同交易所标的，以及分批成交。检查短期确认令牌过期、错误批准证明、并发交易、重复提交、错误 Demo/Live 选择。

特别验证：**券商写入结果为 UNKNOWN 时，阻止状态持续存在**，不因 120 秒锁过期而自动消失；必须由本人查看 Trading 212 官方订单／历史记录，先使用只读核对，再在 Owner Console 使用确认短语 `I CHECKED TRADING 212` 和独立批准密钥人工解除。解除阻止不会自动重发旧订单。

## 第五阶段：通知／运行环境验收

本人在 Owner Console 选择时区、简报时间、是否仅在重要变化时发送，以及是否包括 Live **只读数据**。默认邮件关闭。可选 Resend 要先验证发件人域名并设置独立 API Key；测试真实邮件时应只含有限的观察摘要，不能含账户凭据或完整持仓。Node／Docker 需自行建立周期调度；Cloudflare 每小时 Cron 仅在用户选择的本地时刻执行简报。

## 停止重构／进入测试的判定

- 自动 CI（含 Docker/Node）全绿、文档与代码一致；
- 资金执行边界无自动交易或隐式重试；
- 尚未完成的真实外部验证明确标为 **NOT TESTED**；
- 不因想多做功能而延迟真实 Demo／ChatGPT／Claude 的验收。

**重要：** CI 全绿是“可以开始受控测试”，不是“生产可用”或“可以启用 Live”。本 PR 继续保持 Draft，禁止直接合并或部署 Live。
