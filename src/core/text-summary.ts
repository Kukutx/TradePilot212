// Plain-text versions of the tool payloads. Hosts without the TradePilot widget (Claude Code, other
// terminals) show the model only a tool's text, so every result carries the facts needed to answer
// from it: holdings, orders, plans, skipped legs, tokens to confirm. Lists are capped to stay short.

import type { AccountSummary, ActivityEvent, CancelDraftPayload, CancelPreview, CredentialStatus, EnrichedTradeCandidate, ExecutionVerificationResult, Instrument, OrderDraft, OrderDraftPayload, OrderExecutionResult, OrderNotice, OrderPreview, PendingOrder, PortfolioSnapshot, Position, TradingEnvironment } from "../shared/contracts.js";
import type { AutomationOverview, BasketDraftPayload, BasketExecutionResult, BasketPreview, DcaPlan, PolicyCheck, PriceAlert, ProtectiveLink, RebalancePlan, TargetAllocation, TradingPolicy } from "../shared/automation.js";
import type { AllocationAnalysis, AllocationDrift, ExportReport, IncomeSummary, PerformanceSummary, TaxYearSummary } from "../shared/history.js";
import type { PieChangeDraftPayload, PieChangePreview, PieChangeResult, PieOverview, PiesPayload } from "../shared/pies.js";
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

function noticesLines(notices: OrderNotice[] | undefined): string[] {
  return (notices ?? []).filter((notice) => notice.code !== "LIVE_FUNDS").map((notice) => `  note: ${notice.message}`);
}

function policyLines(checks: PolicyCheck[] | undefined): string[] {
  return (checks ?? []).filter((check) => check.status !== "pass" && check.status !== "skip").map((check) => `  policy ${check.status}: ${check.message}`);
}

function orderLine(order: PendingOrder): string {
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
  return `#${order.id ?? "?"} ${side} ${size} ${order.ticker ?? "?"}${typeof name === "string" ? ` (${name})` : ""} ${String(order.type ?? "").toLowerCase()}${prices}${typeof validity === "string" ? ` ${validity}` : ""}${order.status ? ` (${order.status}${filled})` : ""}`;
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

function portfolio(data: PortfolioSnapshot): string[] {
  const holdings = [...data.positions].sort((a, b) => {
    const value = (position: Position) => (position.walletImpact as { currentValue?: number } | undefined)?.currentValue ?? position.quantity * position.currentPrice;
    return value(b) - value(a);
  });
  return [
    ...credentialsLine(data.environment, data.credentials),
    ...(data.warning ? [data.warning] : []),
    ...(data.account ? [accountLine(data.environment, data.account)] : []),
    ...section(`Holdings (${holdings.length})`, rows(holdings, positionLine)),
    ...section(`Pending orders (${data.orders.length})`, rows(data.orders, orderLine)),
    ...section("Recent TradePilot activity", rows((data.activity ?? []).slice(0, 5), activityLine)),
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
    ...section("By instrument", rows(data.byTicker.filter((item) => item.realizedProfitLoss || item.dividends || item.costs).slice(0, 10), (item) => `${item.ticker}: realized ${signed(item.realizedProfitLoss)}, dividends ${num(item.dividends)}, costs ${num(item.costs)}`)),
    ...(data.coverage.truncated ? ["History was truncated at the page limit; raise maxPages for older records."] : []),
    ...data.notes,
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

function income(data: IncomeSummary): string[] {
  const c = data.accountCurrency;
  return [
    `Period ${data.period.from ? day(data.period.from) : "all history"} to ${day(data.period.to)}: ${money(data.total, c)} (dividends ${num(data.dividends)}, interest ${num(data.interest)}); trailing 12 months ${num(data.trailing12Months)}.`,
    ...(data.forwardAnnual ? [`Expected next 12 months from current holdings: ${num(data.forwardAnnual.total)}${data.forwardAnnual.yieldOnValue === null ? "" : ` (${pct(data.forwardAnnual.yieldOnValue, 2)} of their value)`}; net of withholding tax, from the last year's payments.`] : []),
    ...section("By instrument", rows(data.byTicker.slice(0, 12), (item) => `${item.key}: ${num(item.amount)}`)),
    ...section("By month", rows(data.byMonth.slice(-12), (item) => `${item.key}: ${num(item.amount)}`)),
    ...(data.truncated ? ["History was truncated at the page limit; raise maxPages for older records."] : []),
  ];
}

interface TradeFill {
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

interface UnfilledOrder { ticker?: string; name?: string; side?: string; type?: string; status?: string; createdAt?: string; quantity?: number; value?: number; limitPrice?: number; stopPrice?: number; priceCurrency?: string }

function tradeHistory(data: { fills: TradeFill[]; unfilled?: UnfilledOrder[]; truncated?: boolean }): string[] {
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
      + `${fill.netValue === undefined ? "" : ` = ${num(Math.abs(fill.netValue))}${fill.accountCurrency ? ` ${fill.accountCurrency}` : ""}`}${fill.realisedProfitLoss ? `, P/L ${signed(fill.realisedProfitLoss)}` : ""}${fill.costs ? `, fees ${num(fill.costs)}` : ""}`, 50),
    ...(data.unfilled ? section("Closed without a fill", rows(data.unfilled, (order) => `${day(order.createdAt)} ${String(order.side ?? "").toUpperCase()} ${order.value !== undefined && !order.quantity ? `value ${num(Math.abs(order.value))}` : num(Math.abs(order.quantity ?? 0), 8)} ${order.ticker ?? "?"} ${String(order.type ?? "").toLowerCase()}`
      + `${order.limitPrice === undefined ? "" : ` limit ${num(order.limitPrice, 6)}`}${order.stopPrice === undefined ? "" : ` stop ${num(order.stopPrice, 6)}`}${order.priceCurrency && (order.limitPrice !== undefined || order.stopPrice !== undefined) ? ` ${order.priceCurrency}` : ""} (${order.status ?? "?"})`, 50)) : []),
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
  const condition = alert.condition === "above" || alert.condition === "below" ? `${alert.condition} ${num(alert.price, 6)}${unit}` : `${alert.condition.replace("_", " ")} ${num(alert.percent)}%`;
  return `${alert.ticker}${instrument?.name ? ` (${instrument.name})` : ""} ${condition} (${alert.id}, ${env(alert.environment)})${alert.lastPrice === undefined ? "" : `, last ${num(alert.lastPrice, 6)}${unit}`}${alert.triggeredAt ? `, triggered ${minute(alert.triggeredAt)} at ${num(alert.triggeredPrice, 6)}${unit}` : ", armed"}${alert.note ? ` — ${alert.note}` : ""}`;
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
    case "allocation": lines = allocation(payload as unknown as AllocationAnalysis); break;
    case "performance": lines = performance(payload as unknown as PerformanceSummary); break;
    case "income": lines = income(payload as unknown as IncomeSummary); break;
    case "tax_year": lines = taxYear(payload as unknown as TaxYearSummary); break;
    case "target_allocation": lines = targetAllocation(payload as unknown as Parameters<typeof targetAllocation>[0]); break;
    case "trade_history": lines = tradeHistory(payload as unknown as Parameters<typeof tradeHistory>[0]); break;
    case "basket_draft": lines = basketDraft(payload as unknown as BasketDraftPayload & { rebalance?: RebalancePlan }); break;
    case "basket_preview": lines = basketPreview(payload as unknown as BasketPreview); break;
    case "basket_execution": lines = basketExecution(payload as unknown as BasketExecutionResult); break;
    case "order_draft": {
      const draft = payload as unknown as OrderDraftPayload;
      lines = [...credentialsLine(draft.draft.environment, draft.credentials), `Draft: ${draftLine(draft.draft, draft.resolvedInstrument)}${draft.draft.referencePrice ? `, reference price ${num(draft.draft.referencePrice, 6)} ${draft.resolvedInstrument?.currencyCode ?? ""}`.trimEnd() : ""}.`];
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
    case "trading_policy": lines = policy(payload as unknown as Parameters<typeof policy>[0]); break;
    case "history_export": lines = exports(payload as Parameters<typeof exports>[0]); break;
    case "activity": lines = rows((payload.activity as ActivityEvent[]) ?? [], activityLine); break;
    case "instrument_search": lines = rows((payload.instruments as Instrument[]) ?? [], (item) => `${item.ticker}: ${item.name} (${item.shortName}, ${item.currencyCode}${item.type ? `, ${item.type}` : ""}${item.isin ? `, ${item.isin}` : ""})`); break;
    default: lines = [];
  }
  return lines.filter(Boolean).join("\n");
}
