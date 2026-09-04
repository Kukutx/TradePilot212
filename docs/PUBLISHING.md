# Publishing model

TradePilot 212 is intentionally distributed as **open-source self-hosted software**.

## Recommended model

One person = one deployment = one Trading 212 credential set.

```text
User A → User A's ChatGPT → User A's Worker → User A's Trading 212 keys
User B → User B's ChatGPT → User B's Worker → User B's Trading 212 keys
```

The repository owner does not need to provide a shared server and should not collect other users' brokerage credentials.

## What users do

1. Fork/clone the repository.
2. Run `pnpm setup`.
3. Add their own Trading 212 API credentials to `.env.local`.
4. Run `pnpm doctor`.
5. Run `pnpm deploy` to create their own Cloudflare Worker.
6. Connect their own Worker MCP URL to ChatGPT.

## Do not share the author's instance

A deployed Worker contains the credentials configured for that instance. Never publish one personal Worker endpoint as a generic service for unrelated users.

A true multi-user hosted product would require a separate user identity system, encrypted per-user credentials, tenant isolation and authorization. That is deliberately outside the default architecture.
