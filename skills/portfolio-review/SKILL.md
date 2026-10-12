---
name: portfolio-review
description: Periodic Trading 212 portfolio review with exact performance, income, costs and allocation figures from TradePilot tools. Use when the user asks how their portfolio is doing, for a monthly or yearly review, or "how much have I made".
---

# Portfolio review

Produce a factual review of the user's Trading 212 account. Every number must come from a TradePilot tool result; never estimate weights, returns or totals yourself.

## Steps

1. Pick the window from the request (`1m`, `3m`, `ytd`, `1y`, `all`). Default to `ytd`. Use the environment the user names, otherwise the instance default.
2. Call `get_portfolio_performance` for the window. If `coverage.truncated` is true, say the figures cover only the most recent history and offer to rerun with a larger `maxPages`.
3. Call `get_income_summary` for the same window.
4. Call `analyze_portfolio_allocation`.
5. Optionally call `get_portfolio_dashboard` to show the interactive view. When the user asks about one holding, call `get_holding_detail` for it. It returns the position, the holding's share of the account against any target, its open orders and alerts, the last 12 months of fills and dividends, and how the price moved over 1, 3, 6 and 12 months with the year's high and low. Quote those figures rather than working out a price history from memory.
6. If the user asks what made up a total, list the items for the same window:
   - dividends, interest, deposits and withdrawals: `get_cash_history`, filtered by `types` or `ticker`;
   - trading costs (FX conversion fees, commissions, stamp duty): `get_trade_history`, whose fills carry their `costItems`, plus any account-level fees from `get_cash_history` with type `FEE`.
7. For gains, losses and income per tax year, use `get_tax_year_summary` (see the tax-year skill).

## Report shape

Lead with three numbers: realized P/L, unrealized P/L, and income for the period, in the account currency. Then cover, briefly:

- **Contributions:** deposits, withdrawals, and net. Report `simpleReturn` only when the tool returned it (all-time, untruncated), and call it a simple return on net contributions. Report `annualizedReturn` only when the tool returned it, as the money-weighted yearly return since `annualizedSince`; it counts when each deposit was made, so it differs from the simple return.
- **Costs:** total and the two largest cost types. FX conversion fees are often the biggest; point that out when true.
- **Winners and losers:** the top contributors from `byTicker`.
- **Allocation:** cash share, largest holding, top-5 share, effective number of holdings, currency exposure, and every flag the tool raised.
- **Next steps:** at most three concrete observations, such as concentration or cash drag. This is information, not personalised financial advice. Do not place or prepare orders unless the user asks.

Reply in the user's language.
