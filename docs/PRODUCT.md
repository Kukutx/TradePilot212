# V3 product thesis — investment intelligence, not order entry

## What was wrong with V2
The original app mixed LLM-generated trade ideas, user-facing portfolio UI, broker order execution and a personal OAuth gateway. Its differentiator was the ability to place trades from chat; that capability is unsuitable for a ChatGPT Directory plugin because current publication guidelines prohibit **execution of investment trades**. Simply updating dependencies and rewording order confirmations cannot solve a product-policy conflict.

It also overly relied on model-supplied prices and external research without trusted provenance. Broker-only wrappers can be rejected as unofficial third-party pass-through connectors. Trading 212's Public API is Beta and currently limits Invest/Stocks ISA and multicurrency operations.

## Target persona
A technically capable, privacy-conscious Trading 212 Invest/Stocks ISA account holder who wants to ask questions about **their own** portfolio, see why a risk signal is computed, and monitor threshold events without granting an AI platform permission to trade.

## Durable value (beyond built-in chat)
1. Account-currency-safe valuation with explicit coverage and confidence limitations.
2. Concentration/cash signals from reproducible deterministic rules, not invented LLM scores.
3. Small, structured MCP tools that let ChatGPT or Claude reason over user-approved financial data.
4. Local threshold state and scheduled read-only scans; durable alert events, no broker write endpoints.
5. Independent, auditable stress testing with stated assumptions.

## Explicit non-goals
- **No** investment execution, cancellation, automatic/assisted checkout, external trade deep link or broker order draft hidden in app.
- No autonomous robo-advisor or promise to beat markets.
- No use of unverified LLM price quotes as broker/account values.
- No internal OpenAI/Anthropic API keys required: the connected host is the language interface.
- No forced backward compatibility with old MCP protocol, OAuth DCR, v2 tools, v2 state or v2 secrets.
- No multi-user hosted credential vault in a self-hosted project.

## Where further product upgrades make sense
| Priority | Capability | Acceptance criteria |
| --- | --- | --- |
| P0 | Currency provenance | Unknown FX => risk metric unavailable, never silent estimate |
| P0 | 2026-native MCP | server/discover supported, legacy initialize explicitly rejected |
| P0 | Privacy & permissions | Owner OAuth, read-scoped broker key, bounded outputs |
| P1 | Daily intelligence & watch rules | Last check/source/time disclosed; no broker writes |
| P1 | Independent analytics | Testable concentration, drift, contribution and scenario math |
| P2 | Trusted market research providers | Named/licensed data sources, timestamp, citation, differing confidence |
| P2 | Historical attribution | Broker pagination, dividends, deposits and performance with explicit methodology |
| P2 | Direct host UX quality | Actual ChatGPT and Claude testing on desktop/mobile |
| P3 | Store-ready publication | Verified developer + demo test account + privacy/review |
| P3 | Optional native personal dashboard | Not a ChatGPT plugin execution workaround |

## Commercial/review reality
ChatGPT Directory policy also rejects apps primarily functioning as unofficial third-party connectors. This product must deliver analytics of independent value rather than just proxy account data. A personal self-hosted Worker is not necessarily an approvable general-public SaaS app. Review requirements include stable authenticated sample test credentials and actual hosted availability. Do not claim accepted or certified status.

## Key sources (checked 2026-10-10)
- https://developers.openai.com/plugins/plugin-guidelines
- https://developers.openai.com/plugins/build/mcp-server
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://docs.trading212.com/api
