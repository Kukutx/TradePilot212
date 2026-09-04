# ChatGPT automation model

TradePilot 212 deliberately does **not** embed its own stock-research scheduler or autonomous trading bot.

The recommended architecture is:

```text
ChatGPT Automation
  → market/news/research
  → read TradePilot portfolio/positions/orders
  → produce short / medium / long candidates
  → render the TradePilot plan UI
  → user decides whether to open an order draft
  → explicit human confirmation for execution
```

This keeps responsibilities small and makes self-hosting easier: the Worker is an account/read/execute bridge, while ChatGPT handles language, research and scheduled reasoning.

## Recommended recurring task

Use one daily ChatGPT automation. A good prompt is:

```text
Create my daily Trading 212 Invest decision brief. First read my current TradePilot 212 portfolio and pending orders. Research current market conditions, material company news, earnings/catalysts and major risks using fresh sources. Reassess existing positions and search for new opportunities. Separate actionable ideas into short (<=1 week), medium (<=1 month) and long (>=1 year). Be selective: it is valid to recommend no trade. For every candidate include buy/sell/watch, a 0-100 score, risk level, concise rationale and a current reference price when actionable. Resolve ambiguous names/tickers through TradePilot and render the final candidates with the TradePilot daily trade-plan UI. Do not place, confirm or automatically execute any order. Keep the output concise and decision-oriented.
```

## Why execution stays outside the scheduler

Scheduled research and actual brokerage writes have different risk profiles. Keeping scheduled runs read-only prevents a stale or unattended analysis from turning into a real-money order.

A user can return to the generated brief and say things such as:

```text
Buy about €100 of the top long-term idea.
Sell half of the position you marked as Sell.
Prepare the order in Live.
```

TradePilot then resolves and sizes the request and requires the normal confirmation flow.

## 中文说明

推荐保持“体验合一、代码分离”：定时分析由 ChatGPT Automation 负责，TradePilot 只负责读取 Trading 212、解析股票、展示交易计划和人工确认后的执行。

不要把自动选股 cron、新闻抓取和自动下单塞进 Worker。每天的任务可以自动分析和给建议，但**不要自动下单或自动确认真实资金订单**。
