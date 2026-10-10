# TradePilot 212 V3 Personal

全新架构的**个人自托管 AI 投资研究、组合管理和人工授权交易工作台**。

[English](README.md) · [功能保留矩阵](docs/FEATURE_PARITY.md) · [架构](docs/ARCHITECTURE.md) · [安全](SECURITY.md)

> V3 不支持 V2 的接口、工具名、配置键、OAuth 令牌或状态文件。**功能完整重建，不提供旧协议兼容层**。旧项目仍在独立的 `main`，不会被自动覆盖。

## 你可以做什么

- **投资组合**：读取 Trading 212 Invest 账户、Demo/Live 持仓、资金、可交易股数、待处理订单、近期操作。
- **AI 研究**：股票名称/代码识别，短／中／长期候选研究卡片，核心逻辑、催化剂、风险、反方观点、来源和时间。
- **订单准备**：准确股数、目标金额、可用现金比例、总持仓比例、卖出全部可交易股数；Market、Limit、Stop、Stop-Limit。
- **人工交易**：应用内可编辑草稿 → 券商数据重新校验 → 短期一次性确认 → 本人输入独立授权密钥 → 执行一次；撤单也一样。
- **异常核对**：网络超时、响应损坏及券商 5xx 产生状态“未知”；只读核对订单和持仓，**永不自动重试**。
- **智能分析**：现金／持仓集中度、估值可信覆盖率、历史风险趋势、情景压力测试、监测规则和本地警报。
- **平台运行**：统一 MCP 2026-07-28，OAuth CIMD/PKCE，自托管 Node、Docker、Cloudflare Workers，中英文 React MCP App。

**AI 可以自动研究、整理与建议，但不能自主下单或撤单。** 定时任务只允许读取券商数据并更新本地风险提示。

## 开始使用

推荐 Node.js 24、pnpm 11：

```bash
pnpm install --frozen-lockfile
pnpm setup
# 在 .env.local 中添加自己的 Trading 212 环境变量
pnpm doctor
pnpm check
pnpm dev
```

配置初始为 `DATA_SOURCE=sample`，这仅是醒目标注的**合成演示数据**，绝不允许向券商下单。

读取自己的账户：

```env
DATA_SOURCE=trading212
T212_DEMO_KEY=your-demo-key
T212_DEMO_SECRET=your-demo-secret
T212_LIVE_KEY=
T212_LIVE_SECRET=
PERSONAL_TRADING_ENABLED=false
PERSONAL_LIVE_TRADING_ENABLED=false
```

如果需要在**个人环境**通过应用人工交易，先在 Trading 212 为对应账户配置具有交易权限的 API Key，并核实许可，再明确启用：

```env
PERSONAL_TRADING_ENABLED=true
PERSONAL_LIVE_TRADING_ENABLED=false
PERSONAL_MAX_NOTIONAL=5000
PERSONAL_MAX_QUANTITY=100000
PERSONAL_CONFIRMATION_TTL=90
PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS=false
```

`PERSONAL_APPROVAL_SECRET` 由 `pnpm setup` 生成，必须和登录密码／JWT 密钥不同。每笔订单或撤单都要由本人在界面输入，该密钥只用于**本地 HMAC 计算**；MCP 传输的是与当前一次性令牌绑定的证明。不要把授权密钥发到 ChatGPT 或 Claude 对话里。

**Live 真实资金交易需要再单独设置 `PERSONAL_LIVE_TRADING_ENABLED=true`**，不会因为开启 Demo 自动开放 Live。市场单可能滑点；应用金额限制属于估算，不是成交价格保证。必须在 Trading 212 实际验证交易结果。

## 风险控制与研究质量

- Trading 212 限流按账户共享：账户摘要约每 5 秒一次、持仓每秒一次、待处理订单约每 5 秒一次、标的元数据约每 50 秒一次。V3 使用 Node／Cloudflare 原子预约请求时隙，必要时延迟读取，避免并发撞击限流。
- 同一环境只允许一个真实交易请求处于提交状态。若券商响应未知，新的写操作暂停约 2 分钟；**暂停结束也不意味着前一笔订单失败**，必须先到 Trading 212 核对。
- Live 买入未持有的新标的时，Market 缺少券商可核实的现价，Buy Stop 也缺少成交价格上界。默认要求改用 Limit／Stop-Limit；如自行承担风险，可单独设置 `PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS=true`。四类订单仍全部保留。
- `PERSONAL_MAX_NOTIONAL` 约束按标的报价币种估算，不能保证市价单最终成交金额，汇率和参考价必须自行核实。
- AI 研究卡片会区分 **AI 原评分** 和 **研究材料完整度**，检查来源链接、研究时间、价格时间、风险和反方论点。完整度 100 分也不表示文章或观点经事实核验。

## 部署与连接

- 本地：`pnpm dev`，默认 `http://localhost:8080/mcp`。
- 临时 HTTPS 测试：安装 `cloudflared` 后运行 `pnpm dev:tunnel`。
- Cloudflare：配置正确的 HTTPS `PUBLIC_ORIGIN`；先 `pnpm deploy -- --dry-run`，确认后手动运行 `pnpm deploy`。
- Docker：`docker build -t tradepilot212-personal .`，通过私人环境变量注入密钥，持久化 `.data/`，并在 HTTPS 反向代理后部署。

仅连接可信任的**私人 MCP 宿主**。OAuth 需要 `portfolio:read`；研究订单另外需要 `trading:review`；执行还要显式申请 `trading:execute`。保存本地监测规则则需要 `monitor:write`。

**实际可用性受宿主限制。** ChatGPT 私人 MCP 写操作随账户与工作区权限开放；高风险操作可能被平台阻止。Claude 远程 MCP 功能也依客户端能力而不同。代码实现成功不能保证任何账户可直接在聊天中交易。

> 当前项目是 **Draft／Alpha**，尚未完成真实 ChatGPT／Claude 宿主、Trading 212 Demo 实际交易和 Live 上线测试。现阶段不要部署真实资金密钥用于生产。

## 不适用公开交易插件目录

公开 ChatGPT Plugin Directory 禁止执行投资交易，**V3 Personal 不申报为公开交易插件**。它是你的私人开发／自托管连接。若未来要做公开分析插件，应另建不含交易路径的发行物，而不是悄悄禁用本人的正确功能。

[个人部署及故障手册](docs/OPERATIONS.md) · [产品定位](docs/PRODUCT.md) · [核心工程规则](AGENTS.md) · [功能对照](docs/FEATURE_PARITY.md) · [安全约束](SECURITY.md) · [隐私](PRIVACY.md)

MIT。软件仅提供分析与个人操作工具，不构成投资收益承诺或替代券商审核。
