// Plain-text versions of the tool payloads. Hosts without the TradePilot widget (Claude Code, other
// terminals) show the model only a tool's text, so every result carries the facts needed to answer
// from it: holdings, orders, plans, skipped legs, tokens to confirm. Lists are capped to stay short.

import type { ExportSummary } from "./export-csv.js";
import type { HoldingDetail } from "../shared/holding.js";
import { equalRiskTargets, marketScenarios, PARITY_MIN_VOLATILITY } from "../shared/holding-risk.js";
import { holdingPositionHistory } from "../shared/position-history.js";
import { PRICE_RANGES, priceMove, pricesIn, rangeCovered } from "../shared/prices.js";
import { MAX_REVIEW_QUOTES, REVIEW_AFTER_DAYS, type JournalEntry, type JournalPayload, type JournalReview, type JournalTagStats, type JournalTrade } from "../shared/journal.js";
import type { AccountSummary, ActivityEvent, CancelDraftPayload, CancelPreview, CredentialStatus, EnrichedTradeCandidate, ExecutionVerificationResult, Instrument, OrderDraft, OrderDraftPayload, OrderExecutionResult, OrderNotice, OrderPreview, PendingOrder, PortfolioSnapshot, Position, TradingEnvironment, OrderImpact } from "../shared/contracts.js";
import type { AccountAlert, AutomationOverview, BasketDraftPayload, BasketExecutionResult, BasketPreview, DcaPlan, PolicyCheck, PriceAlert, ProtectiveLink, RebalancePlan, TargetAllocation, TradingPolicy } from "../shared/automation.js";
import type { AllocationAnalysis, AllocationDrift, CalendarReturn, DailyMove, Drawdown, ExportReport, FillTotals, HoldingMix, IncomeSummary, MarketSensitivity, PerformanceSummary, TaxYearSummary } from "../shared/history.js";
import type { TradeTotals } from "../shared/trade-cost.js";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PieOverview, PiesPayload } from "../shared/pies.js";
import { portfolioProtection, stopOutcome, stopProtection, type StopProtection } from "../shared/protection.js";
import type { DayMove, PortfolioToday } from "../shared/today.js";
import { fxShown, resultSplit, resultSplitOf } from "../shared/result-split.js";
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

// Signed by the figure shown: a move that rounds to 0 reads "+0%" either way, not "0%" for a tiny loss.
const signedPct = (value: number) => { const shown = Math.round(value * 1000) / 10 || 0; return `${shown >= 0 ? "+" : ""}${num(shown, 1)}%`; };

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
    ...(data.truncated ? ["History was truncated at the page limit; older fills are not counted yet. A higher maxPages reads further back, and for periods over 60 days TradePilot keeps what it has read, so asking again goes on from there."] : []),
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
  const fx = resultSplit(position)?.fx;
  const walletCurrency = typeof wallet?.currency === "string" ? ` ${wallet.currency}` : "";
  const name = position.instrument.name && position.instrument.name !== position.instrument.ticker ? ` ${position.instrument.name}` : "";
  const available = position.quantityAvailableForTrading !== position.quantity ? `, ${num(position.quantityAvailableForTrading, 8)} available` : "";
  const pies = position.quantityInPies ? `, ${num(position.quantityInPies, 8)} in pies` : "";
  return `${position.instrument.ticker}${name}: ${num(position.quantity, 8)} @ ${num(position.currentPrice, 6)} ${position.instrument.currencyCode ?? ""} (avg ${num(position.averagePricePaid, 6)})`
    + `${value === undefined ? "" : `, value ${num(value)}${walletCurrency}`}${pnl === undefined ? "" : `, P/L ${signed(pnl)}`}${fxShown(fx) ? ` (exchange rate ${signed(fx)})` : ""}${available}${pies}`;
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

/** The unrealized P/L in what the prices did and what the exchange rates did, when a rate moved one. */
function resultSplitLines(data: PortfolioSnapshot): string[] {
  const split = resultSplitOf(data.positions);
  if (!fxShown(split?.fx)) return [];
  const total = data.account?.investments?.unrealizedProfitLoss ?? split.total;
  return [`Of the unrealized P/L, prices made ${signed(total - split.fx)} and exchange rates ${signed(split.fx)} (${split.foreign} holding${split.foreign === 1 ? "" : "s"} in another currency).`];
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
    ...resultSplitLines(data),
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
    ...holdingRiskLines(data),
  ];
}

/** Why a holding's closes were not read, for several at once. */
const RISK_MISSING: Record<NonNullable<AllocationAnalysis["riskMissing"]>[number]["reason"], string> = {
  later: "not read in time; they are being read for the next read",
  symbol: "no quote provider symbol (QUOTE_SYMBOLS)",
  unit: "closes in another unit than Trading 212's (QUOTE_SYMBOLS)",
  data: "no daily closes from the quote provider",
  provider: "no quote provider",
  plan: "no year of closes on the quote provider's plan",
  sample: "no sample closes",
};
/** At most this many tickers are named for one reason. */
const MAX_NAMED = 10;

/** The holdings left out of risk by holding, by reason: one with its own words, several with the reason's. */
function riskMissingLine(missing: NonNullable<AllocationAnalysis["riskMissing"]>): string {
  const groups = new Map<string, typeof missing>();
  for (const item of missing) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item]);
  return `Risk by holding leaves out ${[...groups].map(([reason, items]) => {
    if (items.length === 1) return `${items[0]!.ticker} (${items[0]!.problem.replace(/\.$/, "")})`;
    const named = items.slice(0, MAX_NAMED).map((item) => item.ticker).join(", ");
    return `${named}${items.length > MAX_NAMED ? ` and ${items.length - MAX_NAMED} more` : ""} (${RISK_MISSING[reason as keyof typeof RISK_MISSING]})`;
  }).join("; ")}.`;
}

/** Each holding's share of the holdings' risk beside its share of their value, and what was left out. */
function holdingRiskLines(data: AllocationAnalysis): string[] {
  const missing = data.riskMissing?.length ? [riskMissingLine(data.riskMissing)] : [];
  const { risk } = data;
  if (!risk) return [...(data.riskProblem ? [`No risk by holding: ${data.riskProblem}`] : []), ...missing];
  const pairs = risk.correlations.tickers.flatMap((a, i) => risk.correlations.tickers.slice(i + 1).map((b, k) => ({ a, b, value: risk.correlations.matrix[i]![i + 1 + k]! })))
    .sort((x, y) => y.value - x.value);
  const pair = (item: { a: string; b: string; value: number }) => `${item.a}–${item.b} ${num(item.value, 2)}`;
  return [
    ...section(`Risk by holding (weekly closes ${risk.from} to ${risk.to}, ${risk.weeks} weeks, each in its own currency; ${pct(risk.covered, 0)} of the holdings' value): together ${pct(risk.volatility)} a year, diversification ratio ${num(risk.diversification, 2)} (their own volatilities, weighted, over that)`,
      rows(risk.rows, (row) => `${row.ticker}: ${pct(row.risk, 0)} of the risk, ${pct(row.weight, 0)} of the value; volatility ${pct(row.volatility, 0)} a year, correlation with them together ${num(row.correlation, 2)}`)),
    ...(pairs.length >= 6 ? [`Most alike: ${pairs.slice(0, 3).map(pair).join(", ")}; least alike: ${pairs.slice(-3).reverse().map(pair).join(", ")}.`]
      : pairs.length > 1 ? [`Correlations, most alike first: ${pairs.map(pair).join(", ")}.`] : []),
    ...(risk.short?.length ? [`Too few weekly closes, or weeks that do not line up with the rest's, to measure: ${risk.short.join(", ")}.`] : []),
    ...(risk.jumps?.length ? [`Left out, closes that jump more than fivefold in a week (a change of unit or a split): ${risk.jumps.join(", ")}.`] : []),
    ...(risk.mix ? [mixLine(risk.mix, data.accountCurrency)] : []),
    ...(risk.market ? marketLines(risk.market, risk.mix?.value, data) : []),
    ...parityLines(data),
    ...missing,
  ];
}

/** At most this many holdings are named with their beta, the highest first. */
const MAX_BETA_NAMED = 12;

/** How the holdings measured move with the benchmark, and what a fall in it would take by their beta. */
function marketLines(market: MarketSensitivity, value: number | undefined, data: AllocationAnalysis): string[] {
  const scenarios = value ? marketScenarios(market.beta, value, data.totalValue) : [];
  const worst = market.worstWeek;
  return [
    ...section(`Against the market (${market.ticker}, weekly closes ${market.from} to ${market.to}, ${market.weeks} weeks; its volatility ${pct(market.volatility)} a year): together a beta of ${num(market.beta, 2)}, correlation ${num(market.correlation, 2)}`,
      rows(market.rows.slice(0, MAX_BETA_NAMED), (row) => `${row.ticker}: beta ${num(row.beta, 2)}, correlation ${num(row.correlation, 2)}, ${pct(row.weight, 0)} of the value measured`)),
    ...(market.rows.length > MAX_BETA_NAMED ? [`And ${market.rows.length - MAX_BETA_NAMED} more.`] : []),
    ...(scenarios.length ? [`If ${market.ticker} fell, by that beta alone: ${scenarios.map((scenario) => `${pct(-scenario.market, 0)} → ${signedPct(scenario.move)}, about ${money(Math.round(scenario.amount), data.accountCurrency)}${scenario.account !== undefined ? ` (${signedPct(scenario.account)} of the account, cash and holdings not measured not moving)` : ""}`).join("; ")}. A beta is how the holdings moved with it on average over those weeks, not a forecast; each also moves on its own.`] : []),
    ...(worst ? [`${market.ticker}'s worst week over those weeks, to ${worst.date}: ${signedPct(worst.market)}${worst.mix === undefined ? "" : `; today's mix ${signedPct(worst.mix)} that week`}.`] : []),
  ];
}

/** At most this many holdings are named with their equal-risk weight, those furthest from it first. */
const MAX_PARITY_NAMED = 12;

/** The equal-risk weights beside today's, and the targets that plan the move. */
function parityLines(data: AllocationAnalysis): string[] {
  const { risk } = data;
  if (!risk || risk.parityVolatility === undefined || !risk.rows.every((row) => row.parity !== undefined)) return [];
  const moves = [...risk.rows].sort((a, b) => Math.abs(b.parity! - b.weight) - Math.abs(a.parity! - a.weight) || b.weight - a.weight);
  const plan = equalRiskTargets(data);
  return [
    `Equal-risk weights, at which each holding measured brings the same share of their risk (from the same weeks, the correlations pulled toward their average as far as the weeks leave them in doubt; a holding that moved less than ${pct(PARITY_MIN_VOLATILITY, 0)} a year keeps its weight): together ${pct(risk.parityVolatility)} a year against ${pct(risk.volatility)} at today's weights. Furthest from it first: ${moves.slice(0, MAX_PARITY_NAMED).map((row) => `${row.ticker} ${pct(row.parity, 1)} (now ${pct(row.weight, 1)})`).join(", ")}${moves.length > MAX_PARITY_NAMED ? `, and ${moves.length - MAX_PARITY_NAMED} more` : ""}. They spread the risk by the past year; they are not a forecast.`,
    ...(plan ? [`To plan the move, call plan_portfolio_rebalance with targets ${plan.targets.map((target) => `${target.ticker} ${target.weight}`).join(", ")} and cashWeight ${plan.cashWeight}: shares of the account, so the holdings measured keep their value together and the holdings not measured and the cash free to trade stay as they are, at the values read now${plan.partial ? `; only the ${plan.targets.length} furthest from their equal-risk weight move, as a basket takes ${plan.targets.length} orders at most` : ""}.`] : []),
  ];
}

/** Today's mix of the holdings measured, over the weeks read: its return, bad weeks and deepest fall. */
function mixLine(mix: HoldingMix, currency: string): string {
  const { drawdown } = mix;
  const fall = drawdown?.peak && drawdown.trough
    ? ` Deepest fall ${pct(drawdown.max)}, from ${drawdown.peak} to ${drawdown.trough}, ${drawdown.recovered ? `made up by ${drawdown.recovered}` : "not made up yet"}.`
    : "";
  const bad = mix.badWeek < 0
    ? `A bad week, one in 20: ${pct(mix.badWeek, mix.badWeek > -0.0005 ? 2 : 1)} or worse, about ${money(Math.round(-mix.badWeek * mix.value), currency)} of today's ${money(Math.round(mix.value), currency)} measured; ${signedPct(mix.badWeeks)} on average in those weeks. `
    : `It fell in fewer than one week in 20 (that week ${signedPct(mix.badWeek)}). `;
  return `Today's mix over those weeks, at today's weights kept each week, each holding in its own currency: ${signedPct(mix.return)}, up in ${mix.up} of ${mix.counted} weeks. `
    + bad
    + `Worst week ${signedPct(mix.worst.return)} to ${mix.worst.date}, best ${signedPct(mix.best.return)} to ${mix.best.date}.${fall}`;
}

const points = (value: number) => `${signed(value * 100, 1)} pts`;

function driftLines(drift: AllocationDrift): string[] {
  return section(`Against targets (largest drift ${num(drift.maxDrift * 100, 1)} points; notices above ${num(drift.threshold * 100, 1)} points)`, [
    ...rows(drift.rows, (row) => `${row.ticker}: ${pct(row.current)} now, target ${pct(row.target)}, ${points(row.drift)}`),
    `- Cash: ${pct(drift.cash.current)} now, target ${pct(drift.cash.target)}, ${points(drift.cash.drift)}`,
    ...(drift.untargeted.length ? [`- No target${drift.sellUntargeted ? " (sold by a rebalance to these targets)" : " (kept by a rebalance)"}: ${drift.untargeted.map((item) => `${item.ticker} ${pct(item.current)}`).join(", ")}`] : []),
    ...(drift.volatility ? [targetVolatilityLine(drift.volatility)] : []),
    ...(drift.rebalance ? [driftTradesLine(drift.rebalance)] : []),
    ...(drift.rebalanceOver ? [driftTradesLine(drift.rebalanceOver.totals, `A rebalance of only the ones more than ${num(drift.threshold * 100, 1)} points off (${drift.rebalanceOver.tickers.join(", ")}${drift.rebalanceOver.cashTo?.length ? `, with buys of ${drift.rebalanceOver.cashTo.join(", ")} so the cash doesn't stay more than that over its target` : ""}; plan_portfolio_rebalance with band ${drift.threshold})`)] : []),
  ]);
}

/** What converting the part in other currencies costs, as a clause starting "; ", or that none of it is converted. */
function fxFeeClause(totals: TradeTotals): string {
  if (!(totals.converted > 0)) return "; none of it in another currency";
  const unknown = totals.unknownCurrency ? ` (${totals.unknownCurrency} in a currency not known, counted as converted)` : "";
  return totals.fxFeeRate > 0
    ? `; ${money(totals.converted, totals.currency)} of it in other currencies${unknown}, about ${money(totals.fxFee, totals.currency)} in Trading 212's ${num(totals.fxFeeRate * 100, 3)}% conversion fee, none on a trade paid from or into a balance in that currency`
    : `; ${money(totals.converted, totals.currency)} of it in other currencies${unknown}, no conversion fee counted (FX_FEE_RATE is 0)`;
}

function driftTradesLine(totals: TradeTotals, lead = "A rebalance to the targets"): string {
  if (!(totals.bought > 0) && !(totals.sold > 0)) {
    return totals.buysScaled !== undefined
      ? `- ${lead} would buy nothing: no cash is free above the cash target, and nothing is to be sold to pay for the buys.`
      : `- ${lead} would trade nothing: every change is below 1 in the account currency or within the rounding of a target.`;
  }
  const trades = [totals.bought > 0 ? `buy about ${money(totals.bought, totals.currency)}` : "", totals.sold > 0 ? `sell about ${money(totals.sold, totals.currency)}` : ""].filter(Boolean).join(" and ");
  const scaled = totals.buysScaled === undefined ? "" : totals.bought > 0
    ? ` The cash to spare, with what the sells raise, pays for about ${Math.floor(totals.buysScaled * 100)}% of the buys.`
    : " The cash to spare, with what the sells raise, pays for none of the buys.";
  return `- ${lead} would ${trades}${fxFeeClause(totals)}.${scaled} By weight; whole shares can trade a little less.`;
}

function targetVolatilityLine(volatility: NonNullable<AllocationDrift["volatility"]>): string {
  const { account, leftOut } = volatility;
  return `- At the targets, the holdings and targets measured would move ${pct(volatility.atTargets)} a year together (${pct(volatility.now)} now)`
    + (account ? `; the account, cash counted as not moving, ${pct(account.atTargets)} (${pct(account.now)} now)` : "")
    + (leftOut?.length ? `; not measured, so left out: ${leftOut.join(", ")}` : "")
    + ". From the weeks of risk by holding; past volatility, not a forecast.";
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
    ...riskLines(data),
    ...attributionLines(data),
    ...section("By instrument", rows(data.byTicker.filter((item) => item.realizedProfitLoss || item.dividends || item.costs).slice(0, 10), (item) => `${item.ticker}: realized ${signed(item.realizedProfitLoss)}, dividends ${num(item.dividends)}, costs ${num(item.costs)}`)),
    ...(data.coverage.truncated ? ["History was truncated at the page limit; older records are not counted yet. A higher maxPages reads further back, and for periods over 60 days TradePilot keeps what it has read, so asking again goes on from there."] : []),
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

/** How much the time-weighted return moved from day to day, its best and worst days, and how it moved with the benchmark. */
function riskLines(data: PerformanceSummary): string[] {
  const risk = data.timeWeighted?.risk;
  if (!risk) return [];
  const bench = data.benchmark?.risk;
  const name = data.benchmark ? data.benchmark.shortName ?? data.benchmark.ticker : "";
  const moved = risk.up + risk.down;
  const day = (move: DailyMove) => `${signed(move.return * 100, 2)}% on ${move.date}`;
  const days = [risk.best && `best day ${day(risk.best)}`, risk.worst && `worst ${day(risk.worst)}`].filter(Boolean).join(", ");
  return [[
    `Risk from ${risk.from} to ${risk.to}, ${risk.days} weekdays (${risk.stretches} stretches between readings; today is left out until it is over): volatility ${num(risk.volatility * 100, 1)}% a year${bench ? ` (${name} ${num(bench.volatility * 100, 1)}%)` : ""}.`,
    ...(risk.ratio !== undefined && risk.annualized !== undefined ? [`Return ${signed(risk.annualized * 100, 1)}% a year at this rate, ${num(risk.ratio, 2)} times the volatility.`] : []),
    ...(bench?.beta !== undefined ? [`Beta ${num(bench.beta, 2)}${bench.correlation !== undefined ? ` and correlation ${num(bench.correlation, 2)}` : ""} to ${name}, counting its day before and after too.`]
      : bench ? [`Beta and correlation to ${name} need 60 stretches and a benchmark that moves.`] : []),
    ...(days ? [`${days[0]!.toUpperCase()}${days.slice(1)}.`] : []),
    ...(moved > 1 ? [`Up on ${risk.up} of the ${moved} days it moved.`] : moved ? [`${risk.up ? "Up" : "Down"} on the one day it moved.`] : []),
  ].join(" ")];
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
  if (history === "quantity") return ["No position history: going back through the year's fills leaves fewer than no shares on some day (a split, or shares moved out without a fill)."];
  if (history === "split") return ["No position history: the closes or the fill prices jump as across a split, so the shares before it cannot be matched to the closes."];
  if (history === "fills") return ["No position history: some fills were read without a price or date."];
  if (!history) return [];
  const first = history.days[0]!, last = history.days[history.days.length - 1]!;
  const c = data.accountCurrency ? ` ${data.accountCurrency}` : "";
  const rate = !foreign(data) ? "" : history.fillRates ? ", at its fills' exchange rates (today's is not known: nothing in its currency is held)" : ", at today's exchange rate";
  const since = history.shortened ? ` Older fills were not read, so it starts on ${first.date}.` : "";
  return [`Position from ${first.date} to ${last.date} at the closes${rate}: value ${num(last.value)}${c} against ${num(last.base)}${c} net put in (${num(history.startShares, 8)} shares at the first close, plus buys less sells at their prices), so the price ${history.gain >= 0 ? "added" : "took"} ${num(Math.abs(history.gain))}${c}.${since}`];
}

/** Whether the instrument is priced in another currency than the account's (pence and pounds are one). */
function foreign(data: HoldingDetail): boolean {
  const major = (currency: string | undefined) => (currency?.toUpperCase() === "GBX" ? "GBP" : currency?.toUpperCase());
  return !!data.instrument.currencyCode && !!data.accountCurrency && major(data.instrument.currencyCode) !== major(data.accountCurrency);
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
    ...(data.truncated ? ["History was truncated at the page limit; older records are not counted yet. A higher maxPages reads further back, and for periods over 60 days TradePilot keeps what it has read, so asking again goes on from there."] : []),
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

function tradeHistory(data: { fills: TradeFill[]; count?: number; totals?: FillTotals; unfilled?: UnfilledOrder[]; journal?: JournalEntry[]; truncated?: boolean }): string[] {
  const fills = data.fills;
  const sell = (fill: TradeFill) => String(fill.side ?? "").toUpperCase() === "SELL" || (fill.quantity ?? 0) < 0;
  const fees = new Map<string, number>();
  for (const fill of fills) for (const item of fill.costItems ?? []) fees.set(item.name, (fees.get(item.name) ?? 0) + item.amount);
  // The window's totals from the server cover every fill in it; a result without them (an older one) is added up here.
  const totals: FillTotals = data.totals ?? {
    buys: fills.filter((fill) => !sell(fill)).length,
    sells: fills.filter(sell).length,
    bought: fills.filter((fill) => !sell(fill)).reduce((total, fill) => total + Math.abs(fill.netValue ?? 0), 0),
    sold: fills.filter(sell).reduce((total, fill) => total + Math.abs(fill.netValue ?? 0), 0),
    realised: fills.reduce((total, fill) => total + (fill.realisedProfitLoss ?? 0), 0),
    costs: fills.reduce((total, fill) => total + (fill.costs ?? 0), 0),
  };
  const currency = totals.currency ?? fills.find((fill) => fill.accountCurrency)?.accountCurrency ?? "";
  const all = data.count ?? fills.length;
  const partial = all > fills.length;
  return [
    ...(all ? [`Totals over all ${all} fill(s)${currency ? ` (${currency})` : ""}: ${totals.buys} buys ${num(totals.bought)}, ${totals.sells} sells ${num(totals.sold)}, realized P/L ${signed(totals.realised)}, fees ${num(totals.costs)}.`] : ["No fills in this window."]),
    ...(fees.size ? [`Fees by kind${partial ? ` over the ${fills.length} listed` : ""}: ${[...fees].map(([name, amount]) => `${name} ${num(amount)}`).join(", ")}.`] : []),
    ...(partial ? [`The newest ${fills.length} of ${all} fills are listed below; a higher limit (up to 200) or a shorter window lists more.`] : []),
    ...rows(fills, (fill) => `${day(fill.filledAt)} ${String(fill.side ?? "").toUpperCase()} ${num(Math.abs(fill.quantity ?? 0), 8)} ${fill.ticker ?? "?"}${fill.name ? ` (${fill.name})` : ""} @ ${num(fill.price, 6)}${fill.priceCurrency ? ` ${fill.priceCurrency}` : ""}`
      + `${fill.netValue === undefined ? "" : ` = ${num(Math.abs(fill.netValue))}${fill.accountCurrency ? ` ${fill.accountCurrency}` : ""}`}${fill.realisedProfitLoss ? `, P/L ${signed(fill.realisedProfitLoss)}` : ""}${fill.costs ? `, fees ${num(fill.costs)}` : ""}${fill.orderId ? ` (order ${fill.orderId})` : ""}`, 50),
    ...(data.unfilled ? section("Closed without a fill", rows(data.unfilled, (order) => `${day(order.createdAt)} ${String(order.side ?? "").toUpperCase()} ${order.value !== undefined && !order.quantity ? `value ${num(Math.abs(order.value))}` : num(Math.abs(order.quantity ?? 0), 8)} ${order.ticker ?? "?"} ${String(order.type ?? "").toLowerCase()}`
      + `${order.limitPrice === undefined ? "" : ` limit ${num(order.limitPrice, 6)}`}${order.stopPrice === undefined ? "" : ` stop ${num(order.stopPrice, 6)}`}${order.priceCurrency && (order.limitPrice !== undefined || order.stopPrice !== undefined) ? ` ${order.priceCurrency}` : ""} (${order.status ?? "?"})`, 50)) : []),
    ...section("Journal notes on these orders", rows(data.journal ?? [], (entry) => journalLine(entry))),
    ...(data.truncated ? ["History was truncated at the page limit; older fills are not counted yet. A higher maxPages reads further back, and for periods over 60 days TradePilot keeps what it has read, so asking again goes on from there."] : []),
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
    ...(data.truncated ? ["History was truncated at the page limit; older entries are not counted yet. A higher maxPages reads further back, and for periods over 60 days TradePilot keeps what it has read, so asking again goes on from there."] : []),
  ];
}

function basketTotalsLine(totals: TradeTotals): string {
  const bought = `${money(totals.bought, totals.currency)}`;
  const sold = `${money(totals.sold, totals.currency)}`;
  return totals.bought > 0 && totals.sold > 0 ? `Buys ${bought}, sells ${sold}.` : totals.bought > 0 ? `Buys ${bought}.` : `Sells ${sold}.`;
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
    ...(plan?.totals && (plan.totals.bought > 0 || plan.totals.sold > 0) ? [basketTotalsLine(plan.totals)] : []),
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
    ...(data.impact ? impactLines(data.impact) : []),
    ...noticesLines(data.notices),
    ...policyLines(data.policy),
    tokenLine(data.token, data.expiresAt, data.draft.environment),
  ];
}

/** What the order would change, as estimates at the review's prices. */
function impactLines(impact: OrderImpact): string[] {
  const parts = [
    `shares ${num(impact.sharesBefore, 8)} to ${num(impact.sharesAfter, 8)}`,
    ...(impact.weightBefore === undefined || impact.weightAfter === undefined ? [] : [`${pct(impact.weightBefore)} to ${pct(impact.weightAfter)} of the account`]),
    ...(impact.cashAfter === undefined ? [] : [`cash to trade ${money(impact.cashBefore)} to ${money(impact.cashAfter, impact.currency)}`]),
    ...(impact.realized === undefined ? [] : [`realized ${signed(impact.realized)} ${impact.currency} against Trading 212's average price, before the conversion fee`]),
    ...(impact.fxFee === undefined ? [] : [`conversion fee at most ${money(impact.fxFee, impact.currency)} (${pct(impact.fxFeeRate, 2)})`]),
  ];
  return [
    `If it fills, about: ${parts.join("; ")}.`,
    ...(impact.cashAfter !== undefined && impact.cashAfter < 0 ? ["The cash to trade would fall below zero with the conversion fee: Trading 212 may refuse the order for want of funds."] : []),
    ...(impact.ukRule === "sell_loss" ? ["UK rules, outside an ISA: shares of the same company bought back today or within 30 days are matched with this sale first, at that rebuy's cost instead of the average cost, so most of this loss may not count."]
      : impact.ukRule === "sell" ? ["UK rules, outside an ISA: shares of the same company bought today or within 30 days after this sale are matched with it first, at their own cost instead of the section 104 pool's average."] : []),
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
  const schedule = plan.frequency === "monthly" ? ((plan.dayOfMonth ?? 1) >= 31 ? "monthly on the last day" : `monthly on day ${plan.dayOfMonth}${(plan.dayOfMonth ?? 1) > 28 ? " (or the month's last day)" : ""}`)
    : plan.frequency === "daily" ? "every weekday" : `${plan.frequency === "biweekly" ? "every other" : "weekly on"} ${WEEKDAYS[plan.weekday ?? 1]}`;
  const legs = plan.targetAmount !== undefined
    ? `${num(plan.targetAmount)} across the saved targets, most to the furthest below`
    : plan.legs.map((leg) => `${num(leg.amount)} ${leg.ticker}${leg.orderType === "limit" ? ` (limit +${num(leg.limitOffsetPercent ?? 0.5)}%)` : ""}`).join(", ");
  return `"${plan.label}" (${plan.id}, ${env(plan.environment)}): ${legs}; ${schedule} at ${String(plan.hour).padStart(2, "0")}:00 ${plan.timeZone}; next ${minute(plan.nextRunAt)}`
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

function accountAlertLine(alert: AccountAlert): string {
  const unit = alert.currency ? ` ${alert.currency}` : "";
  const what = alert.condition.startsWith("cash") ? "free cash" : "account value";
  const condition = alert.condition === "day_move" ? `account's day move of ${num(alert.percent)}% either way` : `${what} ${alert.condition.endsWith("above") ? "at or above" : "at or below"} ${num(alert.amount)}${unit}`;
  const last = alert.lastValue === undefined ? ""
    : alert.condition === "day_move" ? `, last ${signedPct(alert.lastValue)} on ${alert.lastDay ?? "?"}` : `, last ${num(alert.lastValue)}${unit}`;
  const fired = !alert.triggeredAt ? ", armed"
    : alert.condition === "day_move" ? `, fired for ${alert.triggeredDay ?? "the day"} at ${signedPct(alert.triggeredValue ?? 0)}, armed again on the next trading day`
      : `, triggered ${minute(alert.triggeredAt)} at ${num(alert.triggeredValue)}${unit}`;
  return `${condition} (${alert.id}, ${env(alert.environment)})${last}${fired}${alert.note ? ` — ${alert.note}` : ""}`;
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
    ...(data.accountAlerts?.length ? section(`Account alerts (${data.accountAlerts.length})`, rows(data.accountAlerts, accountAlertLine)) : []),
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

function exports(data: { requested?: { reportId?: number | string }; reports?: ExportReport[]; summary?: ExportSummary; records?: Array<Record<string, string>>; recordCount?: number }): string[] {
  if (data.summary) return [
    ...exportSummary(data.summary),
    ...(data.records?.length ? [`Newest ${data.records.length} of ${data.recordCount ?? data.records.length} rows:`, ...data.records.map((record) =>
      [record.Time, record.Action, record.Ticker, record["No. of shares"], record.Total !== undefined ? `${record.Total} ${record["Currency (Total)"] ?? ""}`.trim() : undefined].filter(Boolean).join(" · "))] : []),
  ];
  return rows(data.reports ?? [], (report) => {
    const record = report as unknown as Record<string, unknown>;
    return `#${record.reportId ?? "?"} ${record.status ?? ""} ${day(record.timeFrom as string | undefined)} to ${day(record.timeTo as string | undefined)}${record.downloadLink ? `: ${record.downloadLink}` : ""}`;
  });
}

/** What a CSV report adds up to, per currency. */
function exportSummary(summary: ExportSummary): string[] {
  const money = (totals: Record<string, number>) => Object.entries(totals).map(([currency, value]) => `${round2(value)} ${currency}`).join(", ");
  const some = (totals: Record<string, number>) => Object.keys(totals).length > 0;
  return [
    ...summary.actions.map((action) => `${action.action}: ${action.count}${some(action.totals) ? `, total ${money(action.totals)}` : ""}`),
    ...summary.charges.map((charge) => `${charge.name}: ${money(charge.totals)}`),
    ...(some(summary.interest) ? [`Interest: ${money(summary.interest)}`] : []),
    ...(some(summary.dividends) ? [`Dividends (net of withholding): ${money(summary.dividends)}`] : []),
    ...(some(summary.result) ? [`Realised result: ${money(summary.result)}`] : []),
  ];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

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
    case "price_alerts": {
      const onPrice = (payload.alerts as PriceAlert[] | undefined) ?? [];
      const onAccount = (payload.accountAlerts as AccountAlert[] | undefined) ?? [];
      lines = [
        ...section(`Price alerts (${onPrice.length})`, rows(onPrice, (alert) => alertLine(alert))),
        ...section(`Account alerts (${onAccount.length})`, rows(onAccount, accountAlertLine)),
        ...(onPrice.length || onAccount.length ? [] : ["No alerts are set."]),
      ];
      break;
    }
    case "price_alert": lines = payload.alert ? [alertLine(payload.alert as PriceAlert)] : []; break;
    case "account_alert": lines = payload.alert ? [accountAlertLine(payload.alert as AccountAlert)] : []; break;
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
