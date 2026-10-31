# Watchlist

English · [简体中文](./zh-CN/WATCHLIST.md)

The watchlist follows instruments you hold or not: how each one's price is moving, where it sits in its year, and how close it is to the orders and alerts you have on it. Trading 212's Public API has no watchlists, so TradePilot keeps its own, per account, in the store that keeps price alerts and plans. It is never sent to Trading 212 and places nothing.

## Adding and removing

- **From the Watchlist tab.** Type a name, symbol or ISIN under **Add an instrument**; matches show as you type, an exact ticker, symbol or ISIN first, and the ones on the list already say so.
- **From an instrument's page.** **Watch** adds it; **★ Watching** takes it off. The page says since when it is on the list, with its note.
- **From the chat.** `manage_watchlist` with `action: "add"`, an `instrument` (a ticker, symbol, name or ISIN, resolved like an order) and an optional `note`; `action: "note"` changes the note of one on the list (an empty note clears it) and never adds it; `action: "remove"` takes it off. Adding one that is on the list already changes its note.

An instrument is added at its price then (Trading 212's for a holding, else the quote provider's when it answers within 3 seconds), for the move since. Up to 50 instruments per account, each with a note of up to 200 characters on why it is there; **Add a note** and **Edit note** write it in place. × takes a row off; a row Trading 212 no longer lists can still be taken off by its ticker.

## What each row shows

- **The price now**: Trading 212's for a holding, the quote provider's otherwise, else the last daily close, named with its date.
- **The change** to that price since the previous close (**1D**: the last close before the day the price is from, so a quote from Friday is compared with Thursday over the weekend; for a holding, Trading 212's price belongs to its market's session in progress or its last one, as on the dashboard), or over 1, 3 or 12 months when the closes cover the period in full. The figure is written out, not only coloured.
- **Three months** of closes as a small line ending at the price now, green when it ends above where it started and red when below, with the start dotted across.
- **The 12-month range**: where the price sits between the lowest and highest close of the year (and the price now), and how far below the high it is. When the closes cover less than a year (a recent listing, or Alpha Vantage's 100 days), the row gives the range since their first day instead.
- **Levels**: the nearest open order (a stop at its trigger, a limit at its price) or armed above/below price alert, and its distance from the price; "+2 more" when there are others. `get_watchlist` returns all of them, nearest first.
- **Since added**: the move from the price it was added at, shown once a day has passed. It is left out when the two prices are ten times apart, which means one of them is in another unit.
- **Your note.**

Sort by the order added, the biggest move over the chosen period, or the nearest order or alert. A row opens the instrument's page.

## New on Trading 212

Under the watchlist, **New on Trading 212** lists the instruments Trading 212 added in the last 7, 30 or 90 days, newest first, by the listing date its instrument list gives each one (`addedOn`). Chips choose a type (stocks, ETFs and the others it lists), each with how many were added in the window; a row opens the instrument's page and **Add** puts it on the watchlist. The panel reads nothing until you open it: one read of the instrument list, which TradePilot keeps for ten minutes and shares with the search. Instruments without a date are never counted as new, and the panel says how many there are.

At the bottom, the panel turns on a listing alert for what it shows (a type, a currency, or anything), changes it to that, or turns it off: the scheduler then checks hourly and notifies when Trading 212 lists more ([AUTOMATION.md](./AUTOMATION.md#listing-alerts)).

`list_new_instruments` gives the same in the chat (`days` up to 365, `type`, `currency`, `limit` up to 100) and opens the panel with what it read. It is read-only.

## Prices and limits

The daily closes come from the quote provider, the same ones the holding page's chart draws, cached for half an hour ([AUTOMATION.md](./AUTOMATION.md#quotes-for-instruments-you-do-not-hold)). The tab reads four instruments at a time and starts no new reads after 5 seconds; a row past that is named and gets its prices on the next refresh. Closes ten times or more from Trading 212's price, or from the instrument's order and alert prices, are taken to be in another unit and not used, and the provider's quote for it is left out too; the quote is checked against the order and alert prices the same way when the closes did not come. The row names the `QUOTE_SYMBOLS` factor that fixes it. Without a quote provider, or for an instrument it has no symbol for, a held instrument still shows Trading 212's price and the others show why they have none.

Free provider plans allow only a few requests a minute, shared with price alerts and the holding page, so a long watchlist fills over a couple of refreshes on those.

## In the chat

`get_watchlist` returns the rows above, with a text summary for hosts without the widget: each instrument's price and where it came from, the change over each period the closes cover, the range, the levels, the position when held, the move since added and the note. Both tools work without order tools.

The sample account (`TRADEPILOT_SAMPLE_DATA=true`) prices its own instruments with simulated quotes and closes, offline, and lists Amazon and ASML to watch besides its holdings; four instruments it lists were added in the last two months, for the New on Trading 212 panel.
