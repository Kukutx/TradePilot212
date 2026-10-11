# Automation, policy and baskets

TradePilot automates in levels. Each level adds capability without weakening the one below it.

| Level | What happens | Who confirms | Environments |
|---|---|---|---|
| L0 | Scheduled **read-only** analysis: briefs, performance, allocation | Nobody needs to; nothing is sent | Demo and Live |
| L1 | **Broker-native** protective orders: Stop and Limit sells, Good-Till-Cancel, linked so a fill cancels the other | You, once, when placing them; Trading 212 triggers them | Demo and Live |
| L2 | **Standing plans** (dollar-cost averaging). When a plan is due, TradePilot announces it and builds the basket | You, once per run, in the widget | Demo and Live |
| L3 | **Unattended** execution of due plans | Nobody; the policy engine is the only gate | **Demo only**, opt-in |

Live never places an order unattended. That is enforced in code (`src/core/automation.ts`): a Live plan cannot be saved or updated with `autoExecute`, and the scheduler only executes plans whose environment is `demo` while `AUTOMATION_DEMO_ENABLED=true`.

The one unattended write the scheduler makes on Live is a **cancellation**: after one half of a linked stop-loss / take-profit pair fills, it cancels the other half (see below). That can only remove an order that would sell shares you no longer hold.

## Second confirmation for Live

A Live order or Live basket needs two explicit steps in the widget: tick "I understand this sends a real order with real money" and then press the red confirm button. The server enforces it too. `app_execute_order` and `app_execute_basket` refuse a Live token without `liveAcknowledged: true` (`LIVE_ACK_REQUIRED`). The token is left unused, so you can tick the box and confirm again. Demo orders keep the single confirmation.

Why L3 stops at Demo:

- Trading 212's Public API has no quote endpoint, so an unattended run can only size orders from the last price of a position you already hold. It cannot check the price it is about to pay.
- Market orders placed while a market is closed queue until the open and can fill at a gap price.
- A scheduler that misfires on real money cannot be undone. On Demo it is a safe way to see what a plan would have done.

## Policy engine

Every order path runs the same rules (`src/core/policy.ts`): single orders, baskets, and unattended Demo runs. A rule that blocks stops the order before a confirmation token is issued. The rules run again at execution, because the market can close or the daily budget can fill between review and confirmation.

| Variable | Default | Rule |
|---|---|---|
| `POLICY_APPLY_TO` | `live` | Which environments the rules below bind: `live`, `demo`, `both` or `none`. The other environment keeps only the per-order caps and broker checks. |
| `POLICY_MAX_POSITION_WEIGHT` | `0.25` | A buy may not take one instrument above this share of total account value. Skipped when the instrument is in another currency. |
| `POLICY_DAILY_ORDER_LIMIT` | `20` | Orders sent through TradePilot per environment per UTC day. |
| `POLICY_DAILY_NOTIONAL_LIMIT` | `0` (off) | Estimated value sent per UTC day. Only orders in the account currency count; others get a warning. |
| `POLICY_ALLOWED_TICKERS` | empty | When set, only these exact Trading 212 tickers may be traded. |
| `POLICY_BLOCKED_TICKERS` | empty | These tickers may never be traded. |
| `POLICY_ALLOWED_TYPES` | empty | When set, only these instrument types may be bought, for example `ETF`. Sells are always allowed. |
| `POLICY_MARKET_ORDERS_WHEN_CLOSED` | `false` | `false` blocks Market orders while the regular session is closed. Use a Limit order instead or wait for the open. |
| `POLICY_MAX_REFERENCE_AGE_SECONDS` | `0` (warn only) | Blocks a Market order whose reference price is older than this. |

`MAX_ORDER_NOTIONAL` and `MAX_ORDER_QUANTITY` still apply per order in every environment.

Ask the model to call `get_trading_policy` to see the rules in force and today's usage. The confirmation screen lists each rule's result as pass, warn, skip or block.

## Baskets: several orders, one confirmation

A basket is up to 20 orders reviewed and confirmed together.

1. The model opens a basket draft. It never sends anything. The draft comes from `plan_portfolio_rebalance`, `review_protective_orders`, `review_investment_plan` or `review_order_basket`.
2. You can remove legs, then press **Review**. The server validates every leg against one account snapshot, in order, with sells first. Later legs see the shares and cash that earlier legs use. The server then runs the policy for each leg and issues one short-lived token.
3. You confirm. The server re-checks everything, then sends the orders one at a time.
4. If a broker response is uncertain (a timeout or 5xx after a write), the remaining orders are **not sent**. The uncertain order gets a verification record, the same as a single order. Rejected orders do not stop the rest. Nothing is retried.

Protective baskets are the exception to cumulative checks. A stop-loss and a take-profit cover the same shares, so each is checked against the whole position.

## Rebalancing

`plan_portfolio_rebalance` takes target weights as shares of total account value. It returns the smallest set of trades that moves the account toward them:

- Overweight holdings are sold first, which funds the buys.
- Buys share the cash above an optional `cashWeight` reserve, in proportion to how far each is below its target. When cash is short they are scaled down, and the plan says so.
- Trades smaller than `minTradeValue` are dropped. `wholeSharesOnly` disables fractional quantities.
- Holdings without a target are left alone unless `sellUntargeted` is set.
- An instrument you do not hold needs a `referencePrice`. An instrument quoted in another currency needs an `fxRates` entry. Otherwise it is listed under `skipped` with the reason.

The math is pure and tested (`src/core/rebalance.ts`), so the model never computes order sizes in its head.

## Protective orders (L1)

`review_protective_orders` drafts a **Stop** sell below the current price, a **Limit** sell above it, or both, as Good-Till-Cancel orders. After you confirm, they live at Trading 212, which triggers them without TradePilot.

- Trading 212 has no one-cancels-other order, so TradePilot **links the pair** itself (`src/core/protective-links.ts`). Every scheduler tick (once a minute) reads the order book. When one half has left it, the tick reads recent order history:
  - **filled** (fully or partly): the other half is cancelled, once. An unclear cancel result is logged, never retried;
  - **cancelled, rejected or expired without a fill:** the link is dropped and the other half stays;
  - **not in history yet:** the tick waits for the next one.
- Between a fill and the next tick (up to about a minute) both orders exist. A fast market can fill the second in that window. If Trading 212 already reserved the shares for the first order, it rejects the second order when the pair is placed, and only the first one is placed.
- Set `PROTECTIVE_OCO=false` to place unlinked orders.
- A triggered Stop becomes a Market order and can fill below the stop price on a gap.

## Standing plans (L2 and L3)

`manage_investment_plans` creates, updates, pauses and deletes plans. A plan lists up to 10 legs, each a ticker and an amount in the account currency. It runs weekly on a weekday or monthly on a day from 1 to 28, at an hour in UTC (default 15:00, which falls inside both the US and the main EU sessions). Saving a plan places no order. `list_investment_plans` shows each plan's next due time and last outcome.

A scheduler tick runs every minute: a Cron Trigger on Cloudflare, or an interval in the Node and stdio servers. It first settles linked protective orders, then handles plans that are due, then checks price alerts:

- **A due Live plan, or a Demo plan without `autoExecute`:** the tick writes one `plan_due` activity event for that due date. Open the plan with `review_investment_plan` (or ask "run my monthly plan") and confirm the basket as usual. The plan moves to its next date once a run sends at least one order.
- **A due Demo plan with `autoExecute` while `AUTOMATION_DEMO_ENABLED=true`:** the tick builds the basket, runs the full validation and policy, and sends it. A short lock stops overlapping ticks from sending twice.
- **A due plan blocked by the policy**, for example because the market is closed: the plan stays due and is tried at the next tick. The reason is logged once per due date.

Orders are sized from each holding's last broker price and floored to four decimals. A leg you do not hold yet, or one quoted in another currency, is skipped with a note. Buy it once manually first.

Each leg is a Market buy by default. Set `orderType: "limit"` to send a Day Limit buy at the last price plus `limitOffsetPercent` (default 0.5, at most 10), sized at the limit so it never spends more than the leg amount. A limit leg cannot fill at a gap price, so it may be placed while the market is closed and unattended Demo runs do not have to wait for the session. If the price runs away, the order expires at the end of the day and the plan moves on to its next date.

With the policy defaults on Live, closed-market Market orders are blocked. Pick an `hourUtc` inside your instruments' regular session, or use limit legs.

### Turning on Demo automation

```bash
# Cloudflare
npx wrangler secret put AUTOMATION_DEMO_ENABLED   # true
# Node / Docker / stdio
AUTOMATION_DEMO_ENABLED=true
```

The stdio server also needs `TRADEPILOT_ALLOW_WRITES=true`. Without it, Demo automation stays off even when the variable is set.

## Price alerts

`manage_price_alerts` creates, deletes and re-arms alerts on holdings; `list_price_alerts` shows them with the last price seen. Every scheduler tick reads positions once per environment and checks each armed alert:

| Condition | Fires when |
|---|---|
| `above` / `below` | the last price is at or above / at or below `price` |
| `trailing_drop` | the price falls `percent` from the highest price seen since the alert was armed (a trailing-stop warning) |
| `gain_percent` / `loss_percent` | the price is `percent` above / below the position's average cost |

A triggered alert writes one `price_alert_triggered` activity event, goes to the webhook, and stays triggered until you re-arm it. Alerts never place or cancel orders. Trading 212 has no quote endpoint, so only held instruments have a price, and the price is the broker's last position price, checked once a minute.

## Notifications

Set `NOTIFY_WEBHOOK_URL` to an HTTPS endpoint to be told outside the chat. Each notable activity event is posted as JSON with `text` (Slack, Mattermost), `content` (Discord) and the raw `event`. By default these types are sent: `order_submitted`, `order_status_unknown`, `cancel_status_unknown`, `basket_submitted`, `plan_due`, `plan_auto_executed`, `plan_skipped`, `protective_sibling_cancelled`, `pie_submitted`, `pie_status_unknown` and `price_alert_triggered`. `NOTIFY_EVENTS` replaces that list. With `NOTIFY_WEBHOOK_SECRET`, each request carries `X-TradePilot-Signature: sha256=<HMAC of the body>`. Delivery is best effort with a 5-second timeout and no retries.

## Scheduled research (L0)

Research and market news still belong to a scheduled ChatGPT or Claude task, not the server. Here is a prompt for that task:

```text
Prepare my Trading 212 Invest decision brief. Read the current TradePilot 212 portfolio, allocation and pending orders first, and list any investment plans that are due. Research current market conditions, material company news, earnings or catalysts, and major risks using fresh sources. Reassess existing positions and consider new opportunities. Separate actionable ideas into short (<=1 week), medium (<=1 month), and long (>=1 year). It is valid to recommend no trade. For each candidate provide buy/sell/watch, a 0-100 score, risk level, a concise rationale, the key thesis, catalysts, risks, a counter-case when relevant, source references, analysis timestamp, and a current reference price with its timestamp when actionable. Render the final candidates with the TradePilot trade-plan UI. Do not place or confirm an order.
```

## What is never automated

- Live order submission, cancellation, or confirmation.
- Retrying a failed or uncertain broker write, on any environment.
- Changing the policy. It comes from server configuration, not from the model.
