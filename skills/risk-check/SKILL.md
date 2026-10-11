---
name: risk-check
description: Check a Trading 212 portfolio for concentration, currency exposure, cash levels, and risky pending orders using TradePilot's deterministic tools. Use when the user asks about risk, diversification, exposure, or "am I too concentrated".
---

# Risk check

1. Call `analyze_portfolio_allocation`. If the user states their own limits, such as "no position above 10%", pass them as `maxSingleWeight` and the other limits.
2. Call `get_portfolio_dashboard` to see pending orders.
3. For each pending order, call `get_market_hours` when its market is closed or in an extended session. A Market order placed while the market is closed is queued and fills at the next open, possibly at a gap price.

Report:
- every flag the tool raised, in plain language;
- the largest holding, the top-5 share and the effective number of holdings;
- the currency split, noting that FX moves affect returns in the account currency;
- the cash share;
- pending orders that look stale, are far from the last known price, or will queue at the next open.

If a large holding has no stop-loss and no price alert, suggest one: `manage_price_alerts` with `trailing_drop` for a warning that never trades, or, where order tools are available, `review_protective_orders` for a broker-native stop.

Do not compute weights yourself; quote the tool output. Do not prepare orders unless the user asks. Reply in the user's language.
