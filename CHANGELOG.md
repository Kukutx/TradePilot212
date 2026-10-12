# Changelog

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
