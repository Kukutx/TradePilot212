# V3 Personal architecture

```
ChatGPT / Claude / supported private MCP host
    │ OAuth CIMD + S256 + owner consent; modern MCP only
    ▼
src/server/http.ts — authenticated per-request transport
    ├─ Portfolio Intelligence tools (read-only)
    │    └─ IntelligenceService → BrokerReader GET-only → Trading 212
    ├─ Research / Order review tools (model-visible, read-only)
    │    └─ PersonalTradingService → resolveTradeIntent + checkDraft
    ├─ Private interactive MCP App (human-held secret stays inside UI)
    │    ├─ app_prepare_personal_order / cancel → single-use state token
    │    └─ app_execute_personal_order / cancel → HMAC + OAuth scope + fresh broker validation
    │                  └─ Trading212TradeGateway → POST/DELETE ONCE
    └─ Monitoring tools → local rules/events in StateStore

Cloudflare hourly Cron (local-time daily digest or weekday 07:00 UTC watch fallback)
  └─ Portfolio GET → risk calculations → local events; no broker writes

StateStore: atomic Node JSON / Cloudflare Durable Object
UI: bilingual React host-adaptive workspace
```

## Additional self-hosted owner and research planes (V3 alpha.3)

- **Independent authenticated browser:** `src/server/owner-console.ts` and `owner-page.ts` expose `/owner`, separate from MCP host OAuth. Has opaque hashed owner sessions, HttpOnly SameSite Strict cookie, origin checks, CSRF, no third-party scripts, exact hash CSP, explicit Live consent and in-page HMAC confirmation. It shares `PersonalTradingService` and broker write-once invariants; it is **not** an old-host adapter.
- **Time-zone-aware read-only automation:** `OwnerPreferencesStore`, `DailyAutomation`, `createNotifier`; Cloudflare hourly Cron checks *whether* the IANA-local hour matches before calling the broker. An entirely disabled daily digest retains weekday 07:00 UTC risk-rule scans. A configured Resend provider sends only opt-in bounded observation categories, keyed per day/environment. No automatic broker order.
- **Independent primary data:** `ReferenceFxService` fixed official ECB dated currency references; `SecResearchService` fixed SEC filings API with operator contact; `TwelveDataQuoteService` optional vendor quote with source/timestamp/currency/venue validation. They cannot authorize trades and are not presented as a guaranteed broker quote.
- **Host adaptivity:** `src/server/mcp.ts` advertises optional ChatGPT entrypoint metadata and standard MCP App resources. Tool `structuredContent` is suitable for host-generated Intelligent UI or Claude visuals; the host owns generated presentation. These extensions remain untested in real ChatGPT and Claude sessions.

The HTML Owner Console is an alpha single-owner app: before real-money use, validate browser security, passkeys/step-up requirements, device compromise boundaries, actual Demo trades, and broker order reconciliation.

## Product execution planes

**Intelligence plane:** portfolio dashboards, instrument resolution, research briefs/cards, risk simulation, local threshold rules, changes and read-only monitoring. Runs in AI, user-driven and scheduled contexts.

**Human execution plane:** private instance only, with explicit server flags, independently consented OAuth scope, app-only write endpoint, owner approval secret entered into UI, action/token-bound HMAC, one-use confirmation, fresh broker revalidation, and exactly one broker write. All inputs and platform hints are untrusted.

**Never** add model-visible broker write tools or a background broker execution path. The user initiating a research plan is not consent to trade.

## Rate and execution coordination

`src/infra/broker-pacer.ts` uses `StateStore.reserve` (atomic on Node file store and Cloudflare Durable Object) to space account-specific Trading 212 GET and POST/DELETE calls. Broker operations are assigned fixed quota buckets. Failed budget reservations never send a request; non-idempotent writes remain send-once.

`StateStore.claim` and conditional `StateStore.release` create a per-environment exclusive execution lease. The lease is acquired **after** validating the independent human proof but **before** consuming the one-use confirmation. A second valid confirmation cannot concurrently send a separate broker write. A known success or rejection releases the lease; UNKNOWN outcomes retain it for 120 seconds. Manual broker verification is required regardless of lease expiry.

`src/domain/research.ts` scores evidence **documentation completeness**, distinct from any model-provided investment score. It checks basic source URL traceability, research freshness, source dates, risks and counter-case; it performs NO independent web fact checking and never authorizes a trade.

## Broker path restrictions
`src/infra/broker.ts` is GET-only with fixed allowed endpoints and bounded JSON responses. `src/infra/trade-gateway.ts` exclusively maps known approved GET/POST/DELETE endpoints with correct signed sell quantities. Network errors, 408, 5xx and broken response bodies after any broker write produce **UNKNOWN**; no retry and no automatic order replacement.

## Domain data trust
Sample != actual broker. There is no automatic fallback to sample on API failure. Currency coverage for risk allocation requires account-currency evidence. Scenario calculations disclose all assumptions. Reference prices and FX manually supplied for trade sizing are **estimates**, not executable price guarantees; limit orders are preferable when uncertain.

## State and OAuth
V3 storage uses new namespaces: `v3:code:`, `v3:refresh:`, `v3:rule:`, `v3:event:`, `v3:snapshot:`, `v3:trade-confirm:`, `v3:verify:`, `v3:trading-activity:`. V2 state files are unsupported.

OAuth scopes: `portfolio:read`, `monitor:write`, `trading:review`, `trading:execute`, `offline_access`. Tool visibility is not authorization. Only allowlisted Client ID Metadata Documents are accepted; intentionally no old OAuth DCR or MCP session compatibility.

## Production blockers (Draft)
- No live Trading 212 order has been placed by testing.
- Need real Demo order, partial fill, cancellation and unknown-response reconciliation acceptance.
- Need ChatGPT and Claude host tests for app-only actions, rendering/confirmation and permissions.
- Need robust broker rate-limit/freshness telemetry and user-controlled authentication/secret lifecycle before live use.
- Need responsive visual QA and edge-case market controls.
