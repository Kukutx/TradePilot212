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

## Trading 212 API changes

`docs/api/trading212-public-api-v0.json` records what Trading 212's OpenAPI document (https://docs.trading212.com/_bundle/api.json) lists: every operation with its query parameters and documented rate limit, the fields of the responses TradePilot reads (the pies' not yet) and of every request body, and the enums it relies on. `pnpm check:api` (also part of `pnpm check`) runs the client against the sample account offline, following every history page, and checks the pie and report bodies TradePilot builds. It fails when the client calls an operation the document does not have, leaves one out, sends a parameter or body field it does not list, or when the sample account answers with a field it does not list. When Trading 212 changes the API, update the file from the document (and its `readOn` date) first; the failures then say what to change.

## UI / i18n changes

After a change to the widget, run `pnpm audit:ui` (it needs Playwright with Chromium: `pnpm add -D playwright && pnpm exec playwright install chromium`, or one already on the machine). It opens every view of the preview at each host width, theme and language, with everything folded opened too, and after each choice of every switch and tab list, and fails on sideways scrolling, boxes past the edge, text cut off with nothing showing the rest, text under 12px, low contrast, a control with no focus ring or focused out of view, controls under 24px, controls left with the browser's own look, broken images, failed requests and script errors. It exits 1 on problems and 2 when it could not check. `--views`, `--widths`, `--themes` and `--langs` narrow it; `--shots=<folder>` saves pictures of each to look over. Do not build the widget while it runs: the preview serves the built file.

All user-facing widget text should go through `src/ui/i18n`. English is the source key set. New locales should implement all keys and be registered in `src/ui/i18n/index.ts`.

## Runtime changes

Keep runtime-specific behavior in `src/adapters/*`. The core should remain portable across Node and Web-standard runtimes.
