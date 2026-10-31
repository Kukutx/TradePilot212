# 架构

简体中文 · [English](../ARCHITECTURE.md)

TradePilot 212 有意拆成一个与运行时无关的核心和几个小的平台适配器。同一套交易规则和 MCP 接口既能跑在 Node.js 上，也能跑在 Cloudflare Workers 上。

<a id="request-path"></a>
## 请求路径

```text
MCP host
  │
  │ OAuth 2.0 + PKCE
  ▼
Hono application
  │
  ├─ OAuth / protected-resource endpoints
  └─ MCP endpoint
       │
       ▼
   TradingService
       │
       ├─ instrument resolution
       ├─ portfolio reads
       ├─ order sizing
       ├─ validation
       ├─ one-time confirmation state
       ├─ recent activity
       └─ uncertain-write verification
       │
       ▼
Trading212Client
       │
       ▼
Trading 212 Public API
```

React MCP App 界面作为 MCP App 资源提供。它调用仅 App 可见的 MCP 工具来完成刷新、校验、确认、撤单和不确定写入的核对。

<a id="source-layout"></a>
## 源码结构

```text
src/
├─ adapters/
│  ├─ node/
│  │  ├─ index.ts
│  │  └─ file-state-store.ts
│  ├─ stdio/
│  │  └─ index.ts          local MCP over stdio (Claude Code plugin)
│  └─ cloudflare/
│     └─ index.ts
├─ app/
│  ├─ create-app.ts
│  └─ services.ts          shared service wiring for every transport
├─ core/
│  ├─ analytics.ts         pure portfolio, income, cost and market-hours math
│  ├─ automation.ts        standing plans and the due-plan scheduler
│  ├─ config.ts
│  ├─ errors.ts
│  ├─ insights-service.ts  paginated history reads feeding analytics
│  ├─ mcp.ts
│  ├─ oauth.ts
│  ├─ order-watch.ts       reports how open orders ended once they leave the book
│  ├─ policy.ts            pure policy rules shared by every order path
│  ├─ protective-links.ts  one-cancels-other emulation for stop-loss / take-profit pairs
│  ├─ rebalance.ts         pure target-weight rebalance planner
│  ├─ state-store.ts
│  ├─ trading-service.ts
│  ├─ value-history.ts     daily account value record for the performance chart
│  ├─ trading212-client.ts
│  └─ web-utils.ts
├─ shared/
│  ├─ automation.ts        policy, basket, rebalance and plan contracts
│  ├─ contracts.ts
│  ├─ history.ts
│  └─ meta.ts
└─ ui/
   ├─ i18n/
   ├─ App.tsx
   └─ styles.css
```

<a id="core-boundaries"></a>
## 核心边界

<a id="trading212client"></a>
### `Trading212Client`

负责和 Trading 212 之间的 HTTP 交互。

- 读请求遇到临时故障时，有次数受限的重试和退避；
- 写请求只发送一次；
- 写请求超时或服务端返回含糊的错误时，结果记为“执行状态未知”，而不是重试。

<a id="tradingservice"></a>
### `TradingService`

负责应用层规则。

- 解析券商标的；
- 读取账户、持仓和待处理订单；
- 把灵活的下单规模换算成按股数下的订单；
- 执行配置的应用层限制，以及能在本地检查的券商侧约束；
- 每笔订单在检查时评估一次规则，写入前再评估一次；
- 用同一份账户快照校验订单篮，先卖后买，并逐笔发送；
- 起草再平衡和保护性订单的订单篮；
- 签发短期有效的一次性确认；
- 记录一份只含元数据的简短操作记录；
- 写入结果不明确时做回读核对。

`TradingService` 不做市场研究，也不安排定时任务。

<a id="automationservice-policy-and-rebalance"></a>
### `AutomationService`、`policy` 和 `rebalance`

`AutomationService` 保存投资计划，并运行到期计划的定时检查。这个检查由 Worker 的 Cron Trigger 调用，在 Node 和 stdio 服务里则由定时器调用。到期的计划会提示你确认。标记了 `autoExecute` 的 Demo 计划，在 `AUTOMATION_DEMO_ENABLED=true` 时通过 `prepareBasket` 和 `executeBasket` 执行。`policy.ts` 和 `rebalance.ts` 是带单元测试的纯函数。见 [AUTOMATION.md](./AUTOMATION.md)。

<a id="piesservice-pricealerts-accountalerts-and-notifications"></a>
### `PiesService`、`PriceAlerts`、`AccountAlerts` 和通知

`PiesService`（`pies.ts`）读取 Pie 时使用短时缓存，因为 Trading 212 每 30 秒只允许读一次列表、每 5 秒只允许读一次详情；它还会算出偏离和合计。Pie 的变更沿用下单的流程：`preparePieChange` 解析 ticker、规整各成分占比并签发一次性令牌；`executePieChange` 消耗这个令牌，在 Live 上还需要 `liveAcknowledged`，然后只发送一次写请求。

`PriceAlerts`（`alerts.ts`）在每次定时检查中、处理完联动保护单和计划之后运行。它每个环境只读一次持仓，用纯函数 `evaluateAlert` 评估每个已启用的提醒，并写入一条 `price_alert_triggered` 事件。它从不向券商写入。

`AccountAlerts`（`account-alerts.ts`）在同一次检查中紧随其后。账户总值和现金提醒每个环境只取一次账户概要（`TradingService.accountSummary`，30 秒内复用，所以刚被定时检查或仪表盘读过的概要不会再请求一次）；当日涨跌提醒每个环境最多每十分钟一起读一次 `portfolioToday`，只计算其最近一个交易日的持仓，并用 `ended`（当天交易时段结束的时间）跳过提醒设置之前就已结束的交易时段。提醒触发时写入一条 `account_alert_triggered` 事件。它从不向券商写入。

`ListingWatches`（`listing-watch.ts`）随后运行：开启了上架提醒的每个账户最多每小时读一次标的列表（`TradingService.instruments`，缓存十分钟），把 Trading 212 标注在最近 14 天上架的代码记在 `listing-seen:<environment>` 下，对其中没见过且符合条件的写一条 `new_listings` 事件。读取失败的账户等下一次调度再试。

`Goals`（`goals.ts`）按环境保存一个投资目标。它在定时检查中紧跟在市值记录之后，使用刚记下的市值，所以不额外读取：第一次衡量某个目标（或修改过的目标金额）时只记下已达到的节点，之后每达到更高的节点就写一条 `goal_milestone` 事件。它从不向券商写入。

`TargetAllocations`（`targets.ts`）按环境保存目标权重。它在定时检查中排在提醒之后，但每个环境每小时最多读一次账户，用纯函数 `allocationDrift` 比较权重；偏离超过阈值期间，每天最多写一条 `allocation_drift` 事件。同样的偏离也会附在 `analyze_portfolio_allocation` 的结果里。它从不向券商写入。

`OrderWatch`（`order-watch.ts`）在定时检查中紧接联动保护单之后运行，每个环境最多每 5 分钟一次。它把上一次检查时的挂单保存在存储里。对已经离开订单簿的订单，它用 `recentOrderOutcomes` 读一次订单历史（现在也会返回成交均价和成交金额），把成交记录逐行相加，并按成交时间翻页。历史里找不到、或者还没有最终结果的订单，最多再保留三次检查。之后每笔订单得到一条 `order_filled`、`order_partly_filled`、`order_closed` 或 `order_outcome_unknown` 事件，成交信息作为字段附上，方便组件显示。成交时间还会保存在 `order-fills:<env>` 下，供每日摘要使用。它从不向券商写入。`ORDER_WATCH=false` 可以关闭它。

`ValueHistory`（`value-history.ts`）在定时检查中排在订单跟踪之后。每个环境大约每小时一次，它只读取账户概要（`TradingService.accountSummary`），把当天的数据点更新写入 `value-history:<env>:<YYYY-MM>`。每月一个键，保证每个存储值都远低于 Durable Object 的单值上限。`get_portfolio_performance` 用 `points()` 读取时间范围内的数据点。

`notify.ts` 根据 `NOTIFY_WEBHOOK_URL`（一个或多个地址，各有自己的格式）构建一个可选的 `Notifications`。`TradingService.recordActivity` 会把每个事件交给它的 `send`；它按类型过滤，用 `NOTIFY_LOCALE` 的语言书写，按每个地址排版，设置了密钥时对每个消息体签名，并且从不抛出错误。某个地址没有接收的通知，以及因 `NOTIFY_QUIET_HOURS` 暂存的通知，保存在 `notify-outbox:<事件>:<地址哈希>` 下；定时任务的最后一步 `flush()` 发送到期的通知（暂存的按地址合成一条），失败的留到下一次等待。每条在发送前先用 `consume` 取出，所以两次定时任务不会重复发送。存储里只保存每个地址的哈希，从不保存 URL。

<a id="insightsservice-and-analytics"></a>
### `InsightsService` 和 `analytics`

只读。`InsightsService` 在页数预算内翻阅 Trading 212 由新到旧排列的历史记录，并做短时缓存。`analytics.ts` 用带单元测试的纯函数，把这些数据算成仓位配置、收益、收入和交易时段结果。`readHoldingRisk`（`holding-risk.ts`）从价格历史中为配置补上每个持仓过去一年的收盘价，从最大的持仓开始，在几秒内完成；纯函数 `holdingRiskOf`（`shared/holding-risk.ts`）再据此算出每个持仓的风险占比和相关系数。这条路径上的任何部分都不能向券商写入。

<a id="statestore"></a>
### `StateStore`

提供一个小型持久化状态 API，供 OAuth、确认、限流、操作记录和核对记录使用。

Node 使用基于文件、原子写入的实现。Cloudflare 使用一个以 SQLite 为后端的命名 Durable Object。两种实现中，“消耗确认”这一操作都是原子的。

<a id="mcp-layer"></a>
### MCP 层

公开的 MCP 接口有两类工具：

- 模型可见的工具，用于读取组合、解析标的、展示交易计划、查看近期操作和检查订单；
- 仅 App 可见的工具，只有在界面里明确操作时才会调用，用于确认和撤单。

券商写操作始终只对 App 可见。

除了工具，`mcp-prompts.ts` 还把每个 skill 作为 MCP prompt 提供，并为每个配置了密钥的账户，把账户保存的状态（持仓、交易日志、目标、自选列表）作为资源提供，同时为 prompt 的账户和标的参数提供自动补全。每个工具都声明了 `outputSchema`（`tool-output.ts`），服务器会按它检查每个结果。

<a id="execution-invariants"></a>
## 执行不变量

以下规则是有意为之的，扩展项目时应当继续成立：

1. 任何定时或无人值守的路径都不得提交 Live 订单。唯一的 Live 无人值守写操作，是联动的一对保护单中一张成交后，撤销剩下的那张。唯一的无人值守下单路径——带 `autoExecute` 且 `AUTOMATION_DEMO_ENABLED=true` 的到期 Demo 计划——使用与已确认订单篮相同的校验、规则和不重试规则。
2. 准备订单不得提交订单。
3. 每一次下单、订单篮、撤单和 Pie 写操作都要消耗一次性确认。
4. Trading 212 写请求从不自动重试，唯一的例外是收到 429 后重发一次，因为 Trading 212 并没有执行那次请求。
5. 结果未知的写操作保持“未知”，直到回读检查提供证据。
6. 回读核对从不重新提交原来的写请求。
7. Demo 和 Live 凭据保持独立。
8. 面向用户的环境切换不得悄悄改动已经确认的订单。
9. 被规则拦下的订单永远拿不到确认令牌，并且每次写入前会立即再评估一次规则。
10. 密钥永远不会进入结构化 MCP 输出、操作记录或 Git 跟踪的文件。

<a id="cloudflare-adapter"></a>
## Cloudflare 适配器

Worker 适配器提供：

- 通过 `ASSETS` 绑定提供的静态 MCP App 资源；
- 一个单例的命名 Durable Object，用于保存实例状态；
- 从请求推导出的公网地址，避免写死个人 URL；
- 与 Node 相同的 Hono 应用。

部署模型是单用户的。一个 Worker 实例只拥有一组 Trading 212 凭据。

<a id="node-adapter"></a>
## Node 适配器

Node 适配器读取本地环境文件，把状态保存在 `.data/` 下，并追加写入本地 JSONL 审计日志。它适合本地开发，或部署在私有 VPS/容器上。

<a id="ui-principles"></a>
## 界面原则

界面有意保持紧凑：

- 账户状态放在最前；
- Demo/Live 状态始终可见；
- 持仓表格/卡片自适应；
- 交易计划按期限分组；
- 次要的研究细节默认折叠；
- 确认前展示订单的换算过程；
- 过期或未知的数据会明确显示，而不是隐藏；
- 不确定的写操作提供只读核对操作；
- 键盘焦点限制在模态对话框内，按 Escape 关闭当前对话框；
- 只有几个选项的切换（时间段、列表或热力图、订单的方向和类型）只占一个 Tab 位置，用方向键、Home 和 End 在选项之间切换；
- 浏览器原本自己绘制的控件（滚动条、下拉框、复选框、开关、折叠面板）都按组件的样式绘制，在高对比度模式下使用系统颜色；
- 除了工具调用，组件交给宿主的东西只在宿主声明支持时才提供（`getHostCapabilities`）：要保存的文件（`ui/download-file`）、发到对话里的问题（`ui/message`，只在读者选了一个问题时发送），以及当前页面的说明（`ui/update-model-context`：页面名称、账户，以及和工具结果文字相同的摘要，最多 4000 字符；页面稳定片刻后才发送，内容没变就不发）。这些都不会交易，模型也会被告知没有从页面上做过交易。

<a id="extending-the-project"></a>
## 扩展项目

新的券商逻辑通常应通过 `TradingService` 和共享契约加入，而不是放进平台适配器。新的运行时支持应实现 `StateStore`，并为共享的 Hono 应用提供配置、组件 HTML 和可选的审计钩子。

行情数据源、研究流程和定期任务应留在券商桥接层之外，除非券商操作的正确性需要它们。

<a id="transaction-workspace"></a>
### 交易工作区

订单编辑、最终确认和撤单确认都在正常文档流中渲染，而不是用固定定位的 iframe 浮层。这样 MCP 宿主能测量真实内容高度，在较矮的嵌入视图中也不会把对话框压扁。如果宿主支持全屏而当前视口特别矮，界面会尽量请求全屏；文档流布局仍是兜底方案。同一时间只挂载一个交易步骤，所以不会出现嵌套的模态层，也不会有重复的滚动容器。
