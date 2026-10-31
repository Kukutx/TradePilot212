// UK share matching, as HMRC matches the shares a sale disposes of: first with shares of the same company bought on
// the same day, then with shares bought in the 30 days after it (earliest first), and only then with the "section
// 104" pool of everything bought before, at its average cost (TCGA 1992 s.104–106A). Trading 212's realised P/L is
// against the average price of what is held, so the two differ when shares are bought back within 30 days, or bought
// and sold on one day. An estimate: amounts are Trading 212's in the account currency. A split is the same holding in
// other units (s.127): the fills before it are counted in today's units (shared/splits.ts). Other corporate actions
// (mergers, distributions), transfers in and shares bought before the history read are not seen; they are found by
// setting each instrument's fills against the shares held now.

import type { HistoryOrderItem, UkMatching, UkMatchingTicker } from "../shared/history.js";
import { restateSplits } from "../shared/splits.js";
import { localDay } from "../shared/time-zone.js";

const UK_ZONE = "Europe/London";
const EPSILON = 1e-9;
const DAY_MS = 86_400_000;

interface Day {
  day: string;
  /** Shares bought on the day and not yet matched, and what they cost. */
  bought: number;
  cost: number;
  /** Shares sold on the day and not yet matched, what the sales paid in, and how they were matched so far. */
  sold: number;
  soldTotal: number;
  proceeds: number;
  matched: { sameDay: number; thirtyDay: number; pool: number; cost: number };
  /** A sale without an account-currency value, or one matched with a buy without one: its gain is not known. */
  unvalued: boolean;
  /** A buy of the day had no account-currency value. */
  buyUnvalued: boolean;
  /** When the day's sales filled, to tell whether they fall in the tax year, and Trading 212's realised P/L for them. */
  saleTimes: number[];
  realised: number;
}

/** One instrument's fills: its UK days, the shares its fills add up to, and fills that were not trades. */
interface Instrument {
  ticker: string;
  days: Map<string, Day>;
  net: number;
  notTrades: number;
}

const round = (value: number) => Math.round(value * 100) / 100;
/** Quantities to eight places, so 0.1 + 0.2 reads 0.3. */
const shares = (value: number) => Math.round(value * 1e8) / 1e8;

function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The same security under two tickers (two exchanges) is one pool: grouped by ISIN where Trading 212 gives one for
 * the ticker, in any fill or holding, so a record without it joins the same instrument.
 */
type KeyOf = (ticker: string) => string;
function keysBy(orders: HistoryOrderItem[], holdings: Array<{ ticker: string; isin?: string }>): KeyOf {
  const isins = new Map<string, string>();
  for (const item of orders) {
    const ticker = item.order?.ticker ?? item.order?.instrument?.ticker;
    if (ticker && item.order?.instrument?.isin) isins.set(ticker, item.order.instrument.isin);
  }
  for (const holding of holdings) if (holding.isin) isins.set(holding.ticker, holding.isin);
  return (ticker) => { const isin = isins.get(ticker); return isin ? `isin:${isin}` : `ticker:${ticker}`; };
}

/** Each instrument's fills by UK day. Fills without an instrument are counted, not matched. */
function byInstrument(orders: HistoryOrderItem[], keyOf: KeyOf): { instruments: Map<string, Instrument>; unnamed: number } {
  const instruments = new Map<string, Instrument>();
  let unnamed = 0;
  for (const item of orders) {
    const fill = item.fill;
    const time = Date.parse(fill?.filledAt ?? "");
    if (!fill || !Number.isFinite(time)) continue;
    const signed = fill.quantity ?? item.order?.filledQuantity ?? 0;
    const quantity = Math.abs(signed);
    if (!(quantity > 0)) continue;
    const sell = (item.order?.side ?? "").toUpperCase() === "SELL" || signed < 0;
    const ticker = item.order?.ticker ?? item.order?.instrument?.ticker;
    if (!ticker) { unnamed++; continue; }
    const key = keyOf(ticker);
    const instrument = instruments.get(key) ?? { ticker, days: new Map<string, Day>(), net: 0, notTrades: 0 };
    instruments.set(key, instrument);
    instrument.net += sell ? -quantity : quantity;
    if (fill.type && fill.type.toUpperCase() !== "TRADE") instrument.notTrades++;
    const day = localDay(time, UK_ZONE);
    const entry = instrument.days.get(day) ?? { day, bought: 0, cost: 0, sold: 0, soldTotal: 0, proceeds: 0, matched: { sameDay: 0, thirtyDay: 0, pool: 0, cost: 0 }, unvalued: false, buyUnvalued: false, saleTimes: [], realised: 0 };
    instrument.days.set(day, entry);
    const value = fill.walletImpact?.netValue;
    const valued = value !== undefined && Number.isFinite(value);
    if (sell) {
      if (!valued) entry.unvalued = true;
      entry.sold += quantity;
      entry.soldTotal += quantity;
      entry.proceeds += Math.abs(value ?? 0);
      entry.saleTimes.push(time);
      entry.realised += fill.walletImpact?.realisedProfitLoss ?? 0;
    } else {
      if (!valued) entry.buyUnvalued = true;
      entry.bought += quantity;
      entry.cost += Math.abs(value ?? 0);
    }
  }
  return { instruments, unnamed };
}

/** Take `quantity` of `day`'s unmatched buys for `sale`, with their share of the cost. */
function take(day: Day, quantity: number, sale: Day): number {
  if (day.buyUnvalued) sale.unvalued = true;
  const cost = day.bought > EPSILON ? day.cost * (quantity / day.bought) : 0;
  day.bought -= quantity;
  day.cost -= cost;
  if (day.bought < EPSILON) { day.bought = 0; day.cost = 0; }
  return cost;
}

/** Match one instrument's sales (its days oldest first): same day, then the next 30 days, then the pool. Unmatched shares are left in `sold`. */
function matchDays(days: Day[]): void {
  for (const day of days) {
    const quantity = Math.min(day.sold, day.bought);
    if (quantity <= EPSILON) continue;
    day.matched.cost += take(day, quantity, day);
    day.matched.sameDay += quantity;
    day.sold -= quantity;
  }
  for (let index = 0; index < days.length; index++) {
    const day = days[index]!;
    if (day.sold <= EPSILON) continue;
    const last = dayAfter(day.day, 30);
    for (let next = index + 1; next < days.length && day.sold > EPSILON; next++) {
      const later = days[next]!;
      if (later.day > last) break;
      const quantity = Math.min(day.sold, later.bought);
      if (quantity <= EPSILON) continue;
      day.matched.cost += take(later, quantity, day);
      day.matched.thirtyDay += quantity;
      day.sold -= quantity;
    }
  }
  let pool = 0, poolCost = 0, poolUnvalued = false;
  for (const day of days) {
    // What a day's buys leave over joins the pool; a day with sales still unmatched has none left over.
    if (day.bought > EPSILON && day.buyUnvalued) poolUnvalued = true;
    pool += day.bought;
    poolCost += day.cost;
    const quantity = Math.min(day.sold, pool);
    if (quantity <= EPSILON) continue;
    const cost = poolCost * (quantity / pool);
    if (poolUnvalued) day.unvalued = true;
    day.matched.cost += cost;
    day.matched.pool += quantity;
    day.sold -= quantity;
    pool -= quantity;
    poolCost -= cost;
    if (pool < EPSILON) { pool = 0; poolCost = 0; poolUnvalued = false; }
  }
}

/**
 * The tax year's sales matched by the UK rules, from every fill read (`orders`: all history up to now, so a sale's
 * 30-day buys are seen). `from`–`to` is the tax year in UK time; `complete` is whether the history was read to its
 * start. `holdings` are the shares held now: an instrument whose fills add up to something else had shares come or go
 * another way (a transfer, a split), so its matching cannot be trusted. Gains and losses are kept apart per disposal,
 * one instrument's sales on one UK day, as a return adds them up.
 */
export function ukShareMatching(input: {
  orders: HistoryOrderItem[];
  from: Date;
  to: Date;
  currency: string;
  complete: boolean;
  holdings?: Array<{ ticker: string; isin?: string; quantity: number }>;
  now?: Date;
}): UkMatching {
  const now = input.now ?? new Date();
  const keyOf = keysBy(input.orders, input.holdings ?? []);
  const held = new Map<string, number>();
  for (const holding of input.holdings ?? []) held.set(keyOf(holding.ticker), (held.get(keyOf(holding.ticker)) ?? 0) + holding.quantity);
  // Today's shares tell a split listed as the shares it added alone, whenever the history starts.
  const restated = restateSplits(input.orders, keyOf, input.holdings ? (key) => held.get(key) ?? 0 : undefined);
  const splitsOf = new Map<string, Array<{ on: string; ratio: number }>>();
  for (const split of restated.splits) {
    const key = keyOf(split.ticker);
    splitsOf.set(key, [...(splitsOf.get(key) ?? []), { on: localDay(Date.parse(split.at), UK_ZONE), ratio: split.ratio }]);
  }
  const { instruments, unnamed } = byInstrument(restated.items, keyOf);
  const rows: UkMatchingTicker[] = [];
  let gains = 0, losses = 0, unmatched = 0, unvalued = 0, unreconciled = 0, notTrades = 0, split = 0;
  for (const [key, instrument] of instruments) {
    const days = [...instrument.days.values()].sort((a, b) => a.day.localeCompare(b.day));
    matchDays(days);
    const sales = days.filter((day) => day.saleTimes.some((time) => time >= input.from.getTime() && time <= input.to.getTime()));
    if (!sales.length) continue;
    const row: UkMatchingTicker = { ticker: instrument.ticker, disposals: 0, quantity: 0, proceeds: 0, cost: 0, gain: 0, sameDay: 0, thirtyDay: 0, pool: 0, unmatched: 0, realizedProfitLoss: 0 };
    let rowUnvalued = false;
    for (const day of sales) {
      row.disposals += day.saleTimes.length;
      row.quantity += day.soldTotal;
      row.sameDay += day.matched.sameDay;
      row.thirtyDay += day.matched.thirtyDay;
      row.pool += day.matched.pool;
      row.unmatched += day.sold;
      row.realizedProfitLoss += day.realised;
      if (day.unvalued) { rowUnvalued = true; unvalued += day.saleTimes.length; continue; }
      // Only the matched part has a known cost; the proceeds are counted for the same part.
      const matched = day.soldTotal - day.sold;
      const proceeds = day.soldTotal > EPSILON ? day.proceeds * (matched / day.soldTotal) : 0;
      const gain = proceeds - day.matched.cost;
      row.proceeds += proceeds;
      row.cost += day.matched.cost;
      row.gain += gain;
      if (gain > 0) gains += gain; else losses += gain;
    }
    unmatched += row.unmatched;
    // Only history read to its start and up to now adds up to what is held.
    const holding = held.get(key) ?? 0;
    const off = input.holdings && input.complete && Math.abs(instrument.net - holding) > Math.max(1e-6, Math.abs(holding) * 1e-6);
    if (off) unreconciled++;
    if (instrument.notTrades) notTrades++;
    const splits = splitsOf.get(key);
    if (splits) split++;
    rows.push({
      ...row,
      quantity: shares(row.quantity), sameDay: shares(row.sameDay), thirtyDay: shares(row.thirtyDay), pool: shares(row.pool), unmatched: shares(row.unmatched),
      proceeds: round(row.proceeds), cost: round(row.cost), gain: round(row.gain), realizedProfitLoss: round(row.realizedProfitLoss),
      ...(rowUnvalued ? { unvalued: true as const } : {}),
      ...(off ? { reconciliation: { held: shares(holding), fills: shares(instrument.net) } } : {}),
      ...(instrument.notTrades ? { notTrades: instrument.notTrades } : {}),
      ...(splits ? { splits } : {}),
    });
  }
  rows.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain));
  // A sale in the year's last 30 days is matched with buys after it: until those days are past, it can still change.
  const provisional = now.getTime() <= input.to.getTime() + 30 * DAY_MS;
  const notes = [
    "An estimate by HMRC's matching rules: each sale is matched with shares of the same instrument bought the same UK day, then in the 30 days after it, then with the section 104 pool at its average cost. Days and the year (6 April to 5 April) are UK time. Gains and losses are kept apart per disposal, one instrument's sales on one day; `disposals` counts the fills.",
    "Costs and proceeds are Trading 212's net amount of each fill on the account (walletImpact.netValue), taken to include its fees and FX charges as the account's performance figures take them; check them against the Trading 212 statement. A UK return needs pounds sterling at the rate of each trade.",
    "Gains in a Stocks and Shares ISA are free of tax. The pool is one per person across every account and broker, so shares of the same company held elsewhere change the cost; one company listed under two tickers is grouped by its ISIN where Trading 212 gives one.",
  ];
  if (input.currency && input.currency !== "GBP") notes.push(`The account is in ${input.currency}, not GBP, so these amounts are not yet the sterling figures a UK return needs.`);
  if (unmatched > EPSILON) notes.push("Some shares sold could not be matched with any purchase read (bought before the history read, or transferred in); their gain is left out.");
  if (unvalued) notes.push(`${unvalued} sale(s) or the purchases matched with them had no account-currency value from Trading 212; their gain is left out.`);
  if (unreconciled) notes.push(`For ${unreconciled} instrument(s) the fills read do not add up to the shares held now (see reconciliation): shares came or went another way (a transfer in or out, a split, a corporate action), so their matching is not reliable.`);
  if (split) notes.push(`${split} instrument(s) had a split or consolidation (see splits): as HMRC treats it, it is the same holding in other units, so the shares bought and sold before it are counted in today's units, at the same cost, and the quantities here are today's.`);
  if (notTrades) notes.push(`${notTrades} instrument(s) have fills that were not trades (see notTrades), such as a split or a corporate action: they were matched as purchases and sales, which may not be how HMRC treats them.`);
  if (unnamed) notes.push(`${unnamed} fill(s) named no instrument and are left out.`);
  if (provisional) notes.push("Sales in the year's last 30 days are matched with buys up to 30 days after them, and those days are not all past: the figures can still change.");
  if (!input.complete) notes.push("History was not read back to the first purchase (it was truncated at the page limit), so the pool may be missing older purchases. Rerun with a larger maxPages.");
  return {
    rule: "uk",
    currency: input.currency,
    complete: input.complete && unmatched <= EPSILON && unvalued === 0 && unreconciled === 0 && notTrades === 0 && unnamed === 0,
    ...(provisional ? { provisional: true as const } : {}),
    gains: round(gains),
    losses: round(losses),
    net: round(gains + losses),
    realizedProfitLoss: round(rows.reduce((sum, row) => sum + row.realizedProfitLoss, 0)),
    byTicker: rows,
    notes,
  };
}
