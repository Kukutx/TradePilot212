# V2 functional parity → V3 Personal (not backward compatible)

This is an acceptance checklist for **behaviors**, not old code, old tool names or persisted data. Code exists in this draft branch unless otherwise noted. Actual host/Broker Demo acceptance remains pending.

| Capability from V2 | V3 Personal implementation | Verification |
| --- | --- | --- |
| Demo/Live separated | `Configuration`, `executionPermitted`; Live separately opt-in | Unit + config checks |
| Portfolio, cash, holdings | `Trading212Reader`, `IntelligenceService` | Existing analytics tests |
| Pending broker orders | `Trading212TradeGateway.getPendingOrders` and personal MCP | Requires Demo E2E |
| Ticker, company and fuzzy name resolution | `resolveInstrument`, `search_personal_instruments` | New unit tests |
| Quantity sizing | `resolveTradeIntent` | New unit tests |
| Monetary sizing & manual FX input | `resolveTradeIntent`, evidence warnings | New unit tests; trusted FX source future |
| Cash percentage | `resolveTradeIntent` | New unit tests |
| Held percentage (not just tradable) | `resolveTradeIntent` | New unit tests |
| Sell all tradable shares | `resolveTradeIntent` | New unit tests |
| Market, Limit, Stop, Stop-Limit | `Trading212TradeGateway.placeOrder` | Mocked broker tests only |
| Extended hours & time validity | `TradeDraft`, broker payload | Mocked request mapping |
| Review/edit confirmation UI | `PersonalTradeWorkspace` React | UI host QA pending |
| One-use token + human confirmation | `PersonalTradingService`, action-bound HMAC | Workflow tests |
| Cancellation | `prepareCancel`/`executeCancel` | Mock tests; Demo QA pending |
| Unknown write verification | `verifyOutcome` read-only | Mock tests; Demo QA pending |
| Recent TradePilot activity | metadata-only V3 state log and MCP | Requires host QA |
| Short/medium/long AI candidate cards | `tradePlan`, `show_personal_trade_plan` | Host rendering QA pending |
| English/Simplified Chinese | New V3 dashboard + trade UI | Visual/host QA pending |
| OAuth/PKCE | Modern-only CIMD/PKCE with rotated refresh | Existing V3 smoke |
| Node.js, Cloudflare, Docker | New source adapters, deploy script and Dockerfile | Build/dry-run pending |
| Local HTTPS tunnel | `pnpm dev:tunnel`, Cloudflare Quick Tunnel | Manual QA pending |
| Automated market research without trading | host research + local read-only Cron watches | Current deterministic monitor engine |

**V3 additions:** verified-currency concentration, historical risk trend, stress scenarios, local watch rules/alerts, independent human HMAC proof and explicit Demo/Live opt-in.

**No compatibility:** V2 keys (`T212_*_API_KEY`), OAuth refresh tokens, old order tools, stored state and old protocol versions are intentionally rejected. Existing `main` retains the old program untouched.
