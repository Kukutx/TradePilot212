# TradePilot Insight V3 — 全新 AI 投资组合智能分析平台

[English](README.md) · [产品定位](docs/PRODUCT.md) · [架构](docs/ARCHITECTURE.md) · [隐私](PRIVACY.md)

**这是破坏性重建的新项目，不支持 V2 的工具名、OAuth 连接、环境变量、存储格式或交易确认流程，也不存在兼容层。**

## 核心定位

连接 Trading 212 官方 Public API 的只读数据，通过标准 MCP 2026-07-28 向 ChatGPT、Claude 等兼容宿主提供：

- 投资组合概览、估值覆盖率、集中度、现金比例及数据缺失提示；
- 严格标注假设的压力情景计算，不把情景当价格预测；
- 券商历史订单只读查询；
- 组合监测规则及定时检查，并将风险事件仅记录到自托管状态；
- 中英文交互式 MCP App、自动整理的证据简报。

**不提供下单、撤单、资金划转，不向券商执行任何写操作。** ChatGPT 官方插件目录禁止执行投资交易；要成为合格的插件，产品必须从下单工具转为有独立价值的组合分析和监控产品。

## 安装

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
# 生成独立的强 OWNER_PASSWORD、JWT_SIGNING_SECRET
pnpm check
pnpm dev
```

默认 `DATA_SOURCE=sample`：全部是合成演示数据，界面明确标注，不会被显示为真实账户。

读取真实 Trading 212：`DATA_SOURCE=trading212`，配置 `T212_DEMO_KEY` / `T212_DEMO_SECRET` 或 Live 对应密钥；建议仅授予读取权限。

公网使用应配置 HTTPS `PUBLIC_ORIGIN` 和允许的 OAuth 客户端元数据来源。V3 **只允许 2026-07-28 MCP + CIMD/PKCE**，旧客户端不能连接，Claude 实际支持情况需测试。默认 Cloudflare 定时检查为工作日 UTC 07:00，仅检查持仓指标和本地规则，不会下单。

## 注意

- 用户数据由自托管 Node / Cloudflare 实例持有，MCP 宿主可能处理用户主动请求的组合结果。
- 币种数据不足时不猜测汇率；不能可靠计算时明确显示未知。
- 本项目不是自动交易机器人、投资顾问或多租户托管服务。
- GitHub CI 通过不等于 ChatGPT/Claude 插件目录审核通过。

详见 [产品策略](docs/PRODUCT.md)、[架构设计](docs/ARCHITECTURE.md) 和 [安全边界](SECURITY.md)。
