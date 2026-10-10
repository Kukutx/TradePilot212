# Privacy: TradePilot 212

TradePilot 212 is **self-hosted single-owner software**, not a central hosted brokerage service. Each deployment is operated by its owner and holds only that owner's Trading 212 credentials.

## Information handled
- Trading 212 Invest or Stocks ISA account summary, current positions, instrument metadata, outstanding orders and limited order/cancellation history.
- MCP OAuth authorization and public-client metadata; access and refresh tokens issued by the deployment.
- One-time confirmation state, metadata-only activity records and verification records for uncertain broker writes.
- User-supplied model-generated research candidates, source citations, and proposed trade intents.

## Information flows
1. Your own Cloudflare Worker or Node server calls the Trading 212 Public API using credentials stored in that server's private environment.
2. An authorized AI host such as ChatGPT or Claude receives account/tool data **when it invokes a TradePilot tool**. That host may process or retain tool results according to its own privacy and retention terms. Avoid connecting an untrusted host.
3. When an interactive MCP App initiates a broker write, it computes a **single-use HMAC proof inside the UI** from a human-held execution secret. The host receives the proof and one-time order identifier, **not the raw execution secret**. Treat that proof as sensitive until it expires or is consumed.
4. The broker write itself goes directly from your self-hosted server to Trading 212; TradePilot does not route Trading 212 keys through the AI host.

## Storage and retention
- Broker API keys, OAuth signing secret and independent execution secret: only configured environment secrets; not inserted into tool results.
- TradePilot activity records: expire after up to **90 days** in the state store.
- Unknown-execution verification records: expire after **24 hours**.
- One-time execution confirmations: default **90 seconds** (configurable).
- OAuth refresh grants: bounded by configured refresh-token lifetime (default **30 days**) and consumed at rotation. Dynamically registered clients can remain in local state until pruned.
- Node installations also append **local audit JSONL** files. These do not auto-expire; the owner controls their retention and file permissions.
- A deployed service or AI platform may have its own logging policies; disable unnecessary request or token logging.

## Your controls
- Use `trade:read` OAuth scope when you only need account views and AI research.
- Revoke Trading 212 API keys in Trading 212 to cut off broker access.
- Rotate local secrets and redeploy to invalidate access and approval capability as appropriate; changing the signing secret invalidates existing JWTs.
- Shut down your instance and remove its self-hosted state, logs and secrets to stop collection.
- Never delete audit or state data as a substitute for reconciling an uncertain live order directly with Trading 212.

## Security and disclosure
No centralized user registration, cross-user data aggregation, external ad network or hosted analytics backend is included in this repository. Do **not** deploy your personal Worker as a public shared multi-user connector.

Source code and vulnerability disclosure: [SECURITY.md](./SECURITY.md).
Trading 212 and each AI host are independent services with their own terms and privacy policies.
