# Try TradePilot

Three ways to check that TradePilot works for you, from quickest to most complete. None of them touches a real-money account.

| | Needs | You see |
|---|---|---|
| [1. Sample data](#1-sample-data-no-account) | Claude Code and Node 22+ | Every tool, on a simulated account |
| [2. Your Demo account](#2-your-trading-212-demo-account) | A Trading 212 practice-account API key | Your own Demo holdings and history; orders go to the practice account |
| [Local UI preview](#preview-the-ui-locally) | A clone and Node 22+ | The real widget in your browser, on the sample account or your Demo account |
| [3. The full UI](#3-the-full-ui-in-chatgpt-or-claude) | A deployed Worker (free Cloudflare plan) | The dashboard, charts and confirmation screens in ChatGPT or Claude |

## 1. Sample data (no account)

TradePilot has a built-in sample account: EUR cash, five holdings in USD, GBX and EUR, two pies, a year of trades, dividends and deposits, one pending limit order, and two more instruments to watch (Amazon and ASML). Its instruments get simulated quotes, so the watchlist and the price charts work offline. Market orders fill at once against it; other orders stay pending until you cancel them. Live is switched off and nothing is sent to Trading 212.

In Claude Code:

```text
/plugin marketplace add Kukutx/TradePilot212
/plugin install tradepilot212@tradepilot212
```

When the options appear, turn on **Try with sample data**, and turn on **Enable order tools** if you also want to try orders. You can change options later under `/plugin` → Installed → Configure options.

Then ask, for example:

- "Show my portfolio dashboard."
- "How has my portfolio performed this year, and what income did it pay?"
- "Check my allocation for concentration risk."
- "Plan a rebalance to 30% Apple, 30% Microsoft, 20% NVIDIA and 20% VUSA."
- "Set a stop-loss at 110 and a take-profit at 150 on NVIDIA."
- "Create a monthly plan: 200 EUR into VUSA on the 5th."
- "Alert me if Apple falls below 210."
- "Buy 2 Apple." (with order tools on; Claude Code asks before each order)

Claude Code shows the results as text. To see the visual dashboard, use the [local preview](#preview-the-ui-locally) or an MCP Apps host (step 3).

From a clone instead of the plugin:

```bash
pnpm install
TRADEPILOT_SAMPLE_DATA=true pnpm stdio
```

Sample data lives in memory, so it starts fresh each time the server starts. Plans, alerts, the watchlist and the activity log are kept in the data directory as usual.

## 2. Your Trading 212 Demo account

A Demo (practice) account uses virtual money, so orders there are safe to try.

1. In the Trading 212 app or website, switch to your **Practice** account.
2. Open **Settings → API (Beta)** and generate a key. Allow the permissions you want to try: account data, portfolio, history and metadata for read-only use; orders and pies to place orders. Copy the secret, as it is shown only once.
3. In Claude Code, open `/plugin` → Installed → tradepilot212 → Configure options. Turn **Try with sample data** off and paste the **Demo API key** and **secret**. Leave the Live fields empty.
4. Ask for your dashboard. If something fails, `pnpm doctor` in a clone (with the same keys in `.env.local`) checks each setting and the connection.

Orders on the Demo account still need your confirmation each time, unless you turn on **Run Demo plans unattended** for investment plans marked `autoExecute`.

## Preview the UI locally

`pnpm preview` opens the widget exactly as ChatGPT or Claude would show it, in your browser, without deploying anything:

```bash
pnpm install
pnpm preview            # sample account
pnpm preview --demo     # your Demo keys from .env.local
```

Open http://127.0.0.1:4212. Pick a view (dashboard, allocation, performance, income, an order, a cancellation, rebalance, protective orders, a basket, pies, automation), and switch the language, light or dark theme and phone, tablet or desktop width in the header. Each view also shows the text the model would read and the calls the widget made.

The preview listens on 127.0.0.1 only and needs a per-run token for every call. `--demo` uses only your Demo keys: Live is switched off, Demo automation and webhooks are off, and orders still need your confirmation in the widget.

## 3. The full UI in ChatGPT or Claude

The dashboard, charts, order review and confirmation screens render in hosts that support MCP Apps, such as ChatGPT (developer mode) and Claude on the web, desktop and mobile. These connect to a URL, so TradePilot runs as your own Cloudflare Worker:

1. Follow [Setup](../README.md#setup) in the README to configure and deploy. Set `TRADEPILOT_SAMPLE_DATA=true` if you want to start without Trading 212 keys. On a Worker, sample orders can reset between requests, so use your Demo keys for anything beyond a look around.
2. Add the Worker's `/mcp` URL as a custom connector and sign in with your `APP_LOGIN_PASSWORD`.
3. Ask for your dashboard and try the views: holdings, allocation, performance and income tabs, the order editor, rebalance and protective-order baskets, pies, and the automation page.

## What to check

- Numbers match the Trading 212 app for the same account (Demo keys).
- The Demo / Live switch shows which account you are on; Live stays unavailable until you add Live keys.
- Every order opens a review first and is only sent after you confirm it.
- The language follows your host (English or Chinese) and can be switched in the header.

When you are happy with Demo, add Live keys only if you want TradePilot on your real account. Read [Security notes](../README.md#security-notes) first. Live orders always need your confirmation.
