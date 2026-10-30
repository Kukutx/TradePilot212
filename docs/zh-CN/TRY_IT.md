# 试用 TradePilot

简体中文 · [English](../TRY_IT.md)

下面三种方式可以确认 TradePilot 是否适合你，从最快到最完整。哪一种都不会碰真实资金账户。

| | 需要 | 你能看到 |
|---|---|---|
| [1. 样例数据](#1-sample-data-no-account) | Claude Code 和 Node 22+ | 在模拟账户上使用全部工具 |
| [2. 你的 Demo 账户](#2-your-trading-212-demo-account) | Trading 212 模拟账户的 API Key | 你自己的 Demo 持仓和历史；订单发到模拟账户 |
| [本地界面预览](#preview-the-ui-locally) | 克隆的仓库和 Node 22+ | 在浏览器里打开真实界面，用样例账户或你的 Demo 账户 |
| [3. 完整界面](#3-the-full-ui-in-chatgpt-or-claude) | 一个已部署的 Worker（Cloudflare 免费套餐即可） | ChatGPT 或 Claude 里的仪表盘、图表和确认页面 |

<a id="1-sample-data-no-account"></a>
## 1. 样例数据（无需账户）

TradePilot 内置一个样例账户：欧元现金，五个持仓（四个以 USD 计价、一个以 GBX 计价，买入时的汇率和今天不同），两个 Pie，一年的成交、分红和入金记录，一笔待成交的限价单和一笔止损单，另外还有两个观察中的标的（Amazon 和 ASML）。这些标的使用模拟报价，所以自选列表和价格图离线也能用。市价单在样例账户上立即成交；其他订单一直挂着，直到你撤销。Live 处于关闭状态，不会向 Trading 212 发送任何内容。

在 Claude Code 中：

```text
/plugin marketplace add Kukutx/TradePilot212
/plugin install tradepilot212@tradepilot212
```

出现选项时，打开 **Try with sample data**（样例数据）；如果还想试下单，同时打开 **Enable order tools**（下单工具）。之后可以在 `/plugin` → Installed → Configure options 里修改选项。

然后可以这样问，例如：

- “显示我的持仓仪表盘。”
- “今年我的组合表现怎么样，带来了多少收入？”
- “检查一下我的仓位配置有没有集中度风险。”
- “规划一次再平衡：苹果 30%、微软 30%、英伟达 20%、VUSA 20%。”
- “给英伟达设 110 止损、150 止盈。”
- “建一个月度定投计划：每月 5 号投 200 欧元到 VUSA。”
- “苹果跌破 210 时提醒我。”
- “买 2 股苹果。”（需打开下单工具；Claude Code 每次下单前都会先问你）

Claude Code 以文字形式显示结果。想看图形化的仪表盘，请用[本地预览](#preview-the-ui-locally)或支持 MCP Apps 的宿主（第 3 种方式）。

不装插件、改用克隆的仓库：

```bash
pnpm install
TRADEPILOT_SAMPLE_DATA=true pnpm stdio
```

样例数据保存在内存里，所以每次启动服务都会从头开始。定投计划、提醒、自选列表和操作记录照常保存在数据目录里。

<a id="2-your-trading-212-demo-account"></a>
## 2. 你的 Trading 212 Demo 账户

Demo（模拟）账户使用虚拟资金，可以放心在上面试下单。

1. 在 Trading 212 App 或网站上，切换到 **Practice**（模拟）账户。
2. 打开 **Settings → API (Beta)** 生成 Key。勾选你想试的权限：只读使用勾选账户数据、持仓、历史和元数据；要下单再勾选订单和 Pies。复制 Secret，它只显示一次。
3. 在 Claude Code 里打开 `/plugin` → Installed → tradepilot212 → Configure options。关闭 **Try with sample data**，粘贴 **Demo API key** 和 **secret**。Live 相关的栏留空。
4. 让它显示你的仪表盘。如果出错，在克隆的仓库里运行 `pnpm doctor`（把同样的 Key 填进 `.env.local`），它会逐项检查设置和连接。

Demo 账户上的订单仍然每次都需要你确认；例外是你打开了 **Run Demo plans unattended**（无人值守执行 Demo 计划），并且定投计划标记了 `autoExecute`。

<a id="preview-the-ui-locally"></a>
## 在本机预览界面

`pnpm preview` 在你的浏览器里打开界面，和 ChatGPT 或 Claude 里显示的完全一样，不需要部署任何东西：

```bash
pnpm install
pnpm preview            # sample account
pnpm preview --demo     # your Demo keys from .env.local
```

打开 http://127.0.0.1:4212 。选择一个视图（仪表盘、配置、收益、收入、一笔订单、一次撤单、再平衡、保护性订单、订单篮子、Pies、自动化），并在页头切换语言、浅色或深色主题，以及手机、平板或桌面宽度。每个视图还会显示模型会读到的文字，以及界面发出的调用。

预览只监听 127.0.0.1，每次调用都需要本次运行生成的令牌。`--demo` 只使用你的 Demo Key：Live 关闭，Demo 自动化和 webhook 关闭，订单仍然需要你在界面里确认。

<a id="3-the-full-ui-in-chatgpt-or-claude"></a>
## 3. 在 ChatGPT 或 Claude 里使用完整界面

仪表盘、图表、订单审查和确认页面会在支持 MCP Apps 的宿主中显示，例如 ChatGPT（开发者模式）以及网页版、桌面版和移动版 Claude。这些宿主通过 URL 连接，所以 TradePilot 要作为你自己的 Cloudflare Worker 运行：

1. 按 README 里的[安装与部署](../../README.zh-CN.md#安装与部署)完成配置和部署。如果想先不用 Trading 212 Key，设 `TRADEPILOT_SAMPLE_DATA=true`。在 Worker 上，样例订单可能在两次请求之间被重置，所以除了随便看看，其他用途请用你的 Demo Key。
2. 把 Worker 的 `/mcp` 地址添加为自定义连接器，并用你的 `APP_LOGIN_PASSWORD` 登录。
3. 让它显示你的仪表盘，逐个试用各个视图：持仓、自选、配置、收益、收入、记录（成交、资金和税年）、日志、Pies 和自动化标签页（含交易规则）、订单状态、CSV 报表、订单编辑器，以及再平衡和保护性订单篮子。

<a id="what-to-check"></a>
## 需要检查什么

- 同一账户（Demo Key）下的数字与 Trading 212 App 一致。
- Demo / Live 开关显示你当前在哪个账户；添加 Live Key 之前，Live 一直不可用。
- 每笔订单都会先打开审查页面，只有在你确认后才发送。
- 语言跟随宿主（英文或中文），也可以在页头切换。

对 Demo 满意之后，只有在你想把 TradePilot 用在真实账户上时，才添加 Live Key。请先阅读[安全说明](../../README.zh-CN.md#安全说明)。Live 订单始终需要你确认。
