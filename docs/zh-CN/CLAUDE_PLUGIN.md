# Claude 插件和本地 stdio 模式

简体中文 · [English](../CLAUDE_PLUGIN.md)

TradePilot 可以作为本地进程运行，而不是部署成公网 Worker。这种模式适合 Claude Code 和其他会自己启动服务进程的 MCP 客户端。它不需要 OAuth、公网地址，也不需要 Cloudflare 账户。

<a id="install-as-a-claude-code-plugin"></a>
## 作为 Claude Code 插件安装

```text
/plugin install tradepilot212 --marketplace Kukutx/TradePilot212
```

较旧版本的 Claude Code 需要先添加 marketplace：

```text
/plugin marketplace add Kukutx/TradePilot212
/plugin install tradepilot212@tradepilot212
```

启用插件时，Claude Code 会询问以下选项：

| 选项 | 用途 |
|---|---|
| Try with sample data | 用模拟的 Demo 账户代替 Trading 212，不需要 Key 就能试用所有工具。打开时 Live 处于关闭状态。见 [TRY_IT.md](./TRY_IT.md)。 |
| Trading 212 Demo / Live API key and secret | 保存在系统凭据库中（标记为敏感）。不用的环境留空即可。 |
| Default environment | 默认为 `demo`，除非你另选。 |
| Enable order tools | **默认关闭。** 见下文。 |
| Max order value | 单笔订单金额上限，按账户币种计算；`0` 表示关闭。 |
| Run Demo plans unattended | **默认关闭。** 允许标记了 `autoExecute` 的到期 Demo 投资计划在 Claude Code 运行期间自行下单。需要先打开下单工具。Live 计划始终等你确认。 |
| Notification webhook | 可选的 HTTPS webhook（Slack、Discord 或你自己的接口），用于计划到期、成交和价格提醒通知。只在 Claude Code 运行服务时发送。 |
| Quote source / Quote API key | 未持有标的的价格。`stooq`（默认）免费，无需 Key；`finnhub`、`twelvedata` 和 `alphavantage` 需要一个免费 Key。 |

之后可以在 `/plugin` → Installed → Configure options 中修改这些选项。

插件自带预先构建好的服务（`plugin/server.mjs`），只需要 `PATH` 里有 `node` 22+。状态和审计日志保存在插件数据目录中，插件更新后依然保留。

插件会忽略你打开 Claude Code 的那个文件夹里的 `.env` 文件，这样其他项目的设置无法改变它的规则。上面没有对应选项的设置，例如 `POLICY_*` 规则、`TIMEZONE`、`TAX_YEAR_START`、`DIGEST_HOUR`、`BENCHMARK`、`NOTIFY_QUIET_HOURS` 或 `NOTIFY_WEBHOOK_SECRET`，请写进插件数据目录里的 `.env.local`。上面的选项优先于它。

<a id="skills-included"></a>
### 附带的 skill

| Skill | 用途 |
|---|---|
| `/tradepilot212:portfolio-review` | 某段时间的收益、收入、费用和仓位配置 |
| `/tradepilot212:daily-brief` | 只读的开盘前简报，附短期、中期和长期思路 |
| `/tradepilot212:risk-check` | 集中度、货币敞口、现金和有风险的待处理订单 |
| `/tradepilot212:trade-journal` | 对照交易日志里的理由复盘近期成交、费用和汇兑，并保存心得 |
| `/tradepilot212:order-followup` | 订单是否成交、还有哪些待处理，以及经你确认后撤单 |
| `/tradepilot212:tax-year` | 一个税务年度的卖出、盈利和亏损、股息、利息和费用，用于准备报税 |
| `/tradepilot212:rebalance` | 把组合作为一个经过检查的订单篮调向目标权重 |

当你的请求与这些 skill 匹配时，Claude 也会自动使用它们。

<a id="prompts-and-resources-for-any-mcp-client"></a>
### 适用于任何 MCP 客户端的 prompt 和资源

服务器把同样的 skill 作为 MCP prompt 提供，所以不支持插件 skill 的客户端（Claude Desktop、通过 Worker 使用的 Claude.ai，或其他 MCP 宿主）也能运行它们。每个 prompt（`daily-brief`、`portfolio-review`、`risk-check`、`trade-journal`、`order-followup`、`tax-year`、`rebalance`）接受 `environment`（`demo` 或 `live`，输入时自动补全）、一个可选的 `request`（用户自己的原话）；`trade-journal` 和 `order-followup` 还接受 `instrument`，它会从账户持有、有挂单或在自选列表里的 ticker 中自动补全。

它还为每个配置了密钥的账户提供四个 JSON 资源，供宿主附加到对话中（Live 账户把 `demo` 换成 `live`）：

| 资源 | 内容 |
|---|---|
| `tradepilot://demo/holdings` | Trading 212 提供的账户概要、持仓和挂单，最多是一分钟前读取的 |
| `tradepilot://demo/journal` | 全部交易日志记录 |
| `tradepilot://demo/targets` | 保存的目标配置，或 `null` |
| `tradepilot://demo/watchlist` | 自选列表中的标的及其备注 |

这些 prompt 由 `skills/*/SKILL.md` 生成到 `src/core/skill-prompts.ts`，因为 Worker 和打包后的插件在运行时读不到 `skills/`。修改 skill 后，运行 `pnpm build:prompts`（`pnpm build:plugin` 也会运行它）；两者不一致时会有测试失败。

<a id="why-order-tools-are-off-by-default"></a>
### 为什么下单工具默认关闭

在 ChatGPT 和其他 MCP Apps 宿主中，TradePilot 的执行工具仅 App 可见：模型看不到它们，只有在 TradePilot 界面里点击才能调用。

终端类宿主可能无法渲染 MCP Apps 界面。在这样的宿主里，执行工具就成了模型可以直接调用的普通工具。所以在 stdio 模式下，除非你主动打开，TradePilot 既不注册订单检查工具，也不注册执行工具。

如果你打开了它们，请为 `app_execute_order`、`app_execute_basket`、`app_execute_cancel` 和 `app_execute_pie_change` 保留 Claude Code 每次调用前的权限提示，并且永远不要把它们加进允许列表。这个提示就是你的确认步骤。

<a id="run-the-stdio-server-without-the-plugin"></a>
## 不通过插件运行 stdio 服务

在克隆的仓库中：

```bash
pnpm install
pnpm stdio            # reads .env.local, writes are disabled
```

多个客户端（例如 Claude Desktop 和 Claude Code）可以同时在同一个数据目录上运行服务。每次修改都会锁定状态文件，其他进程写过后会重新加载，所以计划、提醒、联动订单和确认令牌保持一致，一个到期计划也只会由其中一个发送。

任何 MCP 客户端配置都可以指向打包好的文件：

```json
{
  "mcpServers": {
    "tradepilot212": {
      "command": "node",
      "args": ["/path/to/TradePilot212/plugin/server.mjs"],
      "env": {
        "T212_DEMO_API_KEY": "...",
        "T212_DEMO_API_SECRET": "...",
        "TRADEPILOT_DATA_DIR": "/path/to/state"
      }
    }
  }
}
```

| 变量 | 默认值 | 含义 |
|---|---|---|
| `TRADEPILOT_ALLOW_WRITES` | `false` | 注册订单检查工具和执行工具 |
| `TRADEPILOT_DATA_DIR` | `~/.tradepilot212` | 确认状态和 `audit.jsonl` |
| `TRADEPILOT_WIDGET_HTML` | 打包的 `plugin/widget.html` | 替换界面文件 |
| `TRADEPILOT_SAMPLE_DATA` | `false` | 用模拟的样例账户代替 Trading 212；Live 关闭 |

其余设置（`T212_*`、`DEFAULT_TRADING_ENV`、`MAX_ORDER_*`、`CONFIRMATION_TTL_SECONDS`）的含义与 Worker 中相同。

<a id="claudeai-and-claude-desktop"></a>
## Claude.ai 和 Claude Desktop

Claude 在网页、桌面和移动端都能渲染 MCP Apps。在这些地方使用时，按 README 的说明部署 Worker，并把它的 `/mcp` 地址添加为自定义连接器。OAuth 流程和仅 App 可见的确认，与在 ChatGPT 中完全一样。

本地 stdio 服务用于 Claude Code，以及在你自己电脑上运行的 Cowork 会话。

<a id="maintaining-the-bundle"></a>
## 维护打包文件

`plugin/server.mjs` 和 `plugin/widget.html` 是构建产物，有意提交到仓库，因为 Claude Code 安装插件时不会运行构建步骤。

修改 `src/` 后，运行：

```bash
pnpm build:plugin
node scripts/smoke-stdio.mjs
```

如果提交的打包文件不是最新的，CI 会失败。
