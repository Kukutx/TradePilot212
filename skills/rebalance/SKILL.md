---
name: rebalance
description: Rebalance a Trading 212 portfolio toward target weights with TradePilot, as one basket the user reviews and confirms. Use when the user asks to rebalance, reach a target allocation, trim an overweight holding, or deploy cash across holdings.
---

# Rebalance

1. Call `analyze_portfolio_allocation` to show the current weights and cash share.
2. Agree on the targets with the user. Targets are shares of **total account value**, so they plus any cash reserve add up to at most 100%. If the user gives only some holdings, ask whether to leave the others as they are (the default) or sell them (`sellUntargeted`).
3. Call `get_trading_policy` for the environment. Point out anything that would block the plan, for example a target above `maxPositionWeight` or a closed market while Market orders are blocked.
4. Call `plan_portfolio_rebalance` with the targets and any `cashWeight`, `minTradeValue` or `wholeSharesOnly` the user wants.
   - Trading 212 has no quote endpoint. An instrument the user does not hold needs a current `referencePrice`, so look it up first.
   - An instrument quoted in another currency needs an `fxRates` entry (instrument-currency units per 1 account-currency unit).
5. Explain the result from the tool output: each trade, current → resulting weight, cash before and after, and every skipped item with its reason. Do not recompute quantities yourself.

The plan opens as a basket in the TradePilot widget. Nothing is sent until the user reviews it there and confirms. Never claim an order was placed unless the widget reports it. Reply in the user's language.
