# TradePilot 212 V3 Personal

**Self-hosted AI investment intelligence, portfolio management and human-authorized personal trading.**

[Test candidate checklist](docs/TEST_READY.md) · [Manual acceptance matrix](docs/HOST_QA.md) · [Owner Console](docs/OWNER_CONSOLE.md) · [Read-only automation](docs/AUTOMATION_DELIVERY.md) · [External evidence](docs/EXTERNAL_DATA.md) · [Adaptive experience strategy](docs/EXPERIENCE_2026.md) · [简体中文](README.zh-CN.md) · [Feature parity](docs/FEATURE_PARITY.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

V3 is a **clean-slate, breaking redesign**. No legacy V2 protocol, tool, OAuth, environment variable or persisted-state compatibility is implemented. The functioning V2 `main` branch remains intact.

## Functionality

Portfolio dashboards for Trading 212 Demo/Live, positions, cash, pending orders, recent activity; bilingual model-proposed short/medium/long investment research cards; ticker/name resolution; order sizing by quantity, target money, percent of available cash, percent of held shares and all tradable shares; Market, Limit, Stop, Stop-Limit; interactive review, single-use human-approved execution and cancellation; unknown-write read-back verification; risk analysis, concentration, stress scenarios and scheduled read-only alerts.

**No unattended trading.** A lost/ambiguous broker write is persisted before transmission and blocks future writes across lock expiration and process restarts until independent owner-approved reconciliation. **Code-level test candidate**: new feature work is frozen pending manual Demo and host acceptance.  Broker writes only after an explicit private owner UI action, fresh risk validation, one-use confirmation and client-side HMAC approval. Uncertain POST/DELETE outcomes must never be retried automatically. Demo and Live require separate authorizations, and both are disabled by default.

## Install

```bash
pnpm install --frozen-lockfile
pnpm setup
# Fill in .env.local, never Git-track it
pnpm doctor
pnpm check
pnpm dev
```

`DATA_SOURCE=sample` is synthetic, clearly labelled and incapable of broker execution. For personal broker usage set `DATA_SOURCE=trading212` and the relevant `T212_DEMO_KEY/SECRET` or `T212_LIVE_KEY/SECRET`.

Opt in to **Demo execution** explicitly with `PERSONAL_TRADING_ENABLED=true` and an independent `PERSONAL_APPROVAL_SECRET` created by `pnpm setup`. Live requires the additional `PERSONAL_LIVE_TRADING_ENABLED=true`. Cap notional/quantity and confirmation expiry with `PERSONAL_MAX_NOTIONAL`, `PERSONAL_MAX_QUANTITY`, `PERSONAL_CONFIRMATION_TTL`.

Write-enabled Trading 212 keys must have the necessary order permissions. Demo and Live keys are never interchanged. The HMAC proof sent through MCP is specific to a single action/token. Never put credentials or the approval secret in an AI chat message.

## Safety, research provenance and broker quotas

- V3 atomically paces broker API calls **per account and endpoint** across Node / Cloudflare (summary ~5s, positions ~1s, pending ~5s, instruments ~50s).
- Only one broker write can be active per environment. An UNKNOWN write retains a two-minute cooldown; expiry is **not evidence** that the broker did not execute.
- New unheld Live Market buys and Live Buy Stops require a bounded-price Limit/Stop-Limit alternative by default. All order types remain available via the separately explicit `PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS=true` owner opt-in.
- `PERSONAL_MAX_NOTIONAL` is an **estimate in instrument quote currency**, not a guaranteed maximum execution price.
- Research cards distinguish the model-provided score from independent **evidence-documentation completeness**, source URLs and time freshness. Source truth is never assumed or verified merely from a complete card.

## Independent owner console and optional automation\n\nThe same private server now serves `/owner` in addition to `/mcp`. The owner console has its own protected browser session, same-origin CSRF, CSP-pinned scripts and client-computed HMAC order/cancel approvals; it is not gated by AI-host write entitlements. Demo/Live authorization and one-write-only semantics are preserved.\n\nUse the console to opt into a timezone-aware daily read-only digest; email is disabled until both an owner setting and a verified Resend sender/API key are configured. Cloudflare evaluates schedules hourly but reads the broker only at the chosen local hour (or original weekday 07:00 UTC monitoring fallback). Node users must schedule `pnpm monitor:once` themselves.\n\nECB reference FX and US SEC primary filings are official fixed-origin reads, while Twelve Data prices require a separately configured vendor API key. Source timestamps and non-executability are explicit. No external source is silently used as a Trading 212 fill guarantee. See [source semantics](docs/EXTERNAL_DATA.md).\n\n## Deploy

Use `pnpm dev` for local Node; `pnpm dev:tunnel` for a temporary Cloudflare HTTPS tunnel; `pnpm deploy -- --dry-run` to validate a personal Cloudflare Worker; `pnpm deploy` only when you explicitly intend deployment; or use the included `Dockerfile` behind a private HTTPS reverse proxy.

The MCP server implements **MCP 2026-07-28 and OAuth CIMD/PKCE only**, with no compatibility shim. OAuth scopes: `portfolio:read`, `trading:review`, `trading:execute`, `monitor:write`, and optional `offline_access`. ChatGPT and Claude custom MCP tool/write availability depends on plan, host and workspace policy; some risky actions can be blocked.

**This is not a public Plugin Directory trading app.** Public directory policy prohibits executing investment trades, so personal trade features belong in private self-hosted integration. No public listing, host eligibility or broker live execution has been verified.

See [personal operations handbook](docs/OPERATIONS.md), [product strategy](docs/PRODUCT.md), [feature parity](docs/FEATURE_PARITY.md), [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md), [privacy](PRIVACY.md). This project is in Draft/Alpha; do not consider it production-ready solely because CI passes.
