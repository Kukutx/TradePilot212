# Security Policy

TradePilot 212 is designed as a **single-user, self-hosted instance**. One deployment should contain one user's Trading 212 credentials.

## Never publish these values

Do not commit or share:

- `.env.local`
- `.env`
- `.dev.vars`
- `APP_LOGIN_PASSWORD`
- `AUTH_SIGNING_SECRET`
- any Trading 212 API key or API secret
- runtime state under `.data/`

The repository's `.gitignore` excludes these files. Run `pnpm release:check` before publishing changes.

## If a Trading 212 credential is exposed

1. Revoke/delete the exposed API key in Trading 212 immediately.
2. Generate a new key/secret pair.
3. Update `.env.local`.
4. Run `pnpm deploy` to replace the Cloudflare Worker secrets.
5. Review account activity and pending orders.

## Trading safeguards

- Demo and Live credentials are stored separately.
- Orders and cancellations require explicit user confirmation in the UI (see the threat model below for how this is enforced).
- Confirmation tokens are short-lived and one-time.
- Trading 212 write requests are never automatically retried after an ambiguous network/write failure.
- Unknown write outcomes can be checked through a read-only verification flow; verification never resubmits the original write.
- The server revalidates order constraints before submission.
- Recent activity stores order/cancellation metadata only and does not contain API credentials or confirmation secrets.
- Server-side quantity and notional caps are configurable per self-hosted instance; positive values are enforced before submission. Setting a cap to `0` deliberately disables only that app-level cap.

- A policy engine (`POLICY_*`, binding Live by default) can cap position weight, daily orders and daily value, restrict tickers and instrument types, and block Market orders while a market is closed. It runs at review and again before every write, including each leg of a basket.
- Baskets are confirmed once with a one-time token; an uncertain leg stops the remaining legs.
- Live orders and baskets need a second, explicit acknowledgement that real money is used; the server rejects a Live execution without it and keeps the token unused.
- Linked stop-loss / take-profit pairs: after one half fills, the scheduler cancels the other. This cancellation is the only unattended Live write, it is sent once and never retried, and `PROTECTIVE_OCO=false` disables it.
- Unattended execution exists only for Demo investment plans, only with `AUTOMATION_DEMO_ENABLED=true`, and goes through the same validation and policy. Live plans cannot be marked for unattended runs; this is enforced in code.

These controls reduce accidental execution risk; they do not eliminate market, broker, API or operational risk.

## Threat model and known limits

Read this before connecting a Live account. It describes where each safeguard is actually enforced.

- **The connection password is the key to the instance.** Anyone who completes the OAuth login with `APP_LOGIN_PASSWORD` receives tokens for every tool, including Live trading if Live credentials are configured. Use a long random password (`pnpm setup` generates one) and never reuse it.
- **"App-only" tools are hidden by the host, not locked by the server.** `app_prepare_order`, `app_execute_order`, and the cancellation tools are marked `visibility: ["app"]`, so a compliant host such as ChatGPT keeps them away from the model and only the widget calls them after a click. The server itself only checks that the caller holds a valid `trade:write` token. A client that holds such a token can call these tools directly, so the human-confirmation step protects against the model acting on its own, not against a stolen token.
- **Limit what a token can do.** If you only want portfolio views, create the Trading 212 API key without order permissions. MCP clients that let you choose scopes can request only `trade:read`, in which case the write tools are not registered at all. Starting with Demo-only credentials is the safest way to try the project.
- **Tokens cannot be revoked one by one.** Access and refresh tokens are signed JWTs with no server-side session list. To cut off every connected client (for example after a password leak), rotate `AUTH_SIGNING_SECRET` and `APP_LOGIN_PASSWORD`, redeploy, and reconnect ChatGPT. Refresh tokens otherwise stay valid for `REFRESH_TOKEN_TTL_SECONDS` (30 days by default).
- **Reference prices come from the caller.** Market-order sizing and the `MAX_ORDER_NOTIONAL` estimate use the `referencePrice` the model supplies, because the Trading 212 Public API has no quote endpoint. When Trading 212 reports a current price for a held position, the cap uses the higher of the two prices, so an understated reference price cannot slip past it. For an instrument you do not hold yet, the estimate is only as good as the supplied price; always read the quantity on the confirmation screen.
- **Policy settings come from the server, not the model.** No tool can change them. Whoever controls the deployment's environment variables controls the policy.
- **Plan sizing uses the last position price.** Unattended Demo runs size Market buys from the broker's last price for a holding. They cannot see the live quote, which is why this mode is limited to Demo.
- **Login throttling is instance-wide.** After 8 failed password attempts in 10 minutes, all logins are paused for the rest of that window, including yours. This protects the password but means an attacker who knows your URL can briefly delay a reconnect.
- **Dynamic client registration is open.** Any caller may register an OAuth client, which is what ChatGPT needs. Registrations are rate-limited and capped at 200; when the cap is reached, clients that never completed a login are removed first, so the client you actually use is kept.

## Local stdio and the Claude plugin

The stdio server has no OAuth layer: anyone who can start the process already holds the Trading 212 keys in its environment. The order-review, basket, plan-management and execution tools are not registered unless `TRADEPILOT_ALLOW_WRITES=true`, and Demo automation stays off without it. This is because a terminal host may not hide app-only tools from the model. If you enable writes, keep the host's per-call permission prompt for the execution tools. The plugin stores API keys in the system credential store, not in settings files.

## Deployment guidance

Recommended public deployment: Cloudflare Workers with Worker Secrets. Do not put credentials in `wrangler.jsonc` or source files.

For Node/VPS/Docker, inject credentials with environment variables or a private `.env.local` file that is never copied into a public image/repository.

## Reporting a vulnerability

Please do not open a public issue containing secrets, account details, exploit payloads against a live account, or personally identifying financial data.

Use GitHub's private security advisory/reporting feature for the repository when available, or contact the repository owner privately.

## Scope

This project is not a custody service and should not be deployed as a shared multi-user service without adding a separate identity, secret-isolation and per-user authorization architecture.
