# TradePilot Insight V3

**An AI-native investment-intelligence app for Trading 212, built on MCP 2026-07-28.**

[简体中文](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Product strategy](docs/PRODUCT.md) · [Privacy](PRIVACY.md)

**V3 is a clean-slate replacement, not an upgrade of TradePilot212 v2.** The old source layout, tools, environment keys, state and OAuth registrations are intentionally unsupported. Reconfigure and reconnect from zero.

## What it does

- Read personal Trading 212 Invest / Stocks ISA portfolio data through its official Public API, or use clearly labelled synthetic fixtures.
- Compute auditable portfolio concentration, cash ratio, position valuation coverage and data limitations.
- Simulate hypothetical broad portfolio price shocks (never a forecast).
- Show recent broker order history as a bounded read-only page.
- Save explicit portfolio threshold rules (cash, largest holding, unrealized loss) and evaluate them automatically with read-only scheduled monitoring. Threshold-crossing events are stored locally for later retrieval.
- Expose a bilingual interactive MCP App UI and precise tools for reasoning hosts including ChatGPT and compatible Claude clients.
- Generate account-evidence briefs that intentionally never invent news articles, price forecasts, recommendations or external source citations.

**No trading, cancellation, fund transfer or broker-account writes exist anywhere in V3.** Investment trade execution through the ChatGPT Plugin Directory is explicitly disallowed in [the publication rules](https://developers.openai.com/plugins/plugin-guidelines). Trade decisions and final execution remain entirely outside the plugin, inside the broker's own app.

## System shape

```
ChatGPT / Claude / modern MCP host
  └─ 2026-07-28 Streamable HTTP /mcp (no legacy initialize)
      ├─ OAuth client metadata + PKCE / owner login
      ├─ Standalone read-only tools
      └─ Portable React MCP App
           │
      IntelligenceService
      ├─ Account snapshot / deterministic analytics / stress scenarios
      ├─ Internal watch rules / threshold events
      ├─ SamplePortfolioProvider (explicit, synthetic)
      └─ Trading212Reader (GET-only, strictly validated official API)
            ├─ Demo account
            └─ Live account (READ ONLY)
      StateStore ├─ Node atomic private local JSON
                 └─ Cloudflare Durable Object
```

## Development

Node.js 24 / pnpm 11 recommended. All configuration uses **new V3 keys**, never v2 keys.

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
# Replace OWNER_PASSWORD and JWT_SIGNING_SECRET with strong independent values.
# DATA_SOURCE=sample is the default and NEVER represents a real account.
pnpm check
pnpm dev
```

For real Trading 212 read-only data, set `DATA_SOURCE=trading212` and either/both pairs `T212_DEMO_KEY/T212_DEMO_SECRET`, `T212_LIVE_KEY/T212_LIVE_SECRET`. Use keys with **read permissions only**. Credentials stay in the self-hosted environment and are never included in MCP responses.

Production requires a stable HTTPS `PUBLIC_ORIGIN`, explicit OAuth client origin allowlist and proper Cloudflare secrets. Use `pnpm build:widget && pnpm exec wrangler deploy --dry-run` before any deployment. The Cloudflare Cron expression in `wrangler.jsonc` runs weekday **07:00 UTC**, and only checks watch rules when `DATA_SOURCE=trading212`.

## First connection

Configure the official remote MCP URL `https://your-instance.example/mcp` in a **modern 2026 protocol** host that supports OAuth Client ID Metadata Documents and PKCE. This project deliberately rejects legacy MCP handshakes and old dynamic client registration. Host support and plan entitlement are not guaranteed, particularly for Claude clients that only implement older OAuth flows.

Suggested prompts:
- “Show my TradePilot portfolio intelligence in Demo. Explain data freshness and valuation coverage.”
- “Analyze concentration and cash risks in my Live portfolio. Don’t recommend trades.”
- “Simulate a -15% portfolio-wide equity shock and list all assumptions.”
- “Create a watch rule if my largest holding goes above 35% of account value.”
- “Summarize read-only investment observations for today and identify which news I should independently research.”

## Safety and publication

Data from Trading 212 is retrieved on request or by an explicit scheduled *read-only* scan; broker response schemas are validated and never replaced with plausible synthetic data on failure. Different-currency holdings with unknown trusted account-currency valuation **remain unknown**, not silently converted. Automatic watch rules only affect self-hosted alert records; they cannot initiate trading.

MCP Plugin Directory acceptance is **not guaranteed**: third-party connector policies, authenticated test accounts, privacy docs, real-host desktop/mobile QA and developer verification still need review. This open-source self-hosted architecture is not a multi-user SaaS platform.

For details see [docs/PRODUCT.md](docs/PRODUCT.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and [PRIVACY.md](PRIVACY.md).

MIT licensed. This software is informational and does not provide individualized investment advice.
