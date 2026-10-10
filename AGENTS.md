# TradePilot 212 Engineering Rules

TradePilot 212 is a self-hosted **single-owner** Trading 212 MCP App. Treat all AI-generated plans and external MCP tool arguments as untrusted input.

## Non-negotiable safety invariants
1. No scheduled, model-initiated, or unattended workflow may submit or cancel a broker order.
2. Plan generation, portfolio reads, symbol resolution, and draft preparation must not send broker writes.
3. Each broker write needs explicit interaction, a server-issued **one-time** confirmation, and an independent human-held approval secret. Never return the approval secret in an MCP tool result or persist it.
4. Demo and Live credentials, authorizations, UI labels, and confirmed order intents must stay separate.
5. Never retry a Trading 212 POST/DELETE. Network failure, server 5xx, and unreadable write responses are **unknown outcomes**, not safe retries. Verification is read-only.
6. Preserve structured errors, expiration semantics, and atomic token consumption. Do not convert unknown outcomes into success or failure without evidence.
7. Validate numerical quantities, instruments, account state, and application-level risk policy on the server, **again immediately before execution**. LLM-provided reference prices and FX rates are not authoritative market data.
8. Never expose credentials through structured MCP responses, client-side logs, audit events, source files, Git, or AI conversations. Use environment secrets.
9. Continue to support one-owner-per-deployment. Do not introduce a multi-user SaaS backend without tenant isolation and credential vaults.
10. Cloudflare Workers and Node adapters must share the same business behavior through runtime-neutral ports.

## Architecture contracts
- `src/core/order-policy.ts`: pure instrument resolution and order validation.
- `src/core/trading-service.ts`: order lifecycle, confirmations, verification and orchestration.
- `src/core/broker-port.ts`: narrow broker interface; no adapter may retry writes.
- `src/core/trading212-client.ts`: Trading 212 REST transport and ambiguous outcome classification.
- `src/core/oauth.ts`: OAuth authorization and server-scoped permissions.
- `src/core/execution-approval.ts`: independent human approval of destructive actions.
- `src/core/state-store.ts`: durable state API and atomic consume.
- `src/core/mcp.ts`: tools, structured results and portable MCP Apps UI.
- `src/adapters/*`: platform-specific storage/HTTP.
- `src/ui/*`: bilingual host-neutral interface. Never assume the MCP host is always ChatGPT.

## Required checks
Before claiming a feature complete: `pnpm install --frozen-lockfile && pnpm check && pnpm audit --prod && pnpm release:check`.
For Cloudflare changes also run `pnpm exec wrangler deploy --dry-run`.
Add regression tests for the failure being fixed, including an adverse scenario whenever a broker write is involved.

Do not commit changes directly to `main`; use a PR. A passing CI does not prove compatibility with a live broker or app-directory acceptance.

See `docs/ARCHITECTURE_2026.md` for target architecture, shipped work and outstanding migration milestones.
