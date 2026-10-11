# TradePilot 212

[简体中文](./README.zh-CN.md) · English

TradePilot 212 is a self-hosted MCP application for Trading 212 Invest. It connects a personal Trading 212 account to ChatGPT or Claude. It adds deterministic performance, income, cost and allocation analytics, rebalancing, protective orders and investment plans, all behind a configurable policy engine. It provides a compact portfolio and trade-plan UI. Every Live broker write still needs an explicit confirmation.

Each deployment belongs to one user. Your Trading 212 credentials stay in your own environment; the repository owner does not run a shared brokerage backend.

## Design goals

- **Conversation-first workflow** — works in ChatGPT, Claude, and Claude Code; use symbols, company names, amounts, percentages, or exact quantities in normal conversation.
- **Explicit execution boundary** — analysis and order preparation are read-only; a broker write happens only after confirmation in the app UI.
- **Self-hosted by default** — Cloudflare Workers is the recommended hosted path; Node.js and Docker/VPS are also supported.
- **Small runtime surface** — the Worker handles account access, instrument resolution, validation, state, and execution. Research and scheduling stay outside the broker bridge.
- **Recoverable failures** — ambiguous write outcomes are never retried automatically and can be checked against current broker state.
- **Portable UI** — responsive inline/fullscreen layouts, an in-flow order workspace that does not depend on fixed iframe overlays, English and Simplified Chinese, with an extensible locale registry.

## What is included

- Trading 212 Invest account summary, positions, pending orders, and recent TradePilot activity
- performance, dividend/interest income, trading costs, trade history, and allocation/concentration analysis computed from Trading 212 history ([docs/ANALYTICS.md](./docs/ANALYTICS.md))
- market-hours awareness, including a warning when a Market order would queue until the next open
- a policy engine: position-weight cap, daily order and value budgets, ticker and instrument-type lists, closed-market Market-order blocking, reference-price age ([docs/AUTOMATION.md](./docs/AUTOMATION.md#policy-engine))
- order baskets: up to 20 orders validated together and confirmed once, sells first, stopping on an uncertain result
- target-weight rebalancing that sizes the trades from broker prices and available cash
- broker-native stop-loss and take-profit orders (Good-Till-Cancel), linked so that when one fills TradePilot cancels the other
- weekly or monthly investment plans that wait for your confirmation when due, with Market or gap-capped Limit legs; Demo plans can optionally run unattended
- Trading 212 pies: value, return, dividends, goal progress and drift from target for every slice; create, update, duplicate and delete pies after confirmation ([docs/PIES.md](./docs/PIES.md))
- price alerts on holdings (above / below a price, trailing drop from the high, gain or loss against average cost), checked every minute
- optional webhook notifications (Slack, Discord or your own endpoint) for due plans, sent orders, fills, alerts and unclear results
- a Claude Code plugin with a local stdio server and review, brief, risk, and journal skills ([docs/CLAUDE_PLUGIN.md](./docs/CLAUDE_PLUGIN.md))
- separate Demo and Live credentials and UI states
- short / medium / long trade-plan cards
- expandable thesis, catalysts, risks, counter-case, sources, and data timestamps
- ticker, symbol, company-name, and partial-name resolution
- order sizing by:
  - exact quantity
  - target monetary amount
  - percentage of available cash for buys
  - percentage of the total held position for sells
  - all currently tradable shares for sells
- Market, Limit, Stop, and Stop-Limit order drafts
- transparent intent-to-quantity conversion with manual-edit indication
- reference-price freshness notices
- structured errors rendered in the selected UI language
- one-time confirmation state and no automatic write retries
- read-back verification after an uncertain order/cancellation response
- OAuth + PKCE for the MCP connection
- Cloudflare Durable Objects or local file-backed state through the same `StateStore` contract

## Requirements

- Node.js 22+
- pnpm 11+
- a Trading 212 Invest account with Public API access
- a Cloudflare account for the recommended hosted deployment
- a ChatGPT or Claude plan that supports custom connectors with MCP Apps, or Claude Code for the local plugin

Install pnpm if needed:

```bash
npm install -g pnpm@11
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Kukutx/TradePilot212.git
cd TradePilot212
pnpm install
```

### 2. Create local configuration

```bash
pnpm setup
```

`pnpm setup` creates `.env.local` if it does not already exist and generates strong local values for the OAuth login password and signing secret.

Open `.env.local` and add the Trading 212 environments you intend to use:

```env
T212_DEMO_API_KEY=
T212_DEMO_API_SECRET=

T212_LIVE_API_KEY=
T212_LIVE_API_SECRET=
```

Demo and Live use separate Trading 212 credentials. Configure either one or both.

Trading 212 API documentation:

- https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key
- https://docs.trading212.com/

For portfolio-only use, read permissions are sufficient. Order review/execution requires the corresponding order permissions on the Trading 212 API key.

### 3. Check the configuration

```bash
pnpm doctor
```

This checks the runtime, local OAuth configuration, and Trading 212 connectivity with read-only requests. It does not place an order.

### 4. Deploy a personal Worker

```bash
pnpm deploy
```

The deployment command:

1. validates the local configuration and project,
2. opens Cloudflare authentication when required,
3. synchronizes the instance settings through Worker Secrets,
4. builds the app,
5. deploys the Worker,
6. prints the App and MCP endpoints.

Typical output:

```text
App: https://tradepilot212.<your-subdomain>.workers.dev
MCP: https://tradepilot212.<your-subdomain>.workers.dev/mcp
```

Check the deployment without publishing it:

```bash
pnpm deploy -- --dry-run
```

Use a different Worker name:

```bash
pnpm deploy -- --name=my-tradepilot
```

### 5. Connect ChatGPT or Claude

In ChatGPT, open the Apps settings and create a custom MCP connection. In Claude, add a custom connector. Use the `/mcp` URL printed by the deployment command.

The OAuth page asks for the `APP_LOGIN_PASSWORD` stored in your own `.env.local`. Do not paste Trading 212 API credentials into ChatGPT.

To use TradePilot only from Claude Code on your own computer, skip the deployment and install the plugin instead:

```text
/plugin install tradepilot212 --marketplace Kukutx/TradePilot212
```

See [docs/CLAUDE_PLUGIN.md](./docs/CLAUDE_PLUGIN.md).

After the connection is established, normal prompts can be simple:

```text
Show my Trading 212 Live portfolio.
How much have I made this year, after fees? How much did I pay in FX fees?
How much dividend income did I get in the last 12 months?
Am I too concentrated? Flag anything above 15%.
Is the US market open right now?
Analyze Nvidia in the context of my current positions.
Compare AMD, Nvidia, and Broadcom for a one-month horizon.
Prepare a Demo order for 0.2 shares of NVDA.
Use about €100 to buy Nvidia in Live.
Sell half of my Apple position.
Sell all currently tradable Apple shares.
Prepare a 220 USD limit buy for 0.5 NVDA. Do not submit it.
```

TradePilot resolves and normalizes the request into an editable quantity-based order. The broker write still requires the final confirmation in the UI.

## Order flow

```text
User request
  ↓
Instrument resolution + account/position read
  ↓
Sizing and editable order draft
  ↓
Server validation + data freshness notices
  ↓
Short-lived one-time confirmation
  ↓
Explicit user confirmation
  ↓
Trading 212 write
```

If a write times out or returns an ambiguous server error, TradePilot does **not** resend it. The UI offers a read-only status check that looks for a matching pending order or a corresponding position change. An inconclusive result remains inconclusive; it is never converted into an automatic retry.

See [docs/ORDERING.md](./docs/ORDERING.md) for the sizing rules and edge cases.

## Automation levels

| Level | What it does | Confirmation |
|---|---|---|
| L0 | Scheduled read-only briefs and analytics | none needed |
| L1 | Broker-native stop-loss / take-profit orders, linked so a fill cancels the other | once, when placed |
| L2 | Investment plans: due runs are announced and opened as a basket | once per run |
| L3 | Unattended runs of due plans | **Demo only**, opt-in with `AUTOMATION_DEMO_ENABLED=true` |

Price alerts and webhook notifications run at every level; they only notify and never trade.

Live never places an order unattended; that is enforced in code, not configuration. The only unattended Live write is cancelling the other half of a stop-loss / take-profit pair after one fills (turn off with `PROTECTIVE_OCO=false`). Live orders and baskets also need a second, explicit confirmation that real money is used. Research and news stay in a scheduled ChatGPT or Claude task. See [docs/AUTOMATION.md](./docs/AUTOMATION.md).

## Configuration

Common instance settings:

```env
DEFAULT_TRADING_ENV=demo
MAX_ORDER_NOTIONAL=5000
MAX_ORDER_QUANTITY=100000
CONFIRMATION_TTL_SECONDS=90
```

`DEFAULT_TRADING_ENV` applies only when a request does not explicitly select Demo or Live.

Set `MAX_ORDER_NOTIONAL=0` or `MAX_ORDER_QUANTITY=0` to disable the corresponding TradePilot application-level cap. Trading 212 account/instrument rules and explicit confirmation still apply.

Policy rules (`POLICY_*`) bind Live by default. A typical Live setup:

```env
POLICY_MAX_POSITION_WEIGHT=0.2
POLICY_DAILY_ORDER_LIMIT=10
POLICY_DAILY_NOTIONAL_LIMIT=3000
POLICY_ALLOWED_TYPES=ETF,STOCK
POLICY_MARKET_ORDERS_WHEN_CLOSED=false
```

All policy variables are described in [docs/AUTOMATION.md](./docs/AUTOMATION.md#policy-engine).

Notifications are optional:

```env
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/…
NOTIFY_WEBHOOK_SECRET=        # optional HMAC signature
NOTIFY_EVENTS=                # optional, e.g. plan_due,price_alert_triggered
```

## Local development

Node development server:

```bash
pnpm setup
# fill .env.local
pnpm doctor
pnpm dev
```

Local MCP endpoint:

```text
http://localhost:8000/mcp
```

For temporary ChatGPT testing from a local Node process:

```bash
pnpm dev:chatgpt
```

This uses a Cloudflare Quick Tunnel. The URL is temporary; use a normal Worker deployment for a stable personal endpoint.

Local Cloudflare runtime:

```bash
cp .dev.vars.example .dev.vars
# fill .dev.vars
pnpm dev:cloudflare
```

## Validation

```bash
pnpm check
pnpm smoke
pnpm audit --prod
pnpm release:check
pnpm deploy -- --dry-run
```

The repository CI runs type checking, tests, production builds, dependency audit, release-safety checks, and a Wrangler deployment dry run.

## Architecture

```text
ChatGPT / MCP host
        │
        ▼
  Hono + OAuth/PKCE
        │
        ▼
 TradingService ─┬─ Trading212Client ── Trading 212
 InsightsService ┤        ▲
 AutomationService ─ policy · rebalance (pure)
        │
        ▼
    StateStore            ← Cron Trigger / interval: due plans
     ├─ file-backed state (Node)
     └─ Durable Object / SQLite (Workers)

React App UI ← MCP App resource
```

The core does not depend on the Node filesystem or Cloudflare APIs. Runtime-specific concerns live under `src/adapters/`.

More detail: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Self-hosting model

```text
User A → User A's ChatGPT → User A's Worker → User A's Trading 212 credentials
User B → User B's ChatGPT → User B's Worker → User B's Trading 212 credentials
```

Do not publish a personal deployed Worker as a shared endpoint for unrelated users. A multi-user hosted service requires separate identity, credential isolation, and authorization architecture that this repository intentionally does not implement.

See [docs/PUBLISHING.md](./docs/PUBLISHING.md).

## Security notes

- `.env.local`, `.dev.vars`, `.data`, build output, and Wrangler state are excluded from Git.
- Trading 212 API credentials are deployed as Worker Secrets, not source configuration.
- Demo and Live credentials are separate.
- order, basket and cancellation confirmations are short-lived and one-time.
- the policy engine runs at review and again at execution; a blocked order never receives a token.
- Live investment plans cannot be set to run unattended.
- write requests are never automatically retried after an ambiguous response.
- order constraints are revalidated immediately before submission.
- recent activity stores order metadata only; it does not store API credentials.
- the confirmation step stops the model from trading on its own, but anyone holding your connection password can trade; read the [threat model](./SECURITY.md#threat-model-and-known-limits) before adding Live credentials.

Run `pnpm release:check` before publishing changes.

See [SECURITY.md](./SECURITY.md).

## Project layout

```text
src/
├─ adapters/
│  ├─ cloudflare/       Workers + Durable Objects + Static Assets
│  └─ node/             Node server + file-backed state
├─ app/                 shared HTTP/MCP application
├─ core/                OAuth, MCP tools, broker client, trading rules, state
├─ shared/              runtime-neutral contracts and metadata
└─ ui/                  React MCP App UI and locale dictionaries

scripts/                 setup, diagnostics, deployment, smoke checks
docs/                    architecture, ordering, automation, publishing, i18n
.github/workflows/        CI
```

## License

MIT. See [LICENSE](./LICENSE).

## Disclaimer

TradePilot 212 is a software integration project, not investment advice. Review market information and every order yourself. Trading 212 controls API availability, permissions, instruments, and broker-side limits, and those may change independently of this repository.
