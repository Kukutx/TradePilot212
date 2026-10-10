# V3 architecture: no compatibility lanes

```
MCP 2026-07-28 host (ChatGPT / supported Claude)
   │  Client ID Metadata Document + OAuth/PKCE
   ▼
Stateless createMcpHandler(legacy=reject)
   ├─ portfolio snapshot / deterministic analysis
   ├─ hypothetical stress and review brief
   ├─ historic order inspection (GET)
   └─ watch-rule CRUD + local alert feed
                  │
         IntelligenceService
             ├─ Pure analytics (domain)
             ├─ SamplePortfolioProvider
             ├─ Trading212Reader (GET-only official origins)
             └─ StateStore (Node file / Durable Object)
                  │
Weekday Cloudflare Cron ─┘ (read portfolio, evaluate rules, persist alerts only)
```

## Runtime state
`v3:code:*`: one-use OAuth authorization code, 5m.
`v3:refresh:*`: one-use refresh grant, 14d.
`v3:client:*`: validated allowlisted CIMD cache, 30m.
`v3:snapshot:*`: local read cache, 30s.
`v3:rule:*`: saved user thresholds.
`v3:rule-status:*`: last trigger state for deduplication.
`v3:event:*`: local monitor alerts, 30d.
`v3:rate:*`: owner login rate limit.

The entire V2 state and API are deliberately unsupported. No migration code, no hidden aliases. New OAuth connections must be set up from zero.

## Protocol
The formal MCP 2026-07-28 revision removed `initialize` and protocol-level sessions and added `server/discover`, explicit request metadata, and mandatory routing headers. V3 uses `createMcpHandler(...,{legacy:"reject"})`; `Mcp-Method` and `Mcp-Name` validation are enforced by the SDK. Each HTTP request is independently authenticated with bearer audience/issuer/scopes. Origin is allowlisted.

## Data trust
The domain model distinguishes `source=sample` vs `source=trading212`. Portfolio totals are in the broker primary currency; instrument `currentPrice` is used for account-currency concentration only when instrument currency matches, or when a verified broker `walletImpact.currentValue` is available. If reconciliation fails, whole-portfolio HHI/concentration/stress totals are **unknown**. This rule prioritizes reliability over a pleasing dashboard.

## AI boundary
The model/host supplies natural-language interpretation and optionally independently sourced market news. Our tools only provide account-backed numeric facts and deterministic calculations. Source absence is not implied evidence. Tool annotations declare real side effects; watch-rule changes affect only local state. This is not a financial adviser.

## Release gates
- TypeScript, unit tests, authenticated MCP smoke, dependency audit, Workers dry-run.
- Demo QA using real Trading 212 **read-only** credentials; no API write permissions.
- Actual latest-protocol ChatGPT and Claude host testing and privacy review.
- Separate publication decision after assessing third-party connector and high-risk financial policy.
