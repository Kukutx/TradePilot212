# Changelog

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
