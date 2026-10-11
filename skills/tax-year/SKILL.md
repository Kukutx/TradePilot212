---
name: tax-year
description: Gather a Trading 212 tax year with TradePilot - sales with realised gains and losses, dividends, interest and costs - to prepare or check a tax return. Use for "what were my capital gains this tax year", "how much dividend income do I declare", "UK tax year 2025/26".
---

# Tax year

1. Work out which country the user files in. Use it only when the request makes it clear (for example "UK tax year", "Steuererklärung", "2025/26"); the account currency does not tell you where someone is taxed, so otherwise ask. Then:
   - UK: starts 6 April, so `yearStart` is `04-06` and `timeZone` is `Europe/London`; "2025/26" is `year` 2025.
   - Most other countries (Germany, France, Spain, Italy, Poland, the Netherlands, the US …): the calendar year, `yearStart` `01-01`, with the country's zone as `timeZone` (for example `Europe/Berlin`).
   With no year named, leave `year` out: the tool takes the latest tax year that has started.
2. Call `get_tax_year_summary` with `environment`, `year`, `yearStart` and `timeZone`. If `truncated` is true, rerun with a larger `maxPages` (up to 40) before reporting.
3. For the detail behind a figure, call `get_trade_history` with `from` and `to` set to the tool's `period` (each sale with its realised P/L and costs), and `get_cash_history` for each dividend and interest payment.
4. For the documents a return is filed from, offer `manage_history_export` to request Trading 212's CSV for the same period, and point the user to the annual statement in the Trading 212 app.

## Report shape

- Sales: how many, total proceeds, gains and losses separately, and the net. Then the instruments with the largest results.
- Income: dividends and interest. Dividends are after any tax withheld at source; the gross amount and the withholding are on the Trading 212 statement.
- Costs: total, with the largest cost types.
- Say once, plainly, that these are Trading 212's figures on an average-cost basis in the account currency. Tax rules can match purchases to sales differently (for example the UK's same-day and 30-day rules) and can need amounts converted at other rates, so the tax due can differ. This is not tax advice.

## Rules

- Every number comes from a tool result. Never work out tax due, allowances or rates yourself unless the user asks, and then show the rule and figures you used.
- If the tax year is still running (`ended` is false), say the figures cover it up to now.
- Reply in the user's language.
