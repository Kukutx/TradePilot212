# Portfolio analytics

TradePilot computes portfolio figures deterministically from Trading 212 data, so the model does not have to do arithmetic. All of these tools are read-only.

| Tool | What it returns | Trading 212 API permission |
|---|---|---|
| `analyze_portfolio_allocation` | Weights, cash share, currency and asset-type exposure, concentration (largest holding, top 5, Herfindahl index, effective number of holdings), rule-based flags | account, portfolio, metadata |
| `get_portfolio_performance` | Realized P/L, unrealized P/L, deposits and withdrawals, dividend and interest income, costs by type, trade counts, per-ticker contribution; for all-time windows, a simple return on net contributions and, after a year of deposits, an annualized money-weighted return; the account value per day that TradePilot recorded in the window | account, history (orders, dividends, transactions), TradePilot's daily value record |
| `get_income_summary` | Dividends and interest by month and by ticker, trailing 12 months, and expected dividends for the next 12 months from current holdings | account, positions, history (dividends, transactions) |
| `get_tax_year_summary` | One tax year: number of sales, proceeds, realised gains and losses kept apart, per-instrument results, dividends, interest and costs. `year` is the calendar year it starts in, `yearStart` its first day as `MM-DD` (`04-06` for the UK) and `timeZone` the zone its days are counted in (`Europe/London`) | account, history (orders, dividends, transactions) |
| `get_trade_history` | Executed fills with price, quantity, net value, realized P/L, FX rate, and costs; with `includeUnfilled`, also orders cancelled, rejected or expired without a fill. A ticker filter is applied by Trading 212, so older trades of one instrument are found | history (orders) |
| `get_cash_history` | Dividends, deposits, withdrawals, interest and fees one by one, with totals per type; filter by type or by an instrument's dividends | history (dividends, transactions) |
| `get_order_status` | One order by id: open (and how much filled), filled, partly filled, cancelled or rejected, with its fills | orders, history (orders) |
| `get_market_hours` | Current session (regular, pre-market, after-hours, overnight, break, closed) and the next open and close | metadata |
| `manage_history_export` | Lists the broker's CSV reports, or requests a new one | history |

## Periods

History tools accept `period` (`1w`, `1m`, `3m`, `ytd`, `1y`, `all`) or an explicit `from` and `to` in ISO 8601. `get_tax_year_summary` takes a `year` and `yearStart` instead.

They read history newest first, in pages of 50 records. Trading 212 allows about 20 history requests per minute, so each tool reads at most `maxPages` pages per data set (10 by default, 40 at most).

When the budget runs out before the requested period is covered, the result is marked `truncated`. The simple and annualized returns are then omitted, because they would be wrong.

## How the figures are defined

- **Amounts** are in the account currency, as Trading 212 reports them.
- **Realized P/L** is the sum of `fill.walletImpact.realisedProfitLoss`, which already reflects the FX rate at execution.
- **Costs** are the taxes and fees attached to each fill (commission, currency conversion fee, stamp duty, FINRA fee, and so on), plus `FEE` transactions.
- **Simple return** is `(current value − net contributions) / net contributions`. It is not time-weighted or annualized. Both returns compare against the current account value, so a window whose `to` is in the past has neither.
- **Annualized return** is the money-weighted rate (XIRR): the yearly rate at which every deposit, every withdrawal and today's account value net to zero. It counts when money went in, so a deposit made last month weighs less than one made three years ago. It is given for all-time windows that reach the present once the first deposit is a year old, and omitted while history is truncated.
- **Tax year** figures use Trading 212's realised P/L per sale, which is worked out against your average purchase price at the exchange rate of the sale. Tax rules match purchases to sales in their own way (the UK's same-day and 30-day rules, for example), and dividends are reported after any tax withheld at source. A sale counts in the year it filled, by its fill time; a sale without Trading 212's account-currency value is left out of proceeds and named in the notes. Use the summary to prepare and check a return; file from the Trading 212 annual statement or a CSV export (`manage_history_export`).
- **Account value history** is TradePilot's own record, because Trading 212's API reports only today's value. While the server runs, the scheduler reads the account summary about once an hour and keeps the last value of each UTC day, together with the cash free to trade and the holdings' value (`src/core/value-history.ts`). Each value is dated by when Trading 212 answered, so a read that crosses midnight UTC counts for the new day. Days it was not running have no point, and the chart spaces points by date, so a gap stays visible. Points are kept for about six years, one stored key per month. The sample account keeps its own record, and after a switch to another Trading 212 account only the current account's days are shown (the account id stays in the store). `get_portfolio_performance` returns the days inside its window as `valueHistory` once there are two or more (a date bound compares whole days, a date-time bound compares when each value was read), and the Performance tab draws them as a line with a hover readout and a table view. `get_portfolio_dashboard` returns the last 30 days as `valueTrend`, and the dashboard shows them as a small line beside the total value, with the change since the first of those days. The value includes deposits and withdrawals, so it is not a return.
- **Concentration** is measured over invested value only, so a large cash balance does not hide a concentrated portfolio. The flag thresholds can be overridden per call.

## Market-hours notices

Order review uses the same exchange schedules. When the market is closed, the confirmation shows a notice.

For a Market order outside an eligible extended session, the notice says that Trading 212 will queue the order and fill it at the next open, possibly at a gap price.

## Limits

Trading 212's Public API has no quote endpoint. Current prices exist only for instruments you already hold, through the positions endpoint.
