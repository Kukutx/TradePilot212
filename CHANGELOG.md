# V3 Personal

## 3.0.0-alpha.3 (Draft, breaking — private personal release)\n\n- New independent authenticated /owner execution console (hashed owner sessions, Secure/Strict HttpOnly cookie, CSRF, signed CSP, browser HMAC step-up) without removing the MCP trading widget.\n- Local owner preferences (IANA timezone, locale, account, scheduled digest options) and hourly Cron with local-hour gating; preserves the prior weekday scan fallback.\n- Optional fixed-endpoint Resend email digests with per-day idempotency, significant-change detection and minimal alert contents; off by default.\n- Official ECB dated reference FX and SEC EDGAR primary filings, plus optional timestamped Twelve Data vendor market quotes, all read-only and clearly non-executable.\n- OpenAI optional sidebar/thread MCP extension metadata and a portable plugin manifest with private safety-first onboarding; shared MCP Apps UI still works without extensions.\n- Expanded owner/browser CSP and independent source tests. No real brokerage account, paid data provider or email service was invoked by CI.\n\n## Unreleased — V3 Personal hardening

- Preserve the owner's full personal trading functionality. No old API or OAuth compatibility.
- Parse the real Trading 212 compact-position currency reliably, reject conflicting currencies and non-finite valuations.
- Add per-account/endpoint atomic broker rate reservations across Node and Cloudflare, including reads, retries, order creation and cancellation.
- Add an environment-scoped exclusive write lease; overlapping valid confirmations cannot execute concurrently; UNKNOWN writes leave a bounded safety cooldown.
- Make Limit/Stop-Limit monetary sizing derive from executable limit prices instead of an LLM reference; timestamp missing FX evidence explicitly.
- Reject unpriced/unbounded Live buy operations by default while allowing separately explicit owner opt-in; do not remove any V2 order type.
- Protect ambiguous write reconciliation against unrelated old/opposite-side/undated orders.
- Display pending-order partial fills, remaining quantity, broker status and creation times in the bilingual workspace.
- Add AI research evidence-documentation completeness and timestamp checks independent of a model-generated buy score; no implied fact verification.
- Reject arithmetic overflow in trade notional and account valuations even when owner disables optional caps.
- Expand mocked OAuth/MCP broker-write smoke, risk policy and negative security regression coverage.
- Add personal operations runbook and updated architecture/security/feature-parity documents.

## 3.0.0-alpha.2 (Draft, breaking)
- New domain, policy, provider and OAuth architecture; no V2 protocol/state/tool compatibility.
- Preserved personal Demo/Live, instrument search, flexible sizing, editable order reviews, four order types, cancel, one-use human confirmation and uncertain-response verification.
- Introduced HMAC-scoped personal approval secret; real writes opt-in and Live separately gated.
- Extended portfolio analytics, coverage-aware risk, stress and risk trend tools.
- Rebuilt bilingual MCP App UI and self-hosted Node/Cloudflare/Docker/deployment/tunnel scripts.
- Added mocked broker and life-cycle tests. External host/real Demo/live testing remains pending.
