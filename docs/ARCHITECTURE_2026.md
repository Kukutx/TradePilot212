# TradePilot 212: Cross-host architecture (2026)

Status: **living design / migration in progress**. Code marked *target* below is not necessarily implemented. This document does not override the existing [execution invariants](ARCHITECTURE.md).

## Product and deployment model
TradePilot is an independent, self-hosted portfolio and trade-decision assistant. It exposes a remotely reachable, OAuth-protected MCP server with a portable MCP App UI. The primary hosts are ChatGPT and Claude; any standards-compliant host can use tool outputs without the UI.

**One owner = one broker credential set = one deployment.** No central brokerage credential service and no pooling of users.

This is a personal broker integration, not a licensed financial advisor, a generic robo-advisor, or an unattended trading bot.

## 2026 protocol baseline
- Adopt the 2026-07-28 MCP specifications incrementally: stateless HTTP, negotiated extensions, predictable tool catalogs, and OAuth authorization hardening.
- Portable UI uses `@modelcontextprotocol/ext-apps` and `_meta.ui.resourceUri`; app-only tools expose `_meta.ui.visibility: ["app"]`. Host hints are **not** authorization.
- Support ChatGPT's CIMD client IDs with strict HTTPS/domain validation, while retaining DCR for hosts that require it. Honor the plural `token_endpoint_auth_methods_supported` and RFC 9207 authorization issuer.
- Do not assume every host supports fullscreen, streaming Tasks, UI actions or the same account/plan entitlements. UI and tool responses must degrade gracefully.
- Refresh tokens, OAuth scope, host capability negotiations and authentication must be tested against actual clients.

References: https://modelcontextprotocol.io/specification/2026-07-28 and https://developers.openai.com/plugins/build/auth

## Trust and data flow

```text
User ── ChatGPT / Claude / generic MCP host
            │  OAuth scopes: trade:read, trade:write
            ▼
         MCP / HTTP adapter (Hono; public remote endpoint)
            │
            ├── Read-only tool surface ───────┐
            │  portfolio, instruments, plans  │
            │                                  ▼
            ├── Draft / preview UI ───────► Application workflows
            │                                  │
            │                             Pure policy engine
            │                             Instrument resolution
            │                             Account & risk checks
            │                                  │
            └── App-only execute/cancel ─► human-held separate approval
                                               │
                                  Atomic one-time confirmation consume
                                               │
                                      BrokerGateway port
                                               │
                                 Trading212 REST adapter (Demo / Live)
                                               │
                                 status or UNKNOWN if ambiguous
                                               │
                                      read-only verification

          StateStore: Durable Object / Node file store
          Audit: metadata only; never API keys or approval secrets
```

LLM research, scoring and schedule orchestration are **untrusted proposal sources**. Broker credentials never enter model context. The deterministic backend alone authorizes and performs broker operations.

## Domain model (target)

| Module | Responsibility | Status |
| --- | --- | --- |
| BrokerGateway | Abstract broker reads/writes and hide transport | Implemented |
| Trading212Client | Broker API, read retry, write-once, classify unknown outcomes | Implemented |
| Instrument resolution | Map user intent to exact tradable identity | Partially implemented; exchange ambiguity still needs stronger checks |
| Order policy | Quantity, estimated notional, max exposure, available cash | Partially implemented; quote provenance/slippage guarantees remain limited |
| TradingService | Coordinated preview, consume, execute, verify | Implemented; more decomposition planned |
| OAuth + CIMD | Authenticated single-owner MCP access | Implemented; refresh rotation and host E2E tests planned |
| Independent execution approval | Human-held secret at final write boundary | Implemented; WebAuthn and out-of-band consent are targets |
| Research/Intelligence | Model-sourced thesis, evidence, catalysts, uncertainty | Existing candidate cards; provider-neutral evidence validation target |
| Risk & portfolio intelligence | Concentration, drift, stale data, alerts, constraints | Target |
| Host capability adapter | Context, UI mode and host feature fallback | Partial; additional Claude QA target |
| Durable workflow/automation | Read-only scheduled research and notifications | External host scheduling; internal scheduler not planned for writes |
| Observability | Request IDs, safe audit, tracing, alerts and reconciliation | Partial |

## Safety model
Two distinct planes:

1. **Intelligence plane (automatic):** read portfolio, gather news, assess evidence, rank candidates, explain catalysts/risks, generate watchlists, monitor drift, prepare editable drafts. No broker writes.
2. **Execution plane (interactive):** server validates authoritative account data, issues one-use confirmation, user enters the separate execution secret, server validates again, consumes confirmation atomically, sends a single broker write, and records status. Reads may retry within published broker rate limits; broker writes may never retry automatically.

AI-generated `referencePrice`, exchange rates and symbol/name matches are suggestions, never independent proof of risk compliance. Do not claim the application cap prevents market slippage; Trading 212 remains the final funds/execution authority. A trusted independent quote source and configurable price deviation rejection are future work.

Error categories: `rejected` means a known failure; `submitted` means the broker acknowledged the write; `unknown` means broker state may have changed and must not trigger an unattended retry.

## Host-specific behavior

| Capability | ChatGPT | Claude | Core |
| --- | --- | --- | --- |
| MCP remote tools | Supported with account/client entitlement | Supported with account/client entitlement | Portable |
| Embedded MCP Apps UI | Supported | Interactive connectors supported | Portable HTML/JS extension |
| OAuth client bootstrap | CIMD + DCR | Host-dependent OAuth discovery | Both with strict validation |
| Automatic research | Use host scheduling where available | Use host scheduling where available | Always read-only |
| Fullscreen / host styles | Feature negotiation | Feature negotiation | Optional fallback |
| Broker order submission | Requires user present | Requires user present | **Always server-protected** |

No host is permitted to bypass confirmation based on a description or model instruction.

## Security and operations
- Avoid **all** stored API tokens and raw broker credentials in prompts, analytics or UI resources.
- Never share a personal Worker endpoint as a generic public multi-user service.
- Separate Demo and Live configuration and keep Demo the default.
- Create short-lived approval state, protect refresh tokens against replay, rate-limit login and execution approval attempts, and audit all broker-write outcomes.
- Adopt dependency security gates (pnpm audit), typechecking, unit tests, Cloudflare dry runs and real-host QA before marking a release ready.
- Use a versioned migration and never deploy changes to a Live account solely based on a passing mocked unit test.

## Migration and acceptance milestones
**Phase A (in this PR):** external write boundary, OAuth CIMD, patched MCP SDK, pure order policy, broker port, transport failure tests, security automation.

**Phase B (before v3 GA):** OAuth refresh rotation, order price provenance, explicit disambiguation, per-environment concurrency/risk budgets, schema validation of broker responses, comprehensive integration tests and Claude/ChatGPT host QA.

**Phase C:** opt-in research adapters, evidence/source confidence, read-only watch rules, portfolio health dashboards and durable analytics. Background workflows still cannot place or cancel broker orders.

**Phase D:** app-directory packaging, discoverability, icons, accessibility, privacy/terms, telemetry opt-out and actual host/review acceptance. Directory acceptance is not automatic from implementing MCP.
