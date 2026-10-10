# TradePilot 212 V3 Personal — Project Rules

This repository branch is a **new architecture** for a **private, self-hosted, single-owner** trading workspace. It is NOT a public Plugin Directory trading app.

## Required product capabilities
- Preserve and redesign the proven V2 capabilities without retaining old endpoints, tools, config names, OAuth sessions or state formats: account dashboard, Demo/Live separation, position and pending-order views, symbol/company search, AI research plan cards, flexible sizing (quantity, amount, cash percentage, held percentage, all tradable), market/limit/stop/stop-limit review, cancellation, bilingual UI, short-lived confirmation, audit, unknown-write verification, Node/Cloudflare deployment, self-hosting and setup/doctor tooling.
- Extend with V3's deterministic portfolio intelligence, scenario analysis, watch rules, risk trends and source limitations.
- Use **new versioned contracts** with no backward-compatibility layers or API aliases.
- Public plugin distribution is not the target. Custom private host write operations can be unavailable or blocked depending on user account/host policy; never claim universal availability.

## Financial safety invariants
1. **Only the explicit private execution boundary may write to Trading 212**. No AI-visible tool, scheduled task, portfolio analysis or tool-chain can submit or cancel a broker order.
2. Separate OAuth scopes for portfolio read, personal trade review, local monitoring and personal execution. App-only annotations are not authorization.
3. Default to SAMPLE or read-only trading; real writes require explicit PERSONAL_TRADING_ENABLED=true, independently configured approval secret and per-environment authorization. LIVE requires a separate opt-in.
4. No automatic retry of Trading 212 POST/DELETE. An unreadable response or network interruption is UNKNOWN, not a safe failure; verification must remain read-only.
5. Token-based preview, an explicit user decision and a single-use, action-bound HMAC proof derived client-side from the private secret. The secret is never passed to MCP tools, logs or model-visible context.
6. Atomically consume confirmations once. Revalidate broker constraints immediately before execution; Demo/Live order data cannot be switched after confirmation.
7. Keep quantity, account currency, FX and reference-price provenance explicit; never claim market-order estimates guarantee fill price. Never substitute a sample snapshot for a failed real account.
8. Credentials must stay in owner-controlled secrets; all broker APIs use fixed official HTTPS origins and minimum necessary scopes.
9. Single-owner-per-deployment; no shared multi-tenant credential pool. Never send live orders during CI, documentation checks or mocked tests.
10. Maintain both English and Simplified Chinese prompts and accessible confirmation UI. Never silently remove a feature; use a parity acceptance matrix.

## Newly enforced safety/quality rules
- Broker per-account rate slots MUST be reserved atomically in the shared `StateStore` before sending any API request. Respect summary 5s, positions 1s, pending orders 5s, instrument metadata 50s and non-idempotent order write quotas. A reservation error is PRE-TRANSPORT, not an unknown execution.
- Before consuming an order/cancel confirmation, atomically acquire an environment-scoped exclusive write lease. Known completion releases it; UNKNOWN holds a 120-second cooldown. Lease expiry NEVER justifies a blind retry.
- Live unheld Market BUY and unbounded Buy Stop require broker-confirmed price or a bounded Limit/Stop-Limit unless separately opted into `PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS` by the single owner. Preserve all original order types.
- Limit/Stop-Limit monetary sizing must derive quantity from the enforced limit, not an AI-generated reference price. Any external FX conversion without a timestamp must warn.
- Portfolio/currency fields must follow Trading 212's actual endpoint schemas (`instrument.currency` for compact position objects and `currencyCode` in instrument metadata). Never guess FX or present stale/missing quote evidence as verified.
- AI research completeness is NOT investment confidence. Score only traceable documentation and freshness, declare truth unverified, and keep it separate from AI model scores.

## V3 Personal owner UX and evidence invariants\n- The authenticated Owner Console `/owner` is a first-class V3 execution interface, NOT a V2 compatibility fallback. It must preserve strong session cookies, strict same-origin CSRF and action-bound browser HMAC confirmation.\n- Scheduler and optional email are owner-opt-in. Cloudflare hourly Cron must not cause hourly brokerage requests when the user has not enabled daily briefs. Resend uses fixed HTTPS, provider idempotency, and never receives full portfolio data or credentials.\n- Persist only validated personal preferences including IANA timezone. Do not imply that a stored alert is an external push notification.\n- Research integrations must use fixed ECB/SEC/Twelve Data URLs, bounded responses, source timestamps, verified currency/ticker/venue, and always remain separate from broker execution-price checks.\n- OpenAI-specific sidebar and thread entrypoints must be optional namespaced MCP extensions. Preserve standard MCP Apps behavior for Claude and hosts that ignore extension metadata. No invented host APIs or plan-level compatibility shims.\n- Keep mock tests for CSRF, cookies, Owner Console HMAC, ID-only order replay, schedule deduplication, official data source failure and host-independent headless output.\n\n## Engineering gates
- Use feature-separated modules: domain/order-policy; infrastructure/broker-reads and broker-writes; services/trading, intelligence and state; MCP/auth; UI.
- Use modern MCP 2026-07-28 only. No DCR/legacy protocol shim; host support must be tested, especially Claude and ChatGPT.
- Every broker write test must assert send-once semantics and verify scope/secret/token gates.
- Run `pnpm check`, `pnpm smoke`, `pnpm audit --prod`, `pnpm release:check`, `pnpm exec wrangler deploy --dry-run`.
- All changes stay in a draft PR. Never modify main or deploy with live keys during code generation.
