# Changelog

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
