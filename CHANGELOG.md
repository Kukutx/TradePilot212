# Changelog

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
