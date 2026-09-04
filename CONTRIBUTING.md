# Contributing

Thanks for improving TradePilot 212.

## Principles

Please keep the project:

- self-hosted by default,
- single-user per deployment,
- runtime-neutral in `src/core`,
- explicit about Demo vs Live,
- human-confirmed for trading writes,
- easy to run on Node and Cloudflare Workers,
- internationalization-friendly.

Do not add hidden auto-trading behavior, silent write retries, shared credentials, or platform-specific dependencies inside core business logic.

## Development

```bash
pnpm install
pnpm setup
pnpm check
pnpm smoke
```

Use Demo credentials for testing whenever possible.

## Before a pull request

Run:

```bash
pnpm check
pnpm smoke
pnpm release:check
pnpm audit --prod
pnpm deploy -- --dry-run
```

Never include `.env.local`, `.dev.vars`, account information, screenshots containing private financial data, or API credentials in a pull request.

## UI / i18n changes

All user-facing widget text should go through `src/ui/i18n`. English is the source key set. New locales should implement all keys and be registered in `src/ui/i18n/index.ts`.

## Runtime changes

Keep runtime-specific behavior in `src/adapters/*`. The core should remain portable across Node and Web-standard runtimes.
