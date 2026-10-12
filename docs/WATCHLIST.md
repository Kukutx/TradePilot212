# Watchlist

The watchlist follows instruments you hold or not: how each one's price is moving, where it sits in its year, and how close it is to the orders and alerts you have on it. Trading 212's Public API has no watchlists, so TradePilot keeps its own, per account, in the store that keeps price alerts and plans. It is never sent to Trading 212 and places nothing.

## Adding and removing

- **From the Watchlist tab.** Type a name, symbol or ISIN under **Add an instrument**; matches show as you type, an exact ticker, symbol or ISIN first, and the ones on the list already say so.
- **From an instrument's page.** **Watch** adds it; **★ Watching** takes it off. The page says since when it is on the list, with its note.
- **From the chat.** `manage_watchlist` with `action: "add"`, an `instrument` (a ticker, symbol, name or ISIN, resolved like an order) and an optional `note`, or `action: "remove"`. Adding one that is on the list already changes its note, and an empty note clears it.

An instrument is added at its price then (Trading 212's for a holding, else the quote provider's when it answers within 3 seconds), for the move since. Up to 50 instruments per account, each with a note of up to 200 characters on why it is there; **Add a note** and **Edit note** write it in place. × takes a row off; a row Trading 212 no longer lists can still be taken off by its ticker.

## What each row shows

- **The price now**: Trading 212's for a holding, the quote provider's otherwise, else the last daily close, named with its date.
- **The change** to that price since the last close before today (**1D**), or over 1, 3 or 12 months when the closes cover the period in full. The figure is written out, not only coloured.
- **Three months** of closes as a small line ending at the price now, green when it ends above where it started and red when below, with the start dotted across.
- **The 12-month range**: where the price sits between the lowest and highest close of the year (and the price now), and how far below the high it is.
- **Levels**: the nearest open order (a stop at its trigger, a limit at its price) or armed above/below price alert, and its distance from the price; "+2 more" when there are others. `get_watchlist` returns all of them, nearest first.
- **Since added**: the move from the price it was added at, shown from the day after. It is left out when the two prices are ten times apart, which means one of them is in another unit.
- **Your note.**

Sort by the order added, the biggest move over the chosen period, or the nearest order or alert. A row opens the instrument's page.

## Prices and limits

The daily closes come from the quote provider, the same ones the holding page's chart draws, cached for half an hour ([AUTOMATION.md](./AUTOMATION.md#quotes-for-instruments-you-do-not-hold)). The tab reads four instruments at a time and starts no new reads after 5 seconds; a row past that is named and gets its prices on the next refresh. Closes ten times or more from Trading 212's price, or from the instrument's order and alert prices, are taken to be in another unit and not used, and the provider's quote for it is left out too; the row names the `QUOTE_SYMBOLS` mapping with the factor that fixes it. Without a quote provider, or for an instrument it has no symbol for, a held instrument still shows Trading 212's price and the others show why they have none.

Free provider plans allow only a few requests a minute, shared with price alerts and the holding page, so a long watchlist fills over a couple of refreshes on those.

## In the chat

`get_watchlist` returns the rows above, with a text summary for hosts without the widget: each instrument's price and where it came from, the 1D and 1M change, the range, the levels, the position when held, the move since added and the note. Both tools work without order tools.

The sample account (`TRADEPILOT_SAMPLE_DATA=true`) prices its own instruments with simulated quotes and closes, offline, and lists Amazon and ASML to watch besides its holdings.
