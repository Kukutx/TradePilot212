# Product strategy — TradePilot 212 V3 Personal

## Customer and deployment
**Primary customer: the owner/operator.** A private personal AI investment cockpit around one Trading 212 Invest/Stocks ISA account, not a public trading plugin, multi-tenant brokerage SaaS or automated investment adviser.

## Differentiation
A generic broker API proxy offers little value. V3 combines:
1. **Account intelligence:** verified portfolio exposure, holdings, currencies, cash, pending orders, P/L, risk trends and data-quality coverage.
2. **AI research workflows:** model-supplied multi-horizon ideas with dated sources, thesis, risk, catalysts and counter-case, clearly distinct from broker facts.
3. **Personal execution cockpit:** convert flexible intents into explicit broker quantity orders, review price/FX/quantity, choose Demo/Live and execute only after the owner types an independent approval secret in the UI.
4. **Lifecycle reliability:** one-write-only semantics, unknown-state reconciliation, metadata audit and short-lived, nonreusable confirmation.
5. **Read-only automation:** host-based research, scheduled portfolio threshold checks and durable local alerts. Autonomous broker writes are prohibited.

## Why not delete private execution?
OpenAI's **public Plugin Directory** has separate restrictions against investment trading; personal custom MCP apps have different capabilities and restrictions. A private owner's valid brokerage integration should not be reduced to read-only solely to satisfy a public listing. However host permission and policy can still block write operations. A separate public read-only product would need its own release approval, not destructive edits to this repository.

## Non-negotiable non-compatibility
V3 introduces new domain contracts, tool names, config flags, OAuth, storage namespace and UI. No aliases, old routes, legacy MCP, DCR fallback, migration readers or preserved ABI. **Feature parity is retained, API compatibility is not.**

## Priorities
P0: safe private brokerage operations + complete preserved feature coverage + real tests.
P1: strong portfolio analytics, evidence provenance, broker-aware order risk and multi-host UX.
P2: trusted licensed market data, portfolio historical attribution, divergence tracking, broker reconciliation.
P3: opt-in research automation and proactive local alerts, but never unattended order submission.

## Acceptance
- New V3 CI passes with all added regression and failure-injection tests.
- No model-visible or scheduled code can trigger broker POST/DELETE.
- API keys remain owner-private, proof-only external confirmation, no automatic write retries.
- Real Trading 212 Demo account tests plus separate ChatGPT/Claude host QA completed **before** Live use.
- Bilingual UX, self-host Node/Docker/Cloudflare paths and configuration diagnostics preserved.

Official references: https://developers.openai.com/plugins/plugin-guidelines ;
https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt ;
https://docs.trading212.com/api ;
https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
