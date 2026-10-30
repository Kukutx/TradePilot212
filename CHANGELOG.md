# Changelog

## 2.71.0

- A check of the widget as drawn. `pnpm audit:ui` opens every view of the preview (the sample account, 28 views) at the three host widths (375, 720 and 1040 px), in light and dark, in English and Chinese, in a headless browser. Each view is checked as it opens and again with everything folded opened: charts shown as tables, "show all" lists, collapsed sections and the date-range panel. It fails when the widget scrolls sideways, a box sticks out past the frame's edge, text is under 12px, a form control keeps the browser's own look, an image is broken or a script error is logged. With `--shots=<folder>` it also saves a picture of each, to look over by eye; `--views`, `--widths`, `--themes` and `--langs` narrow it. It needs Playwright with Chromium.
- What it found, fixed: the search boxes (watchlist, trades) and the date boxes kept the browser's own look underneath the widget's styling, which Safari draws rounded; the order status page and charts shown as tables drew their second line at the browser's "smaller" size, 10.8–11.7px. `<small>` text is now never under 12px.
- The audit also fails on text cut off with nothing showing the rest (an ellipsis or a two-line clamp with no title, or text clipped by its box), on controls under 24px either way (WCAG 2.5.8), on text under 12px in form fields, in what CSS adds before or after an element and in charts as drawn, on boxes fixed past the edge, and on any failed request, named by its address. Besides the folded parts, it chooses each option of every switch and tab list in turn (periods, Value and Drawdown, the history switches, the plan's tabs) and checks the view after each. A view that never finishes loading fails rather than passing empty. A misspelt `--views`, `--widths`, `--themes` or `--langs` stops it rather than checking the preview's default instead; it starts its own preview and waits for that one to say it is listening, so another server on the port is never checked; one view that cannot be checked does not stop the rest. It exits 2 when it could not check, 1 on problems. With `--shots` it saves each view as it opens as well as opened, without the preview's bar over the top.
- The order status page names a limit or stop order as the rest of the widget does, "Limit $215.00", not "Limit · Limit price $215.00".
- What the wider audit found, fixed. A figure too long for its box ("13.4% / target 23.8%" in a holding's share of the account at 375px) and a trade's note cut to two lines now carry the whole text as a title. Names in tables, "Add a note" and the sortable column headers are 24px targets. A tab of the view bar reached with the keyboard scrolls into view, so its focus ring is not cut off. The day's move under a price is no longer faded, which took green under 4.5:1 in light and red in dark; the allocation warning's "!" is dark on amber (white was 2.2:1).

## 2.70.0

- Checked against Trading 212's API document, offline. `docs/api/trading212-public-api-v0.json` records what Trading 212's OpenAPI document lists (read 2026-10-30): its 22 operations with their query parameters and rate limits, the fields of the responses TradePilot reads (the pies' are not recorded yet) and of every request body, and the enums it relies on. A new test, also run alone as `pnpm check:api`, sends every request the client can make to the sample account, every page of the history included, and checks the pie and report bodies TradePilot builds. It fails when an operation is missing or unknown, when a query parameter or body field is not listed (an empty one included), when a page asks for more than 50 records, or when the sample account answers with a field the document does not list. All 22 operations are used and every request matches the document.
- The sample account now answers as Trading 212 does. Open orders carry their side and say how long they stay open as `timeInForce`, not as the request's `timeValidity`. A position names its instrument with the four fields Trading 212 gives (ticker, name, ISIN, currency); the rest comes from the instrument list, as for a real account. Interest on cash is `INTEREST_ON_FREE_CASH`. History comes in pages of 10, so the reads follow `nextPagePath` as on a larger account.
- A holding opened by its exact ticker, as the Holdings tab opens it, again shows its type ("Stocks") and short name: they now come from the instrument list, since a real position does not carry them. For the same reason the daily digest names a holding's dividends by its symbol rather than its full ticker, and an open order's short name is taken from the instrument list.
- Open orders show how long they stay open on the Holdings tab and in the cancel review: "Day only" or "Good till cancelled" (当日有效, 撤单前有效).
- The rate limiter's notes give the documented 20 history reads a minute, not six.

## 2.69.0

- Dividend yield. The Income tab shows the holdings' dividends as a yield on cost (over Trading 212's total cost of the holdings) and on value now, from each holding's last 12 months of dividends per share at the quantity held now, so a holding sold down or bought up over the year is not over- or understated; and the next 12 months' expected dividends on cost. Per holding, each that paid or is expected to pay, highest yield on cost first, with its symbol, what it actually paid and what it is expected to pay. Dividends of instruments sold since are left out; a holding without a total cost, or without Trading 212's value, leaves that yield of the account out rather than guessing it, and a holding that cost nothing is counted at 0.
- Cash not invested. Beside it: the cash free to trade, in pies and reserved for orders, and their total's share of the account; the last 12 months' interest on cash, with share-lending income apart; and that interest as a yearly rate over the average free cash of the days TradePilot recorded, once it has a month of them (four days in five), rather than over today's balance, which a large purchase can shrink to almost nothing. `get_income_summary` returns both as `yields` and `cash`, and its text names them with the currency. Both need a period that ends now, as only today's holdings and cash are known; a last day picked as the reader's own today counts, west of UTC too, and so does a period whose history took long to read. For a period that ended earlier the tab says why they are missing.

## 2.68.0

- Your own days. Beside the period switch on the Performance, Income, Journal, Trades and Cash tabs, a calendar button opens two date boxes: choose a first and a last day and the tab reads just those days, as the tools already could with `from` and `to`. The range then holds on every tab with the switch until a period is chosen again or **Back to the period** is pressed, and the button names it ("Mar 1 – Apr 15, 2026"). The days are checked before anything is read (both given, the first not after the last, the last not after today), both are included, and they run midnight to midnight UTC as the periods do. A window with a first day that the host read and that is none of the periods shows on the same button, and is read again with its own bounds. The last day may be the reader's own today, a day ahead of UTC or behind it.
- The date boxes are drawn in the widget's style: its own calendar icon (the browser's picker still opens from it), the theme's colours in light and dark, and the system's colours in high contrast. Escape closes the panel and the focus returns to the button; a day that cannot be read puts its message on the box that is wrong and moves the focus there. Each tab remembers what it was read for, so a tab read for a range is read again once a period is chosen, even when the range looks like one of the periods.
- On a computer set to dark mode, a widget shown in light no longer takes the dark theme's chart blue, holdings-map and correlation shades: those follow the widget's own theme only.

## 2.67.0

- UK share matching (an estimate). A UK tax year (from 6 April) now also shows its sales matched as HMRC matches them: with shares of the same instrument bought the same UK day, then in the 30 days after, then from the section 104 pool at its average cost. Gains and losses are kept apart per disposal, days and the year are UK time whatever zone the rest of the summary counts in, and one company under two tickers is one pool by its ISIN. The tax year page sets the net gain by those rules beside Trading 212's average-price figure, per instrument with how many shares each rule matched, and says why they differ; `get_tax_year_summary` returns it as `ukMatching`. A UK year reads all history once through the ledger, takes the year's sales from it, and sets each instrument's fills against the shares held now: an instrument whose fills do not add up to what is held (a transfer, a split), with fills that were not trades, or with shares it cannot match or value is marked on its row, and the result is marked incomplete and not compared with Trading 212's figure. A year whose last 30-day buys can still come in says its figures can change, and an account not in GBP is said to need converting.

## 2.66.0

- Fewer waits on Trading 212's limits. Reads of one account are shared by the widget, the model's tools and the scheduler in a process: a read already on its way is joined rather than sent again, and when the account summary, positions or orders are read again with their limit used up (the summary allows one in five seconds), the answer from the last five seconds is returned instead of waiting. The income page reads the summary and the positions at once.
- What must be current is read from Trading 212 then: the holdings and cash an order or a basket is sent against, the order book linked stop-loss and take-profit pairs are settled from, and the check of an order whose outcome was unknown. An order or a cancel forgets what was kept for its account.
- On Cloudflare a read another request started is never waited on (Trading 212 reads, the instrument and exchange lists, the account summary, the dashboard, a report's download): Workers cancels a request's fetch once it has answered, which could leave the others waiting. Elsewhere a Trading 212 read on its way for longer than any read can take is not joined.

## 2.65.0

- An empty panel says what it is and what to do next. Panels that would have a chart keep their title when there is nothing to chart, and say what is missing in their own words (no fees in this period, nothing sold to rank, no dividends or interest) rather than "No data". Where a shorter period is empty, the panel offers **Show all time**; an instrument filter that matches nothing offers to clear it; a journal tag with no trades offers all trades. Empty plans, alerts and linked pairs on the automation page say how to make one.
- Search boxes (the history filter, the watchlist and target searches) draw their own clear button in every browser, Firefox included, and Escape clears them; a second Escape is left to whatever it closes.
- Loading looks alive: a thin sweep runs along the top while anything loads, so refreshing a view already shown is seen, and the skeletons shimmer rather than blink. Both hold still for reduced motion and use the system colours in high contrast.
- Development: wrangler's miniflare pinned an undici with eight advisories (four high); `pnpm-workspace.yaml` now overrides it to 7.30.1. This only affected local `wrangler dev` and deploys, not the server or the widget.

## 2.64.0

- The order form's side, type and validity are rows of buttons rather than menus, so every choice is in view; buy and sell take their colours when chosen. Quantity and prices are typed as text with the decimal keypad, read with a point or a comma like the other forms, and a scroll wheel or an arrow key no longer changes them by one. A single comma before exactly three digits ("2,125") could be either mark, so the form asks for a point or no comma rather than guessing; full-width digits typed on a Chinese keyboard read as ordinary ones everywhere an amount is typed.
- Every switch of a few choices (periods, table or map, chart views, history views, tax rules, cash types, the watchlist's period, the order form's choices) is one Tab stop: the arrow keys, Home and End move between its choices and choose them, as radio buttons do. A key with Alt, Ctrl or Cmd is left to the browser, and a switch that loads data (periods, history views, tax rules) only moves focus with the arrows, Space or Enter choosing, so a quick run of arrows does not start a load per step; while one loads the switch stays focusable.
- High-contrast mode keeps the drawn controls readable: a ticked box, an on switch and a chosen option take the system's highlight, selects go back to the system's own arrow, and the focus ring takes the system's text colour.
- The activity and unfilled-order lists have a chevron that turns as they open, disclosures show the focus ring, placeholders are in the muted text colour, a dialog's Tab loop skips the options a radio group reaches by arrow, and anything the browser still draws takes the primary colour. Where a note cannot grow as it is typed (Firefox, older Safari) it starts taller and scrolls.

- The twelve guides in docs/ are in Simplified Chinese too, in docs/zh-CN, each linked to and from its English version; the Chinese README links to them. Their headings keep the English anchors, so links into a section work in both.

## 2.63.0

- Price and exchange rate: a holding in another currency than the account's shows how much of its unrealized P/L came from the price and how much from the exchange rate since it was bought, from Trading 212's `fxImpact`. The overview and a holding's page split the P/L into the two as bars from zero, the holdings list gives each holding's rate part under its P/L, the dashboard's text names both, and `analyze_portfolio_allocation` returns each holding's `fxImpact`. A foreign holding without the figure is not split rather than guessed.
- The sample account's US and UK holdings were bought at other exchange rates than today's, so it shows the split; its past fills carry the rate of their day.

## 2.62.0

- Your own time zone and tax year. `TIMEZONE` (an IANA zone such as Europe/London) sets the day TradePilot counts in: the daily order and value limits reset at local midnight rather than UTC, the digest's dividend week follows it, and the tax year's days are counted in it. `TAX_YEAR_START` (MM-DD, `04-06` for the UK) is the tax year `get_tax_year_summary` and the History tab use unless another is chosen. Without `TIMEZONE`, a year from 6 April is counted in London and any other in UTC on the server, and in the viewer's own zone in the widget, as before; the History tab reads its year again in the server's zone once it learns it. On the day the zone first changes, the limits and the digest join the new days once (a few more hours on the day's budget behind UTC, a second digest ahead of it).
- A UK year counted in another zone than London's no longer shows the UK rule as chosen, so it can be picked. A tax year starting on a day whose midnight is skipped by a clock change (Santiago, Havana) starts when the clocks jump.
- `DIGEST_HOUR` sends the daily digest at a local hour in `TIMEZONE`, one a local day; `DIGEST_HOUR_UTC` still works (set one, not both).
- The automation page shows the digest's hour with its zone, the zone days are counted in and the tax year's first day. The overview's `settings.digestHourUtc` is now `digestHour` with `digestTimeZone`.
- `T212_DEMO_BASE_URL` and `T212_LIVE_BASE_URL` send Trading 212 requests to another address, such as a proxy you run: HTTPS only (or http on a loopback host), without credentials, a query or a fragment, and never with the sample account. Trading 212 requests never follow a redirect: a read that gets one fails, and a write that gets one has an unknown outcome to verify.

## 2.61.0

- Against the market, on the Allocation tab: how the holdings move with the benchmark (`BENCHMARK`, the S&P 500 through SPY by default). Each holding's beta and correlation to it from a year of weekly closes, the holdings' beta together (their weights times their betas), the benchmark's volatility and its worst week with what today's mix did that week, and what a 5%, 10% and 20% fall in it would take by that beta, in the account currency and as a share of the account. Each holding is a bar from 0 with a mark at 1, with a table view. `analyze_portfolio_allocation` returns it as `risk.market`, its text gives the falls, and the risk-check skill reports them as history, not a forecast.

## 2.60.1

- An order looked up by id opens on a page of its own (`get_order_status`): where it stands, how much of it filled as a bar, the average fill price and value, each fill, **Check again**, and **Review cancel** while it is open (with order tools); a cancellation made there comes back to the order, showing how it ended.
- Trading 212's CSV reports open on a page too (`manage_history_export`): the reports, newest first, with whether each is ready, being built or failed and **Read** for the ready ones, and a report read: its period and rows, realised result, net dividends and interest, each charge by currency, and each action's rows and total.
- The automation page has the trading rules: today's orders and value against their daily limits as bars (amber near the limit, red at it), the position cap, the largest order and the most shares in one, the allowed and blocked tickers and types, whether Market orders wait for the open and how fresh a reference price must be. `get_trading_policy`, `list_price_alerts` and `list_investment_plans` open on it, `manage_target_allocation` on Allocation and `get_recent_trading_activity` on the account with its activity. `get_quote` and `get_market_hours`, which the model uses on the way to an order, stay text. Each opens for the account it names (a list of both accounts, for the server's default); one shown again in an older chat waits for **Show it now** rather than reading the account by itself, and an account without keys shows its setup.

## 2.60.0

- A History tab with three pages. **Trades** adds up the period's fills (realised result, money bought and sold, costs) and lists them a day at a time, each with its journal note, a filter by instrument and the orders that did not fill. **Cash** gives the net movement and net contributions, the totals of deposits, withdrawals, dividends, interest and fees, a filter by kind and every movement by day. **Tax year** shows a calendar or UK (6 April) year, stepped back and forward, with the net gain on sales, gains and losses apart, dividends, interest, costs, the result per instrument and a note that it is not a tax calculation. `get_trade_history`, `get_cash_history` and `get_tax_year_summary` now open in the widget, and their results say which period they cover (`period`).
- The trade page's realised result, money bought and sold, costs and counts are of every fill in the period, not only the newest listed: `get_trade_history` now returns `totals` and `count` over the whole window, and `limit`, and the page says when only the newest are listed. The cash page takes whether a movement is money in or out from its kind (a withdrawal is out whatever its sign), as the performance page does.
- A read the host limited is shown as such: the instrument or kinds asked for (`filter`, now in both results) and a window none of the periods is, with **Show all** to read everything; choosing a period keeps the instrument. A tax year starting on another day than 1 January or 6 April (a fiscal year from 1 July, say) keeps its start as the year is stepped, and the year buttons step the year shown.
- Pies and Automation are tabs too, next to Holdings, Watchlist, Allocation, Performance, Income and Journal, and are read when opened. Changing an alert from the automation page reloads it.
- Lists of records keep to the card's width: a long name is cut short and the amount stays beside it. On a phone each switch above a page (periods, history kinds, tax rules) takes the row, its choices sharing it evenly.

## 2.59.0

- The skills are MCP prompts. Any MCP client, not only the Claude Code plugin, can run the daily brief, portfolio review, risk check, trade journal, order follow-up, tax year and rebalance. Each prompt takes the account (`environment`) and the request in the user's words; the trade journal and order follow-up also take an `instrument`. The prompts are generated from `skills/` (`pnpm build:prompts`), and a test keeps them the same.
- The account's saved state is available as resources: `tradepilot://<demo|live>/holdings` (account summary, holdings and open orders), `/journal`, `/targets` and `/watchlist`, as JSON, for each account with keys.
- The prompts' arguments complete as they are typed: `environment` offers demo and live, and `instrument` the tickers the account holds, has orders on or watches.

## 2.58.0

- Every tool declares what it returns. Each of the 55 tools has an `outputSchema`: an open object whose `kind` names the payload (portfolio, allocation, tax_year, order_preview, order_execution …), with its main fields typed and the shared ones (environment, truncated, token, status …) described. A host can plan with the shape and check it, and the server checks each result against it, so the schemas are kept true by a test that calls every tool on the sample account (all but `app_verify_unknown_execution`, which is checked by its schema). What the broker sends back for an order, cancel or pie change is not typed, so an unusual reply never turns an accepted change into an error.
- Every tool that changes something says whether calling it again with the same arguments changes anything more (`idempotentHint`). Saving target weights and the watchlist are idempotent (saving the same targets again also keeps the day's drift notice from coming back); creating an alert, a plan or a journal note, requesting a report, preparing (each call issues a new token) and executing anything are not.

## 2.57.0

- Reads Trading 212's CSV report. `manage_history_export` gains `read`: it downloads a finished report (`reportId`, or the newest report) and adds it up. It gives the rows and Total of each action (Market buy, Dividend (Ordinary), Interest on cash, Deposit …) and, per currency, the charges the API history does not itemise (currency conversion fees, stamp duty reserve tax, French transaction tax, withholding tax and other fees and levies), interest, dividends (net of withholding) and realised result, with the report's period. `rows` returns up to 200 of its newest rows as well. The file is read by its header, so the columns a period lacks and the older files that put the currency in the header are read too. It is fetched over https from Trading 212's storage without the API key (a redirect only to https), up to 25 MB counted as it arrives, within a minute, and kept per process as its totals and newest rows.
- Asking twice no longer builds two reports: `request` gives a report that holds the period instead (queued, being built or finished, from the same start or earlier to the same end or later, less an hour, with every kind of record), and requests nothing when the reports cannot be listed. The tax-year skill requests and reads the report for the withholding and charges a return may need.

## 2.56.0

- History is read once and kept. Trading 212's history records are final, so TradePilot now keeps what it reads, per account and kind (orders, dividends, cash movements), up to 10,000 of each. Reads that reach back more than 60 days (performance, tax year, income, journal, all-time trade history) read the newest records down to what is kept, then spend the rest of their `maxPages` going further back from where the last one stopped. They therefore reach further back with every call instead of stopping at the same 2,000 records, and once the whole history is kept a read asks only for the records since the last one and the three days before it.
- Kept without gaps. What is known is kept as runs read without a gap, and a read that cannot reach the older records keeps the newest as a run of its own, returned alone and marked truncated, which the next read joins up. An old limit order that fills is not missed: Trading 212 lists an order by when it was made, so the orders open at each read are noted and, once one closes, looked for in its instrument's history.
- Safe to share. Records are added, never rewritten, as chunks merged on read, so two processes reading at once cannot lose each other's records. A local server keeps the ledger in a file of its own (`ledger.json`), and Cloudflare in values of under a million characters. A failing store or unreadable open orders fall back to reading Trading 212 as before, and a stale cursor costs only the run it ended, which later reads read past. The account is named in storage by a one-way digest of its API key. A truncated result now says that a higher `maxPages`, or for long periods asking again, reads further back. More in docs/ANALYTICS.md, **The history ledger**.

## 2.55.0

- Requests keep to Trading 212's limits before they are sent. Every response says how many requests its endpoint has left for the account and when that resets; the widget, the model's tools, the scheduled runs and background reads now share one record of it, per account and endpoint. A request to an endpoint with nothing left waits for the reset (a read up to a minute, an order up to 15 seconds), and when it resets one request goes first while the rest wait a moment for what its response says, so callers at once no longer all spend a 429 and back off together. A reset more than five minutes off is taken as five minutes. One whose limit resets later than that is refused before it is sent, with when it resets; an order refused this way was never sent, so its status is known.
- A history read the limit would hold longer than that comes back with the pages it read, marked truncated, instead of failing; it is not cached, so the next read gets it whole. The `maxPages` description and docs/ANALYTICS.md no longer state a fixed number of history requests a minute, and the README has a **Rate limits** section.

## 2.54.0

- A more modern look. Cards sit just above the page on a soft shadow, the account overview carries a faint wash of colour, and its value and the tiles' figures are larger. The tabs are pills on a quiet rail, buttons and rows answer the pointer, and a view's panels rise in a few frames apart (not at all with reduced motion). The brand mark has a gradient.
- Each instrument has its own tint. Its two letters sit on a colour taken from its symbol, the same in the holdings, the watchlist, the trade plan and baskets, in light and dark, so a row is found again at a glance.
- Figures use Inter's tabular digits everywhere, so columns of numbers line up.
- No browser-default controls left. Scrollbars are a thin rounded thumb in the theme's colours, with no arrows; selects have the widget's own chevron and their lists follow the theme; checkboxes are rounded boxes with a tick; the search box's clear button is a muted cross; number fields have no spinners anywhere; disclosures turn a chevron instead of the system triangle; and notes grow with what is typed instead of showing a resize grip.
- Blind spots fixed on the way: a field beside one with a hint (the order form's **Validity**) no longer drops below its label; a switch that is on is green, visible in the dark theme too, and shows the keyboard focus; while a view loads, the other tabs wait without dropping the keyboard focus.
- A change that rounds to 0% now reads "+0%" in the text a host shows, whichever way it moved, rather than "0%" for a tiny fall and "+0%" for a tiny rise. Tests that read the sample account's prices for today no longer fail on such days, or when its readings fall in different months.
- `zod` is lifted to 4.6.7 (GHSA-mrhx-c7xc-m3w5).

## 2.53.0

- Rebalance only what drifted. `plan_portfolio_rebalance` takes a `band`: only the targets more than that share of the account off their weight trade, sells of those over it paying for buys of those under it, and the rest stay as they are. Cash that would then stay more than the band over its target goes to the targets below their weight within it, so the plan doesn't leave a new drift behind. A note says how many it leaves, and its basket is titled **Rebalance what drifted**. Fewer trades, and fewer conversion fees, for the cost of leaving small drifts.
- Saved targets offer it at their notice threshold. Under the drift, the Allocation tab says what rebalancing only the ones the drift list marks would buy and sell, naming them, with the conversion fee, beside the full rebalance; **Rebalance what drifted** opens that plan as a basket to review. `analyze_portfolio_allocation` and `manage_target_allocation` return it as `drift.rebalanceOver` and say it in their text, with the `band` that plans it.

## 2.52.0

- What a rebalance trades, and what converting costs. A rebalance plan now gives what its buys and sells come to and, for the trades in another currency than the account's, Trading 212's 0.15% currency conversion fee on them: the basket's summary shows **Buys**, **Sells** and **FX fee, at most**, a note says it, and `plan_portfolio_rebalance` returns it as `totals`. Pence count as pounds. The buys now leave room for the fee, and the cash after is net of it, so a plan that spends all the free cash doesn't run short at its last order; an `investAmount` includes it. A plan short only of the fee doesn't say its buys are scaled, and a scaled one never says 100%. It is at most that, as a trade paid from or into a balance held in the instrument's own currency converts nothing.
- Saved targets say it before any plan: under the drift, the Allocation tab gives what a rebalance to them would buy and sell and the fee on the part in other currencies, with the buys fitted to the cash as the planner fits them (and how far the cash goes when it falls short), and `analyze_portfolio_allocation` and `manage_target_allocation` return it as `drift.rebalance` (with each drift row's `currency`) and say it in their text. The target form says the same for the weights typed, as you type; **Today's weights** now fill each share to the nearest 0.01% rather than down, so they trade nothing.
- After a trade is taken out of a rebalance basket, its summary adds up the trades left and the cash after them.
- `FX_FEE_RATE` sets the fee (a fraction, default `0.0015`; 0 if you trade from balances in each currency). The self-host deploy script now also syncs `FX_FEE_RATE`, `BENCHMARK` and `ORDER_WATCH`.

## 2.51.0

- Targets you don't hold yet. The target form on the Allocation tab searches Trading 212's instruments and adds one as a target, beside the holdings; a target not held, saved or added, can be removed from the form with its own button. Enter in the search never saves the form. Equal weights share what the cash leaves among them too (they come first when there are more than 20).
- They count in the risk at the targets: their closes are read beside the holdings', over the same weeks, so the volatility the targets would give, the whole account's included, and each one's share of the risk take them in. While an added one is read the figures stay and say so; one whose closes weren't read this time says a **Refresh** counts it, and one without closes over those weeks is named and left out.
- Saved targets not held count the same way in `drift.volatility` from `analyze_portfolio_allocation` and `manage_target_allocation`, and in the volatility beside the drift.
- The watchlist and the target form share one instrument search.

## 2.50.0

- Risk at the targets typed. The target form on the Allocation tab works out, as each share is typed, the volatility a year the targets would give: the holdings measured together, and the whole account with cash counted as not moving, each beside today's, and under each holding its share of the risk now and at the targets. It reads the holdings' covariance as it opens, for the holdings and the weeks risk by holding measured (when what it reads doesn't match the risk on screen, as when closes are still on their way, it asks for a **Refresh**); a target not held, or a holding not measured, is named and left out, and then the whole account is not given.
- The form says when the holdings kept without a target, with the targets and the cash, come to more than the account, so a rebalance can't reach every target.
- Saved targets say it too: beside their drift, the Allocation tab gives the volatility the targets would give against today's, and `analyze_portfolio_allocation` and `manage_target_allocation` return it as `drift.volatility` and say it in their text.
- The covariance goes only to the widget, through the app-only tool `app_get_holding_covariance`, so the model's context does not carry a matrix of every pair of holdings.

## 2.49.0

- Target weights in the widget. The Allocation tab sets, edits and removes the saved targets, which until now only the assistant could: **Set targets** (or **Edit targets** beside their drift) opens a share for each holding, typed in or filled from today's weights, equal weights or the equal-risk weights, with the cash share, the notice threshold and whether a rebalance sells holdings without a target. It says what the targets and cash come to and what is wrong before saving, checking the shares as the server keeps them, and the drift shows as soon as they are saved. With more than 20 holdings, the presets fill the 20 largest and say what happens to the others. **Use as targets** under the equal-risk weights opens it filled with them. Targets never trade; they work without order tools.

## 2.48.0

- Equal-risk weights. Below today's mix, the Allocation tab gives the weights at which each holding measured would bring the same share of their risk (risk parity), beside today's, as a dumbbell per holding, furthest first, with a table view. The tiles give their volatility together beside today's, what moving to them sells and buys again, in the account currency, and the holding furthest from its equal-risk weight.
- The covariance they are solved on is shrunk toward the average correlation as far as the weeks leave each pair in doubt (Ledoit–Wolf), so 52 weeks of many holdings do not give weights that chase noise. A holding that moved less than 2% a year keeps its weight.
- With order tools, **Plan this rebalance** drafts the move as one basket to review: the holdings measured keep their value together, and the holdings not measured and the free cash stay as they are. Nothing is sent until the basket is confirmed.
- `analyze_portfolio_allocation` returns each row's `parity` and `risk.parityVolatility`, and its text gives the equal-risk weights and the `plan_portfolio_rebalance` targets that move to them.

## 2.47.0

- Today's mix over the year. Below risk by holding, the Allocation tab draws what the holdings measured would have done over the same weeks at today's weights, put back to them each week: its return, **a bad week, 1 in 20** (the weekly return it fell to or below in its worst 5% of weeks, a historical 95% value at risk, in percent and in the account currency on today's value, with the average of those weeks), its worst and best weeks and its deepest fall, with a table view of the line.
- `analyze_portfolio_allocation` returns it as `risk.mix` and says it in its text and its one-line summary. It reuses the closes read for risk by holding: no new reads.

## 2.46.0

- Risk by holding. The Allocation tab shows each holding's share of the holdings' risk beside its share of their value, as two bars, from a year of weekly closes: a holding with a longer risk bar swings more than its weight says, or moves more with the rest. Above them, their volatility together, a diversification ratio (1 when they all move as one) and the holding with most of the risk; below them, how the ten largest move with each other, a grid tinted amber for together and blue for apart with each value written in it. Both have a table view or hover text.
- `analyze_portfolio_allocation` returns it as `risk` (with `riskMissing` and `riskProblem`) and says it in its text, with the most and least alike pairs. Closes are read largest holdings first, four at a time, waiting five seconds at most; the rest are named, read on in the background and measured on the next **Refresh**. Weekly returns keep markets with different closing hours and holidays in step, and each holding is in its own currency. A holding bought late in the year, or whose weeks do not line up with the rest's, is left out rather than shorten the window for all, and one whose closes jump as across a change of unit is left out too.
- Alpha Vantage's free plan, whose closes reach only about 100 trading days back, is not asked for them, so its daily requests are kept for the rest.
- The sample account's closes now share a market factor, so its holdings move together, as real ones do.

## 2.45.0

- Account alerts. `manage_account_alerts` sets an alert on the account as a whole: its total value or its free cash at or above, or at or below, an amount in the account currency, or its day's move a percent or more either way, once per trading day. Value and cash are checked every minute from one account summary read, shared with a dashboard read seconds before. A triggered alert is logged as `account_alert_triggered`, goes to the webhook and is counted in the daily digest.
- The day's move is the holdings' moves on their latest trading day, against the holdings' value before them; a holding still on the session before (another exchange, before its open) is left out, so one day's move is never reported again the next. A session that closed before the alert was set does not count. All of an account's day's-move alerts are read together, every ten minutes.
- The automation page lists them with the last value read and when each fired, with **Add alert**, **Re-arm** and **Delete**. `list_price_alerts`, the automation overview and their text include them, under their own headings. The preview's sample account has three.
- Amounts typed into the alert forms read either separator: `10,000` is ten thousand (it was read as 10), and `1.250,50` and `10 000` work too. Once a separator is typed, the field says what it read.
- The daily digest counts an alert that fired in the last day even when it has been armed again since (a day's move on its next trading day, or by hand).

## 2.44.0

- Risk. The Performance tab has a **Risk** panel: the time-weighted return's volatility a year (and the benchmark's), its return a year over its volatility (from a year of readings), its beta and correlation to the benchmark, its best and worst days, and how many of the days it moved it rose. Below them, **Daily moves** counts how many days it moved by how much, falls in red and rises in green, each bar with its range and count in its hover text and the table view.
- `get_portfolio_performance` gives the same as `timeWeighted.risk` and `benchmark.risk`, and says them in its text. Stretches count the weekdays they cover, with a weekend joined to its Monday and readings days apart counting as that many; holidays are left out of the day counts, and today until it is over. Beta is fitted to the benchmark's day before, the same day and the day after, so readings taken before the benchmark's close still line up; beta and correlation need 60 stretches and a benchmark that moves.
- The preview's sample account now moves with its benchmark fund on weekdays, a little more than it, and stays still at weekends, so its risk, drawdown and monthly returns read like a real account's. Each sample close's daily move is drawn from its ticker and day, so the account and its fund keep moving together after midnight.

## 2.43.0

- Your position. The holding page draws the holding's value at each daily close beside a dashed line of the net put in (the shares held at the first close at that close, plus buys less sells at their fill prices). The gap is what the price did for the position, whatever was traded; the note gives it in the account currency.
- `get_holding_detail`'s text says the same. When older fills were not read, the chart starts at the oldest one read. When the shares do not add up from the fills, the prices jump as across a split, or a fill lacks its price, the chart is left out and the page says why.

## 2.42.0

- Monthly returns. The Performance tab has a year-by-month grid of the time-weighted return, latest year first, with each year's return at the end of its row. Each cell is tinted green or red by its size, with the value written in it. Months only partly recorded, or reaching back over days with no reading, are outlined and in italics. On a narrow screen each year is a grid of four months a row.
- `get_portfolio_performance` gives the same as `timeWeighted.months` and `timeWeighted.years` (with `partial` and `extended` flags), and lists the last 24 months and every year in its text. Each month runs from the last recorded day before it to its last recorded day, so deposits and withdrawals stay out of it.

## 2.41.0

- Drawdown. The Performance tab's return chart has a third view, **Drawdown**: each recorded day's fall from the highest time-weighted return before it, with the benchmark's beside it. Below it: the deepest fall, from which high to which low, the day it was made up (or that it has not been yet), how far below its high the return is now, and the benchmark's deepest fall over the same days.
- `get_portfolio_performance` gives the same as `timeWeighted.drawdown` and `benchmark.drawdown`, and says them in its text. Because it is read from the time-weighted return, deposits and withdrawals are neither rises nor falls.
- A line chart whose values never move keeps a scale of ±1% when it shows percentages, not ±100%.

## 2.40.0

- Gain by instrument. The Performance tab shows where the period's gain came from: one bar per instrument from a shared zero line, gains to the right and losses to the left, largest first, with the total, each one's return on the money at work (with more than ten, the largest gains and losses first), and a table view of its value at the start, buys, sells, dividends and value now. A name opens the instrument's page.
- For 1 month, 3 months, this year or 12 months, the start is the shares held then (today's, less the buys since, plus the sells since) at the quote provider's close before the first day, at today's exchange rate; over all history it is Trading 212's realised and unrealised P/L plus dividends. Instruments that cannot be valued (no closes, or shares that do not add up after a split) are named rather than guessed.
- `get_portfolio_performance` returns it as `attribution` (or `attributionMissing` and `attributionProblem`), and says the total and the three largest gains or losses in its text. It reads the closes alongside the benchmark and reuses the summary's own read of the history.
- The sample account trades only the instruments it holds, so its shares add up from its fills.

## 2.39.0

- The daily digest names the dividends paid since the previous digest ("dividends 10.95 in: KO 9.7, VUSA 1.25", the five largest and then how many more) and those expected in the coming seven days, then any due in the last seven days and not paid yet, marked as due ("dividends expected this week: AAPL ~2.4 10-14, MSFT ~4.15 due 10-08"). The expected ones come from the Income tab's dividend calendar.
- It reads Trading 212's dividend history for this on each attempt, from the first day of the month a week ago, a year before (at most ten pages, as the Income tab), so a payment due late last month is still marked as due. A digest whose dividends cannot be read goes out without them and the next one names what it missed; a dividend that reaches the history up to three days late is named by the next digest after it appears, and none twice.

## 2.38.0

- A dividend calendar. The Income tab shows this month and the next 11: what was paid so far this month and what each month is expected to bring, from each holding's payments over the last year at the quantity held now, then the payments themselves soonest first, with their approximate dates and amounts. A payment due this month that has not come yet says so.
- Dates follow each holding's own spacing (monthly to yearly, or every week or two where its paydays bear that out), stepped on from its last payment, and keep to month ends for holdings that pay then; a payment is as large as the one a year before it, so a small interim and a large final dividend stay so, and the year's payments add up to its total to the cent.
- A holding's page lists its next four expected dividends and how often it pays, and its dividends now run from the first day of this month a year ago (the title gives the date). `get_income_summary` returns the calendar and the payments (`forwardAnnual.calendar`, `forwardAnnual.upcoming`) while the period ends this month, `get_holding_detail` returns `nextDividends` and `dividendFrequency`, and both say them in their text.
- The expected 12-month total reads payments from the first day of this month a year ago, so a yearly or half-yearly payment due this month and a few days late is no longer missing from it, and it takes only the newest year's paydays, so a year read with one payment twice no longer counts it twice. Entries within ten days of a payday count as part of it, and a correction counts against the payday before it.

## 2.37.0

- A map of the holdings. The dashboard's Positions panel switches between the table and a map: one tile per holding, its area its value, coloured green or red by its move on the day or its return since bought, stronger the further it moved. Each tile shows the symbol, the move and the amount as far as it fits, gives its full description on hover and to screen readers, and opens the holding. The colour scale ends where most holdings' moves do, so one big mover does not wash out the rest; the text stays in the text colour with its sign, and a holding without a figure is hatched. On a phone the map is near square.
- The holdings table sorts: from a **Sort** menu or by clicking the Symbol, Day, Position value or P/L header (largest first, then smallest first, then back to Trading 212's order). Phone cards follow the same order. The view, the order and the map's colour are remembered per viewer where the host allows local storage.

## 2.36.0

- A price alert on the day's move: "tell me when Apple moves 3% either way in a day". It compares the price with its previous close, as the dashboard's day does, fires at most once per trading day, and arms itself again on the next, so it never needs re-arming. It works on holdings and on any instrument the quote provider prices, and the holding page's form offers it for both.
- A session that closed before the alert was set does not count, so an alert set on a weekend waits for Monday instead of reporting Friday's move, and once it has fired for a day only a later day counts. It waits, and says why, while Trading 212's exchange schedules cannot be read or the quote provider does not have the previous close yet. Once it has fired, it reads neither positions nor prices until the next trading day.
- The holding page's price ladder and chart draw a day's-move alert at both of its levels from the previous close, the automation overview gives its last change ("on the day -2.14%"), and a fired one says it arms itself again on the next trading day, in place of a Re-arm button. `manage_price_alerts` takes `condition: "day_move"`, and `list_price_alerts` gives the change since the close and the day it fired for.

## 2.35.0

- An instrument's page shows its move on the day under the holding's value: what it made or lost in your currency and the price's change since its previous close, with that close written out ("Since the close on Thu, Oct 8: $222.80"). An instrument you do not hold shows the change under its quoted price (before the open, the last session's, since a quote does not move then). The figures are the dashboard's, from the closes the page's chart already reads, so the page asks the quote provider for nothing more.
- `get_holding_detail` returns the move as `day`, and its text has a line for it.
- The daily digest leads with the holdings' move on their last session and the three that moved most: "day -42.56 (-0.85%) on 2026-10-09 · movers: VUSA -2.33%, AAPL +3.93%, MSFT -1.19%". A digest whose day cannot be read goes out without it. It asks the quote provider for each holding's closes, as opening the dashboard does.
- Fixed: a holding opened from the dashboard showed its market session as unknown on a real account, because Trading 212's holdings do not name the instrument's exchange schedule. The page now takes it from the instrument list, which its order history already reads.
- Reads of Trading 212's instrument list and of its exchanges that start at the same moment now share one request, so an instrument's page, the dashboard's day and the watchlist no longer spend Trading 212's tight limits on these lists twice.

## 2.34.0

- The day's move. The dashboard now shows how the holdings moved on the day, in your currency, under the account value, with a **Day** column (a card row on a phone) giving each holding's change since its previous close and what it made or lost. Before the open, at night and over a weekend it is the last session's move, and the dashboard names that day ("Move on Fri, Oct 9, the last session").
- The previous close is the quote provider's last close before the trading day of Trading 212's price, worked out from the exchange's own schedule (the pre-market counts towards the coming day only for instruments Trading 212 trades then); right after a close, closes that do not yet have it give no move instead of two days' worth. Shares bought or sold since the previous session's close count from their fill price, so a holding bought this morning shows only what it did since, and an instrument sold out that day still counts. Amounts are at today's exchange rates.
- `get_portfolio_today` gives the same in the chat: the dashboard with each holding's move, the total and its change, and why a holding has none. The daily-brief skill leads with it.
- The dashboard reads the moves after it shows, so a slow quote provider never holds it up, and says so if they cannot be read. The read reuses the dashboard's account read rather than asking Trading 212 again, and a previous close that will not change is kept for the day, so refreshing asks the quote provider only for what is new.
- The trade history names the instrument of a fill whose order carries its ticker only on the instrument.
- The watchlist's 1D for a holding now uses the same trading day, so over a weekend it is Friday's move rather than none.
- The holdings table gives the shares free to sell under the quantity, and only when some are held in pies or by a pending sell, in place of its own column, so the Day column fits beside the stop-losses. Below 840 pixels the day's move shows under the price.

## 2.33.0

- Your return against the market. The Performance tab's return chart draws an index fund's price over the same days as a dashed grey line beside your time-weighted return, with a legend, both values in the hover readout and a column in the table view. Under it, how many percentage points you are ahead of it or behind it, and its own return. **Compare with** picks the fund: the default, the ETFs you hold or watch, or none; the choice stays as you switch periods.
- The default is the S&P 500 through SPY, which every quote provider maps without `QUOTE_SYMBOLS`; set `BENCHMARK` to another Trading 212 ticker or a US symbol (`BENCHMARK=VWRLl_EQ`, mapped in `QUOTE_SYMBOLS` when it is not a US listing; a symbol Trading 212 lists on several exchanges names its listings rather than guessing one), or `none`. `get_portfolio_performance` takes `benchmark` for one call and returns `benchmark` with its return on each recorded day, or `benchmarkMissing` and `benchmarkProblem`, the choice it used under `benchmarkChoice` and the choices under `benchmarkOptions`. Its text gives the gap in words. A read without a comparison asks Trading 212 for nothing more, and one with a comparison waits at most 3 seconds for its instrument list and holdings.
- The fund's return is its price from its close on or before the first recorded day to its close on or before each later one, in its own currency: a fund priced in another currency than the account says so, since currency moves are not in it, and a distributing fund's dividends are not in its price. Its closes must reach back to within a week before the first recorded day, else the page says they start too late. They come from the quote provider and are cached for half an hour, like the holding page's chart.
- The sample account compares with its own S&P 500 fund, VUSA, drawn offline.
- The Chinese README lists the holding page, the price chart, the trade journal, the watchlist and the benchmark.

## 2.32.0

- A watchlist. A **Watchlist** tab next to Holdings follows instruments you hold or not: each row gives the price now, its change since the previous close or over 1, 3 or 12 months (**1D**, **1M**, **3M**, **1Y**, in words as well as colour), a three-month line that is green when it ends above where it started, where the price sits in its 12-month range (or since the first close, when there is less than a year of them) and how far below the high, the nearest open order or armed alert with its distance from the price, how it has moved since you added it, and your note on why it is there. Sort by the order added, the biggest move over the period or the nearest order or alert.
- Add from the tab: type a name, symbol or ISIN and the matches show as you type, with the ones on the list already marked. **Watch** on any instrument's page adds it (★ **Watching** takes it off) and the page says since when, with the note. A row opens the instrument's page; × removes it, and **Add a note** or **Edit note** writes in place. At most 50 instruments per account, notes up to 200 characters. The watchlist stays in TradePilot, per account; Trading 212's Public API has no watchlists, so it is never sent there.
- The price is Trading 212's for a holding, the quote provider's otherwise, else the last daily close (named with its date). The closes come from the same provider as the holding page's chart and are cached the same way; the tab reads four instruments at a time and starts no new reads after 5 seconds, naming the rows whose prices come on the next refresh. Closes or a quote ten times or more from Trading 212's price or the instrument's order and alert prices are taken to be in another unit, as on the holding page, and left out.
- `get_watchlist` gives the same in the chat, with a text summary for hosts without the widget; `manage_watchlist` adds an instrument (a second add changes its note), changes a note, or removes one. Both work without order tools, like price alerts.
- The page of an instrument you do not hold now shows its price from the quote provider, with the source and time, and draws the price levels and the alert form from it. A quote that looks like another unit is left out and the page names the fix.
- Instrument search ranks an exact ticker, symbol or ISIN first, then symbols and names starting with what you typed, then words starting with it, then the rest; a US listing comes before the same company elsewhere.
- The sample account prices its own instruments without a network: simulated quotes and exchange rates, named as such, and the same simulated year of closes on every page. It lists two more instruments to watch, Amazon and ASML, and the preview's watchlist has five instruments with notes and alerts, added over the last four months.
- `manage_price_alerts` says that alerts work on any instrument, not only holdings.

## 2.31.0

- A price chart on the holding page. The last year of daily closes as one line, your buys (▲) and sells (▼) of the year on it at their prices (up to 200), and the average cost, open stops and limits and armed price alerts across it, in the colours of the price ladder below and each kind with its own dash. Tags on the price axis give the last close and the levels' prices, as many as fit, nearest the last close first. The scale follows the range's closes: a level well off them (a year-old average cost under a month of prices) keeps its tag at that edge with an arrow rather than flattening the line, and a trade too far from them to draw (a fill before a split, say) is named under the chart. **1M**, **3M**, **6M** and **1Y** pick the range, only those the closes cover in full, and **All** (labelled with its start date) when they reach back further or cover none; the change over it, the high and the low head the chart.
- Hover or tap a day for its close, how the price went from then to the last close, and any trade on it; a tapped day stays until the next tap. With the chart focused, the arrow keys step a day, Home and End jump to the ends, and Page Up and Page Down jump to the previous or next trade. **Show as table** lists every close with your trades that day. Prices under 1 keep the digits that tell them apart.
- The closes come from the quote provider: Stooq's or Twelve Data's year, or Alpha Vantage's last 100 trading days; Finnhub's free plan has none. They are cached for half an hour, a failure for a minute, and the page waits 3 seconds for them, so a slow provider never holds it up (the closes show the next time it opens). Closes ten times or more from Trading 212's price either way (its last price, else the instrument's order and alert prices, else a hundredfold gap from its newest fill) are taken to be in another unit and not drawn, and the page names the `QUOTE_SYMBOLS` mapping with the factor that fixes it. When there is no chart, the page says why: no quote provider, no daily prices on its plan, no symbol for the instrument, the provider's own words on a refusal or limit, or another unit.
- `get_holding_detail` returns the closes under `prices`, or `pricesMissing` and `pricesProblem`, and the fills older than the 20 listed under `history.olderFills`. Its text gives the closes' dates, the change over them and over each of 1, 3 and 6 months they cover in full, with the high and the low, so the chat can talk about the price without the widget.
- The sample account draws a simulated path through its own fills that ends at the last price, and its fills now climb gently towards today's prices over the year.

## 2.30.0

- Look back over the journal. A **Journal** tab next to Income sets each note on an order filled in the period against how that trade has gone since: the fill price, the price now (the broker's for a holding, the quote provider's otherwise, asked about 8 instruments at most, one at a time) and the edge, how far the price moved in the trade's favour, up for a buy and down for a sell. The edge leaves FX and costs out and counts each trade once, so it measures the call; a move under 0.05% reads as unchanged, and a quote ten times from the fill price, most likely in another unit, counts as no price. The overview gives the average edge, how many trades went your way, how many fills have a note and how many of those a look back, the trades due for one, and the realised P/L on the noted sells.
- Per tag: the trades, how many went your way and the average edge, drawn as a bar either side of a centre line. Choosing a tag reads the review again for that tag alone, so every figure is about its trades, and **All trades** goes back; a period change or a saved look back keeps the tag.
- A trade with a reason, no look back and a month since the fill is marked **Due for a look back**; **Add a look back** writes it under the trade, which stays in view. An instrument's name opens its holding page, and Back returns to the journal, read again when a note was written on the way.
- `get_journal_review` gives the same in the chat, for a period or one tag (matched as stored: without a leading `#`, at most 24 characters), with a text summary for hosts without the widget. It works without order tools. The `trade-journal` skill starts from it.
- Sending or cancelling an order clears the order history read in the last minute (also one still being read then), and the widget's loaded tabs, so the holding page, the journal and the performance tab read the new fill the next time they open.
- A tab read for another period than the period switch now shows is read again when you return to it, and a tab's view no longer shows under a holding page or another view the chat opens.
- The preview's sample journal has notes across five instruments, buys and sells, some with a look back, and a **Journal review** view.

## 2.29.0

- A trade journal. Each trade can have a note with why you made it and, later, what came of it looking back, plus a few tags. Notes stay in TradePilot and never reach Trading 212 ([docs/JOURNAL.md](./docs/JOURNAL.md)).
- Write the reason with the order. The order editor has a **Why this trade** field, and the order review tools and `app_prepare_order` take a `thesis`. The review shows it, and once Trading 212 accepts the order it is saved as a note with the order id Trading 212 gave it; the send's result says so, or says the reason could not be saved (a full journal or a failed store), which never changes the order's result. An order whose result is unclear keeps its note too, marked unconfirmed and without an order id, until checking the result finds the order. The thesis stays with the draft when you switch between Demo and Live. An order opened from a trade plan card starts with the card's thesis or rationale. Baskets carry none.
- The holding page has a **Trade journal** section: the instrument's notes, newest first, each dated by the trade it is about and naming its side, size and price, with **Add note**, **Edit**, **Delete** (asked once more in place) and, for a note with only a reason, **Add a look back**. Each fill shows the reason on its order underneath, or **Add note** to write one on it.
- `manage_trade_journal` lists, adds, changes and deletes notes from the chat, for an instrument or an order. It works without order tools, like price alerts. An order has one note; adding a second names the first.
- `get_trade_history` returns each fill's and each unfilled order's `orderId`, and the notes on the orders it lists; `get_holding_detail` returns the instrument's notes. The text summaries quote them, so a text-only host sees the reasons too.
- The `trade-journal` skill reads the reasons written at the time next to how each trade turned out, and saves the review the user agrees with.
- The preview's sample account has notes on its two newest Apple buys and one without an order, and a **Trade journal** view.

## 2.28.0

- A real return for any period. `get_portfolio_performance` adds `timeWeighted`: the time-weighted return over the days TradePilot recorded the account value, with deposits and withdrawals taken out, so it shows how the money invested did. Each stretch between two recorded days is measured by the Modified Dietz method, which weighs a deposit or withdrawal by how long it was in, and the stretches are chained; a stretch that starts empty is measured from its first deposit, and one that ends empty up to its last withdrawal, so the hours with nothing invested don't inflate it. Unlike the simple and money-weighted returns, it works for a window that starts or ends in the past, such as the last month or three months. It is left out when the deposit and withdrawal history read stops after the first recorded day.
- The Performance tab's chart opens on **Return**, the time-weighted return day by day with a line at zero, and switches to **Value** for the account value as before. The note under it says how much was paid in or taken out in between and that it is not counted as a gain or a loss. The overview adds a "Time-weighted return" line with its dates.
- The period switch adds **1M** and **3M** next to YTD, 1Y and All, with short labels so the five fit on a phone; each keeps its full name for screen readers.
- The line charts put their gridlines at round values, "0%, +10%, +20%" or "€15K, €16K, €17K", instead of at the top, middle and bottom of the line, and write each with the decimals its step needs, so no two gridlines read the same.
- The text summary and the tool's one-line result give the time-weighted return too. The preview's made-up value history now reflects the sample account's withdrawal.

## 2.27.0

- Size a buy by risk. The `risk` sizing mode of `review_trading212_order_intent` buys as many shares as would lose a set amount, or a percentage of the account value, if the price fell to a stop-loss: "buy Apple risking 1% of my account with a stop at 200". The entry is the worst price the buy can fill at (the limit, or the higher of the trigger or reference price and the last price), the loss is converted to the account currency like other amounts, and the quantity never goes beyond what the available cash buys. The stop-loss itself is still a separate order, set once the buy fills.
- A lower reference price never inflates a risk-sized buy: a Limit or Stop Limit is sized at its limit, and a Market or Stop buy at the higher of its own price and the last price (the quote source's for an instrument you do not hold). The draft keeps that price as its reference, so the review values the order at it, also after its type is changed in the editor; each review of a Market or Stop raises it to the last price when that is higher and dates it then, so a reference-age policy sees a price just checked. It also carries the budget, and the review warns when the loss at the stop is now over it because the price moved or the quantity changed, or when the price (the order's, or the market's for an order that can fill now) is already at or under the stop-loss. The review reads the exchange rate of the moment too, so a move in the rate counts, and when the quote source can't give the quote just then or no longer has the rate it gave (a rate you gave is kept), no rate converts the loss to the account currency, or nothing prices the order at all, it refuses the order (`RISK_CHECK_UNAVAILABLE`) rather than check it at an old price or not at all. For an instrument you do not hold, a Stop's trigger is compared with that quote, not with a price given. The send checks again, at a quote and rate read from the quote source itself rather than from its one-minute cache: when the price has moved since the review so that the stop would lose more than the review showed, or the price is now under the stop-loss, nothing is sent (`RISK_CHANGED`) and the widget keeps the order in the editor for a new review at the new price. A risk-sized buy is refused when the account's available cash or its currency is unknown, since its quantity could not be capped or its budget converted. A basket takes a risk-sized buy as an ordinary order, without its budget.
- A Stop order's review says that it becomes a Market order once triggered, so after a gap it can fill past its trigger (`STOP_SLIPPAGE`); for a risk-sized Stop buy, that the loss at the stop-loss is counted from the highest of its trigger, the reference price and the last price.
- Switching between Demo and Live works out a quantity sized from the account (a share of cash, of the account value, of a holding, or by risk) again for the other account, rather than carrying the first account's number over. The draft's dated reference price carries over, since the instrument's price is the same in either account; an exchange rate given for the first account's currency is left out, and when the other account cannot size it (no holding to sell, no cash figure), the draft stays on the first account and the error says why.
- The order editor shows the loss at the stop for a risk-sized buy, "At the stop: -€30.00 of the €30.00 budget". It follows the quantity and the limit price as you edit them and turns amber when it goes over the budget.
- The dashboard's coverage line adds what the stops in place would cost if they all triggered, such as "If every stop triggers: -€49.45 (0.4% of holdings)", and the text summary has the same total. It is left out when a stopped holding has no valuation or its stop is already above the price, and when a stop-limit is among the stops counted in it, it reads "If every stop triggers and fills", since a gap can trigger one without a fill.
- The preview has a **Size by risk** view, and its menu now names the holding and portfolio-stops views instead of showing their ids.

## 2.26.0

- Stop-losses for the whole portfolio in one step. `review_portfolio_stops` drafts one Good-Till-Cancel sell stop for every holding with shares that are free to sell and that no pending stop covers. They open as one basket that you review and confirm once:
  - a holding that already has a stop gets one at the same price for its uncovered shares;
  - the others start 8% below the last price, or `dropPercent` below it;
  - `tickers` limits the basket to some holdings. The largest come first, up to 20 orders.
- The dashboard's holdings panel opens with a coverage line, such as "2 of 5 holdings fully covered by stop-losses · Unprotected €3,210 (41% of holdings)". When order tools are on, it has **Add stop-losses** (or **Protect the rest**), which opens that basket.
- Each stop in the basket says why it sits where it does ("Same price as the existing stop" or "8% below the last price"). A protective basket of only stops is labelled **Stop-loss**, not "Stop-loss / take-profit", and so is a stop-loss / take-profit pair once you remove the take-profit.
- What a stop-loss means if it triggers. A holding's page now has a line under its stop, such as "If it triggers: -€49.45 from now · P/L then +€99.82". It shows how much the covered shares would lose from the last price down to the stop, and the P/L they would still have then, in the account currency, converted at the rate the broker's valuation implies. A gap can still fill a stop lower or leave a stop-limit unfilled.
  - With stops at several prices, each order's shares are costed at its own stop and the line reads "If every stop triggers"; the text summary says "from 118 down to 100".
  - A stop-limit is costed at its limit, where it sells or better once triggered, and the page and text summary say so. One whose limit is above its stop does not count as a stop-loss at all, since its sell sits above the price that triggered it.
  - A stop placed by amount in the Trading 212 app has no share count. Its holding shows no outcome and "Covers at least …" or "Placed by amount; shares not known", and the dashboard leaves out the uncovered value.
- The text summaries carry the same figures. The dashboard's "Stop-loss orders" line and a new "Stop-loss" line in the holding summary give them to hosts that show only text, and to the model.
- Layout fixes:
  - The holdings table no longer cuts off its stop-loss column in English at about 1000px. The column now shows only from about 1040px, and below that the stop appears under the holding's name, where it wraps instead of widening the table.
  - On 360px phones the holding cards no longer run past the right edge.
  - At 320px the header controls wrap onto a second row.

## 2.25.0

- A stop-loss from the holding page. When order tools are on and some shares of a holding have no sell stop, the line above the price ladder has **Add a stop-loss** (or **Cover the rest** when a stop covers part of it). It opens the order editor with a good-till-cancelled sell stop:
  - for the uncovered shares, up to what is free to sell;
  - at the existing stop's price, so the whole holding triggers together, or 8% below the last price when there is no stop yet.

  Change anything there; nothing is sent until you review and confirm it, as with every order.
- The daily digest names the holdings that no sell stop fully covers, once any holding has a stop. Someone who never uses stops doesn't get the same list every day.

## 2.24.0

- Stop-loss coverage per holding. When a pending sell stop or stop-limit protects a holding, the dashboard shows it:
  - the highest stop and how far below the last price it is;
  - how much of the holding it covers.

  It appears under the holding's card on narrow screens, in a **Stop-loss** column on wide ones, and under the name in between. A holding's page says the same above its price ladder, or that no stop protects it. The text summary adds a "Stop-loss orders" line that also names the holdings without one. The risk-check skill uses it.
- The holdings table keeps each number on one line.

## 2.23.0

- Price alerts from the widget. A holding's page has an **Add alert** form:
  - above or below a price, starting 5% either side of the last price;
  - for a holding, also a drop from the high, a loss or a gain against the cost;
  - an optional note.

  The new alert's level appears on the price ladder at once.
- Each alert on the holding page and the automation overview has **Re-arm** (once triggered) and **Delete**, which asks once more in place. Alerts only notify and never place orders, so these work with order tools off too, as `manage_price_alerts` does.

## 2.22.0

- A holding page. `get_holding_detail` shows one instrument in one account, held or not:
  - the position, with its share of the account and any saved target weight;
  - the market session;
  - pending orders, with how far each stop or limit is from the last price, and price alerts;
  - the last 12 months of fills and dividends, with the dividend total.

  A failed history read (for example Trading 212's rate limit) leaves the rest on the page and says why.
- In the widget, each holding on the dashboard opens its page. A price ladder lists, highest first, the last price, the average cost, open stops and limits, and the levels where armed alerts fire, each with its distance from the last price. Buy and Sell open the order editor for that instrument, a pending order can be cancelled from the page, and Back returns to the dashboard without reading it again.
- The text for text-only hosts covers the same facts. The order-followup and portfolio-review skills point to the holding page for one instrument.

## 2.21.0

- Pending orders on held instruments say how far their trigger is from the last price, e.g. "8.3% below the last price ($128.75)". A stop or stop-limit is measured from its stop price, a limit from its limit price. Trading 212 has no quote endpoint, so orders on instruments you do not hold have no distance. The text that text-only hosts read carries the same distance, and reads "limit 215" instead of "limit limit 215".
- The dashboard shows a small line of the account value TradePilot recorded over the last 30 days, with the change since the first of those days (deposits and withdrawals included). `get_portfolio_dashboard` returns those days as `valueTrend` once there are two or more, and only for the account the dashboard shows.
- The sample account has a stop-loss on NVIDIA, so the preview shows an order with a distance. Like Trading 212, the sample account now holds back the shares a pending sell covers: they no longer count as available, and a sell for more than the rest is rejected.

## 2.20.0

- An account value chart. Trading 212's API reports only today's value, so the scheduler now reads the account summary about once an hour and keeps the last value of each UTC day (with cash and holdings), for about six years. `get_portfolio_performance` returns the recorded days in its window as `valueHistory`, and the Performance tab draws them as a line with a crosshair readout (pointer or arrow keys) and a table view. The value includes deposits and withdrawals; days the server was not running have no point, and the chart spaces points by date so such gaps stay visible. The sample account keeps its own record, and after a switch to another Trading 212 account only the current account's days are shown.
- A dependency-free line chart joins the widget's bar and column charts.

## 2.19.0

- Invest spare cash by targets without selling: `plan_portfolio_rebalance` takes `buyOnly`, and `investAmount` to cap the amount (it implies `buyOnly`). Only the cash above the cash weight is used, in the targets below their weight and most in the furthest below; overweight holdings stay as they are. The plan says when less cash is free than asked, and when no cash is free at all (this note also replaces a misleading "already within the minimum" note in an ordinary rebalance with no cash).
- The Allocation tab's drift panel has an **Invest spare cash** button next to **Rebalance to targets** while the cash free to trade is at least 1 above the cash target, the same test the planner uses. It opens the buy-only basket for review. `analyze_portfolio_allocation` now also returns `availableCash`, the cash free to trade.
- The rebalance skill offers the buy-only plan for deposits and dividends.

## 2.18.0

- Fill notices for open orders. About every 5 minutes the scheduler compares the open orders with the previous check. For each order that has left the book, it writes `order_filled` (with the shares, average fill price and value in the account currency), `order_partly_filled`, `order_closed` or, when the history never shows how the order ended, `order_outcome_unknown`. This covers orders placed in the Trading 212 app too, and it only reads. Fills and unclear outcomes go to the webhook by default, the widget's activity list shows each fill's shares, price and value, and the daily digest counts the fills of the last day. `ORDER_WATCH=false` turns it off.
- Order history lookups add up fill rows when the order row lacks the filled total, and page by fill time, so an old order's recent fill no longer ends the search early. Linked stop-loss / take-profit pairs use the same lookup.
- The automation page and overview text say whether open orders are watched, and the activity log names the new events in English and Chinese.

## 2.17.0

- Investment plans can invest one amount across your saved targets instead of fixed legs (`targetAmount` in `manage_investment_plans`). Each run works out the split from the account at that moment: the new money goes to the targets below their share, most to the furthest below, so regular contributions move the account toward its targets without selling. Splits under 1 in the account currency stay in cash, and a plan with no saved targets is skipped with that reason. The automation page and plan list say how the plan invests.
- An unattended Demo plan by targets is not sent if the targets are changed or cleared while its basket is priced; the next run window splits it again.
- The daily digest adds the largest drift from the saved targets, from the same account read.
- The rebalance skill offers a plan by targets for moving toward the targets with new money.

## 2.16.0

Target allocation
- New `manage_target_allocation` tool saves target weights per environment (with a cash weight, a drift threshold and whether a rebalance sells holdings without a target), shows them against today's weights, and clears them. It never places orders and works without order tools.
- The Allocation tab shows each target and cash as a bar with a target mark and the drift in percentage points, highlighted past the threshold, and lists holdings without a target. `analyze_portfolio_allocation` returns the same as `drift`, with a flag when it is over the threshold.
- **Rebalance to targets** in the Allocation tab, and `plan_portfolio_rebalance` called without `targets`, plan the trades from the saved targets as a basket you review and confirm.
- The scheduler compares the account with the targets about once an hour and, while the drift is over the threshold (5 points by default), writes an `allocation_drift` activity event and sends it to the webhook, at most once a day.
- The automation overview lists the saved targets; the rebalance skill offers to save targets and to rebalance to saved ones.

## 2.15.0

- New `get_tax_year_summary` tool and `tax-year` skill: one tax year's sales with realised gains and losses kept apart, proceeds, per-instrument results, dividends, interest and costs. The year starts on 1 January unless `yearStart` says otherwise (`04-06` for the UK), and its days are counted in `timeZone` (`Europe/London`), so a trade just after local midnight lands in the right year. The figures are Trading 212's average-cost results; the notes say how country rules can differ and where to get the filing documents.
- `get_portfolio_performance` adds an annualized money-weighted return (XIRR) for all-time windows once the first deposit is a year old. The widget shows it under the realized P/L, with the date it is measured from.
- The simple return is no longer computed for a window that ends in the past, where it compared today's account value with older deposits.
- Performance and income no longer change tickers to capitals (`VUSAl_EQ` became `VUSAL_EQ`), which left those instruments without their names in the widget.

## 2.14.1

- New `order-followup` skill: whether an order filled, what is still pending, and cancelling one through `review_order_cancel`, which the user confirms in the widget.
- The risk-check, portfolio-review and trade-journal skills use `get_order_status`, `get_cash_history` and `review_order_cancel` where they help.
- Price alerts in the automation text name the instrument and the price's currency (for example `below 8500 GBX`).
- The plugin's "Max order value" option says the cap is in your account currency, as it has been since 2.12.
- Unused widget messages removed.

## 2.14.0

Cancelling from the chat
- `review_order_cancel` opens a pending order's cancellation in the widget, prepared the same way as from the dashboard. Nothing is cancelled until you confirm it there. An order that is no longer open says so instead of offering a button.

Names, amounts and wording
- Holdings, dividends, realized P/L, pie slices, baskets and automation show the instrument name first and the ticker second, instead of tickers such as `VUSAl_EQ`. The automation overview sends the instruments its plans, alerts and pairs name, so a fresh widget has their names and currencies.
- Pie amounts carry the account currency; cancel confirmations, price alerts and the order editor's price fields show the instrument currency.
- Profit, loss and change values show their sign (+€12.30). Counts use proper plurals in English and measure words in Chinese ("3 个候选").
- Demo and Live, order statuses, instrument types, time in force and the quote source are translated instead of shown raw. Basket titles, protective and plan notes, pie notices and results are translated from their codes.
- New messages for `PRICE_OUT_OF_RANGE` (with a reminder that GBX is pence), `EXECUTION_BUSY`, and the notices `STOP_ALREADY_TRIGGERED`, `LIMIT_FILLS_AT_ONCE`, `PRICE_FAR_FROM_LAST` and `MARKET_HOURS_UNKNOWN`.
- Allocation bars are shares of total account value and the asset-type breakdown includes cash, so it adds up to 100%. The largest-holding and top-5 tiles say they are measured on invested value, as the concentration checks are.

States
- Live without API keys shows a setup card naming the two settings to add, with a button back to Demo, instead of an empty account under a "Connected" badge. A missing-key error names the environment asked for and which ones are set up, so a tool opened straight on Live gets the same card.
- Loading shows placeholder tiles and a spinning refresh icon. A failed action says which action failed and offers Retry in place.
- The order editor checks quantity and prices at the field, no longer turns a cleared quantity into 0, and explains that the reference price is only used for estimates and limits.

Layout and accessibility
- At phone width the view tabs keep the active tab in view and fade at the edges, basket legs fit on one line with their remove button, pie slices show their quantity without sideways scrolling, and the Demo/Live switch stays on one line.
- Body text is 13–14px, labels at least 12px, and controls are at least 40–44px tall on narrow screens. The language switch is one segmented control.
- Confirmation panels are dialogs: focus moves to their heading, stays inside while they are open, and returns afterwards. Icon buttons have labels.
- A review no longer asks the host for fullscreen by itself; only the Full view button does.
- "Keep watching" ideas show a status chip instead of a disabled button.

Preview
- `pnpm preview` has a "Cancel an order" view.

## 2.13.0

Order safety
- A Stop buy is valued at its stop price when that is above the market, so the order cap, the cash check and the policy see what it can cost once triggered. Before, it was valued at the lower market price.
- A Limit or Stop price ten times above or below the last price is blocked (`PRICE_OUT_OF_RANGE`), which catches pounds typed for a fund quoted in pence. Reviews also say when a stop triggers at once, a limit fills at once, or a price is more than 30% from the last one.
- Several buys of one instrument in a basket count together against the cash and the position-weight cap; before, each leg was checked as if it were the only one.
- Confirmations on one environment are sent one at a time, so two orders confirmed together can no longer both pass the daily order or value limit.
- A write Trading 212 refused with 429 (rate limited) is sent once more after the delay it asks for. Broker errors are classified by HTTP status, so a 429 no longer reads as "order limit" because of a word in the request path.

Protective orders and plans
- After one half of a stop-loss / take-profit pair fills completely, a cancel of the other half that fails is tried again on later ticks, then reported. A partial fill no longer cancels the other half, which still covers the original quantity; you are told to adjust it.
- An unattended Demo plan marks its due date before sending. If a crash cuts the run off before the result is recorded, the next tick asks you to check instead of sending again. The plan is also read again before sending, so one you paused or changed meanwhile is not sent.
- Moving a plan's day or hour no longer runs a period that already ran, and unpausing schedules from now instead of firing a date that passed while paused.
- Unattended Market legs wait when the market hours could not be read, instead of risking a queued order.
- Each scheduler step (protective pairs, plans, alerts, digest) runs even when another fails, one failing alert no longer stops the others, and a tick still running is joined rather than overlapped.
- The daily digest counts as sent only once the webhook accepts it, and is sent whatever `NOTIFY_EVENTS` lists. `protective_attention`, `cancel_rejected` and `daily_digest` are in the default notification list.

New tools
- `get_order_status`: one order by id, open or how it ended, with its fills.
- `get_cash_history`: dividends, deposits, withdrawals, interest and fees one by one, with totals per type.
- `get_trade_history` filters by ticker at Trading 212, so older trades of one instrument are found, and lists cancelled, rejected and expired orders with `includeUnfilled`.
- Instruments can be named by ISIN; one listed on several exchanges returns its listings to choose from.

Sign-in and hosting
- The consent page grants order and pie preparation only when its checkbox is ticked. It starts unticked when the client is not ChatGPT or Claude, so an unknown client gets read-only access unless you choose otherwise.
- `/health` no longer says which Trading 212 accounts are configured.
- The Cloudflare Worker builds the app once per isolate, so instrument, exchange, FX and quote caches survive between requests; the Node server shares one set of services with its scheduler.
- The local state file is flushed to disk before it replaces the old one, the previous version is kept as `.bak`, and an unreadable file is set aside and the backup loaded instead of stopping every request. A process waiting for the file lock now outlasts a lock left by a crashed process.

Quotes
- A `QUOTE_SYMBOLS` entry can carry a factor, such as `VUSAl_EQ=VUSA.L*100`, for a provider that quotes in pounds an instrument Trading 212 prices in pence.

Hosts that show text
- Orders placed by amount in the Trading 212 app show their value instead of "0 shares"; the policy text gives the quantity cap; market hours include the next close.
- Tool annotations: deleting plans and alerts is marked destructive, and the review tools that read the broker are marked as reaching it.

## 2.12.1

- Dependencies refreshed within their ranges. Wrangler 4.149 brings Miniflare builds with patched undici and sharp, which clears twelve advisories in the development tools. Production dependencies had none.
- One advisory remains. `braces`, which `vite-plugin-singlefile` uses through `micromatch` at build time, has no fixed release yet. It only parses the build's own file patterns.

## 2.12.0

Currencies
- `MAX_ORDER_NOTIONAL`, the position-weight rule and the daily value budget now work in the account currency. Before, an order for a fund quoted in pence was compared in pence, so a 500 EUR buy of VUSA counted as about 42,000 and was blocked, while orders in other currencies were left out of the weight and value rules.
- Trading 212 reports a holding's currency as `currency`; TradePilot now reads it, so exchange rates, the currency split and the caps see the right currency.
- Amount and cash-percentage orders in another currency are sized at the rate implied by your holdings when no rate is given, and the preview says so. A cross-currency buy is checked against your available cash at that rate.
- For a currency none of your holdings is priced in, the quote source supplies the rate (Stooq, Twelve Data or Alpha Vantage), so a first purchase in a new currency is still valued in the account currency. Orders, plan legs and rebalance plans say where a quoted rate came from and when.
- With no rate at all, an order in another currency is blocked while `MAX_ORDER_NOTIONAL` is on, instead of being compared with the cap in its own currency. Pass `fxRate` with `fxRateAt` to supply one.
- Cap, cash and sellable-quantity errors carry their amounts, so the widget shows "requested / limit" in place of an empty label.
- Investment plan legs quoted in another currency (for example a GBX fund in a EUR account) are converted instead of skipped.
- The confirmation screen and basket legs show the order's value in the account currency next to the instrument currency.
- The allocation counts cash held in pies and merges GBX into GBP in the currency split.

Orders and automation
- A write that Trading 212 accepted but whose response could not be read is reported as unknown, never as rejected, and counts toward the daily budget.
- A basket no longer sends its buys when the sell that funds them is rejected or blocked. `independentSells` keeps the old behaviour.
- Running an investment plan before its due date counts as that run, so the due date does not buy again.
- A failed daily digest is retried every 15 minutes for the rest of the day instead of being lost.
- Cancelling a Live order needs the same "real money" confirmation as placing one, and the cancel screen says which order it removes.
- Plans that wait on a closed market no longer add a "basket prepared" entry to the activity log every 10 minutes, and Demo activity no longer pushes Live entries out of the log.

Hosts that show text
- Every tool's text now carries the data a model needs when the host does not render the widget: holdings, analytics, drafts, previews with their confirmation token, results, plans, alerts and pies.
- `review_trading212_order` defaults to the configured environment and resolves names; an unknown ticker is an error instead of an empty draft.
- `manage_price_alerts` is available without order tools, since alerts never trade. `review_pie_change` requires `pieId` for changes to an existing pie.

Sign-in
- The sign-in page shows the client's name, the host it returns to and the permissions it asks for, and warns when the host is not a known ChatGPT or Claude address. `OAUTH_REDIRECT_HOSTS` limits which hosts clients may register.
- Refresh tokens rotate on every use; reusing an old one ends that client's session until the owner signs in again. Two requests presenting the same token at once can no longer both succeed.

Analytics
- A date-only `to` covers that whole day, `1w` is a valid period, and `get_trade_history` resolves names as well as tickers. A date that does not exist, such as 2026-02-30, is rejected instead of rolling into March.
- Expected dividends no longer undercount a holding bought partway through the year: a quarterly payer with two payments so far is projected at four.

Widget
- Pending orders show the instrument name, buy or sell, the order type and its prices.
- Policy checks, rebalance notes and skipped-instrument reasons are shown in the widget's language, and the basket review no longer shows its sending-order note twice.
- The Demo / Live switch and the language buttons tell screen readers which one is selected and whether an account has keys.
- `pnpm preview` opens the widget in your browser on the sample account (or your Demo keys with `--demo`), with language, theme and width switches. See [docs/TRY_IT.md](./docs/TRY_IT.md#preview-the-ui-locally).

## 2.11.0

- Added sample data (`TRADEPILOT_SAMPLE_DATA`, plugin option "Try with sample data"): a simulated EUR Demo account with holdings in three currencies, two pies, a year of history and a pending order, so every tool can be tried without a Trading 212 key. Market orders fill at once against it. Live is off and nothing reaches Trading 212. See [docs/TRY_IT.md](./docs/TRY_IT.md).
- Rebalancing now takes exchange rates from the broker's valuation of your holdings, so accounts holding instruments in other currencies are rebalanced without passing `fxRates`. Rates you pass still win.
- Fixed: the widget ignored the host's language and display modes when it opened, so Chinese hosts showed English and the fullscreen button never appeared. A later theme change also reset fullscreen to inline.
- Fixed: dark hosts that do not pass colour variables showed white panels and unreadable text; the widget now has its own dark palette, and primary buttons stay visible on dark backgrounds.
- Fixed: at widths between 640 and 840 pixels the holdings table pushed every panel past the right edge. The table now drops the average-price and available columns there and gains a position-value column.
- Pies show amounts in the account currency, drift is neutral (over- or under-weight is not a gain or loss), and a pie change shows the normalised target shares before review.
- The automation page names the weekday of weekly plans and shows amounts in the account currency.
- Rebalance legs show the instrument currency and estimated value, without repeating the weight change as a reason; skipped instruments are listed once.
- Allocation labels say that the largest-holding and top-5 shares are of invested value; realized P/L by ticker is ordered by size.
- The smallest text is larger (10px instead of 7 to 9px).

## 2.10.0

- Added `get_automation_overview` and an Automation view in the widget: investment plans, price alerts, linked stop-loss / take-profit pairs, today's order and value usage against the policy, and which automation settings are on.
- Added an optional daily digest (`DIGEST_HOUR_UTC`) sent to the notification webhook: total value and change since the last digest, cash, unrealized P/L, largest holdings, pending orders, due plans and recent alerts.
- Fixed: an unattended Demo plan whose orders were rejected or had an unclear result stayed due and was sent again about every 10 minutes. Any run that reaches the broker now moves the plan to its next date.
- Fixed: several stdio servers on one data directory (Claude Desktop and Claude Code together) overwrote each other's state and could each run a due plan. The state file is now locked per operation and reloaded when another process changed it.
- Fixed: a scheduler tick could restore a plan or alert that was paused, changed or deleted while the tick ran.
- Fixed: rebalance orders priced from an external quote or a caller-supplied price were stamped as current, which got past `POLICY_MAX_REFERENCE_AGE_SECONDS`. They now carry the quote time, or stay undated.
- Fixed: `manage_investment_plans` ignored schedule changes on update; frequency, day, weekday and hour can now be changed.
- Fixed: a rebalance with more than 20 notes could not be reviewed; skipped instruments are now summarised.
- Fixed: `get_trade_history` ignored `maxPages`, and `manage_history_export` could request a new export without write access.
- `get_income_summary` now estimates dividends for the next 12 months from each holding's trailing per-share payments and the current quantity, with the yield on invested value.

## 2.9.0

- Added pluggable quotes for instruments you do not hold, because Trading 212 has no quote endpoint. `QUOTE_PROVIDER` defaults to Stooq (free, no key, unofficial); Finnhub, Twelve Data and Alpha Vantage work with `QUOTE_API_KEY`; `none` turns it off. US tickers map automatically, others through `QUOTE_SYMBOLS`.
- New read tool `get_quote`. Price alerts, investment plan legs and rebalance targets without a `referencePrice` now work for instruments you do not hold yet.

## 2.8.0

- Added Trading 212 pies, the last part of the Public API TradePilot did not cover. `list_pies` and `get_pie` show value, invested amount, return, dividends, goal progress and each slice's target share, current share and drift. `review_pie_change` drafts creating, updating, duplicating or deleting a pie; the widget reviews it and you confirm it, with the second confirmation on Live. Reads are cached to respect the pies rate limits. See `docs/PIES.md`.
- Investment plan legs can be Day Limit buys capped at the last broker price plus `limitOffsetPercent` (default 0.5%). They cannot fill at a gap price and can be placed while the market is closed, so unattended Demo plans no longer wait for the session.
- Added price alerts on holdings (`manage_price_alerts`, `list_price_alerts`): above or below a price, a trailing drop from the highest price seen, or a gain or loss against the average cost. The scheduler checks them every minute; alerts never trade.
- Added optional webhook notifications (`NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET`, `NOTIFY_EVENTS`) for due plans, sent orders and baskets, protective fills, pie changes, price alerts and unclear results. The body works with Slack and Discord and can be signed with HMAC-SHA256.
- `review_protective_orders` now tells the model that the pair is linked.

## 2.7.0

- Live orders and Live baskets now need a second confirmation: tick that real money is used, then confirm. The server enforces it (`liveAcknowledged`, error `LIVE_ACK_REQUIRED`) and keeps the token unused when it is missing.
- Stop-loss and take-profit pairs are linked. After one half fills, the scheduler cancels the other, once and without retries. `PROTECTIVE_OCO=false` turns this off.
- The scheduler now runs every minute (Cron Trigger `* * * * *`, 60-second interval in Node and stdio).

## 2.6.0

- Added a policy engine (`POLICY_*`, binding Live by default). It covers a position-weight cap, daily order and value budgets, allowed and blocked tickers, allowed instrument types, blocking Market orders while closed, and reference-price age. Rules run at review and again before each write, and the confirmation screen lists every result. `get_trading_policy` shows the rules and today's usage.
- Added order baskets: up to 20 orders validated against one snapshot, sells first, confirmed once, and sent one by one. An uncertain result stops the remaining orders.
- Added `plan_portfolio_rebalance`, which computes the trades toward target weights from broker prices and available cash, with a cash reserve, minimum trade value, whole-share option and explicit FX rates.
- Added `review_protective_orders` for broker-native Good-Till-Cancel stop-loss and take-profit sells.
- Added weekly and monthly investment plans (`manage_investment_plans`, `list_investment_plans`, `review_investment_plan`). Due plans are announced and opened as a basket for confirmation. With `AUTOMATION_DEMO_ENABLED=true`, Demo plans marked `autoExecute` run unattended. Live plans never do.
- Added a 15-minute Cron Trigger on Cloudflare and a scheduler interval in the Node and stdio servers.
- Added a `rebalance` skill, and a plugin option for unattended Demo plans.
- Rewrote `docs/AUTOMATION.md` around automation levels L0–L3.

## 2.5.0

- Added read-only analytics tools backed by Trading 212 history: `analyze_portfolio_allocation`, `get_portfolio_performance`, `get_income_summary`, `get_trade_history`, `get_market_hours`, and `manage_history_export`. See `docs/ANALYTICS.md`.
- Order review warns when the market is closed, and specifically when a Market order would be queued until the next open.
- Added a local stdio transport (`pnpm stdio`) and a Claude Code plugin with four skills: portfolio review, daily brief, risk check, and trade journal. Order tools are off by default in stdio mode. See `docs/CLAUDE_PLUGIN.md`.
- The widget gains Allocation, Performance and Income tabs with period switching, accessible bar and column charts, and a table view for each chart.
- The broker client now covers exchange schedules, paginated order, dividend and transaction history, and CSV exports.
- Market-order notional checks now use the higher of the supplied reference price and the broker's current position price, so an understated reference price cannot bypass `MAX_ORDER_NOTIONAL`.
- The OAuth password page now refuses to be framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).
- When the OAuth client registry is full, registrations that never completed a login are evicted before clients in use.
- Documented the threat model: where confirmation is enforced, token revocation, reference-price trust, and login throttling.

## 2.4.0

- Replaced fixed order-review modals with an in-flow transaction workspace that can resize with the ChatGPT host.
- When the host provides a very short embedded viewport, TradePilot requests fullscreen when available and falls back cleanly when it is not.
- Only one transaction step is rendered at a time; the portfolio is no longer layered behind order review.
- Removed nested modal scrolling and made confirmation rows stack on narrow embeds.
- Closing a model-opened order draft returns to the portfolio instead of leaving an empty order state.
- Added a layout regression test for fixed-overlay and nested-scroll regressions.

## 2.3.0

- Added structured error codes and bilingual UI error rendering.
- Added reference-price and account-snapshot freshness metadata to order review.
- Added read-only verification for ambiguous order/cancellation write outcomes; original writes are never retried automatically.
- Added a compact recent-activity trail stored in the instance state store.
- Added expandable trade-plan detail fields for thesis, catalysts, risks, counter-case, sources, and timestamps.
- Improved natural-language order conversion UI with calculated quantity, manual-edit indication, and restore action.
- Added keyboard focus containment, Escape handling, live status announcements, and larger mobile touch targets.
- Added architecture documentation and tightened public documentation language.

## 2.2.1

- Hardened company-name resolution across multiple Trading 212 listings.
- Corrected position-percentage sizing to use the total held position while respecting currently tradable quantity.
- Added bilingual sizing-resolution details to the order-review UI.

## 2.2.0

- Added flexible natural-language order intents.
- Added quantity, target-amount, cash-percentage, position-percentage, and all-available sizing modes.
- Added configurable default environment and optional application-level order caps.
- Added ordering and automation documentation.

## 2.1.0

- Added responsive bilingual MCP App UI and bilingual OAuth page.
- Added self-host setup/deployment commands, CI, security checks, and open-source documentation.
- Published the single-user self-hosting model.
