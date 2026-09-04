# Scheduled analysis

TradePilot 212 does not run its own market-research scheduler and does not support unattended broker writes.

The intended split is:

```text
Scheduled ChatGPT task
  → current market/news/research
  → read TradePilot portfolio and pending orders
  → reassess existing positions and new candidates
  → produce short / medium / long ideas
  → render the TradePilot trade-plan UI

Interactive session
  → user chooses an idea
  → TradePilot prepares an editable order
  → user confirms the broker write
```

This keeps the self-hosted Worker focused on broker access and makes scheduled runs read-only.

## Suggested recurring prompt

```text
Prepare my Trading 212 Invest decision brief. Read the current TradePilot 212 portfolio and pending orders first. Research current market conditions, material company news, earnings or catalysts, and major risks using fresh sources. Reassess existing positions and consider new opportunities. Separate actionable ideas into short (<=1 week), medium (<=1 month), and long (>=1 year). It is valid to recommend no trade. For each candidate provide buy/sell/watch, a 0-100 score, risk level, a concise rationale, the key thesis, catalysts, risks, a counter-case when relevant, source references, analysis timestamp, and a current reference price with its timestamp when actionable. Resolve ambiguous names or tickers through TradePilot and render the final candidates with the TradePilot trade-plan UI. Do not place, confirm, or automatically execute an order. Keep the main brief compact; put supporting detail in the expandable candidate fields.
```

## Why execution stays interactive

A scheduled analysis can become stale before a market opens or while conditions change. It can also run when the user is not present. Treating the scheduler as read-only prevents an unattended research result from becoming a real-money action.

The user can later open the brief and continue normally:

```text
Buy about €100 of the top long-term idea.
Sell half of the position marked Sell.
Prepare that order in Live.
```

TradePilot then resolves the instrument, sizes an editable order, validates it against current broker state, and uses the normal confirmation flow.

## Recommended cadence

For a primarily US-equity portfolio in Europe, a weekday pre-market brief is a sensible default. The exact schedule belongs to the ChatGPT automation, not the Worker, and can be changed without redeploying TradePilot.

## Boundaries

Keep these behaviors outside the scheduled task:

- order submission;
- order cancellation;
- automatic confirmation;
- automatic retry of a failed or uncertain broker write.

The scheduler may read current account state and render recommendations, but broker writes remain interactive.
