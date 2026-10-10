# Security — TradePilot Insight V3

**The broker adapter has no POST, PUT, PATCH or DELETE pathways.** Source-code review, test interception and production allowlisting must preserve this property.

Private configuration: `OWNER_PASSWORD`, `JWT_SIGNING_SECRET`, `T212_*_KEY`, `T212_*_SECRET`. Store in local private env files or Cloudflare Secrets. Never paste into an AI prompt or expose in tool results. Use read-only Trading 212 API permissions.

- OAuth: strict allowlisted HTTPS CIMD origins; response `iss`, S256 PKCE, resource audience, signed short-lived access JWT and atomically rotating refresh grants.
- Modern MCP only; no legacy session/DCR fallback. Cross-origin browser calls are restricted to known OAuth client origins.
- Broker data: GET-only fixed official hosts, bounded response sizes, schema validation and no synthetic fallback.
- Currency gaps/partial snapshots must be disclosed and may disable analytics.
- Monitoring is local alert state only. Cloudflare Cron cannot place trades.
- Node persistence is private atomic JSON; DO storage is per-instance, not multi-tenant.
- Never log tokens, raw brokerage payloads, full account identifiers or credentials.

Report vulnerabilities privately via GitHub Security Advisories. Do not disclose real account data in public issues.
