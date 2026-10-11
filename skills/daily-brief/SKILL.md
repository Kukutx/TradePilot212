---
name: daily-brief
description: Pre-market Trading 212 decision brief that reads the live portfolio, checks market hours, researches fresh news, and renders short/medium/long ideas in the TradePilot trade-plan UI without placing orders. Use for a morning brief, daily check-in, or scheduled analysis.
---

# Daily brief

This brief is read-only. Never prepare, confirm or submit an order from it. Scheduled runs must stay read-only.

## Steps

1. Call `get_portfolio_dashboard` to load positions, pending orders and cash.
2. Call `get_market_hours` for one representative holding per exchange, so the brief says whether markets are open, in pre-market, or closed, and when they next open.
3. Call `analyze_portfolio_allocation` and carry its flags into the brief. Call `list_investment_plans` and mention any plan that is due, so the user can confirm it later. Call `list_price_alerts` and mention alerts that triggered since the last brief. If the user holds pies, call `list_pies` and flag a pie whose drift is above 5%.
4. Research current, sourced news for the largest holdings and any pending-order tickers: earnings dates, guidance, material events. Note each source's date. If you have no web access, say so and skip this step rather than relying on memory.
5. Build candidates for `show_daily_trade_plan`:
   - short (≤1 week), medium (≤1 month) and long (≥1 year) horizons;
   - each with buy, sell or watch, a 0–100 score, a risk level, the rationale, thesis, catalysts, risks, a counter-case, sources, and `analysisAsOf`;
   - for actionable Market-order ideas, a `referencePrice` and `referencePriceAt` from a dated source.

   Recommending no trade is valid.
6. Render with `show_daily_trade_plan`. Keep the chat text to a few lines and put the detail in the cards.

## Rules

- Use the broker ticker returned by TradePilot. Resolve ambiguous names with `search_trading212_instruments`.
- Never present a guess as a current price. Trading 212's API has no quote endpoint, so a price comes from a held position, from `get_quote` (TradePilot's quote source, with the time of the price), or from a dated source.
- Reply in the user's language.
