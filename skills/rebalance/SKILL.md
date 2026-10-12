---
name: rebalance
description: Rebalance a Trading 212 portfolio toward target weights with TradePilot, as one basket the user reviews and confirms. Use when the user asks to rebalance, reach a target allocation, trim an overweight holding, or deploy cash across holdings.
---

# Rebalance

1. Call `analyze_portfolio_allocation` to show the current weights and cash share. If it returns `drift`, targets are already saved: show each target's drift and ask whether to rebalance to them or change them.
2. Agree on the targets with the user. If they want each holding to carry the same share of the risk, `analyze_portfolio_allocation` gives the equal-risk weights (`risk.rows[].parity`) and its text the exact `plan_portfolio_rebalance` targets and `cashWeight` that move to them; use those rather than computing your own. Once targets are saved, `drift.volatility` (from `manage_target_allocation` or `analyze_portfolio_allocation`) gives the volatility a year they would give beside today's (targets not held count too, from their own closes, unless named in `leftOut`); tell the user what the change does to risk, as past volatility, not a forecast. Targets are shares of **total account value**, so they plus any cash reserve add up to at most 100%. If the user gives only some holdings, ask whether to leave the others as they are (the default) or sell them (`sellUntargeted`).
3. Call `get_trading_policy` for the environment. Point out anything that would block the plan, for example a target above `maxPositionWeight` or a closed market while Market orders are blocked.
4. Call `plan_portfolio_rebalance` with the targets and any `cashWeight`, `minTradeValue` or `wholeSharesOnly` the user wants.
   - An instrument the user does not hold is priced from TradePilot's quote source when it can be (`get_quote` shows the price and its time). Otherwise pass a current `referencePrice` with `referencePriceAt` from a dated source.
   - An instrument quoted in another currency is converted at the rate implied by a holding in that currency, else at the quote source's rate (the plan notes which). Pass `fxRates` (instrument-currency units per 1 account-currency unit) only when the plan lists it as skipped for want of a rate.
   - To rebalance to the saved targets, call it without `targets`; it uses them and their cash weight.
   - When the user wants to invest cash (a deposit, dividends) without selling anything, pass `buyOnly: true`, or `investAmount` to invest a set amount. Only cash above the reserve is used, most in the targets furthest below.
5. Explain the result from the tool output: each trade, current → resulting weight, cash before and after, what the buys and sells come to (`totals`), and every skipped item with its reason. When trades are in another currency than the account's, give the conversion fee from `totals.fxFee`: Trading 212 charges it on the conversion (0.15% by default), none on a trade paid from or into a balance in that currency, so it is at most that. Do not recompute quantities or fees yourself. Before a plan, `drift.rebalance` gives the same totals for a rebalance all the way to the saved targets.

6. If the user wants to keep these targets, save them with `manage_target_allocation` (`set`, with `cashWeight` and optionally `driftThreshold`). TradePilot then shows the drift in the Allocation tab and notifies when it grows past the threshold (default 5 points).
7. To move toward the targets with new money instead of selling, offer a standing plan with `manage_investment_plans` and `targetAmount`: each run puts that amount into the targets furthest below their weight.

The plan opens as a basket in the TradePilot widget. Nothing is sent until the user reviews it there and confirms. Never claim an order was placed unless the widget reports it. Reply in the user's language.
