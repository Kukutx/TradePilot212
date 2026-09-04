# Troubleshooting

## `pnpm doctor` says Trading 212 Demo/Live is missing

Open `.env.local` and make sure each configured environment has both values:

```env
T212_DEMO_API_KEY=...
T212_DEMO_API_SECRET=...

T212_LIVE_API_KEY=...
T212_LIVE_API_SECRET=...
```

A half-configured pair is rejected.

## Trading 212 returns 401/403

- Verify you generated the key for the correct Demo or Live environment.
- Verify the API secret was copied correctly.
- Check that the API key has the required read/order permissions.
- If the secret was lost, generate a new key/secret pair in Trading 212.

## `pnpm deploy` opens Cloudflare login

That is expected on the first deployment or after Cloudflare credentials expire. Complete the browser authorization and the script will continue.

## ChatGPT cannot connect to the MCP URL

Use the exact endpoint:

```text
https://<worker>.<workers-subdomain>.workers.dev/mcp
```

Check the Worker health endpoint in a browser:

```text
https://<worker>.<workers-subdomain>.workers.dev/health
```

It should return JSON with `ok: true`.

## OAuth page opens but does not return to ChatGPT

Make sure you are running the latest version of TradePilot 212 and redeploy:

```bash
git pull
pnpm install
pnpm deploy
```

Then remove/reconnect the custom App in ChatGPT if it cached an older OAuth registration.

## UI still looks like an older version after deployment

Reconnect or refresh the custom App in ChatGPT. The ChatGPT host can keep an already-rendered widget instance alive even after the Worker has been updated.

## `APP_LOGIN_PASSWORD` rejected

Use the value from your local `.env.local`. If you changed it locally, run `pnpm deploy` so the Cloudflare Worker secret is updated too.

## LIVE buttons are unavailable

Check all of the following:

- Live API key + secret are configured.
- The Trading 212 key has order permissions.
- The ChatGPT OAuth connection granted `trade:write`.
- You are viewing the LIVE environment.

## Order status becomes `unknown`

Do **not** immediately resubmit the order. An `unknown` status means Trading 212 may have received the write but the response was lost/ambiguous.

Refresh pending orders and account activity first. TradePilot intentionally does not retry ambiguous writes automatically.

## Cloudflare Worker name is already in use in your account

Use a custom name:

```bash
pnpm deploy -- --name=my-tradepilot
```

## Local ChatGPT testing

Use:

```bash
pnpm dev:chatgpt
```

This creates a temporary Cloudflare Quick Tunnel. The URL changes between runs; it is intended for development, not permanent hosting.
