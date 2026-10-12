// Plain-text versions of the tool payloads. Hosts without the TradePilot widget (Claude Code, other
// terminals) show the model only a tool's text, so every result carries the facts needed to answer
// from it: holdings, orders, plans, skipped legs, tokens to confirm. Lists are capped to stay short.

import type { HoldingDetail } from "../shared/holding.js";
import { holdingPositionHistory } from "../shared/position-history.js";
import { PRICE_RANGES, priceMove, pricesIn, rangeCovered } from "../shared/prices.js";
import { MAX_REVIEW_QUOTES, REVIEW_AFTER_DAYS, type JournalEntry, type JournalPayload, type JournalReview, type JournalTagStats, type JournalTrade } from "../shared/journal.js";
import type { AccountSummary, ActivityEvent, CancelDraftPayload, CancelPreview, CredentialStatus, EnrichedTradeCandidate, ExecutionVerificationResult, Instrument, OrderDraft, OrderDraftPayload, OrderExecutionResult, OrderNotice, OrderPreview, PendingOrder, PortfolioSnapshot, Position, TradingEnvironment } from "../shared/contracts.js";
import type { AutomationOverview, BasketDraftPayload, BasketExecutionResult, BasketPreview, DcaPlan, PolicyCheck, PriceAlert, ProtectiveLink, RebalancePlan, TargetAllocation, TradingPolicy } from "../shared/automation.js";
import type { AllocationAnalysis, AllocationDrift, CalendarReturn, Drawdown, ExportReport, IncomeSummary, PerformanceSummary, TaxYearSummary } from "../shared/history.js";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PieOverview, PiesPayload } from "../shared/pies.js";
import { portfolioProtection, stopOutcome, stopProtection, type StopProtection } from "../shared/protection.js";
import type { DayMove, PortfolioToday } from "../shared/today.js";
import { WATCH_PERIODS, type WatchLevel, type WatchlistView, type WatchRow } from "../shared/watchlist.js";
import type { OrderStatusReport } from "./trading-service.js";

const MAX_ROWS = 30;

/** Up to `digits` decimals, no trailing zeros, no exponent. */
export function num(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "?";
  return Number(value.toFixed(digits)).toString();
}
const signed = (value: number | undefined, digits = 2) => value === undefined ? "?" : `${value > 0 ? "+" : ""}${num(value, digits)}`;
const money = (value: number | undefined | null, currency?: string) => `${num(value)}${currency ? ` ${currency}` : ""}`;
const pct = (value: number | undefined | null, digits = 1) => value === undefined || value === null ? "?" : `${num(value * 100, digits)}%`;
const env = (environment: TradingEnvironment) => environment.toUpperCase();
const day = (value?: string) => value ? value.slice(0, 10) : "?";
const minute = (value?: string) => value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "?";

function rows<T>(items: T[], line: (item: T) => string, max = MAX_ROWS): string[] {
  const shown = items.slice(0, max).map((item) => `- ${line(item)}`);
  return items.length > max ? [...shown, `- … ${items.length - max} more`] : shown;
}

function section(title: string, lines: string[]): string[] {
  return lines.length ? [`${title}:`, ...lines] : [];
}

function credentialsLine(environment: TradingEnvironment, credentials?: CredentialStatus): string[] {
  return credentials && !credentials[environment] ? [`${env(environment)} credentials are not configured, so there is no ${env(environment)} data.`] : [];
}

function draftLine(draft: OrderDraft, instrument?: Instrument): string {
  const price = draft.type === "limit" ? ` @ ${num(draft.limitPrice, 6)}` : draft.type === "stop" ? ` @ ${num(draft.stopPrice, 6)}` : "";
  const stop = draft.type === "stop_limit" ? ` stop ${num(draft.stopPrice, 6)} limit ${num(draft.limitPrice, 6)}` : "";
  const name = instrument?.name && instrument.name !== draft.ticker ? ` (${instrument.name})` : "";
  const validity = draft.timeValidity ? ` ${draft.timeValidity}` : "";
  return `${draft.side.toUpperCase()} ${num(draft.quantity, 8)} ${draft.ticker}${name} ${draft.type.replace("_", "-")}${price}${stop}${validity}${draft.extendedHours ? " extended hours" : ""}`;
}

/** Text written by the user, on one line and shortened, so a long note cannot crowd out the rest. */
function quoted(text: string, max = 160): string {
  const characters = Array.from(text.replace(/\s+/g, " ").trim());
  return `"${characters.length > max ? `${characters.slice(0, max - 1).join("").trimEnd()}…` : characters.join("")}"`;
}

function journalLine(entry: JournalEntry, withTicker = true): string {
  const order = entry.order ? ` ${entry.order.side.toUpperCase()} ${num(entry.order.quantity, 8)} ${entry.order.type.replace("_", "-")}${entry.order.unconfirmed ? " (result unclear when sent)" : ""}` : "";
  return `${entry.id} ${day(entry.createdAt)}${withTicker ? ` ${entry.ticker}` : ""}${entry.orderId ? ` order ${entry.orderId}` : ""}${order}`
    + `${entry.thesis ? `; why: ${quoted(entry.thesis)}` : ""}${entry.review ? `; review: ${quoted(entry.review)}` : ""}${entry.tags?.length ? `; tags ${entry.tags.join(", ")}` : ""}`;
}

const signedPct = (value: number) => `${value >= 0 ? "+" : ""}${num(value * 100, 1)}%`;

function tagStatsLine(row: JournalTagStats, currency: string, name = row.tag === undefined ? "(no tag)" : `#${row.tag}`): string {
  const edge = row.averageEdge === undefined ? "no price now" : `${row.inFavour}/${row.priced} in your favour, average ${signedPct(row.averageEdge)}`;
  return `${name}: ${row.trades} trade(s), ${edge}${row.realisedProfitLoss ? `, realised ${num(row.realisedProfitLoss)} ${currency}` : ""}`;
}

function journalTradeLine(trade: JournalTrade): string {
  const now = trade.move === undefined ? "no price now" : `now ${num(trade.priceNow)} (${signedPct(trade.move)}, ${signedPct(trade.edge!)} in the trade's favour)`;
  return `${day(trade.filledAt)} ${trade.ticker} ${trade.side.toUpperCase()} ${num(trade.quantity, 8)} @ ${num(trade.price, 4)}${trade.priceCurrency ? ` ${trade.priceCurrency}` : ""}, ${now}`
    + `${trade.realisedProfitLoss === undefined ? "" : `, realised ${num(trade.realisedProfitLoss)}`}${trade.due ? ", due for a look back" : ""}`
    + `; note ${trade.entry.id}${trade.entry.thesis ? `, why: ${quoted(trade.entry.thesis)}` : ""}${trade.entry.review ? `, review: ${quoted(trade.entry.review)}` : ""}${trade.entry.tags?.length ? `, tags ${trade.entry.tags.join(", ")}` : ""}`;
}

function watchLevelText(level: WatchLevel): string {
  const what = level.kind === "alert" ? `alert ${level.condition}` : `${level.side} ${level.kind}`;
  return `${what} ${num(level.price, 6)}${level.distance === undefined ? "" : ` (${signedPct(level.distance)})`}`;
}

/** One watchlist row: the price and where from, the changes (1D is since the previous close), the range and levels. */
function watchLine(row: WatchRow): string {
  const name = row.name && row.name !== row.ticker ? ` (${row.name})` : "";
  const source = row.priceSource === "broker" ? "Trading 212" : row.priceSource === "close" ? `close of ${row.priceAt}` : row.priceSource === "sample" ? "simulated" : row.priceSource;
  const changes = WATCH_PERIODS.filter((key) => row.changes[key] !== undefined).map((key) => `${key.toUpperCase()} ${signedPct(row.changes[key]!)}`);
  const range = row.high !== undefined && row.low !== undefined && row.price !== undefined && row.high > 0
    ? `${row.rangeFrom ? `range since ${row.rangeFrom}` : "12-month range"} ${num(row.low, 6)} to ${num(row.high, 6)}, ${pct(1 - row.price / row.high)} below the high`
    : "";
  return [
    `${row.ticker}${name}: ${row.price === undefined ? "no price" : `${num(row.price, 6)}${row.currencyCode ? ` ${row.currencyCode}` : ""} (${source})`}`,
    changes.join(", "),
    range,
    row.levels.length ? row.levels.map(watchLevelText).join(", ") : "",
    row.held ? `held ${num(row.held.quantity, 8)} at ${num(row.held.averagePrice, 6)}` : "",
    row.sinceAdded === undefined ? "" : `${signedPct(row.sinceAdded)} since added ${day(row.addedAt)}`,
    row.note ? `note: ${quoted(row.note)}` : "",
    row.pricesMissing ? `no daily closes: ${row.pricesProblem}` : "",
  ].filter(Boolean).join("; ") + ".";
}

function watchlist(data: WatchlistView): string[] {
  return [
    ...credentialsLine(data.environment, data.credentials),
    data.items.length ? `Watchlist on ${env(data.environment)}, ${data.items.length} instrument(s), changes to the price now (1D since the previous close):` : `The ${env(data.environment)} watchlist is empty; add instruments with manage_watchlist.`,
    ...data.items.map(watchLine),
  ];
}

function journalReview(data: JournalReview): string[] {
  const currency = data.accountCurrency ?? "";
  return [
    `${env(data.environment)} journal review ${data.period.from ? `${day(data.period.from)} to ${day(data.period.to)}` : `all time to ${day(data.period.to)}`}${data.tag ? `, tag #${data.tag}` : ""}: ${data.withNote} of ${data.fills} fill(s) have a note, ${data.reviewed} with a look back.`,
    `Edge = the price move since the fill in the trade's favour (a buy gains when the price rose, a sell when it fell); FX and costs are left out and each trade counts once.`,
    ...(data.overall.trades ? [`${tagStatsLine(data.overall, currency, "All")}.`] : []),
    ...(data.due ? [`${data.due} trade(s) are ${REVIEW_AFTER_DAYS}+ days old with a reason and no look back yet.`] : []),
    ...(data.unmatched ? [`${data.unmatched} note(s) are on orders not among these fills (still open, cancelled, filled before the period, or reported without a price).`] : []),
    ...(data.withoutOrder ? [`${data.withoutOrder} note(s) are on an instrument rather than a filled order.`] : []),
    ...(data.unpriced.length ? [`No usable price now for ${data.unpriced.join(", ")}.`] : []),
    ...(data.notQuoted.length ? [`Not priced this time, since one review asks the quote provider about ${MAX_REVIEW_QUOTES} instruments at most: ${data.notQuoted.join(", ")}.`] : []),
    ...(data.truncated ? ["History was cut at the page limit; older fills are not counted."] : []),
    ...section("By tag", rows(data.tags, (row) => tagStatsLine(row, currency))),
    ...section(`Trades with a note${data.tradesTotal > data.trades.length ? ` (newest ${data.trades.length} of ${data.tradesTotal})` : ""}`, rows(data.trades, journalTradeLine)),
  ];
}

function noticesLines(notices: OrderNotice[] | undefined): string[] {
  return (notices ?? []).filter((notice) => notice.code !== "LIVE_FUNDS").map((notice) => `  note: ${notice.message}`);
}

function policyLines(checks: PolicyCheck[] | undefined): string[] {
  return (checks ?? []).filter((check) => check.status !== "pass" && check.status !== "skip").map((check) => `  policy ${check.status}: ${check.message}`);
}

function orderLine(order: PendingOrder, positions: Position[] = []): string {
  const quantity = order.quantity ?? 0;
  const value = typeof order.value === "number" ? order.value : undefined;
  const side = String(order.side ?? "").toUpperCase() || (quantity < 0 || (value ?? 0) < 0 ? "SELL" : "BUY");
  const name = (order.instrument as { name?: unknown } | undefined)?.name;
  const currency = typeof order.currency === "string" ? ` ${order.currency}` : "";
  // Orders placed by amount in the Trading 212 app carry a value instead of a share count.
  const size = order.strategy === "VALUE" && value !== undefined ? `value ${num(Math.abs(value))}${currency} of` : num(Math.abs(quantity), 8);
  const prices = [order.stopPrice === undefined ? "" : ` stop ${num(order.stopPrice, 6)}`, order.limitPrice === undefined ? "" : ` limit ${num(order.limitPrice, 6)}`].join("");
  const validity = order.timeInForce ?? order.timeValidity;
  // Sells report negative quantities, filled ones included.
  const filled = typeof order.filledQuantity === "number" && order.filledQuantity !== 0 ? `, filled ${num(Math.abs(order.filledQuantity), 8)}` : "";
  // How far the trigger (or limit) is from the last price, for held instruments only.
  const last = positions.find((position) => position.instrument.ticker === order.ticker)?.currentPrice;
  const trigger = order.stopPrice ?? order.limitPrice;
  const gap = typeof trigger === "number" && last && last > 0 ? (trigger - last) / last : undefined;
  const distance = gap === undefined ? "" : `, ${pct(Math.abs(gap))} ${gap < 0 ? "below" : "above"} the last price ${num(last, 6)}`;
  // "limit 215" rather than "limit limit 215"; a stop-limit names both prices.
  const kind = String(order.type ?? "").toLowerCase();
  const typed = (kind === "limit" || kind === "stop") && prices ? prices.trim() : `${kind}${prices}`;
  return `#${order.id ?? "?"} ${side} ${size} ${order.ticker ?? "?"}${typeof name === "string" ? ` (${name})` : ""} ${typed}${distance}${typeof validity === "string" ? ` ${validity}` : ""}${order.status ? ` (${order.status}${filled})` : ""}`;
}

function positionLine(position: Position): string {
  const wallet = position.walletImpact as { currentValue?: unknown; unrealizedProfitLoss?: unknown; currency?: unknown } | undefined;
  const value = typeof wallet?.currentValue === "number" ? wallet.currentValue : undefined;
  const pnl = typeof wallet?.unrealizedProfitLoss === "number" ? wallet.unrealizedProfitLoss : undefined;
  const walletCurrency = typeof wallet?.currency === "string" ? ` ${wallet.currency}` : "";
  const name = position.instrument.name && position.instrument.name !== position.instrument.ticker ? ` ${position.instrument.name}` : "";
  const available = position.quantityAvailableForTrading !== position.quantity ? `, ${num(position.quantityAvailableForTrading, 8)} available` : "";
  const pies = position.quantityInPies ? `, ${num(position.quantityInPies, 8)} in pies` : "";
  return `${position.instrument.ticker}${name}: ${num(position.quantity, 8)} @ ${num(position.currentPrice, 6)} ${position.instrument.currencyCode ?? ""} (avg ${num(position.averagePricePaid, 6)})`
    + `${value === undefined ? "" : `, value ${num(value)}${walletCurrency}`}${pnl === undefined ? "" : `, P/L ${signed(pnl)}`}${available}${pies}`;
}

function accountLine(environment: TradingEnvironment, account: AccountSummary): string {
  const currency = account.currency ?? "";
  const cash = account.cash ?? {};
  return `${env(environment)} account (${currency || "currency unknown"}): total ${num(account.totalValue)}, available cash ${num(cash.availableToTrade)}`
    + `${cash.inPies ? `, in pies ${num(cash.inPies)}` : ""}${cash.reservedForOrders ? `, reserved for orders ${num(cash.reservedForOrders)}` : ""}`
    + `${account.investments?.currentValue === undefined ? "" : `, invested ${num(account.investments.currentValue)}`}`
    + `${account.investments?.unrealizedProfitLoss === undefined ? "" : `, unrealized P/L ${signed(account.investments.unrealizedProfitLoss)}`}`
    + `${account.investments?.realizedProfitLoss === undefined ? "" : `, realized P/L ${signed(account.investments.realizedProfitLoss)}`}.`;
}

function activityLine(event: ActivityEvent): string {
  const details = [event.side, event.quantity === undefined ? undefined : num(event.quantity, 8), event.ticker, event.orderType, event.orderId ? `order ${event.orderId}` : undefined, event.planId ? `plan ${event.planId}` : undefined, event.outcome]
    .filter((item) => item !== undefined && item !== "").join(" ");
  return `${minute(event.timestamp)} ${event.type}${details ? `: ${details}` : ""}`;
}

/**
 * "NVDA_US_EQ 5 of 20 (25%) from 118, 8.3% below the last price", "… from 118 down to 100 …" for stops at
 * several prices, plus what they cost once triggered when the broker values the holding. A stop-limit is
 * counted at its limit, so the text names the limit and that it may not fill.
 */
function stopText(position: Position, guard: StopProtection, currency: string | undefined): string {
  const gap = guard.gap === undefined ? "" : `, ${pct(Math.abs(guard.gap))} ${guard.gap < 0 ? "below" : "above"} the last price`;
  // Two stop-limits at one stop are separate levels but one trigger, so the range counts distinct stops.
  const prices = [...new Set(guard.levels.map((level) => level.stopPrice))];
  const several = prices.length > 1;
  const range = several ? ` down to ${num(Math.min(...prices), 6)}` : "";
  const limitLevels = guard.levels.filter((level) => level.limitPrice !== undefined);
  const limit = limitLevels[0]?.limitPrice;
  const limits = limit === undefined ? "" : limitLevels.length > 1
    ? " (stop-limits sell at their limit or better, or not at all after a gap)"
    : ` (stop-limit: sells at ${num(limit, 6)} or better, or not at all after a gap)`;
  const outcome = stopOutcome(position, guard);
  const when = `${several ? "if every stop triggers" : "if it triggers"}${limit === undefined ? "" : " and fills"}`;
  const cost = outcome ? `; ${when}: ${money(-outcome.drop, currency)} from now${outcome.pnlAtStop === undefined ? "" : `, P/L ${signed(outcome.pnlAtStop)}`}` : "";
  const share = !guard.unsized
    ? `${num(guard.covered, 8)} of ${num(position.quantity, 8)} (${pct(guard.coverage, 0)})`
    : `${guard.covered > 0 ? `at least ${num(guard.covered, 8)}` : "an unknown number"} of ${num(position.quantity, 8)} (${guard.unsized} stop(s) placed by amount)`;
  return `${guard.ticker} ${share} from ${num(guard.stopPrice, 6)}${range}${limits}${gap}${cost}`;
}

/** Which holdings a pending sell stop covers, how much of each and how far below the last price; and every holding without one. */
function protectionLines(positions: Position[], orders: PendingOrder[], currency: string | undefined): string[] {
  if (!positions.length) return [];
  const guarded = positions.flatMap((position) => {
    const guard = stopProtection(position, orders);
    return guard ? [stopText(position, guard, currency)] : [];
  });
  const bare = positions.filter((position) => !stopProtection(position, orders)).map((position) => position.instrument.ticker);
  // Stop-limits are counted at their limit, so a total with one in it holds only if it fills.
  const { atStops, atStopsShare, atStopsLimited } = portfolioProtection(positions, orders);
  const total = atStops === undefined ? "" : ` If every stop triggers${atStopsLimited ? " and fills" : ""}, the holdings: ${money(-atStops, currency)} from now${atStopsShare === undefined ? "" : ` (${pct(atStopsShare)} of their value)`}.`;
  return [`Stop-loss orders: ${guarded.join("; ") || "none"}.${total}${bare.length ? ` No stop on ${bare.join(", ")}.` : ""}`];
}

function portfolio(data: PortfolioSnapshot): string[] {
  const holdings = [...data.positions].sort((a, b) => {
    const value = (position: Position) => (position.walletImpact as { currentValue?: number } | undefined)?.currentValue ?? position.quantity * position.currentPrice;
    return value(b) - value(a);
  });
  return [
    ...credentialsLine(data.environment, data.credentials),
    ...(data.warning ? [data.warning] : []),
    ...(data.account ? [accountLine(data.environment, data.account)] : []),
    ...valueHistoryLines(data.valueTrend),
    ...(data.today ? todayLines(data.today) : []),
    ...section(`Holdings (${holdings.length})`, rows(holdings, positionLine)),
    ...protectionLines(holdings, data.orders, data.account?.currency),
    ...section(`Pending orders (${data.orders.length})`, rows(data.orders, (order) => orderLine(order, data.positions))),
    ...section("Recent TradePilot activity", rows((data.activity ?? []).slice(0, 5), activityLine)),
  ];
}

/** One instrument's move on the day: against which close, its profit or loss, and the shares traded on the day. */
function dayMoveLine(move: DayMove, currency?: string): string {
  const name = `${move.name ?? move.ticker}${move.shortName && move.shortName !== move.name ? ` (${move.shortName})` : ""}`;
  return `${name}: ${dayMoveText(move, currency)}`;
}

/** One instrument's move on the day, without its name. */
function dayMoveText(move: DayMove, currency?: string): string {
  const traded = [move.bought ? `bought ${num(move.bought, 8)}` : "", move.sold ? `sold ${num(move.sold, 8)}` : ""].filter(Boolean).join(", ");
  const tradedText = traded ? ` (${traded} on the day, from the fill price)` : "";
  const close = move.previousClose ? `the close on ${move.previousClose.date} (${num(move.previousClose.close, 6)}${move.currencyCode ? ` ${move.currencyCode}` : ""})` : "";
  if (move.change !== undefined || move.profitLoss !== undefined) {
    const parts = [
      move.change !== undefined ? `${signedPct(move.change)} since ${close}` : move.quantity === 0 ? `sold out on the day against ${close}` : "",
      move.profitLoss !== undefined ? `${signed(move.profitLoss)}${currency ? ` ${currency}` : ""}` : "",
    ].filter(Boolean);
    return `${parts.join(", ")}${tradedText}${move.problem ? `; ${move.problem}` : ""}`;
  }
  return `no move for the day; ${move.problem ?? "no previous close"}`;
}

/** The day's moves: the total, then each holding, biggest in the account currency first. */
function todayLines(data: PortfolioToday): string[] {
  const currency = data.accountCurrency;
  const total = data.total;
  const days = [...new Set(data.moves.map((move) => move.day))].sort();
  const lead = total
    ? `Holdings on the day (${days.join(", ") || "?"}), against each one's last close before it: ${signed(total.profitLoss)}${currency ? ` ${currency}` : ""}${total.change === undefined ? "" : ` (${signedPct(total.change)})`}, ${total.counted} of ${total.of} instrument(s) with a move.`
    : `No holding has a move for the day${data.moves.length ? "" : ": there are no holdings"}.`;
  return [
    lead,
    ...rows(data.moves, (move) => dayMoveLine(move, currency)),
    ...(data.fillsProblem ? [`The day's fills could not be read (${data.fillsProblem}), so shares traded on the day count from the previous close.`] : []),
    ...(total ? ["Amounts are at today's exchange rates; the previous closes are the quote provider's."] : []),
  ];
}

function allocation(data: AllocationAnalysis): string[] {
  const c = data.accountCurrency;
  return [
    `Total ${money(data.totalValue, c)}, invested ${num(data.investedValue)}, cash ${num(data.cash)} (${pct(data.cashWeight)} of the account).`,
    `Holdings by share of the account: ${data.holdings.slice(0, 12).map((item) => `${item.ticker} ${pct(item.weight)}`).join(", ")}${data.holdings.length > 12 ? ", …" : ""}.`,
    `Currency exposure (cash included): ${data.byCurrency.map((item) => `${item.currency} ${pct(item.weight)}`).join(", ") || "none"}.`,
    `Types: ${data.byType.map((item) => `${item.type} ${pct(item.weight)}`).join(", ") || "none"}.`,
    `Concentration (of invested value): largest ${pct(data.concentration.largestWeight)}, top 5 ${pct(data.concentration.top5Weight)}, effective holdings ${num(data.concentration.effectiveHoldings, 1)}.`,
    ...section("Flags", rows(data.flags, (flag) => flag.message)),
    ...(data.drift ? driftLines(data.drift) : []),
  ];
}

const points = (value: number) => `${signed(value * 100, 1)} pts`;

function driftLines(drift: AllocationDrift): string[] {
  return section(`Against targets (largest drift ${num(drift.maxDrift * 100, 1)} points; notices above ${num(drift.threshold * 100, 1)} points)`, [
    ...rows(drift.rows, (row) => `${row.ticker}: ${pct(row.current)} now, target ${pct(row.target)}, ${points(row.drift)}`),
    `- Cash: ${pct(drift.cash.current)} now, target ${pct(drift.cash.target)}, ${points(drift.cash.drift)}`,
    ...(drift.untargeted.length ? [`- No target${drift.sellUntargeted ? " (sold by a rebalance to these targets)" : " (kept by a rebalance)"}: ${drift.untargeted.map((item) => `${item.ticker} ${pct(item.current)}`).join(", ")}`] : []),
  ]);
}

function targetAllocation(data: { environment: TradingEnvironment; targets?: TargetAllocation; drift?: AllocationDrift; cleared?: boolean }): string[] {
  if (!data.targets) return [data.cleared === undefined ? `No ${env(data.environment)} targets are saved.` : data.cleared ? `${env(data.environment)} targets cleared.` : `No ${env(data.environment)} targets were saved.`];
  return [
    `${env(data.environment)} targets saved ${minute(data.targets.updatedAt)}: ${data.targets.targets.map((target) => `${target.ticker} ${pct(target.weight)}`).join(", ")}; cash ${pct(data.targets.cashWeight)}; holdings without a target are ${data.targets.sellUntargeted ? "sold" : "kept"} by a rebalance.`,
    ...(data.drift ? driftLines(data.drift) : []),
  ];
}

function performance(data: PerformanceSummary): string[] {
  const c = data.accountCurrency;
  return [
    `Period ${data.period.from ? day(data.period.from) : "all history"} to ${day(data.period.to)}, amounts in ${c}.`,
    `Realized P/L ${signed(data.realizedProfitLoss)}; dividends ${num(data.income.dividends)}; interest ${num(data.income.interest)}; costs ${num(data.costs.total)}${data.costs.byType.length ? ` (${data.costs.byType.map((item) => `${item.key} ${num(item.amount)}`).join(", ")})` : ""}.`,
    `Deposits ${num(data.contributions.deposits)}, withdrawals ${num(data.contributions.withdrawals)}, net ${num(data.contributions.net)}.`,
    ...(data.currentValue === undefined ? [] : [`Current value ${num(data.currentValue)}${data.unrealizedProfitLoss === undefined ? "" : `, unrealized P/L ${signed(data.unrealizedProfitLoss)}`}${data.simpleReturn === undefined ? "" : `, simple return on net deposits ${signed(data.simpleReturn * 100, 1)}%`}.`]),
    ...(data.annualizedReturn === undefined ? [] : [`Annualized return (money-weighted, since ${day(data.annualizedSince)}) ${signed(data.annualizedReturn * 100, 1)}% a year.`]),
    `Trades: ${data.trades.buys} buys, ${data.trades.sells} sells, turnover ${num(data.trades.turnover)}.`,
    ...valueHistoryLines(data.valueHistory),
    ...(data.timeWeighted ? [`Time-weighted return from ${data.timeWeighted.from} to ${data.timeWeighted.to}: ${signed(data.timeWeighted.return * 100, 1)}%${data.timeWeighted.netFlows ? `, with ${num(Math.abs(data.timeWeighted.netFlows))} of net ${data.timeWeighted.netFlows < 0 ? "withdrawals" : "deposits"} in between taken out` : ""}. It measures how the money invested did, whatever was paid in or taken out.`] : []),
    ...drawdownLines(data.timeWeighted?.drawdown),
    ...calendarLines(data.timeWeighted),
    ...benchmarkLines(data),
    ...attributionLines(data),
    ...section("By instrument", rows(data.byTicker.filter((item) => item.realizedProfitLoss || item.dividends || item.costs).slice(0, 10), (item) => `${item.ticker}: realized ${signed(item.realizedProfitLoss)}, dividends ${num(item.dividends)}, costs ${num(item.costs)}`)),
    ...(data.coverage.truncated ? ["History was truncated at the page limit; raise maxPages for older records."] : []),
    ...data.notes,
  ];
}

/** Each instrument's gain over the period, largest first, and the ones it could not value. */
function attributionLines(data: PerformanceSummary): string[] {
  const attribution = data.attribution;
  if (!attribution) return data.attributionProblem ? [`No gains by instrument: ${data.attributionProblem}`] : [];
  const since = attribution.from ? `since the close before ${attribution.from}` : "over all history";
  return [
    ...section(`Gain by instrument ${since}: ${signed(attribution.total)} in all (${attribution.basis === "start"
      ? "value now less value at the start, less buys, plus sells and dividends; the start at today's exchange rate"
      : "Trading 212's realised P/L on sales and unrealised P/L on what is held, plus dividends"})`,
      rows(attribution.holdings, (holding) => `${holding.ticker}: ${signed(holding.gain)}${holding.return === undefined ? "" : ` (${signed(holding.return * 100, 1)}%)`}, start ${num(holding.startValue)}${holding.startClose ? ` (${num(holding.startQuantity, 8)} at ${num(holding.startClose.price, 6)} on ${holding.startClose.date})` : ""}, now ${num(holding.value)}${holding.bought ? `, bought ${num(holding.bought)}` : ""}${holding.sold ? `, sold ${num(holding.sold)}` : ""}${holding.dividends ? `, dividends ${num(holding.dividends)}` : ""}`)),
    ...(attribution.missing.length ? [`Not valued: ${attribution.missing.map((item) => `${item.ticker} (${item.problem})`).join("; ")}`] : []),
  ];
}

/**
 * The time-weighted return in each calendar month (the last 24) and year, with the days of the ones only partly
 * recorded, and of the ones reaching back over days with no reading.
 */
function calendarLines(returns: PerformanceSummary["timeWeighted"]): string[] {
  if (!returns?.months?.length) return [];
  const days = (entry: CalendarReturn) => entry.extended ? ` (from ${entry.from}, the last recorded day before it, to ${entry.to})`
    : entry.partial ? ` (${entry.from} to ${entry.to} only)` : "";
  const item = (entry: CalendarReturn) => `${entry.period} ${signed(entry.return * 100, 1)}%${days(entry)}`;
  return [
    `Time-weighted return by month: ${returns.months.slice(-24).map(item).join(", ")}.`,
    ...(returns.years?.length ? [`By year: ${returns.years.map(item).join(", ")}.`] : []),
  ];
}

/** The time-weighted return's deepest fall from a high, and where it stands against its high now. */
function drawdownLines(drawdown: Drawdown | undefined): string[] {
  if (!drawdown) return [];
  if (!drawdown.peak || !drawdown.trough) return ["Over these days it never fell below an earlier high."];
  const now = drawdown.current < 0 ? ` Now ${num(-drawdown.current * 100, 1)}% below the high of ${drawdown.currentPeak}.` : " Now at its high.";
  return [`Largest fall from a high (time-weighted): ${signed(drawdown.max * 100, 1)}%, from the high on ${drawdown.peak} to the low on ${drawdown.trough}, ${drawdown.recovered ? `made up on ${drawdown.recovered}` : "not made up yet"}.${now}`];
}

/** The benchmark over the same days, and how far ahead or behind the time-weighted return is. */
function benchmarkLines(data: PerformanceSummary): string[] {
  const { benchmark, timeWeighted } = data;
  if (!timeWeighted) return [];
  if (!benchmark) return data.benchmarkProblem ? [`No benchmark comparison: ${data.benchmarkProblem}`] : [];
  const name = `${benchmark.shortName ?? benchmark.ticker}${benchmark.name ? ` (${benchmark.name})` : ""}`;
  const gap = (timeWeighted.return - benchmark.return) * 100;
  // Pence are pounds: a GBX fund is in a GBP account's currency.
  const major = (currency: string | undefined) => (currency?.toUpperCase() === "GBX" ? "GBP" : currency?.toUpperCase());
  const currency = benchmark.currencyCode && major(benchmark.currencyCode) !== major(data.accountCurrency) ? ` It is in ${benchmark.currencyCode}, so currency moves against ${data.accountCurrency} are not in it.` : "";
  const standing = Math.abs(gap) < 0.05 ? "level with it" : `${num(Math.abs(gap), 1)} percentage points ${gap > 0 ? "ahead of" : "behind"} it`;
  const fall = !benchmark.drawdown || !timeWeighted.drawdown ? ""
    : benchmark.drawdown.peak ? ` Its largest fall from a high over these days: ${signed(benchmark.drawdown.max * 100, 1)}%.` : " It never fell below an earlier high over these days.";
  return [`Benchmark ${name} over the same days: ${signed(benchmark.return * 100, 1)}% (${benchmark.source === "sample" ? "simulated" : benchmark.source} closes), so the time-weighted return is ${standing}.${fall}${currency}`];
}

function valueHistoryLines(points: PerformanceSummary["valueHistory"]): string[] {
  if (!points || points.length < 2) return [];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const change = last.totalValue - first.totalValue;
  const low = points.reduce((min, point) => (point.totalValue < min.totalValue ? point : min));
  const high = points.reduce((max, point) => (point.totalValue > max.totalValue ? point : max));
  return [
    `Account value recorded on ${points.length} day(s): ${num(first.totalValue)} on ${first.date} to ${num(last.totalValue)} on ${last.date} (${signed(change)}${first.totalValue ? `, ${signed((change / first.totalValue) * 100, 1)}%` : ""}; includes deposits and withdrawals). Low ${num(low.totalValue)} on ${low.date}, high ${num(high.totalValue)} on ${high.date}.`,
  ];
}

function holdingStopLine(position: Position, orders: PendingOrder[], currency: string | undefined): string {
  const guard = stopProtection(position, orders);
  return guard ? `Stop-loss: ${stopText(position, guard, currency)}.` : "Stop-loss: none.";
}

/** The daily closes in one line: the year's change, the shorter ranges' changes, the high and the low. */
function priceLine(data: HoldingDetail): string[] {
  const prices = data.prices;
  if (!prices) return data.pricesProblem ? [`No daily prices: ${data.pricesProblem}`] : [];
  const year = priceMove(prices.points);
  if (!year) return [];
  const unit = data.instrument.currencyCode ? ` ${data.instrument.currencyCode}` : "";
  // Only the ranges the closes reach back over, so a 3-month figure is never a shorter stretch's.
  const shorter = PRICE_RANGES.filter(([key, days]) => key !== "1y" && rangeCovered(prices.points, days)).flatMap(([key, days]) => {
    const move = priceMove(pricesIn(prices.points, days));
    return move ? [`${key.toUpperCase()} ${signedPct(move.change)}`] : [];
  });
  const source = prices.source === "sample" ? "simulated for the sample account" : `${prices.source}${prices.symbol ? ` ${prices.symbol}` : ""}`;
  return [`Daily closes (${source}) ${year.first.date} to ${year.last.date}: ${num(year.first.close, 6)} to ${num(year.last.close, 6)}${unit} (${signedPct(year.change)})${shorter.length ? `; ${shorter.join(", ")}` : ""}; high ${num(year.high.close, 6)} on ${year.high.date}, low ${num(year.low.close, 6)} on ${year.low.date}.`];
}

/** What the price did for the position over the closes, against the start at the first close plus the trading since. */
function positionHistoryLine(data: HoldingDetail): string[] {
  const history = holdingPositionHistory(data);
  if (history === "quantity") return ["No position history: the shares do not add up from the year's fills (a split, or shares moved in or out)."];
  if (history === "fills") return ["No position history: not all of the year's fills were read."];
  if (!history) return [];
  const first = history.days[0]!, last = history.days[history.days.length - 1]!;
  const c = data.accountCurrency ? ` ${data.accountCurrency}` : "";
  return [`Position from ${first.date} to ${last.date} at the closes, at today's exchange rate: value ${num(last.value)}${c} against ${num(last.base)}${c} had the price not moved (${num(history.startShares, 8)} shares at the first close, plus buys less sells at their prices), so the price ${history.gain >= 0 ? "added" : "took"} ${num(Math.abs(history.gain))}${c}.`];
}

function holding(data: HoldingDetail): string[] {
  const c = data.accountCurrency;
  const name = data.instrument.name && data.instrument.name !== data.ticker ? ` (${data.instrument.name})` : "";
  const market = data.market ? `; market ${data.market.session.replaceAll("_", " ")}${data.market.isOpen && data.market.nextClose ? `, closes ${minute(data.market.nextClose)}` : !data.market.isOpen && data.market.nextOpen ? `, opens ${minute(data.market.nextOpen)}` : ""}` : "";
  const weight = data.weight === undefined ? "" : `, ${pct(data.weight)} of the account${data.targetWeight === undefined ? "" : ` (target ${pct(data.targetWeight)})`}`;
  const history = data.history;
  return [
    ...credentialsLine(data.environment, data.credentials),
    `${data.ticker}${name} on ${env(data.environment)}${data.instrument.type ? `, ${data.instrument.type}` : ""}${data.instrument.currencyCode ? ` in ${data.instrument.currencyCode}` : ""}${market}.`,
    data.position ? `Holding: ${positionLine(data.position)}${weight}.` : `Not held${data.quote ? `; price ${num(data.quote.price, 6)}${data.instrument.currencyCode ? ` ${data.instrument.currencyCode}` : ""} (${data.quote.source === "sample" ? "simulated for the sample account" : `${data.quote.source} ${data.quote.symbol}, ${minute(data.quote.asOf)}`})` : ""}${data.targetWeight === undefined ? "" : `; target ${pct(data.targetWeight)}`}.`,
    ...(data.position ? [holdingStopLine(data.position, data.orders, c)] : []),
    ...(data.day ? [`On the day (${data.day.day}): ${dayMoveText(data.day, c).replace(/\.$/, "")}.`] : []),
    ...priceLine(data),
    ...positionHistoryLine(data),
    ...section(`Pending orders (${data.orders.length})`, rows(data.orders, (order) => orderLine(order, data.position ? [data.position] : []))),
    ...section(`Price alerts (${data.alerts.length})`, rows(data.alerts, (alert) => alertLine(alert, data.instrument))),
    ...section(`Journal notes (${data.journalTotal ?? data.journal.length})`, rows(data.journal, (entry) => journalLine(entry, false), 10)),
    ...(history
      ? [
          ...section(`Fills since ${history.from.slice(0, 10)} (${history.olderFills?.length ? `newest ${history.fills.length} of ${history.fills.length + history.olderFills.length}` : history.fills.length}${history.fillsTruncated ? ", more not read" : ""})`, rows(history.fills, (fill) => `${fill.filledAt?.slice(0, 10) ?? "?"} ${fill.side ?? "?"} ${num(Math.abs(fill.quantity ?? 0), 8)} @ ${num(fill.price, 6)}${fill.priceCurrency ? ` ${fill.priceCurrency}` : ""}${fill.netValue === undefined ? "" : `, ${money(fill.netValue, fill.accountCurrency)}`}${fill.realisedProfitLoss ? `, realized ${signed(fill.realisedProfitLoss)}` : ""}`)),
          `Dividends since ${(history.dividendsFrom ?? history.from).slice(0, 10)}: ${money(history.dividendTotal, c)} from ${history.dividendCount} payment(s)${history.dividends[0] ? `, last ${money(history.dividends[0].amount, history.dividends[0].currency)} on ${history.dividends[0].date.slice(0, 10)}` : ""}${history.dividendsTruncated ? "; older payments were not read, so the total covers only the newer part of the window" : ""}.`,
          ...(history.nextDividends ? [`Expected next dividends${history.dividendFrequency ? ` (${FREQUENCY_TEXT[history.dividendFrequency]})` : ""}, at today's quantity, dates approximate: ${history.nextDividends.slice(0, 4).map((payment) => `${payment.on < data.timestamp.slice(0, 10) ? `due ${payment.on}, not paid yet` : `about ${payment.on}`} ${money(payment.amount, c)}`).join("; ")}.`] : []),
        ]
      : [`History not read: ${data.historyProblem ?? "unknown error"}.`]),
  ];
}

function taxYear(data: TaxYearSummary): string[] {
  const c = data.accountCurrency;
  return [
    `Tax year ${data.firstDay} to ${data.lastDay} (${data.timeZone})${data.ended ? "" : " (still running)"}, amounts in ${c}.`,
    `Sales: ${data.disposals.count}, proceeds ${num(data.disposals.proceeds)}; gains ${num(data.disposals.gains)}, losses ${num(data.disposals.losses)}, net ${signed(data.disposals.net)}.`,
    `Dividends ${num(data.income.dividends)}; interest ${num(data.income.interest)}; costs ${num(data.costs.total)}${data.costs.byType.length ? ` (${data.costs.byType.map((item) => `${item.key} ${num(item.amount)}`).join(", ")})` : ""}.`,
    ...section("Sales by instrument", rows(data.byTicker, (item) => `${item.ticker}: ${item.disposals} sale(s), proceeds ${num(item.proceeds)}, realized ${signed(item.realizedProfitLoss)}`)),
    ...data.notes,
  ];
}

const FREQUENCY_TEXT = { 52: "weekly", 26: "every two weeks", 12: "monthly", 4: "quarterly", 2: "twice a year", 1: "once a year" } as const;

function income(data: IncomeSummary): string[] {
  const c = data.accountCurrency;
  return [
    `Period ${data.period.from ? day(data.period.from) : "all history"} to ${day(data.period.to)}: ${money(data.total, c)} (dividends ${num(data.dividends)}, interest ${num(data.interest)}); trailing 12 months ${num(data.trailing12Months)}.`,
    ...(data.forwardAnnual ? [`Expected next 12 months from current holdings: ${num(data.forwardAnnual.total)}${data.forwardAnnual.yieldOnValue === null ? "" : ` (${pct(data.forwardAnnual.yieldOnValue, 2)} of their value)`}; net of withholding tax, from the last year's payments.`] : []),
    ...(data.forwardAnnual?.calendar ? section("Dividend calendar, this month and the next 11 (each holding's usual spacing from its last payment, at today's quantity)", rows(
      data.forwardAnnual.calendar.filter((month) => month.paid || month.expected),
      (month) => `${month.month}: ${month.paid ? `paid ${num(month.paid)}, ` : ""}expected ${num(month.expected)}`,
    )) : []),
    ...(data.forwardAnnual?.upcoming ? section(`Next payments (${data.forwardAnnual.upcoming.length}, dates approximate)`, rows(
      data.forwardAnnual.upcoming,
      (payment) => `${payment.on < data.timestamp.slice(0, 10) ? `due ${payment.on}, not paid yet` : `about ${payment.on}`}: ${payment.ticker} ${num(payment.amount)}`,
      10,
    )) : []),
    ...section("By instrument", rows(data.byTicker.slice(0, 12), (item) => `${item.key}: ${num(item.amount)}`)),
    ...section("By month", rows(data.byMonth.slice(-12), (item) => `${item.key}: ${num(item.amount)}`)),
    ...(data.truncated ? ["History was truncated at the page limit; raise maxPages for older records."] : []),
  ];
}

interface TradeFill {
  orderId?: string;
  ticker?: string;
  name?: string;
  side?: string;
  type?: string;
  filledAt?: string;
  quantity?: number;
  price?: number;
  priceCurrency?: string;
  netValue?: number;
  accountCurrency?: string;
  realisedProfitLoss?: number;
  costs?: number;
  costItems?: Array<{ name: string; amount: number; currency?: string }>;
}

interface UnfilledOrder { orderId?: string; ticker?: string; name?: string; side?: string; type?: string; status?: string; createdAt?: string; quantity?: number; value?: number; limitPrice?: number; stopPrice?: number; priceCurrency?: string }

function tradeHistory(data: { fills: TradeFill[]; unfilled?: UnfilledOrder[]; journal?: JournalEntry[]; truncated?: boolean }): string[] {
  const fills = data.fills;
  const sum = (side: string) => fills.filter((fill) => String(fill.side).toUpperCase() === side).reduce((total, fill) => total + Math.abs(fill.netValue ?? 0), 0);
  const count = (side: string) => fills.filter((fill) => String(fill.side).toUpperCase() === side).length;
  const fees = new Map<string, number>();
  for (const fill of fills) for (const item of fill.costItems ?? []) fees.set(item.name, (fees.get(item.name) ?? 0) + item.amount);
  const currency = fills.find((fill) => fill.accountCurrency)?.accountCurrency ?? "";
  const realized = fills.reduce((total, fill) => total + (fill.realisedProfitLoss ?? 0), 0);
  return [
    ...(fills.length ? [`Totals${currency ? ` (${currency})` : ""}: ${count("BUY")} buys ${num(sum("BUY"))}, ${count("SELL")} sells ${num(sum("SELL"))}, realized P/L ${signed(realized)}, fees ${num([...fees.values()].reduce((a, b) => a + b, 0))}${fees.size ? ` (${[...fees].map(([name, amount]) => `${name} ${num(amount)}`).join(", ")})` : ""}.`] : ["No fills in this window."]),
    ...rows(fills, (fill) => `${day(fill.filledAt)} ${String(fill.side ?? "").toUpperCase()} ${num(Math.abs(fill.quantity ?? 0), 8)} ${fill.ticker ?? "?"}${fill.name ? ` (${fill.name})` : ""} @ ${num(fill.price, 6)}${fill.priceCurrency ? ` ${fill.priceCurrency}` : ""}`
      + `${fill.netValue === undefined ? "" : ` = ${num(Math.abs(fill.netValue))}${fill.accountCurrency ? ` ${fill.accountCurrency}` : ""}`}${fill.realisedProfitLoss ? `, P/L ${signed(fill.realisedProfitLoss)}` : ""}${fill.costs ? `, fees ${num(fill.costs)}` : ""}${fill.orderId ? ` (order ${fill.orderId})` : ""}`, 50),
    ...(data.unfilled ? section("Closed without a fill", rows(data.unfilled, (order) => `${day(order.createdAt)} ${String(order.side ?? "").toUpperCase()} ${order.value !== undefined && !order.quantity ? `value ${num(Math.abs(order.value))}` : num(Math.abs(order.quantity ?? 0), 8)} ${order.ticker ?? "?"} ${String(order.type ?? "").toLowerCase()}`
      + `${order.limitPrice === undefined ? "" : ` limit ${num(order.limitPrice, 6)}`}${order.stopPrice === undefined ? "" : ` stop ${num(order.stopPrice, 6)}`}${order.priceCurrency && (order.limitPrice !== undefined || order.stopPrice !== undefined) ? ` ${order.priceCurrency}` : ""} (${order.status ?? "?"})`, 50)) : []),
    ...section("Journal notes on these orders", rows(data.journal ?? [], (entry) => journalLine(entry))),
    ...(data.truncated ? ["History was truncated at the page limit; raise maxPages for older fills."] : []),
  ];
}

function orderStatus(data: OrderStatusReport): string[] {
  const filled = data.fills.reduce((sum, fill) => sum + (fill.quantity ?? 0), 0);
  const value = data.fills.reduce((sum, fill) => sum + Math.abs(fill.netValue ?? 0), 0);
  const average = filled > 0 ? data.fills.reduce((sum, fill) => sum + (fill.price ?? 0) * (fill.quantity ?? 0), 0) / filled : undefined;
  return [
    `Order ${data.orderId} on ${env(data.environment)}: ${data.state.replace("_", " ")}.`,
    ...(data.order ? [orderLine(data.order)] : []),
    ...(data.fills.length ? [`Filled ${num(filled, 8)}${average === undefined ? "" : ` at an average ${num(average, 6)}`}${value ? `, ${num(value)} ${data.fills.find((fill) => fill.currency)?.currency ?? ""}`.trimEnd() : ""} in ${data.fills.length} fill(s).`] : []),
    ...(data.state === "not_found" ? ["Not among the open orders or the recent history pages."] : []),
  ];
}

function cashHistory(data: { items: Array<{ date: string; type: string; amount: number; currency: string; ticker?: string; name?: string; quantity?: number; grossPerShare?: number; perShareCurrency?: string }>; count: number; totals: Record<string, number>; currency: string; truncated?: boolean }): string[] {
  return [
    Object.keys(data.totals).length ? `Totals${data.currency ? ` (${data.currency})` : ""}: ${Object.entries(data.totals).map(([type, total]) => `${type.toLowerCase()} ${signed(total)}`).join(", ")}.` : "No entries in this window.",
    ...rows(data.items, (item) => `${day(item.date)} ${item.type}${item.ticker ? ` ${item.ticker}` : ""}${item.name ? ` (${item.name})` : ""} ${signed(item.amount)} ${item.currency}`.trimEnd()
      + `${item.quantity === undefined ? "" : `, ${num(item.quantity, 8)} shares`}${item.grossPerShare === undefined ? "" : ` × ${num(item.grossPerShare, 6)} ${item.perShareCurrency ?? ""} gross`.trimEnd()}`, 60),
    ...(data.count > data.items.length ? [`${data.count - data.items.length} more not shown; raise limit or narrow the window.`] : []),
    ...(data.truncated ? ["History was truncated at the page limit; raise maxPages for older entries."] : []),
  ];
}

function basketDraft(data: BasketDraftPayload & { rebalance?: RebalancePlan }): string[] {
  const plan = data.rebalance;
  const skipped = plan?.skipped.map((item) => `${item.ticker}: ${item.reason}`) ?? [];
  const notes = data.notes.filter((note) => !skipped.some((line) => note.includes(line)));
  return [
    ...credentialsLine(data.environment, data.credentials),
    `${data.title} (${data.purpose}, ${env(data.environment)}):`,
    ...rows(data.legs, (leg) => `${draftLine(leg.draft, leg.instrument)}${leg.draft.referencePrice ? `, price ~${num(leg.draft.referencePrice, 6)}` : ""}${leg.estimatedNotional === undefined ? "" : ` ≈ ${money(leg.estimatedNotional, leg.estimatedNotionalCurrency)}`}${leg.reason ? ` (${leg.reason})` : ""}`),
    ...(plan ? [`Total value ${money(plan.totalValue, plan.accountCurrency)}; cash ${num(plan.cashBefore)} before, ${num(plan.cashAfter)} after.`] : []),
    ...section("Skipped", rows(skipped, (line) => line)),
    ...section("Notes", rows(notes, (line) => line)),
  ];
}

function tokenLine(token: string, expiresAt: string, environment: TradingEnvironment): string {
  return `Confirmation token ${token}, valid until ${minute(expiresAt)}. Send it only after the user explicitly says to${environment === "live" ? "; Live also needs liveAcknowledged=true once the user confirms real money is used" : ""}.`;
}

function orderPreview(data: OrderPreview): string[] {
  return [
    `Ready to send to ${env(data.draft.environment)}: ${draftLine(data.draft, data.instrument)}${data.estimatedNotional === undefined ? "" : ` ≈ ${money(data.estimatedNotional, data.estimatedNotionalCurrency)}`}${data.estimatedAccountNotional === undefined ? "" : ` (about ${money(data.estimatedAccountNotional, data.accountCurrency)})`}.`,
    ...(data.draft.thesis ? [`Why (saved to the journal once sent): ${quoted(data.draft.thesis)}.`] : []),
    ...(data.availableCash === undefined ? [] : [`Available cash ${money(data.availableCash, data.accountCurrency)}.`]),
    ...noticesLines(data.notices),
    ...policyLines(data.policy),
    tokenLine(data.token, data.expiresAt, data.draft.environment),
  ];
}

function basketPreview(data: BasketPreview): string[] {
  return [
    `Ready to send to ${env(data.environment)}: ${data.title} (${data.purpose}), sells first:`,
    ...data.legs.flatMap((leg) => [`- ${draftLine(leg.draft, leg.instrument)}${leg.estimatedNotional === undefined ? "" : ` ≈ ${money(leg.estimatedNotional, leg.estimatedNotionalCurrency)}`}${leg.estimatedAccountNotional === undefined ? "" : ` (about ${num(leg.estimatedAccountNotional)} in the account currency)`}`, ...noticesLines(leg.notices), ...policyLines(leg.policy)]),
    ...data.notes,
    tokenLine(data.token, data.expiresAt, data.environment),
  ];
}

function cancelPreview(data: CancelPreview): string[] {
  return [
    `Ready to cancel on ${env(data.environment)}: ${data.order ? orderLine(data.order) : `order ${data.orderId}`}.`,
    tokenLine(data.token, data.expiresAt, data.environment),
  ];
}

function basketExecution(data: BasketExecutionResult): string[] {
  return rows(data.legs, (leg) => `${draftLine(leg.draft)}: ${leg.result ? `${leg.result.status}${leg.result.ok ? "" : ` (${leg.result.message})`}${leg.result.verificationId ? `, verificationId ${leg.result.verificationId}` : ""}` : `not sent (${leg.skipped ?? "skipped"})`}`);
}

function orderExecution(data: OrderExecutionResult): string[] {
  const order = data.order as PendingOrder | undefined;
  return [
    ...(order && typeof order === "object" && order.id !== undefined ? [`Trading 212 order ${orderLine(order)}.`] : []),
    ...(data.status === "unknown" ? [`The result is uncertain. Do not resend; check with app_verify_unknown_execution${data.verificationId ? ` (verificationId ${data.verificationId})` : ""} or the order list.`] : []),
    ...(data.journalEntryId ? [`The reason was saved to the trade journal as ${data.journalEntryId}.`] : []),
    ...(data.journalNotSaved ? ["The reason could not be saved to the trade journal (it is full or its store failed); add it with manage_trade_journal."] : []),
  ];
}

function candidates(data: { environment: TradingEnvironment; credentials?: CredentialStatus; candidates: EnrichedTradeCandidate[] }): string[] {
  return [
    ...credentialsLine(data.environment, data.credentials),
    ...rows(data.candidates, (item) => {
      const instrument = item.resolvedInstrument ? `${item.resolvedInstrument.ticker} (${item.resolvedInstrument.name})` : item.ticker ?? item.symbol ?? item.name ?? "?";
      const held = item.heldQuantity === undefined ? "" : `, held ${num(item.heldQuantity, 8)}`;
      return `${item.action.toUpperCase()} ${instrument}: score ${item.score}, ${item.horizon}-term, ${item.risk} risk${held}${item.resolutionError ? `; not resolved: ${item.resolutionError}` : ""}`;
    }),
  ];
}

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function planLine(plan: DcaPlan): string {
  const schedule = plan.frequency === "monthly" ? `monthly on day ${plan.dayOfMonth}` : `weekly on ${WEEKDAYS[plan.weekday ?? 1]}`;
  const legs = plan.targetAmount !== undefined
    ? `${num(plan.targetAmount)} across the saved targets, most to the furthest below`
    : plan.legs.map((leg) => `${num(leg.amount)} ${leg.ticker}${leg.orderType === "limit" ? ` (limit +${num(leg.limitOffsetPercent ?? 0.5)}%)` : ""}`).join(", ");
  return `"${plan.label}" (${plan.id}, ${env(plan.environment)}): ${legs}; ${schedule} at ${plan.hourUtc}:00 UTC; next ${minute(plan.nextRunAt)}`
    + `${plan.paused ? "; paused" : ""}${plan.autoExecute ? "; runs unattended" : "; waits for confirmation"}${plan.lastOutcome ? `; last: ${plan.lastOutcome}` : ""}`;
}

function alertLine(alert: PriceAlert, instrument?: { name?: string; currencyCode?: string }): string {
  const unit = instrument?.currencyCode ? ` ${instrument.currencyCode}` : "";
  const condition = alert.condition === "above" || alert.condition === "below" ? `${alert.condition} ${num(alert.price, 6)}${unit}`
    : alert.condition === "day_move" ? `day's move of ${num(alert.percent)}% either way` : `${alert.condition.replace("_", " ")} ${num(alert.percent)}%`;
  const day = alert.condition === "day_move"
    ? `${alert.lastDayChange === undefined ? "" : `, ${signedPct(alert.lastDayChange)} since the close on ${alert.lastCloseDate ?? "?"}`}${alert.triggeredAt ? `; fired for ${alert.triggeredDay ?? "the day"}, armed again on the next trading day` : ""}`
    : "";
  return `${alert.ticker}${instrument?.name ? ` (${instrument.name})` : ""} ${condition} (${alert.id}, ${env(alert.environment)})${alert.lastPrice === undefined ? "" : `, last ${num(alert.lastPrice, 6)}${unit}`}${alert.triggeredAt ? `, triggered ${minute(alert.triggeredAt)} at ${num(alert.triggeredPrice, 6)}${unit}` : ", armed"}${day}${alert.note ? ` — ${alert.note}` : ""}`;
}

function linkLine(link: ProtectiveLink): string {
  return `${link.ticker}: ${link.orders.map((order) => `${order.role.replace("_", "-")} ${order.orderId}`).join(" + ")}`;
}

function automation(data: AutomationOverview): string[] {
  const instruments = new Map((data.instruments ?? []).map((instrument) => [instrument.ticker, instrument]));
  return [
    ...credentialsLine(data.environment, data.credentials),
    ...section(`Plans (${data.plans.length})`, rows(data.plans, planLine)),
    ...section(`Price alerts (${data.alerts.length})`, rows(data.alerts, (alert) => alertLine(alert, instruments.get(alert.ticker)))),
    ...section(`Linked stop-loss / take-profit pairs (${data.links.length})`, rows(data.links, linkLine)),
    ...(data.targets ? [`Target weights: ${data.targets.targets.map((target) => `${target.ticker} ${pct(target.weight)}`).join(", ")}, cash ${pct(data.targets.cashWeight)}; drift notices above ${num(data.targets.driftThreshold * 100, 1)} points.`] : []),
    `Today through TradePilot: ${data.usageToday.orders} order(s), ${num(data.usageToday.notional)}${data.currency ? ` ${data.currency}` : ""}.`,
    ...(data.settings.orderWatch ? ["Open orders are watched: how each one ends (filled, partly filled, closed) is reported about every 5 minutes."] : []),
  ];
}

function pieLine(pie: PieOverview, currency?: string): string {
  return `${pie.name} (#${pie.id}): value ${money(pie.value, currency)}, invested ${num(pie.invested)}, return ${signed(pie.result)}${pie.resultPercent === null ? "" : ` (${signed(pie.resultPercent)}%)`}, cash ${num(pie.cash)}`
    + `${pie.drift === undefined ? "" : `, drift ${pct(pie.drift)}`}${pie.goal ? `, goal ${num(pie.goal)}${pie.progress === null ? "" : ` (${pct(pie.progress)})`}` : ""}`;
}

function sliceLines(pie: PieOverview): string[] {
  return rows(pie.instruments ?? [], (slice) => `${slice.ticker}: target ${pct(slice.targetShare)}, current ${pct(slice.currentShare)} (${signed(slice.driftShare * 100, 1)} pts), ${num(slice.ownedQuantity, 8)} shares${slice.value === undefined ? "" : `, value ${num(slice.value)}`}${slice.issues.length ? `, issues: ${slice.issues.map((issue) => issue.name).join(", ")}` : ""}`);
}

function pies(data: PiesPayload): string[] {
  return [
    ...credentialsLine(data.environment, data.credentials),
    `Totals: value ${money(data.totals.value, data.currency)}, invested ${num(data.totals.invested)}, return ${signed(data.totals.result)}, cash ${num(data.totals.cash)}.`,
    ...data.pies.flatMap((pie) => [`- ${pieLine(pie, data.currency)}`, ...sliceLines(pie).map((line) => `  ${line}`)]),
    ...data.notes,
  ];
}

function pieChange(data: PieChangeDraftPayload | PieChangePreview | PieChangeResult): string[] {
  if (data.kind === "pie_change_result") return data.pie?.settings?.id ? [`Pie #${data.pie.settings.id}${data.pie.settings.name ? ` "${data.pie.settings.name}"` : ""}.`] : [];
  if (data.kind === "pie_change_draft") {
    const draft = data.draft;
    const shares = Object.entries(draft.instrumentShares ?? {});
    const total = shares.reduce((sum, [, share]) => sum + share, 0);
    return [
      ...credentialsLine(draft.environment, data.credentials),
      `${draft.action} pie${draft.pieId ? ` #${draft.pieId}` : ""}${draft.name ? ` "${draft.name}"` : ""}${draft.goal ? `, goal ${num(draft.goal)}` : ""}${draft.dividendCashAction ? `, dividends ${draft.dividendCashAction}` : ""}.`,
      ...(shares.length && total > 0 ? [`Target slices: ${shares.map(([ticker, share]) => `${ticker} ${pct(share / total)}`).join(", ")}.`] : []),
      ...(data.current ? [`Now: ${pieLine(data.current)}`] : []),
    ];
  }
  return [
    `${data.action} pie${data.pieId ? ` #${data.pieId}` : ""}${data.request?.name ? ` "${data.request.name}"` : ""} on ${env(data.environment)}.`,
    ...section("Slice changes", rows(data.changes, (change) => `${change.ticker}: ${pct(change.from)} → ${pct(change.to)}`)),
    ...data.notices,
    tokenLine(data.token, data.expiresAt, data.environment),
  ];
}

function policy(data: { environment: TradingEnvironment; policy: TradingPolicy; maxOrderNotional: number; maxOrderQuantity?: number; usageToday: { orders: number; notional: number } }): string[] {
  const p = data.policy;
  const off = "off";
  return [
    `Per-order caps: value ${data.maxOrderNotional || off} (account currency), quantity ${data.maxOrderQuantity === undefined ? "?" : data.maxOrderQuantity || off} shares.`,
    `Max position weight ${p.maxPositionWeight ? pct(p.maxPositionWeight) : off}; daily orders ${p.dailyOrderLimit || off} (used ${data.usageToday.orders}); daily value ${p.dailyNotionalLimit || off} (used ${num(data.usageToday.notional)}).`,
    `Allowed tickers ${p.allowedTickers.join(", ") || "any"}; blocked ${p.blockedTickers.join(", ") || "none"}; allowed types to buy ${p.allowedTypes.join(", ") || "any"}.`,
    `Market orders while closed ${p.marketOrdersWhenClosed ? "allowed" : "blocked"}; reference price older than ${p.maxReferenceAgeSeconds ? `${p.maxReferenceAgeSeconds}s blocks` : "any age only warns"}.`,
  ];
}

function exports(data: { requested?: { reportId?: number | string }; reports?: ExportReport[] }): string[] {
  return rows(data.reports ?? [], (report) => {
    const record = report as unknown as Record<string, unknown>;
    return `#${record.reportId ?? "?"} ${record.status ?? ""} ${day(record.timeFrom as string | undefined)} to ${day(record.timeTo as string | undefined)}${record.downloadLink ? `: ${record.downloadLink}` : ""}`;
  });
}

/** Extra lines for a tool payload, or nothing when the summary already says it all. */
export function describePayload(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const payload = data as Record<string, unknown> & { kind?: string };
  let lines: string[] = [];
  switch (payload.kind) {
    case "portfolio": lines = portfolio(payload as unknown as PortfolioSnapshot); break;
    case "portfolio_today": lines = todayLines(payload as unknown as PortfolioToday); break;
    case "allocation": lines = allocation(payload as unknown as AllocationAnalysis); break;
    case "performance": lines = performance(payload as unknown as PerformanceSummary); break;
    case "income": lines = income(payload as unknown as IncomeSummary); break;
    case "tax_year": lines = taxYear(payload as unknown as TaxYearSummary); break;
    case "holding": lines = holding(payload as unknown as HoldingDetail); break;
    case "target_allocation": lines = targetAllocation(payload as unknown as Parameters<typeof targetAllocation>[0]); break;
    case "trade_history": lines = tradeHistory(payload as unknown as Parameters<typeof tradeHistory>[0]); break;
    case "basket_draft": lines = basketDraft(payload as unknown as BasketDraftPayload & { rebalance?: RebalancePlan }); break;
    case "basket_preview": lines = basketPreview(payload as unknown as BasketPreview); break;
    case "basket_execution": lines = basketExecution(payload as unknown as BasketExecutionResult); break;
    case "order_draft": {
      const draft = payload as unknown as OrderDraftPayload;
      lines = [...credentialsLine(draft.draft.environment, draft.credentials), `Draft: ${draftLine(draft.draft, draft.resolvedInstrument)}${draft.draft.referencePrice ? `, reference price ${num(draft.draft.referencePrice, 6)} ${draft.resolvedInstrument?.currencyCode ?? ""}`.trimEnd() : ""}.`,
        ...(draft.draft.thesis ? [`Why: ${quoted(draft.draft.thesis)}.`] : [])];
      break;
    }
    case "order_preview": lines = orderPreview(payload as unknown as OrderPreview); break;
    case "order_execution": lines = orderExecution(payload as unknown as OrderExecutionResult); break;
    case "cancel_draft": {
      const draft = payload as unknown as CancelDraftPayload;
      lines = [...credentialsLine(draft.environment, draft.credentials), draft.order ? `Cancel on ${env(draft.environment)}: ${orderLine(draft.order)}. The user confirms it in the widget.` : `Order ${draft.orderId} is not open on ${env(draft.environment)}.`];
      break;
    }
    case "cancel_preview": lines = cancelPreview(payload as unknown as CancelPreview); break;
    case "order_status": lines = orderStatus(payload as unknown as OrderStatusReport); break;
    case "cash_history": lines = cashHistory(payload as unknown as Parameters<typeof cashHistory>[0]); break;
    case "execution_verification": {
      const verification = payload as unknown as ExecutionVerificationResult;
      lines = [`Status: ${verification.status.replaceAll("_", " ")}${verification.positionDelta === undefined ? "" : `; position changed by ${num(verification.positionDelta, 8)}`}.`];
      break;
    }
    case "trade_plan": lines = candidates(payload as unknown as { environment: TradingEnvironment; credentials?: CredentialStatus; candidates: EnrichedTradeCandidate[] }); break;
    case "investment_plans": lines = rows((payload.plans as DcaPlan[]) ?? [], planLine); break;
    case "investment_plan": lines = payload.plan ? [planLine(payload.plan as DcaPlan)] : []; break;
    case "automation": lines = automation(payload as unknown as AutomationOverview); break;
    case "pies": lines = pies(payload as unknown as PiesPayload); break;
    case "pie_change_draft":
    case "pie_change_preview":
    case "pie_change_result": lines = pieChange(payload as unknown as PieChangeDraftPayload | PieChangePreview | PieChangeResult); break;
    case "price_alerts": lines = rows((payload.alerts as PriceAlert[]) ?? [], (alert) => alertLine(alert)); break;
    case "price_alert": lines = payload.alert ? [alertLine(payload.alert as PriceAlert)] : []; break;
    case "trade_journal": lines = rows((payload as unknown as JournalPayload).entries, (entry) => journalLine(entry)); break;
    case "journal_review": lines = journalReview(payload as unknown as JournalReview); break;
    case "watchlist": lines = watchlist(payload as unknown as WatchlistView); break;
    case "journal_entry": lines = payload.entry ? [journalLine(payload.entry as JournalEntry)] : []; break;
    case "trading_policy": lines = policy(payload as unknown as Parameters<typeof policy>[0]); break;
    case "history_export": lines = exports(payload as Parameters<typeof exports>[0]); break;
    case "activity": lines = rows((payload.activity as ActivityEvent[]) ?? [], activityLine); break;
    case "instrument_search": lines = rows((payload.instruments as Instrument[]) ?? [], (item) => `${item.ticker}: ${item.name} (${item.shortName}, ${item.currencyCode}${item.type ? `, ${item.type}` : ""}${item.isin ? `, ${item.isin}` : ""})`); break;
    default: lines = [];
  }
  return lines.filter(Boolean).join("\n");
}
