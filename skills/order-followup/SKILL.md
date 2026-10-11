---
name: order-followup
description: Follow up Trading 212 orders with TradePilot - whether an order filled, what is still pending, and cancelling a pending order after the user confirms it in the widget. Use for "did my order go through", "what orders are open", "cancel my Apple limit order".
---

# Order follow-up

1. Call `get_portfolio_dashboard` for the environment to list pending orders, with their ids, types, prices and how much has filled.
2. For one order, call `get_order_status` with its id. It says whether the order is open, partly filled, filled, cancelled, rejected or closed, and lists each fill with its price. If the user names an instrument rather than an id, match it to the dashboard's pending orders; for an order that is no longer pending, call `get_trade_history` for that instrument with `includeUnfilled`.
3. To cancel, call `review_order_cancel` with the order id. It opens the cancellation in the TradePilot widget, where the user confirms it, with a second confirmation on Live. It never cancels by itself. If the order is a stop-loss, say that cancelling it leaves the position unprotected.

## Rules

- Never say an order was cancelled or filled unless a tool result says so. After the user confirms a cancellation in the widget, check it with `get_order_status`.
- A partly filled order keeps its filled shares when the rest is cancelled.
- If `review_order_cancel` is not available, order tools are switched off on this instance. Tell the user they can cancel the order in the dashboard or the Trading 212 app.
- Reply in the user's language.
