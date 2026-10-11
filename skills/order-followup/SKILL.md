---
name: order-followup
description: Follow up Trading 212 orders with TradePilot - whether an order filled, what is still pending, and cancelling a pending order after the user confirms it. Use for "did my order go through", "what orders are open", "cancel my Apple limit order".
---

# Order follow-up

1. Call `get_portfolio_dashboard` for the environment to list pending orders, with their ids, types, prices and how much has filled. For instruments the user holds, each order's text also says how far its stop or limit is from the last price.
2. For one order, call `get_order_status` with its id. For an order that has ended (filled, partly filled, cancelled, rejected or closed), it lists each fill with its price. For an order that is still open, it gives only the filled quantity so far; the individual fills appear once the order ends.
3. If the user names an instrument rather than an id, match it against the pending orders. If more than one order matches, list them with side, type, price and id, and ask which one they mean before going on. For an order that is no longer pending, call `get_trade_history` for that instrument with `includeUnfilled`.
4. To cancel, call `review_order_cancel` with the order id. If the order is a stop-loss, say that cancelling it leaves the position unprotected.
   - Where the TradePilot widget is shown, the user confirms the cancellation there, with a second confirmation on Live.
   - In a text-only host (a terminal), no widget appears. Show the order from the tool's text. If the user wants it cancelled, call `app_prepare_cancel` (this sends nothing) and show its summary. Call `app_execute_cancel` with that token only after the user explicitly confirms in the conversation. On Live, pass `liveAcknowledged` only after they confirm they understand it is their real account.

## Rules

- Never say an order was cancelled or filled unless a tool result says so. After a cancellation, check it with `get_order_status`.
- A partly filled order keeps its filled shares when the rest is cancelled.
- If `review_order_cancel` is not available, order tools are switched off on this instance. Tell the user they can cancel the order in the dashboard or the Trading 212 app.
- Reply in the user's language.
