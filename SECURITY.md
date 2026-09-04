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
- Live orders require explicit user confirmation in the UI.
- Confirmation tokens are short-lived and one-time.
- Trading 212 write requests are never automatically retried after an ambiguous network/write failure.
- Unknown write outcomes can be checked through a read-only verification flow; verification never resubmits the original write.
- The server revalidates order constraints before submission.
- Recent activity stores order/cancellation metadata only and does not contain API credentials or confirmation secrets.
- Server-side quantity and notional caps are configurable per self-hosted instance; positive values are enforced before submission. Setting a cap to `0` deliberately disables only that app-level cap.

These controls reduce accidental execution risk; they do not eliminate market, broker, API or operational risk.

## Deployment guidance

Recommended public deployment: Cloudflare Workers with Worker Secrets. Do not put credentials in `wrangler.jsonc` or source files.

For Node/VPS/Docker, inject credentials with environment variables or a private `.env.local` file that is never copied into a public image/repository.

## Reporting a vulnerability

Please do not open a public issue containing secrets, account details, exploit payloads against a live account, or personally identifying financial data.

Use GitHub's private security advisory/reporting feature for the repository when available, or contact the repository owner privately.

## Scope

This project is not a custody service and should not be deployed as a shared multi-user service without adding a separate identity, secret-isolation and per-user authorization architecture.
