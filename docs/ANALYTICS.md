# Portfolio analytics

TradePilot computes portfolio figures deterministically from Trading 212 data, so the model does not have to do arithmetic. All of these tools are read-only.

| Tool | What it returns | Trading 212 API permission |
|---|---|---|
| `analyze_portfolio_allocation` | Weights, cash share, currency and asset-type exposure, concentration (largest holding, top 5, Herfindahl index, effective number of holdings), rule-based flags | account, portfolio, metadata |
| `get_portfolio_performance` | Realized P/L, unrealized P/L, deposits and withdrawals, dividend and interest income, costs by type, trade counts, per-ticker contribution; for all-time windows, a simple return on net contributions | account, history (orders, dividends, transactions) |
| `get_income_summary` | Dividends and interest by month and by ticker, trailing 12 months, and expected dividends for the next 12 months from current holdings | account, positions, history (dividends, transactions) |
| `get_trade_history` | Executed fills with price, quantity, net value, realized P/L, FX rate, and costs | history (orders) |
| `get_market_hours` | Current session (regular, pre-market, after-hours, overnight, break, closed) and the next open and close | metadata |
| `manage_history_export` | Lists the broker's CSV reports, or requests a new one | history |

## Periods

History tools accept `period` (`1m`, `3m`, `ytd`, `1y`, `all`) or an explicit `from` and `to` in ISO 8601.

They read history newest first, in pages of 50 records. Trading 212 allows about 20 history requests per minute, so each tool reads at most `maxPages` pages per data set (10 by default, 40 at most).

When the budget runs out before the requested period is covered, the result is marked `truncated`. The simple return is then omitted, because it would be wrong.

## How the figures are defined

- **Amounts** are in the account currency, as Trading 212 reports them.
- **Realized P/L** is the sum of `fill.walletImpact.realisedProfitLoss`, which already reflects the FX rate at execution.
- **Costs** are the taxes and fees attached to each fill (commission, currency conversion fee, stamp duty, FINRA fee, and so on), plus `FEE` transactions.
- **Simple return** is `(current value − net contributions) / net contributions`. It is not time-weighted or annualized.
- **Concentration** is measured over invested value only, so a large cash balance does not hide a concentrated portfolio. The flag thresholds can be overridden per call.

## Market-hours notices

Order review uses the same exchange schedules. When the market is closed, the confirmation shows a notice.

For a Market order outside an eligible extended session, the notice says that Trading 212 will queue the order and fill it at the next open, possibly at a gap price.

## Limits

Trading 212's Public API has no quote endpoint. Current prices exist only for instruments you already hold, through the positions endpoint.
