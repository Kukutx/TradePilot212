---
name: trade-journal
description: Review recent Trading 212 trades with fills, realized P/L, fees and FX from TradePilot history, set against the reasons written in the trade journal, and save what the user learns. Use for "review my trades", "what did I trade last month", "why did I buy X", "which of my reasons work", or a post-trade journal.
---

# Trade journal

1. For "how are my trades doing" or "which reasons work", start with `get_journal_review` for the window (default `all`): each trade with a note next to how it has gone since, its `edge` (the move in the trade's favour since the fill: up for a buy, down for a sell), per-tag counts and average edge, and `due`, the trades with a reason and no look back yet. Quote its figures; never work an edge out yourself.
2. Call `get_trade_history` for the requested window (default `1m`), filtered by ticker if the user names one. Set `includeUnfilled` when the user asks about orders that did not fill. Each fill carries its `orderId`, and `journal` holds the notes on those orders: the `thesis` written when the trade was made and any `review` written since.
3. Call `get_portfolio_performance` for the same window to get totals and costs. For one order the user asks about, `get_order_status` gives its state and each fill. For one instrument, `manage_trade_journal` with `action: "list"` and the `instrument` also returns notes that are not tied to an order.
4. Group the fills by ticker and present each round trip or position change with:
   - date, side, quantity and price;
   - net value and realized P/L from the tool;
   - costs, with FX conversion fees called out;
   - the reason recorded at the time, quoted as written, when a note exists.
5. Compare each recorded reason with what happened: did the thesis play out, was the exit planned, what cost money (fees, FX, timing). An edge leaves FX and costs out and counts every trade once, so a small trade with a large move weighs as much as a large one; say so when it matters. Start with the trades `due` for a look back. For a trade with no note, ask the user why they made it, or infer it from the conversation and say it is inferred.
6. Offer one habit to keep or change, for example from a tag whose trades keep going against the user. When the user agrees with a reflection on a trade, save it with `manage_trade_journal`: `update` with the note's `entryId` and a `review` when the trade has a note, or `add` with the `instrument`, `orderId` and `review` when it has none. Keep the user's own words; tags such as `earnings` or `breakout` help find patterns later.

Never recompute P/L from prices; Trading 212's `realisedProfitLoss` already includes FX. Never rewrite a thesis after the fact: it records what the user thought then. If the history is truncated, say so. Reply in the user's language.
