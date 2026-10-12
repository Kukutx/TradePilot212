# Trade journal

TradePilot keeps a note per trade: why you made it, and later, looking back, what came of it. Notes live in TradePilot's own store (the same one that keeps price alerts and plans) and are never sent to Trading 212.

## Writing a note

- **With the order.** The order editor has a **Why this trade** field, and `review_trading212_order_intent`, `review_trading212_order` and `app_prepare_order` take a `thesis`. The review shows it with the order. Once Trading 212 accepts the order, the thesis is saved as a note with the order id Trading 212 gave it. An order whose result is unclear keeps its note too, without an order id and marked as unconfirmed; when **Verify status** (`app_verify_unknown_execution`) finds the order, the mark goes, and a pending order found that way gives the note its id. When the note cannot be saved (the journal is full, or its store fails), the result says so and the order stands. The thesis goes with the draft when you switch between Demo and Live. An order sent from a trade plan card starts with the card's thesis or rationale, which you can change or clear in the editor. Baskets (rebalancing, plans, portfolio stops) carry no thesis.
- **On a past fill.** On a holding's page, each fill without a note has **Add note**. The note is tied to that fill's order.
- **On an instrument.** **Add note** at the top of the holding's journal writes one without an order, such as what you are waiting for before buying.
- **From the chat.** `manage_trade_journal` with `action: "add"`, an `instrument` and a `thesis` or `review`; an `orderId` from `get_trade_history` or `get_order_status` ties it to that order.

Each note has a thesis (why), a review (looking back) or both, up to 1000 characters each, and up to 8 tags. An order has at most one note, also when two saves happen at once: adding a second one names the first so you can change it instead, and deleting a note frees its order. Up to 1000 notes are kept.

## Reading them

- The holding page lists the instrument's notes, and any note on one of its listed fills, newest first, with the fill each is about (side, size, price and the day of the trade). Each fill with a note shows its reason underneath. A note with only a reason offers **Add a look back**.
- `get_trade_history` returns each fill's `orderId` and, under `journal`, the notes on the orders it lists.
- `get_holding_detail` returns the instrument's notes under `journal`: the 20 newest and any on a listed fill, with `journalTotal` when there are more.
- `manage_trade_journal` with `action: "list"` returns the notes for an environment, optionally for one instrument (a ticker that a note carries matches even when Trading 212 no longer lists it) or one order.

## Looking back

The **Journal** tab, or `get_journal_review` in the chat, sets each note on an order filled in the period next to how that trade has gone since:

- **Edge**: how far the price has moved in the trade's favour since the fill, up for a buy and down for a sell. The fill price is compared with the price now: the broker's for a holding, the quote provider's for an instrument you no longer hold. The quote provider is asked about 8 instruments at most per look, one at a time, since free plans allow only a few requests a minute and price alerts use the same allowance; the page names any left unpriced that way. An instrument with no quote, or a quote ten times from the fill price either way (most likely a symbol mapped to another unit, such as pounds for a fund quoted in pence), counts without an edge, and the page says which. FX and costs are left out, and each trade counts once whatever its size, so it measures the call rather than the money.
- **Went your way**: how many of the priced trades have an edge above 0.05% (a smaller move reads as unchanged), and the average edge, for all of them and per tag. A tag's row shows its average as a bar from a centre line, right when it went your way and left when it went against you. Choosing a tag reads the review again for that tag alone, so every figure on the page is about its trades, and **All trades** goes back; the row of trades without a tag is not a filter.
- **Realised on these sells**: what Trading 212 booked on the sells with a note.
- **Trades with a note**: how many of the period's fills have a note, and how many of those have a look back.
- **Due for a look back**: trades with a reason, no look back, and at least 30 days since the fill. Each says so, and **Add a look back** writes one under the trade, which stays in view while you write.

The tab follows the period switch (1M, 3M, YTD, 1Y, All), and an instrument's name opens its holding page, whose Back link returns to the journal. Notes on orders that are not among the period's fills (still open, cancelled, filled before it, or reported without a price) and notes without an order are counted at the foot. An order history read is kept for a minute for each period; sending or cancelling an order drops it, so a new fill shows the next time the tab opens. A note written on a holding page opened from the journal shows when Back returns to it.

The `trade-journal` skill uses all of these to review your trades: it reads the reasons you gave at the time next to how each trade turned out, and saves what you take from it as the review.

## Changing and deleting

`manage_trade_journal` with `action: "update"` and an `entryId` changes the thesis, review or tags; a field left out stays as it is and an empty value clears it, as long as the note keeps a thesis or a review. `action: "delete"` removes the note. On the holding page, **Edit** and **Delete** do the same, and Delete asks once more in place.

The journal tool works without order tools (`trade:write`), like price alerts, since it never trades.
