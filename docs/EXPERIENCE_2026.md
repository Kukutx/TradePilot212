# V3 Personal — Intelligent UI & Simplicity Strategy (2026-10-10)

**Positioning:** Private, single-owner **AI investment copilot**. The product spots what needs checking, explains portfolio risk, supports research and simulations, and enables only human-confirmed broker execution. Preserve all legitimate V2 functions, but do NOT add protocol/tool/state backward compatibility.

## Three surfaces

**1. Conversational, adaptive.** Provide compact typed data with source, account currency, time and evidence limits. ChatGPT's *Intelligent UI* dynamically composes its own answers; this is NOT a plugin-controlled rendering API. Claude similarly may generate its own visuals. Never assume either host will create a specific card. A headless MCP tool remains useful without UI.

**2. Shared MCP Apps UI.** Use the open MCP Apps bridge and host-provided theme tokens; feature-detect any optional extension. Inline is short and task-specific, with at most two primary actions. Fullscreen handles detailed risk investigation, scenarios and personal order review. An owner chooses the Demo/Live account, and an AI research score never becomes an execution authorization.

**3. Independent personal Owner Console (Alpha implemented).** The new self-hosted `/owner` page offers independent owner-login, read-only data and research, personal preferences, watch setup, and human-confirmed brokerage order/cancel. Browser session, same-origin CSRF, action-bound HMAC and Live opt-in are enforced. This is a new V3 interface—not a legacy fallback. WebAuthn, real-browser compatibility, threat-model review and Live readiness remain unverified.

## Now implemented

- `get_personal_attention_center`: one cached portfolio snapshot plus source-separated local monitoring history; deterministically prioritize incomplete valuations, concentration/cash threshold signals, and past events. Clearly distinguish synthetic data from the real broker. No news, brokerage writes or trade advice.
- Bilingual **Today** view; primary navigation Today / Portfolio / Risk / Private Trade, with deeper Trend / Stress / Brief in an expandable area.
- Cross-host MCP Apps theme tokens and inline/fullscreen capability hints.
- `enable_basic_portfolio_monitoring`: one action to create only missing local watch rules (cash below 5%, max holding above 35%, unrealized P/L below -10% of account value), keeping prior user-defined rules. Requires `monitor:write`, never touches broker orders.
- Empty trading symbol and quantity by default; AI research without share sizing can open a prefilled editor but never silently creates a one-share proposal.
- Independent `/owner` page with login and step-up human confirmation, personalized timezone-aware daily read-only digest and optional Resend email (OFF by default).
- Fixed-origin ECB dated reference FX, official SEC primary filing links and optional Twelve Data timestamped quotes; evidence metadata is never used to authorize brokerage writes.
- Namespaced ChatGPT sidebar/thread entrypoint hints in MCP tool metadata, while keeping portable MCP Apps behavior for Claude.

## Next priorities

P0: real ChatGPT/Claude device-and-account MCP host verification and security hardening of the **implemented Alpha** standalone Owner Console, including independent real-browser security review and optional future WebAuthn.
P1: timezone-aware **one daily** read-only brief and optional Resend email are implemented (OFF by default). Further work: multiple delivery times, verified device push/ChatGPT notification permissions, and operational email QA.
P1: official ECB reference FX, primary SEC filings and optional vendor quote metadata are implemented. Still needed: licensed broad news, validated paid provider subscriptions, rigorous broker-history order reconciliation and performance attribution without confusing deposits with investment returns.
P2: optional ChatGPT sidebar/thread entrypoints have been **declared**; runtime host verification, plugin settings and deep-link extensions remain pending. Claude-compatible standard MCP Apps behavior is preserved.

## Acceptance

- One natural-language question produces a useful, timestamped portfolio attention summary in one MCP call.
- No hallucinated market quotes, no silent FX conversion, no automatic brokerage writes.
- A second valid confirmation cannot overlap an in-flight broker write; unknown writes never auto-retry.
- Test web/mobile at narrow and wide widths, dark/light themes, keyboard and screen reader.
- No claim of host interoperability, Live readiness or actual push notifications without device-and-account E2E tests.

## Official references
- https://openai.com/index/gpt-6-for-everyone/
- https://developers.openai.com/plugins/concepts/ui-guidelines
- https://developers.openai.com/plugins/build/extensions
- https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
