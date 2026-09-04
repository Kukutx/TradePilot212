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
│  └─ cloudflare/
│     └─ index.ts
├─ app/
│  └─ create-app.ts
├─ core/
│  ├─ config.ts
│  ├─ errors.ts
│  ├─ mcp.ts
│  ├─ oauth.ts
│  ├─ state-store.ts
│  ├─ trading-service.ts
│  ├─ trading212-client.ts
│  └─ web-utils.ts
├─ shared/
│  ├─ contracts.ts
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
- issues short-lived one-time confirmations;
- records a small metadata-only activity trail;
- performs read-back verification after an ambiguous write.

`TradingService` does not perform market research and does not schedule work.

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

1. No scheduled or unattended path may submit a broker write.
2. Preparing an order must not submit it.
3. Every order/cancellation write consumes a one-time confirmation.
4. A Trading 212 write request is never retried automatically.
5. An unknown write result stays unknown until a read-back check provides evidence.
6. Read-back verification never resubmits the original write.
7. Demo and Live credentials remain separate.
8. A user-facing environment switch must not silently change an already confirmed order.
9. Secrets never enter structured MCP output, activity records, or Git-tracked files.

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
