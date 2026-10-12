# Claude plugin and local stdio mode

TradePilot can run as a local process instead of a public Worker. This mode suits Claude Code and other MCP clients that launch a server process. It needs no OAuth, no public URL, and no Cloudflare account.

## Install as a Claude Code plugin

```text
/plugin install tradepilot212 --marketplace Kukutx/TradePilot212
```

On older Claude Code versions, add the marketplace first:

```text
/plugin marketplace add Kukutx/TradePilot212
/plugin install tradepilot212@tradepilot212
```

When the plugin is enabled, Claude Code asks for its options:

| Option | Purpose |
|---|---|
| Try with sample data | Use a simulated Demo account instead of Trading 212, to try every tool without a key. Live is off while it is on. See [TRY_IT.md](./TRY_IT.md). |
| Trading 212 Demo / Live API key and secret | Stored in the system credential store (marked sensitive). Leave unused environments empty. |
| Default environment | `demo` unless you choose otherwise. |
| Enable order tools | **Off by default.** See below. |
| Max order value | Per-order value cap in your account currency; `0` disables it. |
| Run Demo plans unattended | **Off by default.** Lets due Demo investment plans marked `autoExecute` place orders on their own while Claude Code is running. Needs order tools enabled. Live plans always wait for you. |
| Notification webhook | Optional HTTPS webhook (Slack, Discord or your own) for due plans, fills and price alerts. Only sent while Claude Code runs the server. |
| Quote source / Quote API key | Prices for instruments you do not hold. `stooq` (default) is free with no key; `finnhub`, `twelvedata` and `alphavantage` need a free key. |

You can change these later under `/plugin` → Installed → Configure options.

The plugin ships a prebuilt server (`plugin/server.mjs`) and needs only `node` 22+ on your `PATH`. State and the audit log are kept in the plugin data directory, so they survive plugin updates.

The plugin ignores `.env` files in the folder you open Claude Code in, so another project's settings cannot change its policy. For settings that have no option above, such as `POLICY_*` rules, `DIGEST_HOUR_UTC`, `BENCHMARK` or `NOTIFY_WEBHOOK_SECRET`, put a `.env.local` in the plugin data directory. The options above take precedence over it.

### Skills included

| Skill | Use it for |
|---|---|
| `/tradepilot212:portfolio-review` | Performance, income, costs, and allocation for a period |
| `/tradepilot212:daily-brief` | Read-only pre-market brief with short, medium, and long ideas |
| `/tradepilot212:risk-check` | Concentration, currency exposure, cash, and risky pending orders |
| `/tradepilot212:trade-journal` | Reviewing recent fills, fees, and FX against the reasons in your trade journal, and saving what you learn |
| `/tradepilot212:order-followup` | Whether an order filled, what is still pending, and cancelling one after your confirmation |
| `/tradepilot212:tax-year` | One tax year's sales, gains and losses, dividends, interest and costs, to prepare a tax return |
| `/tradepilot212:rebalance` | Moving the portfolio toward target weights as one reviewed basket |

Claude also picks these skills up automatically when your request matches.

### Why order tools are off by default

In ChatGPT and other MCP Apps hosts, TradePilot's execution tools are app-only: the model cannot see them, and only a click in the TradePilot UI can call them.

A terminal host may not render MCP Apps UIs. In such a host the execution tools would be ordinary tools the model could call. So in stdio mode, TradePilot registers neither the order-review tools nor the execution tools unless you enable them.

If you enable them, keep Claude Code's per-call permission prompt on for `app_execute_order`, `app_execute_basket`, `app_execute_cancel` and `app_execute_pie_change`, and never add them to an allow-list. That prompt is then your confirmation step.

## Run the stdio server without the plugin

From a clone:

```bash
pnpm install
pnpm stdio            # reads .env.local, writes are disabled
```

Several clients (for example Claude Desktop and Claude Code) can run the server on the same data directory at once. The state file is locked for every change and reloaded when another process wrote it, so plans, alerts, linked orders and confirmation tokens stay consistent and a due plan is sent by only one of them.

Any MCP client config can point at the bundled file:

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

| Variable | Default | Meaning |
|---|---|---|
| `TRADEPILOT_ALLOW_WRITES` | `false` | Register the order-review and execution tools |
| `TRADEPILOT_DATA_DIR` | `~/.tradepilot212` | Confirmation state and `audit.jsonl` |
| `TRADEPILOT_WIDGET_HTML` | bundled `plugin/widget.html` | Override the UI file |
| `TRADEPILOT_SAMPLE_DATA` | `false` | Serve the simulated sample account instead of Trading 212; Live is off |

The remaining settings (`T212_*`, `DEFAULT_TRADING_ENV`, `MAX_ORDER_*`, `CONFIRMATION_TTL_SECONDS`) mean the same as in the Worker.

## Claude.ai and Claude Desktop

Claude renders MCP Apps on the web, desktop, and mobile. For those surfaces, deploy the Worker as described in the README and add its `/mcp` URL as a custom connector. The OAuth flow and app-only confirmation behave exactly as they do in ChatGPT.

The local stdio server is for Claude Code, and for Cowork sessions that run on your own computer.

## Maintaining the bundle

`plugin/server.mjs` and `plugin/widget.html` are build outputs that are committed on purpose, because Claude Code does not run build steps when it installs a plugin.

After changing `src/`, run:

```bash
pnpm build:plugin
node scripts/smoke-stdio.mjs
```

CI fails if the committed bundle is out of date.
