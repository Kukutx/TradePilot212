# Trade journal

TradePilot keeps a note per trade: why you made it, and later, looking back, what came of it. Notes live in TradePilot's own store (the same one that keeps price alerts and plans) and are never sent to Trading 212.

## Writing a note

- **With the order.** The order editor has a **Why this trade** field, and `review_trading212_order_intent`, `review_trading212_order` and `app_prepare_order` take a `thesis`. The review shows it with the order. Once Trading 212 accepts the order, the thesis is saved as a note with the order id Trading 212 gave it. An order whose result is unclear keeps its note too, without an order id and marked as unconfirmed. An order sent from a trade plan card starts with the card's thesis or rationale, which you can change or clear in the editor. Baskets (rebalancing, plans, portfolio stops) carry no thesis.
- **On a past fill.** On a holding's page, each fill without a note has **Add note**. The note is tied to that fill's order.
- **On an instrument.** **Add note** at the top of the holding's journal writes one without an order, such as what you are waiting for before buying.
- **From the chat.** `manage_trade_journal` with `action: "add"`, an `instrument` and a `thesis` or `review`; an `orderId` from `get_trade_history` or `get_order_status` ties it to that order.

Each note has a thesis (why), a review (looking back) or both, up to 1000 characters each, and up to 8 tags. An order has at most one note: adding a second one names the first so you can change it instead. Up to 1000 notes are kept.

## Reading them

- The holding page lists the instrument's notes, newest first, with the fill each is about (side, size, price and the day of the trade). Each fill with a note shows its reason underneath. A note with only a reason offers **Add a look back**.
- `get_trade_history` returns each fill's `orderId` and, under `journal`, the notes on the orders it lists.
- `get_holding_detail` returns the instrument's notes under `journal`: the 20 newest and any on a listed fill, with `journalTotal` when there are more.
- `manage_trade_journal` with `action: "list"` returns the notes for an environment, optionally for one instrument or one order.

The `trade-journal` skill uses all of these to review your trades: it reads the reasons you gave at the time next to how each trade turned out, and saves what you take from it as the review.

## Changing and deleting

`manage_trade_journal` with `action: "update"` and an `entryId` changes the thesis, review or tags; a field left out stays as it is and an empty value clears it, as long as the note keeps a thesis or a review. `action: "delete"` removes the note. On the holding page, **Edit** and **Delete** do the same, and Delete asks once more in place.

The journal tool works without order tools (`trade:write`), like price alerts, since it never trades.
