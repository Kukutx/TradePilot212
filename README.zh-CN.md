# TradePilot 212

中文 · [English](./README.md)

一个**每人独立部署、自己使用自己 Trading 212 密钥**的 MCP / ChatGPT App。

它不是公共券商 SaaS，也不会让很多用户共用一台服务器或一套 Trading 212 密钥。正确使用方式是：**每个人部署自己的一份 TradePilot 212。**

## 你能得到什么

- Trading 212 Invest 账户、持仓、待处理订单
- DEMO / LIVE 一键切换，凭据完全分开
- 短期 / 中期 / 长期候选股票界面
- 买入、卖出、撤单前都必须人工确认
- Trading 212 写操作不会自动重试，避免重复订单
- ChatGPT 连接使用 OAuth + PKCE
- ChatGPT 内嵌 UI + 全屏 UI，自适应桌面和移动端
- 中文 / 英文，可继续扩展更多语言
- 同一套代码支持 Node、Docker/VPS、Cloudflare Workers
- Workers 使用 Durable Object 保存一次性确认状态

## 最推荐：Cloudflare Workers 免费自托管

个人使用最简单。正常轻量使用的目标就是 Cloudflare Workers Free Plan，因此不需要 VPS，也不需要购买域名。

## 5 分钟快速上手

### 1. 准备环境

需要：

- Node.js 22+
- pnpm 11+
- Cloudflare 免费账户
- Trading 212 Invest 账户，并且可以使用 Public API
- 支持自定义 App / MCP 的 ChatGPT

没有 pnpm：

```bash
npm install -g pnpm@11
```

### 2. 下载项目

```bash
git clone https://github.com/Kukutx/TradePilot212.git
cd TradePilot212
pnpm install
```

### 3. 自动生成本地配置

```bash
pnpm setup
```

它会自动创建：

```text
.env.local
```

并自动生成安全的：

```env
APP_LOGIN_PASSWORD=...
AUTH_SIGNING_SECRET=...
```

这两个不用你自己想密码。

然后只需要打开 `.env.local`，填 Trading 212 密钥：

```env
T212_DEMO_API_KEY=
T212_DEMO_API_SECRET=

T212_LIVE_API_KEY=
T212_LIVE_API_SECRET=
```

你可以只配置 Demo、只配置 Live，也可以两个都配置。

还可以按个人习惯调整：

```env
DEFAULT_TRADING_ENV=demo
MAX_ORDER_NOTIONAL=5000
MAX_ORDER_QUANTITY=100000
```

`DEFAULT_TRADING_ENV` 只在你没有明确说 Demo / Live 时生效。`MAX_ORDER_NOTIONAL` 或 `MAX_ORDER_QUANTITY` 设为 `0` 可以关闭对应的 TradePilot 应用层限制；Trading 212 自身限制和最终人工确认仍然保留。

### 4. Trading 212 密钥在哪里生成

官方说明：

- https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key
- https://docs.trading212.com/

Trading 212 中进入：

```text
Settings
→ API (Beta)
→ Generate API key
```

Demo 和 Live 是两套独立凭据，所以你想用哪个环境，就生成哪个环境的 Key + Secret。

如果只需要查看账户，给读取权限即可。
如果要使用 TradePilot 的买入 / 卖出 / 撤单按钮，还需要开启创建订单、撤销订单等相关权限。

**Secret 只应该保存在你自己的设备和 Cloudflare Secrets 中，禁止提交到 GitHub。**

### 5. 一键检查

填完 `.env.local` 后运行：

```bash
pnpm doctor
```

它会检查：

- Node 版本
- OAuth 配置
- Demo Key 是否可用
- Live Key 是否可用
- Trading 212 是否能正常读取账户

这一步**只读，不会下单**。

### 6. 一键部署到 Cloudflare

```bash
pnpm deploy
```

第一次运行时会自动完成：

```text
项目检查
→ 如果没登录 Cloudflare，自动打开登录页面
→ 上传你的私密 Secrets
→ 构建 UI
→ 部署 Worker
→ 输出公网地址
```

最终会看到类似：

```text
App: https://tradepilot212.xxxxx.workers.dev
MCP: https://tradepilot212.xxxxx.workers.dev/mcp
```

想先测试部署配置、不真正上线：

```bash
pnpm deploy -- --dry-run
```

想换 Worker 名字：

```bash
pnpm deploy -- --name=my-tradepilot
```

### 7. 接入 ChatGPT

打开 ChatGPT：

```text
Settings
→ Apps
→ Advanced settings / Developer mode
→ Create custom App / MCP
```

填写：

```text
Name: TradePilot 212
MCP URL: pnpm deploy 输出的 /mcp 地址
```

连接后会打开 TradePilot 登录页面。

密码就是：

```text
.env.local 里的 APP_LOGIN_PASSWORD
```

连接成功以后，可以直接问：

```text
打开我的 Trading 212 Demo 投资组合
```

或者：

```text
打开我的 Trading 212 Live 投资组合
```

LIVE 是真实资金环境，最终提交订单仍然必须经过人工确认。

## 日常可以完全 All in ChatGPT

连接后，平时不需要记 Trading 212 的复杂 ticker，也不需要为了日常操作再打开另一个交易界面。直接对 ChatGPT 说自然语言即可。

例如：

```text
分析英伟达，结合我现在的持仓告诉我值不值得买。
Apple 短期一周、中期一个月、长期一年以上分别怎么看？
DEMO 买 0.2 股 NVDA。
LIVE 大概用 100 欧元买英伟达。
用我 20% 的可用现金买 Apple。
卖掉我一半的英伟达。
把 Apple 可卖的全部卖掉。
NVDA 220 美元挂限价买 0.5 股。
只准备订单，不要提交。
```

TradePilot 会把代码、简称或公司名解析成 Trading 212 的准确 ticker；如果你说“一半”“全部”“可用现金的 20%”，它会先读取账户/持仓再换算成可编辑的标准数量订单，然后仍然进入两步人工确认。按金额下单时，如果交易币种不同，ChatGPT 需要提供当前参考价和必要的实时汇率。

核心原则：**输入尽量自由，真正执行必须明确。**


## 本地使用

如果暂时不想部署公网：

```bash
pnpm setup
# 填好 .env.local
pnpm doctor
pnpm dev
```

本地 MCP：

```text
http://localhost:8000/mcp
```

### 本地 + ChatGPT 临时公网地址

开发测试可以：

```bash
pnpm dev:chatgpt
```

它会使用 Cloudflare Quick Tunnel 暂时把本地服务暴露到公网。

注意：Quick Tunnel 重启后地址可能变化，所以长期使用仍推荐 `pnpm deploy` 部署 Worker。

### 本地模拟 Cloudflare Workers

```bash
cp .dev.vars.example .dev.vars
# 填入自己的配置
pnpm dev:cloudflare
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm setup` | 自动创建 `.env.local`，生成安全 OAuth 密钥 |
| `pnpm doctor` | 只读检查环境和 Trading 212 连接 |
| `pnpm dev` | Node 本地开发 |
| `pnpm dev:chatgpt` | Node + 临时 Cloudflare Tunnel |
| `pnpm dev:cloudflare` | 本地 Workers 环境 |
| `pnpm deploy` | 检查、同步 Secrets、部署个人 Worker |
| `pnpm check` | TypeScript + 测试 + 构建 |
| `pnpm smoke` | OAuth + PKCE + MCP Smoke Test |
| `pnpm release:check` | 发布前检查是否误带本地密钥 |

## 当前安全模型

一个实例只属于一个人：

```text
你的 ChatGPT
    ↓
你的 TradePilot Worker
    ↓
你的 Trading 212 API Key
    ↓
你的 Trading 212 账户
```

另一个用户应该重新部署一份：

```text
用户 B 的 ChatGPT
    ↓
用户 B 的 Worker
    ↓
用户 B 自己的 Trading 212 Key
```

不会经过你的 Worker，也不会使用你的服务器资源。

项目已经做了这些保护：

- `.env.local`、`.dev.vars`、运行时状态默认禁止提交 Git
- Cloudflare 上使用 Worker Secrets
- 订单确认 Token 短时有效且只能使用一次
- 下单请求状态不确定时绝不自动重复提交
- Demo / Live 明确区分
- 下单前重新验证持仓和风险限制
- Live 订单保持人工最终确认

更多见 [SECURITY.md](./SECURITY.md)。

## 中英国际化

目前：

- English (`en`)
- 简体中文 (`zh-CN`)

默认跟随 ChatGPT Host Locale，也可以在 UI 里手动切换。
OAuth 登录页面同样支持中英双语。

以后增加意大利语、日语等，只需要新增翻译字典并注册，不需要修改交易逻辑。

见 [docs/I18N.md](./docs/I18N.md)。

## 项目结构

```text
src/
├─ adapters/
│  ├─ node/            # 本地 / VPS / Docker
│  └─ cloudflare/      # Workers / Durable Object / Static Assets
├─ app/                # 通用 HTTP / MCP App
├─ core/               # OAuth、MCP、Trading 212、风控、状态接口
├─ shared/             # 公共类型和版本信息
└─ ui/
   ├─ i18n/            # 国际化
   ├─ App.tsx          # ChatGPT App UI
   └─ styles.css
```

业务逻辑和部署平台是分开的，所以以后可以继续增加其他运行环境或券商适配器，而不用重做整套系统。

## 开源发布模式

这个项目推荐的发布方式就是：

> 开源代码，用户自己 Clone，自己部署，自己提供自己的 Trading 212 Key。

不要求项目作者提供公共服务器，也不要求作者保存任何用户的券商密钥。

更多说明见 [docs/PUBLISHING.md](./docs/PUBLISHING.md)。

## 风险说明

TradePilot 212 是自托管软件工具，不构成投资建议。所有市场判断和订单都应该由用户自行检查。交易可能产生亏损。Trading 212 API 的权限、限制和可用性由 Trading 212 控制，未来可能变化。

## License

MIT，见 [LICENSE](./LICENSE)。


## 更多文档

- [自然语言与灵活下单](./docs/ORDERING.md)
- [ChatGPT 定时分析架构](./docs/AUTOMATION.md)
- [国际化](./docs/I18N.md)
- [发布模型](./docs/PUBLISHING.md)
- [故障排查](./docs/TROUBLESHOOTING.md)
