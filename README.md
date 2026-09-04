# TradePilot 212

[中文](./README.zh-CN.md) · English

Self-hosted Trading 212 MCP / ChatGPT App for **one user per deployment**. It gives ChatGPT a clean Demo/Live portfolio UI and lets the user review orders with explicit human confirmation.

> **You own the server and the credentials.** Each person deploys their own instance and uses their own Trading 212 API keys. This project is not a shared brokerage SaaS.

## Highlights

- Trading 212 Invest account, positions and pending orders
- DEMO / LIVE switching with separate credentials
- Short / medium / long trade-plan cards for ChatGPT
- Human review before every order or cancellation
- No automatic retry for Trading 212 write requests
- OAuth + PKCE for the ChatGPT connection
- Responsive ChatGPT App UI with inline/fullscreen layouts
- English + Simplified Chinese, with an extensible locale registry
- One core codebase for Node.js, Docker/VPS and Cloudflare Workers
- Cloudflare Durable Object state for atomic one-time confirmation tokens

## Recommended setup: Cloudflare Workers

This is the easiest self-hosted path. For normal personal use it is designed to work on the Cloudflare Workers Free plan, so you do not need a VPS or a domain.

### 1. Requirements

- Node.js 22+
- pnpm 11+
- A free Cloudflare account
- A Trading 212 Invest account with Public API access
- ChatGPT with custom Apps / MCP support

If pnpm is not installed:

```bash
npm install -g pnpm@11
```

### 2. Clone and install

```bash
git clone https://github.com/Kukutx/TradePilot212.git
cd TradePilot212
pnpm install
```

### 3. Create your private config

```bash
pnpm setup
```

This creates `.env.local` and automatically generates strong values for:

- `APP_LOGIN_PASSWORD`
- `AUTH_SIGNING_SECRET`

Now open `.env.local` and paste your Trading 212 credentials.

```env
T212_DEMO_API_KEY=
T212_DEMO_API_SECRET=

T212_LIVE_API_KEY=
T212_LIVE_API_SECRET=
```

You may configure only Demo, only Live, or both.

### 4. Get Trading 212 API credentials

Official guide:

- https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key
- https://docs.trading212.com/

In Trading 212, go to **Settings → API (Beta) → Generate API key**. Demo and Live use separate credentials, so create each environment you want to use.

For dashboard-only use, read permissions are enough. For the order buttons, also enable the permissions needed to create/cancel orders.

Never commit or share the API key/secret.

### 5. Verify everything before deployment

```bash
pnpm doctor
```

This performs safe read-only checks and tells you whether Demo/Live can connect. It does not place an order.

### 6. Deploy

```bash
pnpm deploy
```

The script will:

1. run the project checks,
2. open Cloudflare login if needed,
3. upload your private values as Worker secrets,
4. deploy the Worker,
5. print your public App and MCP URLs.

Example:

```text
App: https://tradepilot212.<your-subdomain>.workers.dev
MCP: https://tradepilot212.<your-subdomain>.workers.dev/mcp
```

To validate deployment without publishing:

```bash
pnpm deploy -- --dry-run
```

To use a different Worker name:

```bash
pnpm deploy -- --name=my-tradepilot
```

### 7. Connect it to ChatGPT

In ChatGPT:

1. Open **Settings → Apps**.
2. Enable **Developer mode / Advanced settings** if needed.
3. Create a custom App / MCP connection.
4. Name it `TradePilot 212`.
5. Use the MCP URL printed by `pnpm deploy`.
6. Connect.
7. On the TradePilot authorization page, enter the `APP_LOGIN_PASSWORD` stored in `.env.local`.

Then try:

```text
Open my Trading 212 Demo portfolio.
```

or:

```text
Open my Trading 212 Live portfolio.
```

**LIVE uses real funds.** TradePilot intentionally keeps final execution behind a separate confirmation action.

## Local development

### Node.js

```bash
pnpm setup
# fill .env.local
pnpm doctor
pnpm dev
```

Local endpoint:

```text
http://localhost:8000/mcp
```

### Local Node + temporary public URL

For development/testing with ChatGPT:

```bash
pnpm dev:chatgpt
```

This uses a Cloudflare Quick Tunnel. The temporary URL can change when restarted, so use the Worker deployment for normal always-online use.

### Local Cloudflare runtime

```bash
cp .dev.vars.example .dev.vars
# fill .dev.vars
pnpm dev:cloudflare
```

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm setup` | Create `.env.local` and generate strong OAuth secrets |
| `pnpm doctor` | Safe read-only environment + Trading 212 connectivity check |
| `pnpm dev` | Run the Node development server |
| `pnpm dev:chatgpt` | Node + temporary Cloudflare tunnel |
| `pnpm dev:cloudflare` | Run with the local Workers runtime |
| `pnpm deploy` | Validate, sync secrets and deploy your personal Worker |
| `pnpm check` | Types + tests + production builds |
| `pnpm smoke` | OAuth + PKCE + MCP smoke test |
| `pnpm release:check` | Check publishable files for accidental local credential leakage |

## Security model

TradePilot is intentionally **single-user / single-instance**:

```text
Your ChatGPT
    ↓
Your TradePilot Worker
    ↓
Your Trading 212 API keys
    ↓
Your Trading 212 account
```

A second user should deploy a second Worker with their own credentials.

Important safeguards:

- secrets stay in `.env.local` locally and Cloudflare Worker secrets online,
- `.env.local`, `.dev.vars` and runtime state are ignored by Git,
- order/cancel confirmation tokens are short-lived and one-time,
- writes are never automatically retried when execution status is uncertain,
- Live is clearly separated from Demo,
- server-side quantity/notional checks run before submission.

See [SECURITY.md](./SECURITY.md) for details.

## Internationalization

The UI currently includes:

- English (`en`)
- Simplified Chinese (`zh-CN`)

The ChatGPT widget follows the host locale by default and also has a manual language switch. The OAuth page supports the same languages.

Adding another language does not require changing trading logic. See [docs/I18N.md](./docs/I18N.md).

## Architecture

```text
src/
├─ adapters/
│  ├─ node/            # Local / VPS / Docker
│  └─ cloudflare/      # Workers + Durable Object + Static Assets
├─ app/                # Shared HTTP / MCP application
├─ core/               # OAuth, MCP, Trading 212, risk rules, state interfaces
├─ shared/             # Contracts and app metadata
└─ ui/
   ├─ i18n/            # Locale dictionaries
   ├─ App.tsx          # ChatGPT App UI
   └─ styles.css
```

Runtime-specific code stays in adapters; business and safety logic is shared.

## Documentation

- [Chinese setup guide](./README.zh-CN.md)
- [Internationalization](./docs/I18N.md)
- [Publishing / self-host model](./docs/PUBLISHING.md)
- [Security](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## Disclaimer

This project is a self-hosted software tool, not investment advice. Review all market information and every order yourself. Trading can result in financial loss. Trading 212 API availability, permissions and limits are controlled by Trading 212 and may change.

## License

MIT — see [LICENSE](./LICENSE).
