# TradePilot 212

简体中文 · [English](./README.md)

TradePilot 212 是一个面向 Trading 212 Invest 的自托管 MCP 应用。它把个人 Trading 212 账户接入 ChatGPT，提供简洁的持仓与交易计划界面，并把所有券商写操作保留在明确的人工确认之后。

每个部署实例只属于一个用户。Trading 212 凭据保存在用户自己的环境里，仓库维护者不提供共享券商后端，也不接触其他用户的 API 密钥。

## 设计目标

- **以 ChatGPT 为主要入口**：平时可以直接说股票代码、公司名、金额、比例或准确股数。
- **执行边界清楚**：分析和订单准备只读；真正写入 Trading 212 之前必须在应用界面里确认。
- **默认自托管**：推荐 Cloudflare Workers，同时支持 Node.js 和 Docker/VPS。
- **职责保持简单**：Worker 只负责账户访问、标的解析、校验、状态和执行；市场研究与定时任务不塞进券商桥接层。
- **异常可恢复**：写入结果不确定时不会自动重试，而是提供只读状态检查。
- **界面可扩展**：支持内嵌/全屏、自适应桌面和移动端；订单审查使用正常文档流，不依赖固定 iframe 浮层；当前提供中文和英文。

## 功能

- Trading 212 Invest 账户概览、持仓、待处理订单和近期 TradePilot 操作记录
- Demo / Live 独立凭据和独立状态提示
- 短期 / 中期 / 长期交易计划卡片
- 可展开查看核心逻辑、催化剂、风险、反方观点、来源和数据时间
- 支持 ticker、股票代码、公司名和部分名称解析
- 下单数量支持：
  - 指定股数
  - 指定目标金额
  - 买入时使用可用现金的一定比例
  - 卖出时使用总持仓的一定比例
  - 卖出当前全部可交易数量
- Market / Limit / Stop / Stop-Limit 订单草稿
- 清楚展示自然语言指令如何换算成最终股数，并标记手动修改
- 参考价格新鲜度提示
- 结构化错误，界面按当前语言显示
- 短期一次性确认状态，写操作绝不自动重试
- 订单/撤单结果不确定时提供只读状态核对
- MCP 连接使用 OAuth + PKCE
- Cloudflare Durable Objects 与本地文件状态共用同一套 `StateStore` 接口

## 环境要求

- Node.js 22+
- pnpm 11+
- 已开放 Public API 的 Trading 212 Invest 账户
- 推荐使用 Cloudflare 账户部署公网 Worker
- 支持自定义 Apps / MCP 连接的 ChatGPT 客户端或套餐

没有 pnpm 时：

```bash
npm install -g pnpm@11
```

## 安装与部署

### 1. 下载并安装依赖

```bash
git clone https://github.com/Kukutx/TradePilot212.git
cd TradePilot212
pnpm install
```

### 2. 创建本地配置

```bash
pnpm setup
```

如果 `.env.local` 不存在，`pnpm setup` 会创建它，并生成本地 OAuth 登录密码和签名密钥。

打开 `.env.local`，填写你需要的 Trading 212 环境：

```env
T212_DEMO_API_KEY=
T212_DEMO_API_SECRET=

T212_LIVE_API_KEY=
T212_LIVE_API_SECRET=
```

Demo 和 Live 使用不同凭据，可以只配置其中一个，也可以同时配置。

Trading 212 官方 API 文档：

- https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key
- https://docs.trading212.com/

如果只查看账户，读取权限即可。如果需要在 TradePilot 中准备并执行订单，还需要给 API Key 开启对应的下单/撤单权限。

### 3. 检查配置

```bash
pnpm doctor
```

这个命令检查 Node 版本、本地 OAuth 配置以及 Demo / Live 的 Trading 212 连接。所有券商检查均为只读，不会下单。

### 4. 部署个人 Worker

```bash
pnpm deploy
```

部署脚本会依次：

1. 检查本地配置与项目状态；
2. 必要时打开 Cloudflare 登录；
3. 把实例配置同步到 Worker Secrets；
4. 构建应用；
5. 部署 Worker；
6. 输出 App 和 MCP 地址。

典型输出：

```text
App: https://tradepilot212.<your-subdomain>.workers.dev
MCP: https://tradepilot212.<your-subdomain>.workers.dev/mcp
```

只检查部署配置、不正式发布：

```bash
pnpm deploy -- --dry-run
```

指定不同的 Worker 名：

```bash
pnpm deploy -- --name=my-tradepilot
```

### 5. 接入 ChatGPT

在 ChatGPT 的 Apps 设置中创建自定义 MCP 连接，填入部署脚本输出的 `/mcp` 地址。

OAuth 页面要求输入你自己 `.env.local` 里的 `APP_LOGIN_PASSWORD`。不要把 Trading 212 API Key 或 Secret 粘贴到 ChatGPT 对话里。

连接后可以直接用自然语言：

```text
打开我的 Trading 212 Live 持仓。
结合我现在的仓位分析英伟达。
比较 AMD、Nvidia 和 Broadcom 的一个月机会。
DEMO 准备买 0.2 股 NVDA。
LIVE 大约用 100 欧元买 Nvidia。
卖掉我一半 Apple 持仓。
卖掉 Apple 当前全部可卖数量。
准备一个 NVDA 220 美元、0.5 股的限价买单，不要提交。
```

TradePilot 会把自然语言请求解析成 Trading 212 能接受的标准数量订单，并先展示成可编辑草稿。真正写入券商仍需要最后确认。

## 订单流程

```text
用户指令
  ↓
解析标的 + 读取账户/持仓
  ↓
换算数量 + 可编辑订单草稿
  ↓
服务器校验 + 数据时间提示
  ↓
短期一次性确认
  ↓
用户明确确认
  ↓
写入 Trading 212
```

如果写请求超时，或 Trading 212 返回无法确定执行结果的服务端错误，TradePilot **不会再次发送原请求**。界面会提供只读状态检查，用当前待处理订单和持仓变化判断是否存在执行迹象。如果仍无法确认，就保持“不确定”，不会擅自转换成重试。

具体规则见 [docs/ORDERING.md](./docs/ORDERING.md)。

## 定时分析与市场研究

TradePilot 本身不实现选股定时器、新闻爬虫或自动交易循环。

定时 ChatGPT 任务可以负责市场研究、读取 TradePilot 持仓并生成交易计划；真实执行继续保持为独立的交互操作。

详见 [docs/AUTOMATION.md](./docs/AUTOMATION.md)。

## 常用配置

```env
DEFAULT_TRADING_ENV=demo
MAX_ORDER_NOTIONAL=5000
MAX_ORDER_QUANTITY=100000
CONFIRMATION_TTL_SECONDS=90
```

`DEFAULT_TRADING_ENV` 只在用户没有明确指定 Demo / Live 时生效。

把 `MAX_ORDER_NOTIONAL=0` 或 `MAX_ORDER_QUANTITY=0` 可以关闭对应的 TradePilot 应用层限制。Trading 212 自身的账户/标的限制以及最终人工确认仍然保留。

## 本地开发

Node 开发服务器：

```bash
pnpm setup
# 填写 .env.local
pnpm doctor
pnpm dev
```

本地 MCP：

```text
http://localhost:8000/mcp
```

本地开发时临时接入 ChatGPT：

```bash
pnpm dev:chatgpt
```

它会使用 Cloudflare Quick Tunnel。地址是临时的，长期个人使用应部署正常 Worker。

本地模拟 Workers：

```bash
cp .dev.vars.example .dev.vars
# 填写 .dev.vars
pnpm dev:cloudflare
```

## 项目检查

```bash
pnpm check
pnpm smoke
pnpm audit --prod
pnpm release:check
pnpm deploy -- --dry-run
```

GitHub CI 会执行类型检查、测试、生产构建、生产依赖审计、发布安全检查和 Wrangler 部署 dry-run。

## 架构

```text
ChatGPT / MCP Host
        │
        ▼
  Hono + OAuth/PKCE
        │
        ▼
 TradingService ───── Trading212Client
        │                   │
        │                   ▼
        │              Trading 212
        ▼
    StateStore
     ├─ Node 文件状态
     └─ Workers Durable Object / SQLite

React App UI ← MCP App Resource
```

核心业务代码不依赖 Node 文件系统或 Cloudflare API，运行时差异集中在 `src/adapters/`。

详见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 自托管模型

```text
用户 A → 用户 A 的 ChatGPT → 用户 A 的 Worker → 用户 A 的 Trading 212 凭据
用户 B → 用户 B 的 ChatGPT → 用户 B 的 Worker → 用户 B 的 Trading 212 凭据
```

不要把自己的已部署 Worker 作为公共地址提供给无关用户。真正的多用户托管服务需要独立身份、凭据隔离和租户授权体系，这不属于本仓库的默认架构。

详见 [docs/PUBLISHING.md](./docs/PUBLISHING.md)。

## 安全说明

- `.env.local`、`.dev.vars`、`.data`、构建目录和 Wrangler 本地状态均不会提交到 Git。
- Trading 212 API 凭据通过 Worker Secrets 部署，不进入源码配置。
- Demo / Live 凭据完全独立。
- 下单和撤单确认短期有效且只能使用一次。
- 写请求出现不确定结果时不会自动重试。
- 真正提交前会再次检查订单约束。
- 最近操作记录只保存订单元数据，不保存 API 凭据。

提交代码前建议运行：

```bash
pnpm release:check
```

更多安全说明见 [SECURITY.md](./SECURITY.md)。

## 目录结构

```text
src/
├─ adapters/
│  ├─ cloudflare/       Workers + Durable Objects + Static Assets
│  └─ node/             Node server + file-backed state
├─ app/                 共享 HTTP/MCP 应用
├─ core/                OAuth、MCP 工具、券商客户端、交易规则、状态
├─ shared/              与运行时无关的类型与元数据
└─ ui/                  React MCP App UI 和语言文件

scripts/                 安装、检查、部署、smoke test
docs/                    架构、下单、定时任务、发布、国际化
.github/workflows/        CI
```

## License

MIT，见 [LICENSE](./LICENSE)。

## 免责声明

TradePilot 212 是软件集成项目，不构成投资建议。市场信息和订单都应由用户自行检查。Trading 212 对 API 可用性、权限、标的和券商限制拥有最终控制权，并可能独立于本项目发生变化。
