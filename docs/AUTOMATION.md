# Automation, policy and baskets

English · [简体中文](./zh-CN/AUTOMATION.md)

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
| `POLICY_MAX_POSITION_WEIGHT` | `0.25` | A buy may not take one instrument above this share of total account value. An order in another currency is converted at the rate implied by your holdings or the quote source's rate; the rule is skipped when no rate is known. |
| `POLICY_DAILY_ORDER_LIMIT` | `20` | Orders sent through TradePilot per environment per day, in `TIMEZONE` (UTC without one). |
| `POLICY_DAILY_NOTIONAL_LIMIT` | `0` (off) | Estimated value sent per day (in `TIMEZONE`, UTC without one), in the account currency. Orders in another currency count at the rate implied by your holdings or the quote source's rate; one with no known rate gets a warning and is not counted. |
| `POLICY_ALLOWED_TICKERS` | empty | When set, only these exact Trading 212 tickers may be traded. |
| `POLICY_BLOCKED_TICKERS` | empty | These tickers may never be traded. |
| `POLICY_ALLOWED_TYPES` | empty | When set, only these instrument types may be bought, for example `ETF`. Sells are always allowed. |
| `POLICY_MARKET_ORDERS_WHEN_CLOSED` | `false` | `false` blocks Market orders while the regular session is closed. Use a Limit order instead or wait for the open. |
| `POLICY_MAX_REFERENCE_AGE_SECONDS` | `0` (warn only) | Blocks a Market order whose reference price is older than this. |

`MAX_ORDER_NOTIONAL` and `MAX_ORDER_QUANTITY` still apply per order in every environment. `MAX_ORDER_NOTIONAL` is in the account currency.

Ask the model to call `get_trading_policy` to see the rules in force and today's usage. The confirmation screen lists each rule's result as pass, warn, skip or block.

## Baskets: several orders, one confirmation

A basket is up to 20 orders reviewed and confirmed together.

1. The model opens a basket draft. It never sends anything. The draft comes from `plan_portfolio_rebalance`, `review_protective_orders`, `review_portfolio_stops`, `review_investment_plan` or `review_order_basket`.
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
- With `band`, only the targets more than that share of the account off their weight are traded (`0.05` is 5 points); the rest are left as they are, and a note says how many (targets skipped for want of a price count among them). Sells of those over it fund buys of those under it, with any cash above the reserve. When the cash would then stay more than the band above its target, so that it would be off target itself, it goes to the targets within the band below their weight, as `buyOnly` puts it, and a note says how much. This is tolerance-band rebalancing: fewer trades and fees, at the cost of leaving small drifts. Holdings without a target, with `sellUntargeted`, are sold only when their whole weight is over the band. `band` is ignored with `buyOnly`.
- With `buyOnly`, nothing is sold. Only the cash above the reserve is invested, in the targets below their weight and most in the furthest below; overweight holdings stay as they are. `investAmount` caps the amount (and implies `buyOnly`), for example to invest a deposit and no more. When less cash is free than asked, the plan says so.
- An instrument you do not hold is priced from the external quote source when it can map it; otherwise it needs a `referencePrice` (add `referencePriceAt` so the review can check its age). An instrument quoted in another currency is converted at the rate implied by a holding in that currency (pence and pounds at 100:1), else at the quote source's rate; with neither it needs an `fxRates` entry. Otherwise it is listed under `skipped` with the reason.

- `totals` gives what the buys and the sells come to in the account currency, the part traded in another currency than the account's (pence count as pounds), and Trading 212's currency conversion fee on that part, `FX_FEE_RATE` (default `0.0015`, the 0.15% Trading 212 charges on Invest and ISA accounts). A note says it too, and the basket's summary shows **Buys**, **Sells** and **FX fee, at most**. The fee comes off a sell's proceeds and on top of a buy, so the buys leave room for it (an `investAmount` includes it) and the cash after is net of it: a plan that spends all the free cash does not run short at its last order. It is at most that: a trade paid from, or into, a balance held in the instrument's own currency converts nothing. Set `FX_FEE_RATE=0` if you keep such balances for every currency you trade.

The math is pure and tested (`src/core/rebalance.ts`), so the model never computes order sizes in its head.

### Saved targets and drift notices

`manage_target_allocation` saves target weights for an environment (`set`), shows them with today's drift (`get`) and removes them (`clear`). In the widget, the Allocation tab sets them too: **Set targets** (or **Edit targets** beside their drift) opens a form with a share for each holding, and for saved targets not held, typed in or filled from today's weights, equal weights (sharing what the cash leaves) or the [equal-risk weights](./ANALYTICS.md#equal-risk-weights) (the holdings measured move among themselves; the others and the cash keep today's shares). The form takes the cash share (left empty, whatever the targets leave), the notice threshold in points and whether a rebalance sells holdings without a target, and says what the targets and cash come to; an empty share, or 0, is no target. It checks the shares as the server keeps them, to 0.01%, so what it accepts is saved. A target list takes 20 holdings: with more, the presets fill the 20 largest (for the equal-risk weights, the 20 furthest from them, as their plan moves) and leave the others without a target, which says whether they then stay or a rebalance sells them. **Use as targets** under the equal-risk weights opens it filled with them, as shares of the whole account. With [risk by holding](./ANALYTICS.md#risk-by-holding), the form works out as you type what volatility a year the targets would give, beside today's: the holdings measured together, and the whole account with cash counted as not moving when every holding and target with a share is measured, and under each holding its share of the risk now and at the targets (a holding without a target counts at today's share, or none when a rebalance sells it). Below the holdings, a search adds an instrument you don't hold yet as a target (up to 20 of them), and a target not held has a button that takes it out of the form; equal weights share what the cash leaves among these too, and they come first when there are more than 20. Their closes are read beside the holdings', over the same weeks, so they count in the risk at the targets; while an added one is read the figures stay and say so, one whose closes weren't read this time counts after a **Refresh**, and one without closes over those weeks is named and left out. When the holdings kept without a target, with the targets and the cash, come to more than the account, the form says a rebalance can't reach every target, and gives no whole-account figure. It reads the holdings' covariance as it opens, through the app-only `app_get_holding_covariance`, for the holdings and the weeks risk by holding on screen measured, with the targets not held in the form beside them, and works the rest out in the widget; when what it reads doesn't match the risk on screen (the holdings measured changed since, or closes are still on their way), it asks for a **Refresh**. Saving reads the allocation again, so the drift shows at once; **Remove targets** clears them on a second press. Weights are shares of total account value; `cashWeight` is the share meant to stay in cash and defaults to whatever the targets leave over. `sellUntargeted` says whether a rebalance to these targets sells holdings that have none (default: they are kept, and then they do not count as drift). Once targets are saved:

- `analyze_portfolio_allocation` and the widget's Allocation tab show each target and cash against today's weight, with the drift in percentage points. Holdings without a target are listed; they count toward the drift only when `sellUntargeted` is set. With risk by holding, `drift.volatility` gives the volatility a year at the targets beside today's: `now` and `atTargets` for the holdings measured together, `account` for the whole account (cash counted as not moving) when every holding and target with a weight is measured and the targets, the holdings kept beside them and the cash target come to no more than the account, and `leftOut` for those that are not measured. `manage_target_allocation` returns it too, so saving targets says what risk they take. It is past volatility, not a forecast.
- `drift.rebalance` gives what a rebalance to the targets would buy and sell, from the change in each weight times the account's value, with the conversion fee on the part in other currencies as in `totals` above; each drift row carries the instrument's `currency`. As the planner does, it leaves out changes under 1 in the account currency, counts holdings without a target only when `sellUntargeted` sells them, and fits the buys and their fee to the cash free above the cash target plus what the sells raise net of the fee; when that falls short, `buysScaled` gives the share of each buy it pays for (0 when there is nothing to buy with). Changes within the 0.01% a target is kept to are rounding, not a move, and are left out. The Allocation tab says it under the drift, and the target form says it for the weights typed as you type (its **Today's weights** fill each share to the nearest 0.01%, so they trade nothing). It is by value: whole shares can make the plan itself trade a little less.
- `drift.rebalanceOver` gives the same for a rebalance of only the targets more than `driftThreshold` off their weight, the ones the drift list marks, with holdings without a target when `sellUntargeted` sells them (`tickers`, largest drift first, and `totals`; `cashTo`, the targets within the threshold it buys with cash that would otherwise stay more than the threshold over its target), when it trades some of them and fewer than a rebalance to every target. The Allocation tab says it under the full estimate.
- `plan_portfolio_rebalance` without `targets` uses the saved ones, their cash weight and their `sellUntargeted` choice. In the widget, **Rebalance to targets** opens that plan as a basket to review, and **Rebalance what drifted** (shown with `drift.rebalanceOver`) the plan with `band` set to the threshold. When cash is above its target, **Invest spare cash** opens the buy-only version, which sells nothing. Nothing is sent until you confirm the basket.
- The scheduler compares the account with the targets about once an hour. While any target or cash is more than `driftThreshold` (default `0.05`, 5 points) away, it writes an `allocation_drift` activity event and sends it to the webhook, at most once a day.

Targets only inform; they never place orders, so they work without order tools.

## Protective orders (L1)

`review_protective_orders` drafts a **Stop** sell below the current price, a **Limit** sell above it, or both, as Good-Till-Cancel orders. After you confirm, they live at Trading 212, which triggers them without TradePilot.

- Trading 212 has no one-cancels-other order, so TradePilot **links the pair** itself (`src/core/protective-links.ts`). Every scheduler tick (once a minute) reads the order book. When one half has left it, the tick reads recent order history:
  - **filled completely:** the other half is cancelled. A cancel that fails or ends unclear is tried again on the next ticks (cancelling twice is harmless), up to five times; then the link is dropped and a `protective_attention` event asks you to cancel it in Trading 212. An order that is already gone counts as cancelled;
  - **filled partly**, then closed: the other half still covers the original quantity, so it is left open, the link is dropped and a `protective_attention` event asks you to adjust it to what you hold;
  - **cancelled, rejected or expired without a fill:** the link is dropped and the other half stays;
  - **not in history yet:** the tick waits for the next one.
- Between a fill and the next tick (up to about a minute) both orders exist. A fast market can fill the second in that window. If Trading 212 already reserved the shares for the first order, it rejects the second order when the pair is placed, and only the first one is placed.
- Set `PROTECTIVE_OCO=false` to place unlinked orders.
- A triggered Stop becomes a Market order and can fill below the stop price on a gap.

`review_portfolio_stops` covers the whole portfolio at once. It drafts one Good-Till-Cancel Stop sell for each holding whose shares free to sell no pending sell stop covers yet. All of them open as one basket that you confirm once.
- A holding that already has a stop below the price gets the same stop price for its uncovered shares, so the whole holding triggers together.
- The others start `dropPercent` (default 8) below the last price.
- `tickers` limits the basket to some holdings. The largest uncovered holdings come first, up to 20 orders.
- Shares that a take-profit or another sell already reserves are not free to sell, so they get no stop.

These stops are not linked to anything. The dashboard's holdings panel shows how many holdings are fully covered and the value left unprotected, and opens the same basket when order tools are on.

## Order fill notices

About every 5 minutes per environment, the scheduler reads the open orders and compares them with the previous check (`src/core/order-watch.ts`). When an order has left the book, it reads the recent order history once and writes one activity event for that order:

- `order_filled`: filled. The event gives the shares, the average fill price and the value in the account currency when the history includes them.
- `order_partly_filled`: partly filled before the rest was cancelled or expired.
- `order_closed`: closed without a fill (cancelled, rejected or expired).
- `order_outcome_unknown`: the order left the book, but after three checks the history still has no final entry for it (none at all, or only an earlier state such as new or partly filled). Check it in Trading 212.

The history can lag the order book, so an order whose history entry is missing or not final yet is checked again on the next checks. An order placed by value has no share count, so a cancellation, rejection or expiry after part of it filled counts as partly filled.

Fills and unclear outcomes are notified by default. `order_closed` stays in the activity log unless you add it to `NOTIFY_EVENTS`, because most of those are cancellations you made yourself. The widget's activity list shows each fill's shares, average price and value. The daily digest counts the fills of the last day, from a separate record that does not depend on how many events the activity log keeps.

This covers orders placed anywhere, the Trading 212 app included. It only reads: one order-book read per check, plus one history read when an order has left. An order that opens and fills between two checks, which is most Market orders, is not seen; its own result already says how it went. The first check after starting only records what is open. Set `ORDER_WATCH=false` to turn it off.

## Standing plans (L2 and L3)

`manage_investment_plans` creates, updates, pauses, skips a run of and deletes plans. A plan lists up to 10 legs, each a ticker and an amount in the account currency, or instead gives a `targetAmount` to invest across the [saved targets](#saved-targets-and-drift-notices). It runs every weekday (Monday to Friday), weekly on a weekday, every other week on a weekday (counted from its first run), or monthly on a day from 1 to 31 (a day past a month's end is its last day, so 31 is always the last day). It is due at an `hour` in its own `timeZone`, an IANA name such as Europe/London, with summer time followed: 09:00 in London stays 09:00 all year. Without either a new plan is due at 15:00 UTC, which falls inside both the US and the main EU sessions; an `hour` without a zone is in the server's `TIMEZONE`. Plans saved before 2.79 keep their UTC hour (`hourUtc` is still accepted, as an hour in UTC). `skip` leaves out the next run, or the run waiting for you, and the plan is due on the one after. Saving a plan places no order. `list_investment_plans` shows each plan's next due time and last outcome, and its latest runs (the last 12, from 2.87): when each ran, whether you confirmed it or the scheduler sent it unattended, how many of its orders went in, and the runs skipped or with nothing to buy. A run the scheduler holds back before building its orders (a closed market) is not one of them. One that sent nothing (its checks failed at sending, or a rule blocked every order) is listed once for its due date as stopped before sending, as the plan stays due and is tried again. On the Automation tab, **Last runs** under a plan lists them. The widget's Automation tab does the same where the account can be written to: **New plan** opens a form (the buys, or an amount by the targets; how often, the day, the hour and the time zone, the server's by default), and each plan has **Open orders now** (its basket at today's prices, to review and confirm), **Skip next**, **Pause** or **Resume**, **Change** and **Delete**. A change sends only what changed, so a plan whose buys alone changed keeps its due date.

A scheduler tick runs every minute: a Cron Trigger on Cloudflare, or an interval in the Node and stdio servers. It first settles linked protective orders, then reports how open orders ended, records the day's account value (about once an hour), handles plans that are due, checks price alerts and drift from saved targets, and sends the daily digest when one is due. Each step runs even when an earlier one fails, and a tick that is still running when the next one starts is joined rather than run twice:

- **A due Live plan, or a Demo plan without `autoExecute`:** the tick writes one `plan_due` activity event for that due date. Open the plan with `review_investment_plan` (or ask "run my monthly plan") and confirm the basket as usual. The plan moves to its next date once a run reaches the broker, whether the orders were accepted, rejected or unclear, so nothing is sent twice for one due date.
- **A due Demo plan with `autoExecute` while `AUTOMATION_DEMO_ENABLED=true`:** the tick builds the basket, runs the full validation and policy, and sends it. A short lock stops overlapping ticks from sending twice, and the plan is read again under the lock, so a plan you paused or changed meanwhile is not sent.
- **A due plan blocked before anything is sent**, by the policy, because the market is closed, or because the market hours could not be read this tick: the plan stays due and is tried again about every 10 minutes, when its run lock expires. The reason is logged once per due date.
- **An unattended run that reached the broker**, even with a rejected or unclear result: the plan moves to its next date and is never re-sent automatically. Check `lastOutcome` and the activity log.
- **An unattended run cut off before its result was recorded** (a crash or restart mid-send): the plan marks its due date before sending, so the next tick sees the mark, logs one `plan_due` event asking you to check Trading 212, and waits for you instead of sending again.

A plan with `targetAmount` works out its buys when it runs. Each target's goal is its share of the target weights applied to what the targets hold plus the new money; the money goes to the targets below their goal, in proportion to how far below they are. So the most underweight holdings get the most, and nothing is sold. Splits under 1 in the account currency stay in cash, and a plan with no saved targets is skipped with that reason. Its buys are Market orders and go through the same review, policy and confirmation as any other plan.

Changing a plan's day, weekday or hour schedules it from now, but a period that already ran is not run again because its time moved. Unpausing a plan whose due date passed while it was paused schedules the next date from now instead of running at once.

Orders are sized from each holding's last broker price and floored to four decimals. A leg you do not hold yet is priced from the external quote source (see below) and skipped with a note when it cannot be priced. A leg quoted in another currency is converted at the rate implied by a holding in that currency (pence and pounds at 100:1), else at the quote source's rate, and skipped with a note when no rate is known.

Running a plan before its due date counts as that run. Once the early run reaches the broker, the plan moves to the date after the one that was due, so the scheduled date does not buy again.

Each leg is a Market buy by default. Set `orderType: "limit"` to send a Day Limit buy at the last price plus `limitOffsetPercent` (default 0.5, at most 10), sized at the limit so it never spends more than the leg amount. A limit leg cannot fill at a gap price, so it may be placed while the market is closed and unattended Demo runs do not have to wait for the session. If the price runs away, the order expires at the end of the day and the plan moves on to its next date.

With the policy defaults on Live, closed-market Market orders are blocked. Pick an `hour` inside your instruments' regular session, or use limit legs.

### Turning on Demo automation

```bash
# Cloudflare
npx wrangler secret put AUTOMATION_DEMO_ENABLED   # true
# Node / Docker / stdio
AUTOMATION_DEMO_ENABLED=true
```

The stdio server also needs `TRADEPILOT_ALLOW_WRITES=true`. Without it, Demo automation stays off even when the variable is set.

## Price alerts

`manage_price_alerts` creates, deletes and re-arms price alerts, on holdings or on instruments the external quote source can price; `list_price_alerts` shows them with the last price seen. Every scheduler tick reads positions once per environment and checks each armed alert:

| Condition | Fires when |
|---|---|
| `above` / `below` | the last price is at or above / at or below `price` |
| `trailing_drop` | the price falls `percent` from the highest price seen since the alert was armed (a trailing-stop warning) |
| `gain_percent` / `loss_percent` | the price is `percent` above / below the position's average cost |
| `day_move` | the price is `percent` or more above or below its previous close: the day's move, as the dashboard shows it |

A day's-move alert fires at most once per trading day and arms itself again on the next one, so "tell me when Apple moves 3% in a day" keeps working without re-arming; it has no **Re-arm** button. The previous close and the trading day are the dashboard's: the quote provider's last daily close before the day of the price, the day taken from the exchange's schedule in Trading 212 (the pre-market counts toward the coming day only for a holding Trading 212 trades then; a quote is always the regular session's). A session that closed before the alert was set does not count, so one set on a weekend waits for Monday rather than reporting Friday, and once it has fired for a day only a later day counts. It waits, and says why, while Trading 212's exchange schedules cannot be read (it does not guess the day) and while the provider does not have the previous close yet, which happens when the next session starts within hours of the last close.

What it costs: while it waits for a move, it reads the price each minute like any other alert (a quote each minute for an instrument you do not hold), and it needs the quote provider's daily closes, read again every half hour until the previous close is one that will not change, then kept for the day in a long-running server. Once it has fired, it reads neither positions nor prices until the next trading day. On a plan with a small daily allowance, such as Alpha Vantage's free 25 requests, set day's-move alerts on holdings; one on an instrument you do not hold uses up that allowance within the hour.

In the widget, a holding's page has an **Add alert** form. It offers above or below a price and the day's move for any instrument, and trailing drop, loss and gain for a holding. The page and the automation overview have **Delete** on each alert and **Re-arm** on a triggered one, except a day's move. The price ladder on the holding page shows where each armed alert would fire (a day's move at both levels, once the previous close is known), and the automation overview gives a day's-move alert's last change from its close. A triggered alert writes one `price_alert_triggered` activity event, goes to the webhook, and stays triggered until you re-arm it (a day's move, until the next trading day). Alerts never place or cancel orders. Held instruments use the broker's last position price; others use the external quote source below. Prices are checked once a minute.

## Account alerts

`manage_account_alerts` creates, deletes and re-arms alerts on the account as a whole; `list_price_alerts` and the automation overview show them with the last value read. They suit what a price alert cannot say: that the account as a whole fell to a level, that dividends and interest have built up enough cash to invest, that cash is running low before a plan is due, or that the whole account had a big day.

| Condition | Fires when |
|---|---|
| `value_above` / `value_below` | the account's total value is at or above / at or below `amount`, in the account currency |
| `cash_above` / `cash_below` | the free cash (available to trade) is at or above / at or below `amount` |
| `day_move` | the holdings' move on their latest trading day is `percent` or more either way: the moves `get_portfolio_today` reads for that day, added up, against the holdings' value before them |

Value and cash come from Trading 212's account summary, read once per environment each scheduler tick (every minute), or taken from a read less than 30 seconds old; a waiting alert writes its last value at most every ten minutes. A day's move reads each holding's previous close and the day's fills, so an environment's day's-move alerts read it together, at most every ten minutes.

A day's move belongs to the latest trading day of the holdings with a move. Only the holdings whose move is from that day count: one still on the session before (on another exchange, before its open) is left out, so a big Monday is not reported again when Tuesday's first market opens. With every holding read on that day, the change is the one `get_portfolio_today` and the dashboard's day show; otherwise it is measured against what that day's movers were worth before it (shares sold on the day included) plus Trading 212's value now of the other holdings, taken as flat. A day only taken to be today because the exchange schedules could not be read is not used. The alert fires at most once for a trading day and arms itself again on the next; re-arming it by hand does not change that. A session that closed before the alert was set does not count (without the exchange schedules, one on an earlier UTC day), so one set on a weekend or after the close waits for the next session. When no holding has a move yet, the schedules or the holdings' value cannot be read, or the read fails, it waits and tries again ten minutes later.

A triggered alert writes one `account_alert_triggered` activity event (with the value and its currency, for value and cash), goes to the webhook, and stays triggered until you re-arm it (a day's move, until the next trading day). In the widget, the automation page has an **Account alerts** list with **Add alert**: its starting amount is 5% under or over the account's value now, half its free cash or twice it (at least 100), rounded to tens, or 2% for the day's move. Amounts can be typed with either separator: `10,000`, `10 000` and `1.250,50` all read as expected, a lone comma before three digits groups thousands, and the field says what it read once a separator is in it. At most 50. Alerts never place or cancel orders.

## Listing alerts

`manage_listing_alert` turns on, changes or turns off an account's listing alert: tell me when Trading 212 lists new instruments of these types (`STOCK`, `ETF`, …) in these currencies, or any when none are given. The watchlist's **New on Trading 212** panel turns it on for what the panel shows, changes it, or turns it off ([WATCHLIST.md](./WATCHLIST.md#new-on-trading-212)).

The scheduler reads the instrument list at most once an hour per account. An instrument is new when Trading 212 dates it (`addedOn`) in the last 14 days and the alert has not seen it before, so one dated a little earlier than the read that first lists it still counts; what is listed when the alert is turned on counts as seen. Each find writes one `new_listings` activity event naming what was added (cut short with how many more) and goes to the webhook. A read that fails is tried again on the next tick. One alert per account. It never places orders.

## Goal milestones

When the account has an investment goal (`manage_goal`, or the Performance tab's goal panel; [ANALYTICS.md](./ANALYTICS.md#investment-goal)), the scheduler measures it each time it records the account value, about once an hour, with no read of its own. When the value first reaches 25%, 50%, 75% or 100% of the target, it writes one `goal_milestone` activity event saying so, in `NOTIFY_LOCALE`'s language, and sends it to the webhook. The progress already made when a goal is set, or its target changed, is taken as known and not announced. A fall below a milestone is not announced, and the milestone is not said again when the value climbs back; a jump past two says the higher one. It never places orders.

## Quotes for instruments you do not hold

Trading 212's Public API has no quote endpoint; it only reports the last price of positions you hold. TradePilot fills the gap with a pluggable external quote source, used by `get_quote`, price alerts, the watchlist, the page of an instrument you do not hold, the benchmark on the Performance tab, plan legs you do not hold yet, and rebalance targets without a `referencePrice`. A held instrument always uses the broker's price. The sample account uses simulated quotes and exchange rates for its own instruments instead, with no network.

The same source draws the price chart on the holding page: the last year of daily closes, with your fills marked on it and the average cost, open stops and limits and armed alerts drawn across it. Stooq and Twelve Data give the year and Alpha Vantage's free plan the last 100 trading days, so the chart offers the ranges the closes cover; Finnhub's daily prices are not on its free plan. The Allocation tab's risk by holding reads the same year for each holding, largest first and five seconds at most, from Stooq or Twelve Data; Alpha Vantage's 100 days are too few for it, so it does not spend that plan's requests ([ANALYTICS.md](./ANALYTICS.md#risk-by-holding)). A chart is read again after half an hour, a failed read after a minute, and the page waits 3 seconds for the closes before it shows without them. When the closes end ten times or more from Trading 212's price either way (the last price, else the instrument's order and alert prices, else a hundredfold gap from the newest fill), they are taken to be in another unit and the page says so instead of drawing them, naming the mapping with the factor that fixes it; see the factor below. A refusal or a limit is reported in the provider's own words. The sample account draws a simulated path through its own fills.

The same source supplies exchange rates for currencies none of your holdings is priced in, so a first purchase in a new currency can be valued in the account currency (for `MAX_ORDER_NOTIONAL`, the policy rules and amount-based sizing). Stooq, Twelve Data and Alpha Vantage give rates; Finnhub's are not on its free plan. A rate implied by your holdings always wins, and the preview names the source and time of a quoted one.

| `QUOTE_PROVIDER` | Key | Notes |
|---|---|---|
| `stooq` (default) | none | Free, no account. Unofficial and best effort; prices may be delayed, and the service may change or block requests. |
| `finnhub` | free key in `QUOTE_API_KEY` | Real-time US quotes on the free tier; no exchange rates or daily history. |
| `twelvedata` | free key | Daily request limit on the free tier. |
| `alphavantage` | free key | Small daily limit (each holding page with a chart uses one); latest trading day's price. |
| `none` | | External quotes off. |

US tickers (`AAPL_US_EQ`) map automatically. Other markets differ in symbol suffixes and price units (London ETFs are often quoted in pence), so they are priced only when you map them in the provider's format, for example `QUOTE_SYMBOLS=VUSAl_EQ=VUSA.UK,SAPd_EQ=SAP.DE` for Stooq or `VUSAl_EQ=VUSA.L` for Finnhub. When the provider quotes in a different unit from Trading 212, add a factor: `VUSAl_EQ=VUSA.L*100` turns a price in pounds into pence. Check one with `get_quote` before relying on it: a quote off by a factor of 100 would size an order 100 times too large or too small. Quotes are cached for one minute. Gain and loss alerts need a holding, because they compare with the average cost.

An external price only sizes an order; the order still goes through the usual review, policy and broker checks, and Live orders still wait for your confirmation.

## Notifications

Set `NOTIFY_WEBHOOK_URL` to one or more HTTPS endpoints, separated by spaces or commas, to be told outside the chat. Each gets the message laid out for its service, known by its address:

| Service | Address | What is sent |
|---|---|---|
| Slack | `https://hooks.slack.com/services/…` | A header and the details as plain text, so a ticker's underscores are not read as italics |
| Discord | `https://discord.com/api/webhooks/…` | The title in bold and the details, with markdown escaped and nobody mentioned |
| Telegram | `https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat>` | The title in bold and the details (HTML); every query parameter goes in the body |
| ntfy | `https://ntfy.sh/<topic>`, or `ntfy:https://your-server/<topic>` | Title, message and a higher priority for events that need you now |
| Bark | `https://api.day.app/<key>` | Title and body, grouped as TradePilot, time-sensitive for events that need you now |
| Anything else | any HTTPS URL | JSON with `text` (Slack, Mattermost), `content` (Discord) and the raw `event`, as before |

A format before the address (`slack:`, `discord:`, `telegram:`, `ntfy:`, `bark:`, `raw:`) sets it for a self-hosted server or a relay. An address that holds a token (Telegram's, Bark's key, a Slack hook) is never written to the logs or the store, and errors about it name its place in the list, not its text.

`NOTIFY_LOCALE=zh-CN` writes notifications in Chinese (`en` is the default): the event's name, buy or sell, shares, and figures as each language writes them, the value of a fill in its currency (€1,303.75).

By default these types are sent: `order_submitted`, `order_status_unknown`, `order_filled`, `order_partly_filled`, `order_outcome_unknown`, `cancel_status_unknown`, `basket_submitted`, `plan_due`, `plan_auto_executed`, `plan_skipped`, `protective_sibling_cancelled`, `protective_attention`, `cancel_rejected`, `pie_submitted`, `pie_status_unknown`, `price_alert_triggered`, `account_alert_triggered`, `new_listings`, `goal_milestone`, `allocation_drift` and `daily_digest`. `NOTIFY_EVENTS` replaces that list. With `NOTIFY_WEBHOOK_SECRET`, each request carries `X-TradePilot-Signature: sha256=<HMAC of the body>`, whatever the service.

Each request waits 5 seconds at most. One an endpoint does not accept is tried again from the scheduler after a minute, then 5, 15, 60 and 180 minutes, and then given up (logged); the other endpoints are not sent it again. A daily digest no endpoint accepted is left to the digest's own retry, every 15 minutes. Waiting deliveries are kept in the server's store, at most 200, for at most 30 hours.

`NOTIFY_QUIET_HOURS=22-07` (whole hours in `TIMEZONE`, UTC without one; `22:00-07:00` also works) holds notifications during those hours and sends them as one message when they end, oldest first. Events that need you at once still go out: an order, cancellation or pie change whose result is unclear, protective orders that need attention, and a rejected cancellation. The daily digest comes at its own hour.

**Send a test** on the widget's Automation tab, or the `test_notifications` tool, sends one test message to each endpoint at once, even in quiet hours, and says what each answered, naming only its kind and host. It needs order tools on (`trade:write`), since it sends to the outside world. An address must not hold a user name or password; put a token in its path or query. The Automation tab shows where notifications go, in which language, and the quiet hours.

### Daily digest

Set `DIGEST_HOUR` (0 to 23, in `TIMEZONE`, UTC without one) or `DIGEST_HOUR_UTC` (always UTC; not both) together with `NOTIFY_WEBHOOK_URL` to receive one short message per environment per day, a day being one in that zone: total value and its change since the previous digest, the holdings' move on their last session with the three that moved most (as on the dashboard; left out when the quote provider's closes cannot be read), cash, unrealized P/L, the three largest holdings, pending orders, orders filled in the last day, plans that are due, alerts that triggered in the last day, the dividends paid since the previous digest (the five largest by instrument, then how many more) and those expected in the coming seven days (as the Income tab's dividend calendar works them out), then any due in the last seven days and not paid yet (also across a month end), marked as due and, with saved targets, the largest drift from them. Once any holding has a pending sell stop, it also names the holdings that no stop fully covers. It only reads. The day's move asks the quote provider for each holding's daily closes, as opening the dashboard does (cached for half an hour, and a previous close that will not change is kept for the day); on a plan with a small daily allowance, such as Alpha Vantage's free 25 requests, that is one request per holding each day. The dividends take one read of Trading 212's dividend history from the first day of the month a week ago, a year before (so a yearly payment due late last month is still seen; a page or two for most accounts, at most ten, as for the Income tab), on each attempt. A digest whose dividends cannot be read goes out without them, and the next one names what it missed; a dividend that reaches the history up to three days after the time it is dated is named by the next digest after it appears, and none is named twice. After a long gap, dividends received are named from at most 31 days back. When the history stops at ten pages, expected dividends are left out rather than shown short. The digest is sent whatever `NOTIFY_EVENTS` lists, and a day counts as done only once the webhook accepted it; until then it is tried again every 15 minutes.

The digest is written in `NOTIFY_LOCALE`'s language.

### Weekly and monthly reports

Set `REPORTS=weekly`, `monthly` or `weekly,monthly` together with `DIGEST_HOUR` (or `DIGEST_HOUR_UTC`) to receive a report at the digest's hour: on Monday for the seven days before, on the 1st for the month before, the days counted in the digest's zone. Each says the account's value at the start and end of the period, as TradePilot recorded it, with the change; the time-weighted return over those days (deposits and withdrawals left out); net deposits; dividends and interest; the buys and sells with their turnover; the realized gains; the costs; and, when a goal is set, how far the account is towards it at the period's last recorded value, from the same history reads as `get_portfolio_performance`. A report whose history stopped at the page limit says its figures may be low. Reports are sent whatever `NOTIFY_EVENTS` lists, come at their hour in quiet hours too, and are tried again every 15 minutes from the digest's hour until an endpoint accepts them, on later days too: a week no endpoint took on Monday goes out on Tuesday, until the next week ends (the latest period that ended is the one sent, so a report first turned on midweek sends last week's). The value at the start is the last one recorded before the period's first midnight, so the first day's move counts; each is recorded once in the activity log (`weekly_report`, `monthly_report`). They only read.

## Seeing what runs

`get_automation_overview` opens the widget on everything the scheduler acts on for an environment: plans with their next due time and last outcome, alerts with the last price seen, linked stop-loss / take-profit pairs, saved target weights, today's orders and value against the policy budgets, and which automation settings are on.

## Scheduled research (L0)

Research and market news still belong to a scheduled ChatGPT or Claude task, not the server. Here is a prompt for that task:

```text
Prepare my Trading 212 Invest decision brief. Read the current TradePilot 212 portfolio, allocation and pending orders first, and list any investment plans that are due. Research current market conditions, material company news, earnings or catalysts, and major risks using fresh sources. Reassess existing positions and consider new opportunities. Separate actionable ideas into short (<=1 week), medium (<=1 month), and long (>=1 year). It is valid to recommend no trade. For each candidate provide buy/sell/watch, a 0-100 score, risk level, a concise rationale, the key thesis, catalysts, risks, a counter-case when relevant, source references, analysis timestamp, and a current reference price with its timestamp when actionable. Render the final candidates with the TradePilot trade-plan UI. Do not place or confirm an order.
```

## What is never automated

- Live order submission or confirmation, and any Live cancellation except the other half of a filled protective pair.
- Retrying a failed or uncertain broker write, on any environment.
- Changing the policy. It comes from server configuration, not from the model.
