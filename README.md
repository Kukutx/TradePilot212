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

**Try it first:** turn on sample data to explore every feature on a simulated account with no Trading 212 key, then move to your Demo account. See [docs/TRY_IT.md](./docs/TRY_IT.md). Every guide in docs/ is also in Simplified Chinese, in [docs/zh-CN](./docs/zh-CN/).

## What is included

- Trading 212 Invest account summary, positions, pending orders, and recent TradePilot activity
- the holdings as a sortable table (by value, the day's move, profit or loss, or name) or as a map: one tile per holding, sized by its value and coloured by its move on the day or its return since bought; a tile opens the holding ([docs/ANALYTICS.md](./docs/ANALYTICS.md#the-holdings-map))
- the day's move of every holding and of the account: each holding's price against its previous close, with the profit or loss in your currency and shares bought or sold that day counted from their fill price; before the open and over a weekend it is the last session's move. Each instrument's page shows its own, and the daily digest leads with it ([docs/ANALYTICS.md](./docs/ANALYTICS.md#the-days-move))
- a page per holding: position and share of the account, a price chart of the last year's daily closes with your buys and sells marked on it and the average cost, open stops and limits and alert levels drawn across it, a price ladder of the same levels, the last year of fills and dividends, and its trade journal
- a watchlist of instruments you follow, held or not: the price now, the change over a day, a month, three months or a year, a three-month line, where the price sits in its 12-month range, the nearest open order or alert, the move since you added it and your note; add from search or from any instrument's page ([docs/WATCHLIST.md](./docs/WATCHLIST.md))
- a trade journal: why you made each trade, written with the order or later on its fill, and what came of it looking back, kept in TradePilot and tied to the Trading 212 order; a Journal tab sets each reason against how the trade has gone since and shows per tag how often your reasons went your way ([docs/JOURNAL.md](./docs/JOURNAL.md))
- performance, dividend/interest income, trading costs, trade history (including cancelled and rejected orders), itemised dividends and cash movements, and allocation/concentration analysis computed from Trading 212 history ([docs/ANALYTICS.md](./docs/ANALYTICS.md))
- order follow-up from the chat: one order's status and fills, and a cancellation opened in the widget for you to confirm
- market-hours awareness, including a warning when a Market order would queue until the next open
- a policy engine: position-weight cap, daily order and value budgets, ticker and instrument-type lists, closed-market Market-order blocking, reference-price age ([docs/AUTOMATION.md](./docs/AUTOMATION.md#policy-engine))
- order baskets: up to 20 orders validated together and confirmed once, sells first, stopping on an uncertain result
- target-weight rebalancing that sizes the trades from broker prices and available cash; set the targets in the widget (typed in, or filled from today's weights, equal weights or the equal-risk weights, with instruments you don't hold yet found by a search, and the volatility they would give worked out as you type) or through the assistant; saved targets show their drift in the widget, notify when it grows past a threshold and rebalance in one click, all of them or only the ones past the threshold, or invest spare cash in the underweight targets without selling; the plan, the drift and the target form say what a rebalance buys and sells and about what Trading 212's 0.15% currency conversion fee comes to ([docs/AUTOMATION.md](./docs/AUTOMATION.md#saved-targets-and-drift-notices))
- broker-native stop-loss and take-profit orders (Good-Till-Cancel), linked so that when one fills TradePilot cancels the other
- fill notices for open orders, including ones placed in the Trading 212 app: filled (with the average price), partly filled, or closed without a fill, in the activity log and to the webhook ([docs/AUTOMATION.md](./docs/AUTOMATION.md#order-fill-notices))
- investment plans every weekday, weekly, every other week or monthly (any day, or the last), at an hour in their own time zone, that wait for your confirmation when due, with Market or gap-capped Limit legs, or one amount split across your saved targets so the most underweight holdings get the most; Demo plans can optionally run unattended; plans are created, changed, paused or opened for review from the widget's Automation tab as well as in the chat
- Trading 212 pies: value, return, dividends, goal progress and drift from target for every slice; create, update, duplicate and delete pies after confirmation ([docs/PIES.md](./docs/PIES.md))
- price alerts on holdings or any quoted instrument (above / below a price, a day's move either way from the previous close that arms itself again each trading day, trailing drop from the high, gain or loss against average cost), checked every minute
- account alerts: the account value or the free cash at or above / at or below an amount, or the whole account moving a percent in a day either way, added on the automation page or by asking ([docs/AUTOMATION.md](./docs/AUTOMATION.md#account-alerts))
- the widget and the chat work together where the host allows it: **Ask** sends a question about the page in view to the chat, **Save** saves the holdings, trades, cash movements or tax year as CSV (opens in Excel, Chinese names intact) or JSON, and the model is told which page you are looking at and what it shows, so "why is this down?" needs no explaining
- a built-in sample account (`TRADEPILOT_SAMPLE_DATA=true`) for trying everything without an API key ([docs/TRY_IT.md](./docs/TRY_IT.md))
- quotes for instruments you do not hold from a pluggable source (free Stooq by default, or Finnhub, Twelve Data or Alpha Vantage with your key), used by price alerts, plans, rebalancing and the journal review
- optional webhook notifications (Slack, Discord or your own endpoint) for due plans, sent orders, fills, price and account alerts and unclear results, plus an optional daily account digest with the day's move, the dividends paid since the last one and those expected in the coming week
- an automation overview in the widget: plans, price and account alerts, linked pairs, today's budget use and settings
- expected dividend income for the next 12 months from each holding's trailing payments, as a dividend calendar (paid this month and expected per month) with each payment's approximate date, and a holding's next payments on its page
- an account value chart from TradePilot's own daily record (Trading 212's API has no value history)
- your time-weighted return against an index fund's over the same days, the S&P 500 by default or any ETF you hold or watch, as a second line on the return chart with the gap in percentage points ([docs/ANALYTICS.md](./docs/ANALYTICS.md))
- risk on the Performance tab: volatility, return over volatility, beta and correlation to the benchmark, best and worst days, and a chart of how many days moved by how much ([docs/ANALYTICS.md](./docs/ANALYTICS.md#risk))
- equal-risk weights on the Allocation tab: the weights at which each holding would bring the same share of the risk (risk parity, with correlations shrunk toward their average), beside today's, and a button that drafts the rebalance to them as a basket to review ([docs/ANALYTICS.md](./docs/ANALYTICS.md#equal-risk-weights))
- today's mix over the year on the Allocation tab: what your holdings at today's weights did over the last year, with a bad week one in 20 (a 95% value at risk) in money, the worst week and the deepest fall ([docs/ANALYTICS.md](./docs/ANALYTICS.md#todays-mix-over-the-year))
- against the market on the Allocation tab: each holding's beta to the benchmark (the S&P 500 by default) and the holdings' together, the market's worst week and what a 5%, 10% or 20% fall in it would take by that beta, in money and as a share of the account ([docs/ANALYTICS.md](./docs/ANALYTICS.md#against-the-market))
- risk by holding on the Allocation tab: each holding's share of the risk beside its share of the value, from a year of weekly closes, their volatility together, a diversification ratio and how the largest move with each other ([docs/ANALYTICS.md](./docs/ANALYTICS.md#risk-by-holding))
- your position on each holding's page: its value at each daily close beside the net put in (the shares held at the start, plus buys less sells), so you see what the price did for it whatever you traded ([docs/ANALYTICS.md](./docs/ANALYTICS.md#your-position))
- monthly returns: the time-weighted return in each calendar month and year, as a year-by-month grid tinted green and red ([docs/ANALYTICS.md](./docs/ANALYTICS.md#monthly-returns))
- drawdown: the deepest fall of the time-weighted return from a high, when it was made up, how far below its high it is now, and the benchmark's deepest fall over the same days, as a third view of the return chart ([docs/ANALYTICS.md](./docs/ANALYTICS.md#drawdown))
- where a period's gain came from: each instrument's gain over 1 month, 3 months, this year, 12 months or all history (value now against its value at the start, its buys, sells and dividends), as bars either side of zero ([docs/ANALYTICS.md](./docs/ANALYTICS.md#gain-by-instrument))
- an annualized money-weighted return (XIRR) and a tax-year summary with realised gains and losses kept apart, dividends, interest and costs ([docs/ANALYTICS.md](./docs/ANALYTICS.md))
- a Claude Code plugin with a local stdio server and review, brief, risk, journal, order follow-up, rebalance and tax-year skills ([docs/CLAUDE_PLUGIN.md](./docs/CLAUDE_PLUGIN.md))
- a local preview of the widget on the sample account (`pnpm preview`), with language, theme and screen-width switches ([docs/TRY_IT.md](./docs/TRY_IT.md#preview-the-ui-locally))
- separate Demo and Live credentials and UI states
- short / medium / long trade-plan cards
- expandable thesis, catalysts, risks, counter-case, sources, and data timestamps
- ticker, symbol, ISIN, company-name, and partial-name resolution
- price sanity checks: a Limit or Stop price ten times off the last price (a pence/pounds slip) is blocked, and a stop that triggers at once or a limit that fills at once is called out
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
- one-time confirmation state and no automatic write retries (only a write Trading 212 refused with 429 is sent once more)
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

Demo and Live use separate Trading 212 credentials. Configure either one or both. To reach Trading 212 through a proxy you run, set `T212_DEMO_BASE_URL` or `T212_LIVE_BASE_URL` (HTTPS only; the keys are sent to it, and redirects are never followed).

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

Price and account alerts and webhook notifications run at every level; they only notify and never trade.

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

`MAX_ORDER_NOTIONAL` is in the account currency. An order in another currency is converted at the rate implied by your holdings, or, for a currency none of them is priced in, at the quote source's rate; pence (GBX) count at 100 to the pound. When no rate is known at all, the order is blocked while the cap is on instead of being compared in its own currency: pass `fxRate` (instrument-currency units per 1 account-currency unit) with `fxRateAt`, or set `MAX_ORDER_NOTIONAL=0`.

Set `MAX_ORDER_NOTIONAL=0` or `MAX_ORDER_QUANTITY=0` to disable the corresponding TradePilot application-level cap. Trading 212 account/instrument rules and explicit confirmation still apply.

OAuth clients may register any HTTPS redirect address by default (loopback addresses are always allowed for local tools). To accept only the hosts you use, list them:

```env
OAUTH_REDIRECT_HOSTS=chatgpt.com,.claude.ai   # .claude.ai is claude.ai and its subdomains
```

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
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/…   # one or more: Slack, Discord, Telegram, ntfy, Bark or any HTTPS endpoint
NOTIFY_LOCALE=zh-CN           # optional, notifications in Chinese (default en)
NOTIFY_QUIET_HOURS=22-07      # optional, hold all but urgent events overnight (in TIMEZONE), sent as one message after
NOTIFY_WEBHOOK_SECRET=        # optional HMAC signature
NOTIFY_EVENTS=                # optional, e.g. plan_due,price_alert_triggered
DIGEST_HOUR=7                 # optional daily digest at 07:00 in TIMEZONE (or DIGEST_HOUR_UTC=7)
REPORTS=weekly,monthly        # optional, a weekly report on Monday and a monthly one on the 1st, at the digest's hour
```

Days are counted in UTC unless you set your own zone; the tax year starts on 1 January unless you set its first day:

```env
TIMEZONE=Europe/London        # daily order limits reset at local midnight; the digest hour and tax year use it
TAX_YEAR_START=04-06          # the UK tax year; the History tab and get_tax_year_summary default to it
```

On the day you switch from UTC to another zone (or first set one), the limits and the digest join the new days once: in a zone behind UTC the day's budget can count a few hours more than the local day, and in one ahead of it the digest can go out a second time.

The Performance tab compares the return with the S&P 500 (SPY) by default; `BENCHMARK=VWRLl_EQ` picks another fund (map non-US listings in `QUOTE_SYMBOLS`) and `BENCHMARK=none` turns it off.

Rebalance estimates count Trading 212's currency conversion fee, 0.15% on Invest and ISA accounts, on the trades in another currency than the account's. Set `FX_FEE_RATE` (a fraction, `0.0015` by default) if yours differs, or `FX_FEE_RATE=0` if you trade from balances held in each currency, which convert nothing.

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

## Rate limits

Trading 212 limits each endpoint per account (history reads a few a minute, the account summary one in five seconds, and so on) and reports with every response how many requests are left and when the limit resets. The widget, the model's tools, the scheduled runs and background reads all share one record of that, per account and endpoint: a request to an endpoint with nothing left waits for its reset (a read up to a minute, an order up to 15 seconds) or is refused before it is sent, so it never spends a 429 that every other caller would then back off from. A history read the limit would hold longer comes back with the pages it read, marked truncated. The record is kept in memory, per process; a 429 is still retried as before.

Reads are shared the same way. A read of an endpoint that is already on its way is joined rather than sent again, so a dashboard and the day's change opened together read the account summary once. When the account summary, positions or orders are read again while their limit is used up, the answer from the last five seconds is returned instead of waiting for the reset. Sending an order or a cancel forgets what was kept for that account in that process. What must be current is always read from Trading 212 then, never from a kept answer: the holdings and cash an order or a basket is sent against, the order book the linked stop-loss and take-profit pairs are settled from, and the check of an order whose outcome was unknown. On Cloudflare a read is not joined across requests, because Workers cancels a request's fetch once it has answered; answers already given are still shared there.

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
