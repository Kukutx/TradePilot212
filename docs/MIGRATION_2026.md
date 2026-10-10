# 2026 Breaking Migration (v3 candidate)

**Status:** changes are currently in a draft PR. Do not deploy this branch into a Live brokerage integration without testing Demo first.

## What changes
1. **Execution authorization:** every Demo/Live order and cancellation requires an independent human-held `EXECUTION_APPROVAL_SECRET`. The interactive UI derives an action-and-token-bound HMAC proof; the raw secret is not sent as an MCP tool parameter.
2. **OAuth refresh grants:** refresh JWTs are now tracked server-side and consumed once. Old pre-migration refresh tokens are deliberately invalid because they have no server-side grant. Reauthorize the MCP host.
3. **OAuth clients:** support ChatGPT CIMD client metadata with public `none` + PKCE authentication, plus DCR fallback for other compatible hosts. Redirects include RFC 9207 `iss`.
4. **Price guards:** with `MAX_ORDER_NOTIONAL > 0`, a Market **buy of an unheld instrument** cannot proceed using only an AI/user-supplied reference price. Use a broker-enforced **Limit** order. Unbounded Buy Stop orders require Stop-Limit.
5. **Transport behavior:** unreadable broker write responses are treated as **UNKNOWN**, with no automatic retry. Oversized chunked MCP requests return HTTP 413. The anonymous health endpoint no longer exposes credential setup status.
6. **Portable apps:** source text and documentation are now designed for ChatGPT, Claude and other compatible MCP hosts, but real-host review is still required.

## Owner upgrade procedure
1. Back up the local `.data/` directory or Cloudflare Durable Object state according to your deployment practice. Never check secrets or backups into Git.
2. Update the repository to the reviewed release/branch and run `pnpm install --frozen-lockfile`.
3. Run `pnpm setup` to generate the new `EXECUTION_APPROVAL_SECRET` if not already present. Store it in a secure password manager.
4. Run `pnpm doctor`, `pnpm check`, `pnpm audit --prod`, `pnpm release:check` and `pnpm smoke`. Smoke uses a test OAuth flow and must never send a real order.
5. For Cloudflare, `pnpm deploy -- --dry-run` before `pnpm deploy`. Worker Secrets include the new approval secret. For local Workers, update `.dev.vars` separately.
6. Remove and reconnect the host's OAuth integration to obtain fresh refresh-token grants. Existing pre-migration tokens are not migratable.
7. Validate portfolio reads in Demo, then use a small **Demo Limit** order and verify lifecycle, cancellation and activity. Recheck whether the host supports the embedded UI.
8. Keep Live execution disabled until your own Demo QA and reconciliation procedure succeed.

## Reversion
Use Git to return to the previous known-good release or deploy the previous Worker build. **Do not downgrade to escape an unknown broker-write state**; reconcile with Trading 212 first. New OAuth grant state does not guarantee backward compatibility with the old untracked refresh tokens.

No migration of broker credentials into the AI host or a shared database is introduced.
