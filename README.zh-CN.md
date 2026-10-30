# TradePilot 212

简体中文 · [English](./README.md)

TradePilot 212 是一个面向 Trading 212 Invest 的自托管 MCP 应用。它把个人 Trading 212 账户接入 ChatGPT 或 Claude，提供确定性的收益、分红、费用和仓位配置分析，以及再平衡、保护性止损止盈和定投计划，所有下单都经过可配置的规则引擎。它还提供简洁的持仓与交易计划界面。Live 账户的每一次券商写操作仍然需要你明确确认。

每个部署实例只属于一个用户。Trading 212 凭据保存在用户自己的环境里，仓库维护者不提供共享券商后端，也不接触其他用户的 API 密钥。

## 设计目标

- **以对话为主**：ChatGPT、Claude 和 Claude Code 里都能用，平时直接说股票代码、公司名、金额、比例或准确股数即可。
- **执行边界清楚**：分析和订单准备只读；真正写入 Trading 212 之前必须在应用界面里确认。
- **默认自托管**：推荐 Cloudflare Workers，同时支持 Node.js 和 Docker/VPS。
- **职责保持简单**：Worker 只负责账户访问、标的解析、校验、状态和执行；市场研究与定时任务不塞进券商桥接层。
- **异常可恢复**：写入结果不确定时不会自动重试，而是提供只读状态检查。
- **界面可扩展**：支持内嵌/全屏、自适应桌面和移动端；订单审查使用正常文档流，不依赖固定 iframe 浮层；当前提供中文和英文。

**先试用：** 打开样例数据，不需要 Trading 212 Key 就能在模拟账户上体验全部功能，然后再接入你的 Demo 账户。步骤见 [docs/zh-CN/TRY_IT.md](./docs/zh-CN/TRY_IT.md)，下方“快速试用”有中文简版。

## 快速试用

1. 在 Claude Code 里安装插件：`/plugin marketplace add Kukutx/TradePilot212`，然后 `/plugin install tradepilot212@tradepilot212`。
2. 在插件选项里打开 **Try with sample data**（样例数据）；想试下单就同时打开 **Enable order tools**。
3. 直接问：“看一下我的持仓”“今年收益和分红怎么样”“把组合再平衡到苹果 30%、微软 30%、英伟达 20%、VUSA 20%”“英伟达设 110 止损、150 止盈”“每月 5 号定投 200 欧 VUSA”。
4. 想用自己的账户：在 Trading 212 切到 **Practice（模拟）账户**，在 **Settings → API (Beta)** 生成 Key 和 Secret，填进插件的 Demo 选项，并关闭样例数据。Live 栏留空。
5. 想先在本机看看图形界面：克隆仓库后运行 `pnpm install && pnpm preview`，浏览器打开 http://127.0.0.1:4212 ，就能在样例账户上点遍仪表盘、图表、下单确认、再平衡、Pies 和自动化页面。加 `--demo` 会改用你 `.env.local` 里的 Demo Key（Live 始终关闭）。
6. 想在 ChatGPT 或 Claude 里用图形界面：按下方“安装与部署”部署 Worker，把 `/mcp` 地址作为自定义连接器加进去。

样例数据只在内存里，重启后重置；Live 在样例模式下始终关闭，不会连接 Trading 212。

## 功能

- Trading 212 Invest 账户概览、持仓、待处理订单和近期 TradePilot 操作记录
- 持仓可以看列表，也可以看热力图：列表能按市值、当日涨跌、盈亏或名称排序；热力图每个持仓一块，面积按市值，颜色按当日涨跌或持有以来的收益，点一块就进入该持仓的页面（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#the-holdings-map)）
- 每个持仓和整个账户的当日涨跌：现价对比前一交易日收盘价，盈亏换算成账户币种，当天买卖的股数按成交价计算；开盘前和周末显示上个交易日的涨跌。持仓详情页也显示该标的的当日涨跌，每日摘要开头就是它（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#the-days-move)）
- 每个持仓一页：持仓和占账户比例、过去一年日线价格走势图（标出你的买卖点，成本价、挂单止损限价和提醒价横线）、同样价位的价格阶梯、过去一年成交和分红，以及它的交易日志
- 自选列表：持有和没持有的标的都能加，显示现价、1日/1月/3月/1年涨跌、三个月走势小图、在 12 个月区间里的位置、最近一笔挂单或提醒还差多少、加入以来涨跌和你的备注；可从搜索或任意标的页加入（[docs/zh-CN/WATCHLIST.md](./docs/zh-CN/WATCHLIST.md)）
- 交易日志：下单时写下理由，或事后补在成交上，之后再写复盘；存在 TradePilot 里并关联 Trading 212 订单。“日志”标签页把每条理由和这笔交易之后的走势对照，按标签统计你的判断有多少次对了（[docs/zh-CN/JOURNAL.md](./docs/zh-CN/JOURNAL.md)）
- 基于 Trading 212 历史数据计算收益、分红和利息收入、交易费用、成交记录（含已撤销和被拒的订单）、逐笔股息与资金流水，以及仓位集中度（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md)）
- 在对话里跟进订单：查询单个订单的状态和成交明细；发起撤单后在界面里由你确认
- 交易时段感知：休市时下市价单会提示订单将排队到下次开盘
- 规则引擎：单一持仓占比上限、每日下单笔数和金额预算、标的和品种白名单/黑名单、休市禁止市价单、参考价时效（[docs/zh-CN/AUTOMATION.md](./docs/zh-CN/AUTOMATION.md#policy-engine)）
- 组合篮子：最多 20 笔订单一起校验、一次确认，先卖后买，遇到结果不确定的订单就停止发送剩余订单
- 按目标权重再平衡：根据券商价格和可用现金算出买卖数量；目标可以直接在界面里设置（手动输入，或填入今天的权重、等权重、风险平价权重，还可以搜索添加还没持有的标的，边输入边算出这组目标下的波动率），也可以让助手设置；保存的目标在界面里显示偏离，偏离超过阈值时提醒，一键再平衡（全部调到目标，或只调偏离超过阈值的），或只买不卖把闲置现金投给低配的标的；调仓计划、偏离面板和目标表单都会给出要买卖的金额，以及按 Trading 212 的 0.15% 汇兑费估算的费用（[docs/zh-CN/AUTOMATION.md](./docs/zh-CN/AUTOMATION.md#saved-targets-and-drift-notices)）
- 券商原生止损和止盈单（GTC，长期有效），两张联动：一张成交后 TradePilot 自动撤另一张
- 挂单成交通知（包括在 Trading 212 App 里下的单）：全部成交（附均价）、部分成交、未成交就关闭，写进操作记录并推送到 webhook（[docs/zh-CN/AUTOMATION.md](./docs/zh-CN/AUTOMATION.md#order-fill-notices)）
- 每周或每月定投计划：到期后等你确认，每一项可以用市价单，或用限价单封顶以防跳空高开；也可以按保存的目标权重分配一笔金额，最低配的买得最多；Demo 计划可以选择无人值守自动执行
- Trading 212 Pies：查看每个 Pie 的市值、收益、股息、目标进度，以及每个成分的目标占比和实际偏离；确认后可新建、修改、复制、删除 Pie（[docs/zh-CN/PIES.md](./docs/zh-CN/PIES.md)）
- 价格提醒（持仓或任何能取到外部报价的标的）：高于或低于某价格、当日相对前收盘涨跌超过一定比例（每个交易日自动重新启用）、从最高点回撤一定比例（移动止损式提醒）、相对成本价盈利或亏损一定比例，每分钟检查
- 账户提醒：账户总值或可用现金不低于或不高于某个金额，或整个账户单日涨跌达到一定比例（任一方向，每个交易日自动重新启用）；在“自动化”页添加，也可以直接让 Claude 设置（[docs/zh-CN/AUTOMATION.md](./docs/zh-CN/AUTOMATION.md#account-alerts)）
- 内置样例账户（`TRADEPILOT_SAMPLE_DATA=true`），不需要 API Key 就能试用全部功能（[docs/zh-CN/TRY_IT.md](./docs/zh-CN/TRY_IT.md)）
- 未持仓标的的外部报价，数据源可插拔：默认免费的 Stooq，无需注册；也可以填自己的 Finnhub、Twelve Data 或 Alpha Vantage Key。价格提醒、自选列表、未持有标的的详情页、定投、再平衡和日志复盘都能用
- 可选的 webhook 通知（Slack、Discord 或你自己的接口）：计划到期、订单发出、止损止盈成交、价格提醒和账户提醒、结果不确定时都会推送；还可以每天推一条账户摘要，包括当日涨跌、上次摘要以来到账的分红和未来一周预计的分红
- 界面里的“自动化”页：定投计划、价格提醒和账户提醒、联动的止损止盈、今日额度使用和各项设置一目了然
- 根据每只持仓过去 12 个月的派息，预计未来 12 个月的股息收入；分红日历按月显示本月已到账和预计金额，列出每笔预计分红的大概日期，持仓页也会显示这只标的接下来的分红
- 账户市值走势图，来自 TradePilot 自己每天的记录（Trading 212 的 API 没有历史市值）
- 时间加权收益，可以和同期指数基金对比：默认是标普 500，也可以选你持有或自选里的任意 ETF，在收益图上画成第二条线，并给出跑赢或跑输多少个百分点（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md)）
- 风险指标：业绩页给出年化波动率、收益 ÷ 波动、相对基准的 Beta 和相关系数、单日最大涨跌幅，以及每日涨跌分布图（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#risk)）
- 风险平价权重：配置页给出让每个持仓贡献相同风险份额的权重（相关性向平均值收缩，防止追着噪声走），和今天的权重并排对比；可以一键把调仓生成为待检查的订单篮，确认前不发送（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#equal-risk-weights)）
- 当前持仓回看一年：配置页按今天的持仓比例回看过去一年，给出收益、“20 周一遇的糟糕周”（历史 95% VaR，含按今天市值折算的金额）、最差一周和最大回撤（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#todays-mix-over-the-year)）
- 持仓风险分布：配置页按最近一年的周收盘价，给出每个持仓的风险占比和市值占比、组合波动率、分散度，以及最大几个持仓之间的相关系数（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#risk-by-holding)）
- 持仓走势：持仓详情页画出该持仓每天收盘时的市值，并和“净投入”（期初持股按当天收盘价计，加买入减卖出）的虚线对比，看出价格本身为这笔持仓赚了或亏了多少，不受买卖影响（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#your-position)）
- 月度收益：按月、按年的时间加权收益，用红绿深浅的年×月表格展示（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#monthly-returns)）
- 回撤：时间加权收益距前高的最大跌幅、哪天回到前高、目前比高点低多少，以及同期指数基金的最大回撤，在收益图里切到“回撤”查看（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#drawdown)）
- 收益来源：近 1 个月、3 个月、今年、12 个月或全部历史里，每个标的赚了或亏了多少（现值对比期初市值，加减买入、卖出和分红），画成零线两侧的条形图（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md#gain-by-instrument)）
- 年化资金加权收益（XIRR），以及按税务年度汇总：已实现盈利和亏损分开列、股息、利息和费用（[docs/zh-CN/ANALYTICS.md](./docs/zh-CN/ANALYTICS.md)）
- Claude Code 插件：本地 stdio 服务，附带复盘、简报、风险检查、交易日志、订单跟进、再平衡和税务年度七个 skill（[docs/zh-CN/CLAUDE_PLUGIN.md](./docs/zh-CN/CLAUDE_PLUGIN.md)）
- 本地界面预览（`pnpm preview`）：在样例账户上打开真实的界面，可切换中英文、深浅色和屏幕宽度（[docs/zh-CN/TRY_IT.md](./docs/zh-CN/TRY_IT.md#preview-the-ui-locally)）
- Demo / Live 独立凭据和独立状态提示
- 短期 / 中期 / 长期交易计划卡片
- 可展开查看核心逻辑、催化剂、风险、反方观点、来源和数据时间
- 支持 ticker、股票代码、ISIN、公司名和部分名称解析
- 价格核对：限价或止损价与最新价相差十倍以上（常见于便士和英镑弄混）会被拦下；止损单一下就会触发、限价单会立即成交时会提示
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
- 短期一次性确认状态，写操作不自动重试（只有被 Trading 212 以 429 限流拒绝的写操作会再发一次）
- 订单/撤单结果不确定时提供只读状态核对
- MCP 连接使用 OAuth + PKCE
- Cloudflare Durable Objects 与本地文件状态共用同一套 `StateStore` 接口

## 环境要求

- Node.js 22+
- pnpm 11+
- 已开放 Public API 的 Trading 212 Invest 账户
- 推荐使用 Cloudflare 账户部署公网 Worker
- 支持带 MCP Apps 的自定义连接器的 ChatGPT 或 Claude 套餐；只用本地插件时，有 Claude Code 即可

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

Demo 和 Live 使用不同凭据，可以只配置其中一个，也可以同时配置。要通过你自己的代理访问 Trading 212，设 `T212_DEMO_BASE_URL` 或 `T212_LIVE_BASE_URL`（只允许 HTTPS，API 密钥会发给它；重定向一律不跟随）。

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

### 5. 接入 ChatGPT 或 Claude

在 ChatGPT 的 Apps 设置中创建自定义 MCP 连接，或在 Claude 中添加自定义连接器，填入部署脚本输出的 `/mcp` 地址。

OAuth 页面要求输入你自己 `.env.local` 里的 `APP_LOGIN_PASSWORD`。不要把 Trading 212 API Key 或 Secret 粘贴到 ChatGPT 对话里。

如果只在自己电脑上的 Claude Code 里使用，可以跳过部署，直接安装插件：

```text
/plugin install tradepilot212 --marketplace Kukutx/TradePilot212
```

安装时会提示填写 Trading 212 API Key（保存在系统凭据库中）。下单工具默认关闭，原因和用法见 [docs/zh-CN/CLAUDE_PLUGIN.md](./docs/zh-CN/CLAUDE_PLUGIN.md)。

连接后可以直接用自然语言：

```text
打开我的 Trading 212 Live 持仓。
今年扣掉费用后我赚了多少？汇兑费交了多少？
过去 12 个月分红收入多少？
我的仓位是不是太集中了？超过 15% 的都标出来。
美股现在开盘了吗？
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

具体规则见 [docs/zh-CN/ORDERING.md](./docs/zh-CN/ORDERING.md)。

## 自动化级别

| 级别 | 内容 | 需要确认 |
|---|---|---|
| L0 | 定时只读简报和分析 | 不需要 |
| L1 | 券商原生止损/止盈单，一张成交后自动撤另一张 | 下单时确认一次 |
| L2 | 定投计划：到期时提醒，并打开为待确认的篮子 | 每次执行确认一次 |
| L3 | 到期计划无人值守执行 | **仅限 Demo**，需设置 `AUTOMATION_DEMO_ENABLED=true` |

价格提醒、账户提醒和 webhook 通知在任何级别都可用，它们只通知，不会下单。

Live 账户永远不会无人值守下单，这一点写在代码里，不能通过配置打开。唯一的 Live 无人值守写操作，是止损/止盈其中一张成交后撤销另一张（可用 `PROTECTIVE_OCO=false` 关闭）。Live 单笔订单和篮子还需要勾选“使用真实资金”作为第二次确认。市场研究和新闻仍由定时的 ChatGPT 或 Claude 任务完成。详见 [docs/zh-CN/AUTOMATION.md](./docs/zh-CN/AUTOMATION.md)。

## 常用配置

```env
DEFAULT_TRADING_ENV=demo
MAX_ORDER_NOTIONAL=5000
MAX_ORDER_QUANTITY=100000
CONFIRMATION_TTL_SECONDS=90
```

`DEFAULT_TRADING_ENV` 只在用户没有明确指定 Demo / Live 时生效。

`MAX_ORDER_NOTIONAL` 按账户货币计算。其他货币的订单按持仓推算出的汇率折算；没有任何持仓用到的货币，改用行情源的汇率；便士（GBX）按 100 便士兑 1 英镑。如果完全拿不到汇率，开启上限时这笔订单会被拦下，而不会拿外币金额直接和上限比较：可以传入 `fxRate`（1 单位账户货币折合多少标的货币）和 `fxRateAt`，或者设 `MAX_ORDER_NOTIONAL=0`。

把 `MAX_ORDER_NOTIONAL=0` 或 `MAX_ORDER_QUANTITY=0` 可以关闭对应的 TradePilot 应用层限制。Trading 212 自身的账户/标的限制以及最终人工确认仍然保留。

OAuth 客户端默认可以注册任何 HTTPS 回调地址（本机回环地址始终允许，方便本地工具）。只想接受你在用的宿主时，列出它们：

```env
OAUTH_REDIRECT_HOSTS=chatgpt.com,.claude.ai   # .claude.ai 表示 claude.ai 及其子域名
```

规则引擎（`POLICY_*`）默认只约束 Live。一个常见的 Live 配置：

```env
POLICY_MAX_POSITION_WEIGHT=0.2
POLICY_DAILY_ORDER_LIMIT=10
POLICY_DAILY_NOTIONAL_LIMIT=3000
POLICY_ALLOWED_TYPES=ETF,STOCK
POLICY_MARKET_ORDERS_WHEN_CLOSED=false
```

全部规则变量见 [docs/zh-CN/AUTOMATION.md](./docs/zh-CN/AUTOMATION.md#policy-engine)。

通知是可选的：

```env
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/…
NOTIFY_WEBHOOK_SECRET=        # 可选，HMAC 签名
NOTIFY_EVENTS=                # 可选，例如 plan_due,price_alert_triggered
DIGEST_HOUR=7                 # 可选，每天按 TIMEZONE 的 7 点推送账户摘要（或 DIGEST_HOUR_UTC=7）
```

日期默认按 UTC 计算，税年默认从 1 月 1 日开始；可以设成你自己的：

```env
TIMEZONE=Europe/London        # 每日下单限额在当地午夜重置，摘要时间和税年也按它计算
TAX_YEAR_START=04-06          # 英国税年；记录页和 get_tax_year_summary 默认用它
```

从 UTC 改成别的时区（或升级到 2.62 后第一次设置）的那一天，限额和摘要会按新日期衔接一次：时区在 UTC 之后时，当天已用的额度可能多算几个小时；时区在 UTC 之前时，摘要可能提前再发一次。

收益页默认拿时间加权收益和标普 500（SPY）对比；`BENCHMARK=VWRLl_EQ` 换成别的基金（非美国上市的要在 `QUOTE_SYMBOLS` 里映射），`BENCHMARK=none` 关闭对比。

调仓估算会把 Trading 212 的汇兑费（Invest 和 ISA 账户为 0.15%）计入用非账户货币交易的部分。费率不同时设 `FX_FEE_RATE`（小数，默认 `0.0015`）；如果你用各币种的余额直接交易、不需要换汇，设 `FX_FEE_RATE=0`。

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

详见 [docs/zh-CN/ARCHITECTURE.md](./docs/zh-CN/ARCHITECTURE.md)。

## 自托管模型

```text
用户 A → 用户 A 的 ChatGPT → 用户 A 的 Worker → 用户 A 的 Trading 212 凭据
用户 B → 用户 B 的 ChatGPT → 用户 B 的 Worker → 用户 B 的 Trading 212 凭据
```

不要把自己的已部署 Worker 作为公共地址提供给无关用户。真正的多用户托管服务需要独立身份、凭据隔离和租户授权体系，这不属于本仓库的默认架构。

详见 [docs/zh-CN/PUBLISHING.md](./docs/zh-CN/PUBLISHING.md)。

## 调用限速

Trading 212 对每个账户的每个接口单独限速（历史记录每分钟只能读几次，账户概要每 5 秒一次，等等），每次响应都会告诉你还剩几次、何时重置。组件、模型调用的工具、定时任务和后台读取共用同一份记录，按账户和接口分开：某个接口次数用完时，请求会等它重置（读取最多等 1 分钟，下单最多等 15 秒），等不到就在发送前直接拒绝，不会白白吃一个 429 让其他调用跟着退避。历史记录读到一半被限速拦住时，返回已读到的部分并标记为不完整。这份记录保存在内存里，按进程分开；遇到 429 仍会像以前一样重试。

## 安全说明

- `.env.local`、`.dev.vars`、`.data`、构建目录和 Wrangler 本地状态均不会提交到 Git。
- Trading 212 API 凭据通过 Worker Secrets 部署，不进入源码配置。
- Demo / Live 凭据完全独立。
- 下单、篮子和撤单确认短期有效且只能使用一次。
- 规则引擎在审查时和执行前各检查一次；被规则拦下的订单拿不到确认令牌。
- Live 定投计划不能设置为无人值守执行。
- 写请求出现不确定结果时不会自动重试。
- 真正提交前会再次检查订单约束。
- 最近操作记录只保存订单元数据，不保存 API 凭据。

### 安全边界（接入 Live 账户前请阅读）

- **连接密码就是实例的钥匙。** 任何人只要用 `APP_LOGIN_PASSWORD` 完成 OAuth 登录，就能拿到全部工具的令牌；如果配置了 Live 凭据，也包括真实交易。请使用 `pnpm setup` 生成的长随机密码，不要复用。
- **"仅 App 可见"的工具由宿主隐藏，而不是由服务器锁住。** 下单、撤单相关的 `app_*` 工具标记为 `visibility: ["app"]`，ChatGPT 这类宿主不会把它们交给模型，只有界面在你点击后才会调用。服务器只校验调用方是否持有有效的 `trade:write` 令牌。因此人工确认防的是模型擅自下单，防不了令牌被盗。
- **按需收窄权限。** 只想看持仓时，可以创建不带下单权限的 Trading 212 API Key；允许自选权限范围的 MCP 客户端也可以只申请 `trade:read`，这样写操作工具根本不会注册。初次试用建议只配置 Demo 凭据。
- **令牌无法单独吊销。** 访问令牌和刷新令牌都是签名 JWT，服务器不保存会话列表。每个刷新令牌只能用一次：用过就换发新的，旧令牌再次出现时会作废这个客户端的整条刷新链，所以被复制的刷新令牌在任一方用上新令牌后就失效。如需让所有已连接客户端失效（例如密码泄露后），请同时更换 `AUTH_SIGNING_SECRET` 和 `APP_LOGIN_PASSWORD`，重新部署后再重新连接 ChatGPT。否则刷新令牌会在 `REFRESH_TOKEN_TTL_SECONDS`（默认 30 天）内一直有效。
- **参考价格来自调用方。** Trading 212 Public API 没有行情接口，所以按金额下单和 `MAX_ORDER_NOTIONAL` 的估算都使用模型提供的 `referencePrice`。如果 Trading 212 返回了已持仓标的的当前价，额度检查会取两者中较高的价格，偏低的参考价无法绕过上限；对于尚未持有的标的，估算只取决于提供的价格，确认时请务必核对最终股数。
- **登录限流是全实例共享的。** 10 分钟内密码错误 8 次后，该时间窗口内所有登录都会暂停，包括你自己。
- **OAuth 客户端注册是开放的**（ChatGPT 需要）。注册有频率限制，总数上限 200；达到上限时会优先清理从未完成登录的客户端，正在使用的连接会被保留。登录页会显示客户端名称、登录后返回的地址和申请的权限；返回地址不是已知的 ChatGPT 或 Claude 地址时会给出警告。设置 `OAUTH_REDIRECT_HOSTS` 可以直接拒绝其他地址。

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
