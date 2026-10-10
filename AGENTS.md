# TradePilot Insight V3 — Engineering rules
This is a **greenfield breaking replacement**. No legacy adapter, alias, migration, DCR fallback, old MCP handler or old order API.

## Product
A self-hosted investment-intelligence MCP App. It provides independent analytics, not generic pass-through of broker endpoints.

## Invariants
- All Trading 212 requests are GET to fixed official origins. **Never implement order/cancel, monetary transactions or credential forwarding to AI hosts.**
- MCP **2026-07-28 only** via `createMcpHandler(factory,{legacy:"reject"})`. No `initialize`, `Mcp-Session-Id`, legacy tool names or DCR.
- OAuth CIMD/PKCE S256; exact client ID and redirect matching, issuer validation, resource audience binding, rotating single-use refresh grants. Client metadata origins must be explicitly trusted.
- Sample data must always be labelled. Never silently substitute sample on brokerage errors.
- Reject incomplete or invalid account/position data; analytics must disclose currency coverage and cannot silently invent FX.
- Scenario outputs are stress simulations, not predictions. No automated personalized trade instruction or execution.
- Watch rules and Cron may change local analysis state only; no brokerage writes.
- No credentials, tokens, account IDs or sensitive logs in MCP results, UI, public health, source control.
- Single-owner deployment; directory approval is a separate review, not implied by CI.
- Write tests, run `pnpm check && pnpm audit --prod && pnpm exec wrangler deploy --dry-run`, PR only (never commit directly to main).
