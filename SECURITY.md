# Security — TradePilot 212 V3 Personal

This is **private single-owner brokerage software**, not a public ChatGPT trading plugin.

## Secrets and authorization
Keep `OWNER_PASSWORD`, `JWT_SIGNING_SECRET`, `PERSONAL_APPROVAL_SECRET`, and `T212_{DEMO,LIVE}_{KEY,SECRET}` outside Git and AI conversations. Trading 212 keys are configured per account environment in self-hosted runtime secrets.

OAuth requires CIMD+PKCE and explicit scopes. Personal broker writes require `trading:execute` on the connection, `PERSONAL_TRADING_ENABLED=true` on the owner server, and `PERSONAL_LIVE_TRADING_ENABLED=true` additionally for Live. Neither app-only tool metadata nor host confirmation prompts are sufficient authentication.

A human enters the independent secret into the sandboxed UI for each operation. Only a single-use HMAC proof bound to the specific order/cancel token and operation is sent via MCP. The proof is itself a short-lived capability; treat it as sensitive until consumed.

## Independent Owner Console\n\n`/owner` has a separate 12-hour owner session, secure HttpOnly Strict SameSite cookie over HTTPS, CSRF protection, same-origin POST requirements, no CDN and hash-pinned content-security policy. An authenticated session still cannot place a trade without the independent human HMAC proof, server flags and fresh order check. Browser malware, hostile extensions or a fully compromised server remain out of scope for these protections.\n\n## Read-only external sources and email\n\nECB rates use a fixed official HTTPS host and preserve observation dates. SEC research is disabled until `SEC_CONTACT_EMAIL` is configured; official SEC ticker and filing URLs are bounded and User-Agent identification is sent only to SEC. Twelve Data quotes are optional and not broker execution guarantees. Resend email requires explicit owner opt-in plus independently configured provider key/sender/recipient and uses provider idempotency keys.\n\nNo external provider receives Trading 212 API credentials or the raw personal approval secret. Email alerts contain limited observation labels, not complete holdings.\n\n## Write safety
- Draft generation never submits a broker write.
- Broker state and order constraints are revalidated before writing.
- Confirmation is stored as one-use and expires within 30–300 seconds.
- Each Trading 212 POST or DELETE is sent **at most once**; loss of response never triggers retry.
- A per-environment atomic write lease prevents two independent confirmation tokens from concurrently spending the same cash; UNKNOWN outcomes leave a 120-second cooldown. Lock expiration NEVER implies execution failed.
- Rate reservations are per account/API endpoint, including reads and command writes; refusing a reservation must occur before any broker request.
- Without separately opting into `PERSONAL_ALLOW_UNQUOTED_LIVE_BUYS=true`, unheld Live Market buys and Buy Stops must use a bounded-price order type when app-level notional caps are enabled.
- UNKNOWN statuses must be read back before a person takes any further action.
- Demo/Live cannot swap after confirmation.
- Sample mode has no executable trade route.
- Market orders can slip; prices entered by an AI or user are merely references.

## Data and operations
- Broker URL bases are fixed to official Demo/Live HTTPS hosts.
- Internal monitoring/Cron may read account data and update local alerts; it cannot place/cancel orders.
- Durable state is personal, not tenant-isolated multi-user infrastructure.
- Never log passwords, approval secrets, JWTs, authorization codes, raw brokerage credentials or request bodies.
- Back up the private `.data/` directory securely; do not copy secrets into images.
- Node Docker must run behind an HTTPS reverse proxy. Cloudflare Secret Store must be limited to the operator's account.

## Disclosure
Report security issues privately using GitHub Security Advisories. Do not publish personal account information, keys or live broker requests.
