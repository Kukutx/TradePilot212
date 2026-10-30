# Architecture

English · [简体中文](./zh-CN/ARCHITECTURE.md)

TradePilot 212 is intentionally split into a runtime-neutral core and small platform adapters. The same trading rules and MCP surface run on Node.js and Cloudflare Workers.

## Request path

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

The React MCP App UI is served as an MCP App resource. It calls app-only MCP tools for refresh, validation, confirmation, cancellation, and uncertain-write verification.

## Source layout

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

## Core boundaries

### `Trading212Client`

Owns HTTP interaction with Trading 212.

- read requests have bounded retry/backoff for transient failures;
- write requests are sent exactly once;
- a write timeout or ambiguous server error becomes an unknown execution state rather than a retry.

### `TradingService`

Owns application rules.

- resolves broker instruments;
- reads account, positions, and pending orders;
- converts flexible sizing into a quantity-based order;
- enforces configured application-level limits and broker-facing constraints that can be checked locally;
- evaluates the policy for each order at review and again before the write;
- validates baskets against one snapshot, sells first, and sends them one order at a time;
- drafts rebalance and protective-order baskets;
- issues short-lived one-time confirmations;
- records a small metadata-only activity trail;
- performs read-back verification after an ambiguous write.

`TradingService` does not perform market research and does not schedule work.

### `AutomationService`, `policy` and `rebalance`

`AutomationService` stores investment plans and runs the due-plan tick. The tick is called from the Worker's Cron Trigger and from an interval in the Node and stdio servers. Due plans are announced for confirmation. Demo plans marked `autoExecute` run through `prepareBasket` and `executeBasket` when `AUTOMATION_DEMO_ENABLED=true`. `policy.ts` and `rebalance.ts` are pure functions with unit tests. See [AUTOMATION.md](./AUTOMATION.md).

### `PiesService`, `PriceAlerts`, `AccountAlerts` and notifications

`PiesService` (`pies.ts`) reads pies with short caches, because Trading 212 allows one list read every 30 seconds and one detail read every 5 seconds, and adds drift and totals. Pie changes follow the order pattern: `preparePieChange` resolves tickers, normalises shares and issues a one-time token; `executePieChange` consumes it, needs `liveAcknowledged` on Live, and sends the write once.

`PriceAlerts` (`alerts.ts`) is checked on every scheduler tick after protective links and plans. It reads positions once per environment, evaluates each armed alert with the pure `evaluateAlert`, and writes one `price_alert_triggered` event. It never writes to the broker.

`AccountAlerts` (`account-alerts.ts`) follows it on the same tick. Value and cash alerts take the account summary once per environment (`TradingService.accountSummary` with a 30-second reuse, so a summary the tick or a dashboard just read is not asked again); day's-move alerts read `portfolioToday` together per environment at most every ten minutes, count only the holdings on its latest trading day, and use `ended` (when that day's sessions closed) to skip a session that was over before the alert was set. A fired alert writes one `account_alert_triggered` event. It never writes to the broker.

`TargetAllocations` (`targets.ts`) keeps saved target weights per environment. It runs on the tick after alerts but reads the account at most once an hour per environment, compares weights with the pure `allocationDrift`, and writes an `allocation_drift` event at most once a day while the drift is over its threshold. The same drift is attached to `analyze_portfolio_allocation`. It never writes to the broker.

`OrderWatch` (`order-watch.ts`) runs on the tick right after protective links, at most every 5 minutes per environment. It keeps the open orders from the previous check in the store. For orders that have left the book, it reads the order history once with `recentOrderOutcomes`, which now also returns the average fill price and the filled value, adds up fill rows, and pages by fill time. An order whose history entry is missing or not final yet is kept for up to three checks. Each order then gets one `order_filled`, `order_partly_filled`, `order_closed` or `order_outcome_unknown` event, with the fill facts as fields so the widget can show them. Fill times are also kept under `order-fills:<env>` for the digest. It never writes to the broker. `ORDER_WATCH=false` turns it off.

`ValueHistory` (`value-history.ts`) runs on the tick after the order watch. About once an hour per environment it reads only the account summary (`TradingService.accountSummary`) and upserts the day's point under `value-history:<env>:<YYYY-MM>`. One key per month keeps every stored value well under the Durable Object value limit. `get_portfolio_performance` reads the points in its window with `points()`.

`notify.ts` builds an optional webhook sender from `NOTIFY_WEBHOOK_URL`. `TradingService.recordActivity` passes every event to it; the sender filters by type, signs the body when a secret is set, and swallows delivery errors.

### `InsightsService` and `analytics`

Read-only. `InsightsService` walks Trading 212's newest-first history pages within a page budget and caches them briefly. `analytics.ts` turns that data into allocation, performance, income and market-session results with pure, unit-tested functions. `readHoldingRisk` (`holding-risk.ts`) adds a year of each holding's closes from the price history to the allocation, largest first and within a few seconds, and the pure `holdingRiskOf` (`shared/holding-risk.ts`) turns them into each holding's share of the risk and the correlations. Nothing on this path can write to the broker.

### `StateStore`

Provides the small durable state API used by OAuth, confirmations, rate limits, activity, and verification records.

Node uses an atomic file-backed implementation. Cloudflare uses a named Durable Object backed by SQLite. The confirmation consume operation is atomic in both implementations.

### MCP layer

The public MCP surface has two kinds of tools:

- model-visible tools for portfolio reads, instrument resolution, trade-plan rendering, recent activity, and order review;
- app-only tools invoked by explicit UI interactions for confirmation and cancellation.

Broker writes remain app-only.

Beside the tools, `mcp-prompts.ts` offers each skill as an MCP prompt and the account's saved state (holdings, journal, targets, watchlist) as resources for each account with keys, with completion for the prompts' account and instrument arguments. Every tool declares its `outputSchema` (`tool-output.ts`), and the server checks each result against it.

## Execution invariants

These rules are deliberate and should remain true when extending the project:

1. No scheduled or unattended path may submit a Live order. The only unattended Live write is cancelling the surviving half of a linked protective pair after the other half filled. The one unattended path, due Demo plans with `autoExecute` and `AUTOMATION_DEMO_ENABLED=true`, uses the same validation, policy and no-retry rules as a confirmed basket.
2. Preparing an order must not submit it.
3. Every order, basket, cancellation and pie write consumes a one-time confirmation.
4. A Trading 212 write request is never retried automatically, except once after a 429, which Trading 212 did not carry out.
5. An unknown write result stays unknown until a read-back check provides evidence.
6. Read-back verification never resubmits the original write.
7. Demo and Live credentials remain separate.
8. A user-facing environment switch must not silently change an already confirmed order.
9. An order that the policy blocks never receives a confirmation token, and the policy is evaluated again immediately before each write.
10. Secrets never enter structured MCP output, activity records, or Git-tracked files.

## Cloudflare adapter

The Worker adapter provides:

- static MCP App assets through the `ASSETS` binding;
- a singleton named Durable Object for instance state;
- request-derived public origin, avoiding a hard-coded personal URL;
- the same Hono application used by Node.

The deployment model is single-user. One Worker instance owns one Trading 212 credential set.

## Node adapter

The Node adapter reads local environment files, persists state under `.data/`, and appends a local JSONL audit log. It is suitable for local development or a private VPS/container deployment.

## UI principles

The UI is intentionally compact:

- account state first;
- Demo/Live status always visible;
- responsive position table/cards;
- trade plans grouped by horizon;
- secondary research details collapsed by default;
- order conversion shown before confirmation;
- stale/unknown data is surfaced rather than hidden;
- uncertain writes expose a read-only verification action;
- keyboard focus is contained within modal dialogs and Escape closes the active dialog;
- each switch of a few choices (a period, table or map, an order's side and type) is one Tab stop, with the arrow keys, Home and End moving between its choices;
- the controls the browser would draw (scrollbars, selects, checkboxes, switches, disclosures) are drawn in the widget's style and keep the system's colours in high-contrast mode.

## Extending the project

New brokerage logic should normally enter through `TradingService` and shared contracts, not through platform adapters. New runtime support should implement `StateStore` and provide the shared Hono application with configuration, widget HTML, and optional audit hooks.

Market-data providers, research workflows, and recurring tasks should remain external to the broker bridge unless they are required for broker correctness.

### Transaction workspace

Order editing, final confirmation, and cancellation confirmation render in normal document flow rather than a fixed-position iframe overlay. This lets the MCP host measure the real content height and avoids compressed dialogs in short embedded views. If the host exposes fullscreen and the current viewport is unusually short, the UI makes a best-effort fullscreen request; the in-flow layout remains the fallback. Only one transaction step is mounted at a time, so there is no nested modal stack or duplicate scroll container.
