---
name: trade-journal
description: Review recent Trading 212 trades with fills, realized P/L, fees and FX from TradePilot history, and help the user extract lessons. Use for "review my trades", "what did I trade last month", or a post-trade journal.
---

# Trade journal

1. Call `get_trade_history` for the requested window (default `1m`), filtered by ticker if the user names one.
2. Call `get_portfolio_performance` for the same window to get totals and costs.
3. Group the fills by ticker and present each round trip or position change with:
   - date, side, quantity and price;
   - net value and realized P/L from the tool;
   - costs, with FX conversion fees called out.
4. Ask the user, or infer from the conversation, why each trade was made. Then reflect briefly on what went well, what cost money (fees, FX, timing), and one habit to keep or change.

Never recompute P/L from prices; Trading 212's `realisedProfitLoss` already includes FX. If the history is truncated, say so. Reply in the user's language.
