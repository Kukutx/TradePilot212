---
name: risk-check
description: Check a Trading 212 portfolio for concentration, currency exposure, cash levels, and risky pending orders using TradePilot's deterministic tools. Use when the user asks about risk, diversification, exposure, or "am I too concentrated".
---

# Risk check

1. Call `analyze_portfolio_allocation`. If the user states their own limits, such as "no position above 10%", pass them as `maxSingleWeight` and the other limits.
2. Call `get_portfolio_dashboard` to see pending orders. Its "Stop-loss orders" line says which holdings a pending sell stop covers, how many shares, and how far below the last price it sits. Where the broker values the holding, it also says what reaching the stop would cost from now and the P/L left then, in the account currency (a gap can fill a stop lower). It also names the holdings without one.
3. For each pending order, call `get_market_hours` when its market is closed or in an extended session. A Market order placed while the market is closed is queued and fills at the next open, possibly at a gap price.

Report:
- every flag the tool raised, in plain language;
- the largest holding, the top-5 share and the effective number of holdings;
- the currency split, noting that FX moves affect returns in the account currency;
- where its `risk` is: the holdings' volatility together, the diversification ratio, and any holding whose share of the risk is well above its share of the value (it swings more, or moves more with the rest); the most alike pairs from its correlations; from `risk.mix`, what a bad week (one in 20) has cost today's mix, in percent and in the account currency, and its deepest fall over the year, said as history, not a forecast. Name the holdings in `riskMissing` or `short` as not measured;
- the cash share;
- pending orders that look stale, are far from the last known price, or will queue at the next open. For one that has partly filled, `get_order_status` gives the quantity filled so far.

If a large holding has no stop-loss and no price alert, or its stop covers only part of it, suggest one: `manage_price_alerts` with `trailing_drop` for a warning that never trades, or, where order tools are available, `review_protective_orders` for a broker-native stop. When several holdings lack one, `review_portfolio_stops` drafts a stop for each of them in one basket that the user confirms once.

If the user wants a stale order gone, and order tools are available, follow the order-followup skill: `review_order_cancel` opens the cancellation for the user to confirm, and it never cancels by itself.

Do not compute weights yourself; quote the tool output. Do not prepare orders unless the user asks. Reply in the user's language.
