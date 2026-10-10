# ChatGPT, Claude and other MCP hosts

TradePilot212 has **one** OAuth-protected Streamable HTTP MCP endpoint: `https://<your-deployment>/mcp`.
A distinct MCP server is **not** required for ChatGPT, Claude or every future AI provider.

## ChatGPT
1. Deploy the Worker privately and keep all Trading 212 keys and the execution approval secret in Worker Secrets.
2. In a ChatGPT experience that supports custom remote MCP apps, add the `/mcp` URL.
3. Authorize via the TradePilot OAuth login page. In the host's app configuration, use CIMD or DCR according to availability; `trade:read` alone is enough for portfolio/plan features.
4. Review portfolio read operations and UI rendering before trying Demo order preparation.
5. Every broker order/cancellation requires a separate approval value typed **inside the interactive UI**, never in the AI prompt.

## Claude
1. Choose a Claude client supporting custom remote MCP connectors and interactive Apps (availability can vary by client and plan).
2. Add the same `/mcp` URL and follow its OAuth connection UI. Dynamic client registration remains available for compatibility.
3. Start with portfolio and instrument search; check whether the interactive dashboard and full-screen mode are supported in that host.
4. Verify Demo-only preview first. Never assume Claude host options mirror ChatGPT's.

## Generic MCP hosts
When embedded UI is unavailable, use the **read-only tools** and structured output; order-execution tools are intended for the interactive MCP App, and are protected server-side. Do not copy a secret into model tool arguments or prompt messages.

## Compatibility requirements
- Public remote HTTPS for production; localhost is only for local development.
- MCP Streamable HTTP with bearer OAuth 2.0, PKCE S256, audience/resource binding.
- ChatGPT CIMD or RFC 7591 DCR registration; metadata must accurately describe supported methods.
- The MCP Apps HTML extension is optional in the host; text/structured tools must still be comprehensible.
- Host support/entitlements and UI implementation change independently from TradePilot releases.

Official references:
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/plugins
- https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- https://modelcontextprotocol.io/specification/2026-07-28

**Host compatibility is still subject to live connector testing**. A successful CI build is not proof of ChatGPT or Claude directory approval.
