# Changelog

## Unreleased — 2026 cross-host security redesign (breaking, draft)

- Expanded portable MCP App support for ChatGPT, Claude and other compatible hosts; added modern CIMD client metadata and RFC 9207 OAuth issuer.
- Enforced a separate human-held execution secret, used only to derive scoped, single-use HMAC order/cancellation proofs in the UI.
- Introduced broker-neutral `BrokerGateway` and a pure order-policy module, with new security tests.
- Added replay-proof OAuth refresh-token rotation backed by atomic `StateStore.consume`.
- Fixed unreadable broker-write responses to remain UNKNOWN and never cause automatic retry.
- Blocked AI-only reference prices from authorizing capped Market buys of unheld instruments; bounded-price Limit/Stop-Limit is the safe fallback.
- Hardened streamed MCP upload limits and removed credential flags from anonymous health status.
- Updated MCP SDK dependencies and pinned the patched client transitive dependency; added a production dependency audit gate.
- Expanded CI with OAuth/MCP smoke tests, read-only scope tests, and failure-injection regression tests.
- Added architecture, migration, privacy, compatibility and safety rule documentation.

**Migration:** [docs/MIGRATION_2026.md](./docs/MIGRATION_2026.md). Not a released version; do not deploy to Live accounts without separate acceptance testing.


## 2.4.0

- Replaced fixed order-review modals with an in-flow transaction workspace that can resize with the ChatGPT host.
- When the host provides a very short embedded viewport, TradePilot requests fullscreen when available and falls back cleanly when it is not.
- Only one transaction step is rendered at a time; the portfolio is no longer layered behind order review.
- Removed nested modal scrolling and made confirmation rows stack on narrow embeds.
- Closing a model-opened order draft returns to the portfolio instead of leaving an empty order state.
- Added a layout regression test for fixed-overlay and nested-scroll regressions.

## 2.3.0

- Added structured error codes and bilingual UI error rendering.
- Added reference-price and account-snapshot freshness metadata to order review.
- Added read-only verification for ambiguous order/cancellation write outcomes; original writes are never retried automatically.
- Added a compact recent-activity trail stored in the instance state store.
- Added expandable trade-plan detail fields for thesis, catalysts, risks, counter-case, sources, and timestamps.
- Improved natural-language order conversion UI with calculated quantity, manual-edit indication, and restore action.
- Added keyboard focus containment, Escape handling, live status announcements, and larger mobile touch targets.
- Added architecture documentation and tightened public documentation language.

## 2.2.1

- Hardened company-name resolution across multiple Trading 212 listings.
- Corrected position-percentage sizing to use the total held position while respecting currently tradable quantity.
- Added bilingual sizing-resolution details to the order-review UI.

## 2.2.0

- Added flexible natural-language order intents.
- Added quantity, target-amount, cash-percentage, position-percentage, and all-available sizing modes.
- Added configurable default environment and optional application-level order caps.
- Added ordering and automation documentation.

## 2.1.0

- Added responsive bilingual MCP App UI and bilingual OAuth page.
- Added self-host setup/deployment commands, CI, security checks, and open-source documentation.
- Published the single-user self-hosting model.
