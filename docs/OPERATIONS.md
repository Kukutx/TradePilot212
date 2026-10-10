# V3 Personal: operator runbook (no legacy compatibility)

## Setup and permission separation

Use a private self-hosted server. Store `OWNER_PASSWORD`, `JWT_SIGNING_SECRET` and `PERSONAL_APPROVAL_SECRET` only in the owner-controlled environment or Cloudflare Secrets. Run `pnpm setup`, `pnpm doctor`, `pnpm check`, `pnpm smoke`, `pnpm audit --prod`, `pnpm release:check`.

Start with `DATA_SOURCE=sample` (clearly fake). For brokerage reads switch to `DATA_SOURCE=trading212`, supply an account-specific DEMO key/secret (read scopes only first) and validate portfolio/currency outputs. To test brokerage writes, use a separate Demo trading-capable key, set `PERSONAL_TRADING_ENABLED=true`, keep `PERSONAL_LIVE_TRADING_ENABLED=false`, and acquire the host OAuth scopes `portfolio:read trading:review trading:execute`.

Live is an entirely distinct approval: configure an independently scoped Live API key pair, explicitly opt into `PERSONAL_LIVE_TRADING_ENABLED=true`, then reconnect the private host. Never assume Demo credentials cover Live.

## What the five risk flags mean

- `PERSONAL_TRADING_ENABLED=false`: all broker POST and DELETE workflows disabled (default).
- `PERSONAL_LIVE_TRADING_ENABLED=false`: Live stays read/review-only even when Demo is writable (default).
- `PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS=false`: reject an unheld Live Market BUY without an authoritative broker-held reference, and an unbounded Buy Stop, when `PERSONAL_MAX_NOTIONAL>0` (default). All types remain available via explicit owner opt-in, or use a bounded Limit/Stop-Limit instead.
- `PERSONAL_MAX_NOTIONAL=5000`: approximate per-order cap in instrument **quote** currency; market fills, spread, FX and slippage may exceed estimated notional. `0` disables only this app-level cap.
- `PERSONAL_MAX_QUANTITY=100000`: quantity cap per order; `0` disables only this app-level cap.

`PERSONAL_CONFIRMATION_TTL=90` seconds by default, min 30 and max 300. UI must show the exact Demo/Live environment and expiry.

## Execution sequence

1. Research/review tools analyze or calculate an explicit ticker, type and quantity; they **cannot write to the broker**.
2. The owner reviews the editable order and uses the in-app `app_prepare_*` flow to obtain a short-lived, one-use confirmation token.
3. The owner enters the independent approval secret **inside the widget**, not the chat. An action- and token-bound HMAC proof is computed locally. An OAuth `trading:execute` scope and per-environment server flags are also required.
4. The server acquires an atomic exclusive environment write lease. A second concurrent confirmation cannot send another broker request.
5. It consumes the token once, rechecks broker account data and order constraints, then issues **one** POST or DELETE.
6. An acknowledged write releases the lease. A definite rejection releases it. A network timeout/unreadable write response/408/5xx is **UNKNOWN**, and the lease stays for approximately 120 seconds to prevent overlapping writes.
7. For UNKNOWN: use the **read-only verification** tool and independently check actual Trading 212 pending orders, fills and account history. Expired lock or missing evidence is never proof of non-execution. Do not automatically retry.

Rate limits are per **broker account**, not API key. The server reserves distinct atomic rate slots across Node and Cloudflare. Official rates include summary ~1/5s, positions ~1/1s, instruments ~1/50s, pending orders ~1/5s and historical orders ~6/min. Tool requests may pause before performing a GET. Too many queued calls fail before contacting the broker.

## Compatibility with AI hosts

Private ChatGPT write-capable full MCP beta is currently documented for **Business / Enterprise / Edu**, and some high-risk actions may be blocked. Pro users can use read/fetch connectors with developer mode, but full write support is not a generic Pro guarantee. Claude custom MCP support depends on account/host capability. Test UI and OAuth interaction in a real connected host; CI only exercises an in-memory MCP host with mocked broker operations.

See: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt

No V2 OAuth sessions, tools, state, API names or env-key aliases exist. Migrating V3 requires a clean new deployment or deliberately isolated testing and manual reconfiguration; do not overwrite a known-good Live instance.

## Release acceptance checklist

- Fresh `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm smoke`, `pnpm audit --prod`, `pnpm release:check`.
- `pnpm deploy -- --dry-run` and `pnpm exec wrangler deploy --dry-run` pass with no real financial credentials in logs.
- Separate Node/Docker/Cloudflare boot and secret isolation checks.
- Trading 212 **Demo** end-to-end: portfolio schema, currency coverage, one Market/Limit/Stop/Stop-Limit behavior according to broker account permissions, cancellation, partial fill and uncertain-write recovery.
- Real ChatGPT and Claude host checks, including private write entitlement, interactive UI and mobile/desktop access.
- Never claim real-money readiness solely from GitHub CI; no production API writes are part of this repository's automated tests.
