# Architecture

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
│  ├─ policy.ts            pure policy rules shared by every order path
│  ├─ protective-links.ts  one-cancels-other emulation for stop-loss / take-profit pairs
│  ├─ rebalance.ts         pure target-weight rebalance planner
│  ├─ state-store.ts
│  ├─ trading-service.ts
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

### `PiesService`, `PriceAlerts` and notifications

`PiesService` (`pies.ts`) reads pies with short caches, because Trading 212 allows one list read every 30 seconds and one detail read every 5 seconds, and adds drift and totals. Pie changes follow the order pattern: `preparePieChange` resolves tickers, normalises shares and issues a one-time token; `executePieChange` consumes it, needs `liveAcknowledged` on Live, and sends the write once.

`PriceAlerts` (`alerts.ts`) is checked on every scheduler tick after protective links and plans. It reads positions once per environment, evaluates each armed alert with the pure `evaluateAlert`, and writes one `price_alert_triggered` event. It never writes to the broker.

`notify.ts` builds an optional webhook sender from `NOTIFY_WEBHOOK_URL`. `TradingService.recordActivity` passes every event to it; the sender filters by type, signs the body when a secret is set, and swallows delivery errors.

### `InsightsService` and `analytics`

Read-only. `InsightsService` walks Trading 212's newest-first history pages within a page budget and caches them briefly. `analytics.ts` turns that data into allocation, performance, income and market-session results with pure, unit-tested functions. Nothing on this path can write to the broker.

### `StateStore`

Provides the small durable state API used by OAuth, confirmations, rate limits, activity, and verification records.

Node uses an atomic file-backed implementation. Cloudflare uses a named Durable Object backed by SQLite. The confirmation consume operation is atomic in both implementations.

### MCP layer

The public MCP surface has two kinds of tools:

- model-visible tools for portfolio reads, instrument resolution, trade-plan rendering, recent activity, and order review;
- app-only tools invoked by explicit UI interactions for confirmation and cancellation.

Broker writes remain app-only.

## Execution invariants

These rules are deliberate and should remain true when extending the project:

1. No scheduled or unattended path may submit a Live order. The only unattended Live write is cancelling the surviving half of a linked protective pair after the other half filled. The one unattended path, due Demo plans with `autoExecute` and `AUTOMATION_DEMO_ENABLED=true`, uses the same validation, policy and no-retry rules as a confirmed basket.
2. Preparing an order must not submit it.
3. Every order, basket, cancellation and pie write consumes a one-time confirmation.
4. A Trading 212 write request is never retried automatically.
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
- keyboard focus is contained within modal dialogs and Escape closes the active dialog.

## Extending the project

New brokerage logic should normally enter through `TradingService` and shared contracts, not through platform adapters. New runtime support should implement `StateStore` and provide the shared Hono application with configuration, widget HTML, and optional audit hooks.

Market-data providers, research workflows, and recurring tasks should remain external to the broker bridge unless they are required for broker correctness.

### Transaction workspace

Order editing, final confirmation, and cancellation confirmation render in normal document flow rather than a fixed-position iframe overlay. This lets the MCP host measure the real content height and avoids compressed dialogs in short embedded views. If the host exposes fullscreen and the current viewport is unusually short, the UI makes a best-effort fullscreen request; the in-flow layout remains the fallback. Only one transaction step is mounted at a time, so there is no nested modal stack or duplicate scroll container.
