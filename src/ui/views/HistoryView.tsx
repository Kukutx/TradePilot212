import { useMemo, useState } from "react";
import type { CashHistory, CashHistoryItem, FillTotals, HistoryFilter, TaxYearSummary, TradeFill, TradeHistory } from "../../shared/history";
import type { JournalEntry } from "../../shared/journal";
import type { MessageKey, SupportedLocale } from "../i18n";
import { AssetAvatar, Metric } from "../components/common";
import { BarList } from "../components/charts";
import { amount, dayLabel, money, qty, signedClass, time } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, orderStatusLabel, orderTypeLabel, plural, type Translator } from "../lib/messages";
import { chartLabels, costLabel, instrumentDatum, PeriodSwitch, type InsightPeriod } from "./InsightsView";

/** The three pages of the History tab, read by their own tools. */
export type HistoryKind = "trade_history" | "cash_history" | "tax_year";
export const HISTORY_KINDS: readonly HistoryKind[] = ["trade_history", "cash_history", "tax_year"];

/** How the tax year is counted: the calendar year, or the UK's from 6 April in London. */
export type TaxRule = "calendar" | "uk";
export const TAX_RULES: Record<TaxRule, { yearStart: string; timeZone?: string }> = {
  calendar: { yearStart: "01-01" },
  uk: { yearStart: "04-06", timeZone: "Europe/London" },
};
/** The rule a year start is counted by; none for another start (a fiscal year from 1 July, say), which is kept as it is. */
export const taxRuleOf = (yearStart: string): TaxRule | undefined => (Object.keys(TAX_RULES) as TaxRule[]).find((rule) => TAX_RULES[rule].yearStart === yearStart);
/** A year that starts on 1 January is named by its number; any other by the two years it spans, as 2025/26. */
export const taxYearLabel = (year: number, yearStart: string) => (yearStart === TAX_RULES.calendar.yearStart ? String(year) : `${year}/${String((year + 1) % 100).padStart(2, "0")}`);

export function HistorySwitch({ value, onChange, t, disabled }: { value: HistoryKind; onChange: (next: HistoryKind) => void; t: Translator; disabled: boolean }) {
  const options: Array<[HistoryKind, MessageKey]> = [["trade_history", "historyTrades"], ["cash_history", "historyCash"], ["tax_year", "historyTaxYear"]];
  return (
    <div className="segmented" role="radiogroup" aria-label={t("historyViews")}>
      {options.map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "active" : ""} disabled={disabled} onClick={() => { if (value !== key) onChange(key); }}>{t(label)}</button>
      ))}
    </div>
  );
}

const sellOf = (fillItem: Pick<TradeFill, "side" | "quantity">) => String(fillItem.side ?? "").toUpperCase() === "SELL" || (fillItem.quantity ?? 0) < 0;
/** The UTC day a record falls on, to group the list by day. */
const dayOf = (value: string | undefined) => (value ?? "").slice(0, 10);

/** Items grouped by day, newest day first, keeping each day's order. */
function byDay<T>(items: T[], when: (item: T) => string | undefined): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = [];
  for (const item of items) {
    const day = dayOf(when(item));
    const last = groups.at(-1);
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** Narrow the list to what the filter names: a ticker, symbol or name, in any case. */
function matches(filter: string, ticker: string | undefined, name: string | undefined, book?: InstrumentBook): boolean {
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return true;
  if (!ticker) return false;
  const label = instrumentLabel(ticker, book, name ? { name } : undefined);
  return [ticker, label.name, label.detail ?? ""].some((text) => text.toLowerCase().includes(wanted));
}

function FilterBox({ value, onChange, label }: { value: string; onChange: (next: string) => void; label: string }) {
  return (
    <div className="historyFilter" role="search">
      <input type="search" autoComplete="off" spellCheck={false} aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/**
 * The direction money moved, from its kind where that says it, so a withdrawal is money out whatever sign it is sent
 * with (as the performance page reads it). Dividends and interest keep their sign: a correction is negative.
 */
const CASH_OUT = new Set(["WITHDRAW", "WITHDRAWAL", "FEE"]);
const CASH_IN = new Set(["DEPOSIT"]);
export function cashSigned(type: string, value: number): number {
  const kind = type.toUpperCase();
  return CASH_OUT.has(kind) ? -Math.abs(value) : CASH_IN.has(kind) ? Math.abs(value) : value;
}

/** What a read the host made was limited to, with a way back to everything. */
function FilterNote({ filter, name, period, book, t, locale, busy, onClear }: {
  filter?: HistoryFilter; name?: string; period: { from?: string; to: string } | null; book?: InstrumentBook; t: Translator; locale: SupportedLocale; busy: boolean; onClear?: () => void;
}) {
  const parts = [
    ...(filter?.ticker ? [instrumentLabel(filter.ticker, book, name ? { name } : undefined).name] : []),
    ...(filter?.types ?? []).map((type) => cashTypeLabel(type, t)),
    ...(period ? [period.from ? fill(t("taxSpan"), { from: dayLabel(period.from, locale), to: dayLabel(period.to, locale) }) : fill(t("historyUntil"), { to: dayLabel(period.to, locale) })] : []),
  ];
  if (!parts.length) return null;
  return (
    <div className="notice compactNotice historyFiltered">
      <span>{t("historyFilteredBy")} <strong>{parts.join(" · ")}</strong></span>
      {onClear && <button type="button" className="linkButton" disabled={busy} onClick={onClear}>{t("historyShowAll")}</button>}
    </div>
  );
}

function Toolbar({ kind, period, t, busy, onKind, onPeriod }: { kind: HistoryKind; period: InsightPeriod | null; t: Translator; busy: boolean; onKind: (next: HistoryKind) => void; onPeriod: (next: InsightPeriod) => void }) {
  return (
    <div className="viewToolbar reviewToolbar">
      <HistorySwitch value={kind} onChange={onKind} t={t} disabled={busy} />
      <PeriodSwitch value={period} onChange={onPeriod} t={t} disabled={busy} />
    </div>
  );
}

/** Adds up fills the way the server does for a whole window. */
function totalsOf(fills: TradeFill[]): FillTotals {
  const sum: FillTotals = { bought: 0, sold: 0, realised: 0, costs: 0, buys: 0, sells: 0 };
  for (const item of fills) {
    const value = Math.abs(item.netValue ?? 0);
    if (sellOf(item)) { sum.sold += value; sum.sells += 1; } else { sum.bought += value; sum.buys += 1; }
    sum.realised += item.realisedProfitLoss ?? 0;
    sum.costs += item.costs ?? 0;
  }
  return sum;
}

/**
 * `period` is null when the host read a window none of the switch's periods is; the window then shows with the filter.
 * The page's own filter box narrows only the fills listed, so its totals are of those.
 */
export function TradeHistoryView({ data, book, locale, t, period, busy, onPeriod, onKind, onOpen, onClearFilter }: {
  data: TradeHistory & { journal?: JournalEntry[] }; book?: InstrumentBook; locale: SupportedLocale; t: Translator; period: InsightPeriod | null; busy: boolean;
  onPeriod: (next: InsightPeriod) => void; onKind: (next: HistoryKind) => void; onOpen?: (ticker: string) => void; onClearFilter?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const currency = data.fills.find((item) => item.accountCurrency)?.accountCurrency ?? "EUR";
  const m = (value: number | undefined, signed = false) => money(value, currency, locale, { signed });
  const fills = data.fills.filter((item) => matches(filter, item.ticker, item.name, book));
  const unfilled = (data.unfilled ?? []).filter((item) => matches(filter, item.ticker, item.name, book));
  const filtering = filter.trim() !== "";
  // A result from before the server added up the whole window (a host's saved one) is added up here.
  const totals = useMemo(() => (filtering || !data.totals ? totalsOf(fills) : data.totals), [filtering, fills, data.totals]);
  const count = filtering ? fills.length : data.count ?? data.fills.length;
  const notes = new Map((data.journal ?? []).flatMap((entry) => (entry.orderId ? [[entry.orderId, entry] as const] : [])));
  return (
    <main className="contentStack">
      <Toolbar kind="trade_history" period={period} t={t} busy={busy} onKind={onKind} onPeriod={onPeriod} />
      <FilterNote filter={data.filter} name={data.fills.find((item) => item.ticker === data.filter?.ticker)?.name} period={period ? null : data.period} book={book} t={t} locale={locale} busy={busy} onClear={onClearFilter} />
      {data.truncated && <div className="notice warning compactNotice">{t("historyTruncated")}</div>}
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("realizedPnL")}</span>
          <strong className={`heroValue ${signedClass(totals.realised)}`}>{m(totals.realised, true)}</strong>
          <span className="overviewSubline">{plural(count, locale, t("historyFillsOne"), t("historyFills"))} · {fill(t("historyBuysSells"), { buys: String(totals.buys), sells: String(totals.sells) })}</span>
        </div>
        <div className="metricGrid">
          <Metric label={t("historyBought")} value={m(totals.bought)} />
          <Metric label={t("historySold")} value={m(totals.sold)} />
          <Metric label={t("costs")} value={m(totals.costs)} />
        </div>
      </section>
      <section className="dataPanel">
        <div className="pieHeader"><h2>{t("historyFillsTitle")}</h2>{data.fills.length > 0 && <FilterBox value={filter} onChange={setFilter} label={t("historyFilterInstrument")} />}</div>
        {fills.length === 0 ? <div className="emptyState compact">{filter ? t("historyNoMatch") : t("historyNoFills")}</div> : byDay(fills, (item) => item.filledAt).map((group) => (
          <div key={group.day} className="historyDay">
            <h3 className="historyDayTitle">{group.day ? dayLabel(group.day, locale, { weekday: true }) : "—"}</h3>
            <ul className="historyList">
              {group.items.map((item, index) => {
                const sell = sellOf(item);
                const ticker = item.ticker ?? "";
                const label = instrumentLabel(ticker, book, item.name ? { name: item.name } : undefined);
                const note = item.orderId ? notes.get(item.orderId) : undefined;
                const text = note?.thesis ?? note?.review;
                return (
                  <li key={`${item.orderId ?? ""}-${item.filledAt ?? ""}-${index}`} className={`historyRow${text ? " withNote" : ""}`}>
                    <div className="historyWho">
                      <AssetAvatar ticker={ticker || "?"} label={label} />
                      <div>
                        {onOpen && ticker ? <button type="button" className="inlineLink reviewName" disabled={busy} title={ticker} onClick={() => onOpen(ticker)}>{label.name}</button> : <strong title={ticker}>{label.name}</strong>}
                        <small>
                          <b className={`orderSide ${sell ? "sell" : "buy"}`}>{sell ? t("sell") : t("buy")}</b>
                          {` ${qty(Math.abs(item.quantity ?? 0), locale)} × ${amount(item.price, item.priceCurrency, locale, { digits: 4 })}`}
                          {item.filledAt ? ` · ${time(item.filledAt, locale)}` : ""}{item.type ? ` · ${orderTypeLabel(item.type, t)}` : ""}
                        </small>
                      </div>
                    </div>
                    <div className="historyAmount">
                      <strong>{item.netValue === undefined ? "—" : money(Math.abs(item.netValue), item.accountCurrency ?? currency, locale)}</strong>
                      {item.realisedProfitLoss ? <small className={signedClass(item.realisedProfitLoss)}>{fill(t("holdingRealized"), { amount: money(item.realisedProfitLoss, item.accountCurrency ?? currency, locale, { signed: true }) })}</small>
                        : item.costs > 0 ? <small>{fill(t("historyCostOf"), { amount: money(item.costs, item.accountCurrency ?? currency, locale) })}</small> : null}
                    </div>
                    {text && <p className="fillNote"><span>{t(note?.thesis ? "journalWhy" : "journalReview")}</span>{text}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {(data.count ?? 0) > data.fills.length && <p className="panelNote">{fill(t(filtering ? "historyShowingNewestFiltered" : "historyShowingNewest"), { shown: String(data.fills.length), count: String(data.count) })}</p>}
      </section>
      {unfilled.length > 0 && (
        <section className="dataPanel activityPanel">
          <details>
            <summary>{t("historyUnfilledTitle")}<b>{unfilled.length}</b></summary>
            <ul className="historyList">
              {unfilled.map((item, index) => {
                const ticker = item.ticker ?? "";
                const label = instrumentLabel(ticker, book, item.name ? { name: item.name } : undefined);
                const sell = sellOf(item);
                const price = item.limitPrice ?? item.stopPrice;
                return (
                  <li key={`${item.orderId ?? ""}-${index}`}>
                    <div className="historyWho">
                      <AssetAvatar ticker={ticker || "?"} label={label} />
                      <div>
                        <strong title={ticker}>{label.name}</strong>
                        <small>
                          <b className={`orderSide ${sell ? "sell" : "buy"}`}>{sell ? t("sell") : t("buy")}</b>
                          {item.quantity !== undefined ? ` ${qty(Math.abs(item.quantity), locale)}` : item.value !== undefined ? ` ${amount(item.value, item.priceCurrency, locale)}` : ""}
                          {price !== undefined ? ` @ ${amount(price, item.priceCurrency, locale, { digits: 4 })}` : ""}{item.type ? ` · ${orderTypeLabel(item.type, t)}` : ""}
                          {item.createdAt ? ` · ${dayLabel(item.createdAt, locale)}` : ""}
                        </small>
                      </div>
                    </div>
                    {item.status && <span className="statusPill">{orderStatusLabel(item.status, t)}</span>}
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      )}
    </main>
  );
}

const CASH_KEYS: Record<string, MessageKey> = {
  DEPOSIT: "deposits",
  WITHDRAW: "withdrawals",
  DIVIDEND: "dividends",
  INTEREST: "interest",
  FEE: "historyFees",
  TRANSFER: "historyTransfers",
};
/** One movement of a kind, for its row. */
const CASH_ITEM_KEYS: Record<string, MessageKey> = {
  DEPOSIT: "historyDeposit",
  WITHDRAW: "historyWithdrawal",
  DIVIDEND: "historyDividend",
  INTEREST: "interest",
  FEE: "historyFee",
  TRANSFER: "historyTransfer",
};
/** A kind of cash movement in words, as a total (or with `one`, for one movement); one Trading 212 adds later shows as it is sent. */
export function cashTypeLabel(type: string, t: Translator, one = false): string {
  const key = (one ? CASH_ITEM_KEYS : CASH_KEYS)[type.toUpperCase()];
  return key ? t(key) : type.replaceAll("_", " ").toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}
/** The order the totals are shown in: money in and out first, then what the account earned and paid. */
const CASH_ORDER = ["DEPOSIT", "WITHDRAW", "DIVIDEND", "INTEREST", "FEE"];
const cashRank = (type: string) => { const at = CASH_ORDER.indexOf(type); return at < 0 ? CASH_ORDER.length : at; };

export function CashHistoryView({ data, book, locale, t, period, busy, onPeriod, onKind, onOpen, onClearFilter }: {
  data: CashHistory; book?: InstrumentBook; locale: SupportedLocale; t: Translator; period: InsightPeriod | null; busy: boolean;
  onPeriod: (next: InsightPeriod) => void; onKind: (next: HistoryKind) => void; onOpen?: (ticker: string) => void; onClearFilter?: () => void;
}) {
  const [type, setType] = useState<string | null>(null);
  const currency = data.currency || "EUR";
  const types = Object.keys(data.totals).sort((a, b) => cashRank(a) - cashRank(b) || a.localeCompare(b));
  const shown = type && types.includes(type) ? type : null;
  const items = shown ? data.items.filter((item) => item.type === shown) : data.items;
  const total = (key: string) => cashSigned(key, data.totals[key] ?? 0);
  const net = types.reduce((sum, key) => sum + total(key), 0);
  const contributed = total("DEPOSIT") + total("WITHDRAW");
  const who = (item: CashHistoryItem) => (item.ticker ? instrumentLabel(item.ticker, book, item.name ? { name: item.name } : undefined) : undefined);
  return (
    <main className="contentStack">
      <Toolbar kind="cash_history" period={period} t={t} busy={busy} onKind={onKind} onPeriod={onPeriod} />
      <FilterNote filter={data.filter} name={data.items.find((item) => item.ticker === data.filter?.ticker)?.name} period={period ? null : data.period} book={book} t={t} locale={locale} busy={busy} onClear={onClearFilter} />
      {data.truncated && <div className="notice warning compactNotice">{t("historyTruncated")}</div>}
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("historyCashNet")}</span>
          <strong className={`heroValue ${signedClass(net)}`}>{money(net, currency, locale, { signed: true })}</strong>
          <span className="overviewSubline">{t("netContributions")} · {money(contributed, currency, locale, { signed: true })}</span>
        </div>
        <div className="metricGrid">
          {types.length === 0 ? <Metric label={t("historyCash")} value="—" /> : types.map((key) => <Metric key={key} label={cashTypeLabel(key, t)} value={money(total(key), currency, locale, { signed: true })} />)}
        </div>
      </section>
      <section className="dataPanel">
        <div className="pieHeader"><h2>{t("historyCashTitle")}</h2></div>
        {types.length > 1 && (
          <div className="filterChips" role="radiogroup" aria-label={t("historyCashType")}>
            {[null, ...types].map((key) => (
              <button key={key ?? "all"} type="button" role="radio" aria-checked={shown === key} className={shown === key ? "active" : ""} onClick={() => setType(key)}>
                {key === null ? t("historyAll") : cashTypeLabel(key, t)}
              </button>
            ))}
          </div>
        )}
        {items.length === 0 ? <div className="emptyState compact">{t("historyNoCash")}</div> : byDay(items, (item) => item.date).map((group) => (
          <div key={group.day} className="historyDay">
            <h3 className="historyDayTitle">{group.day ? dayLabel(group.day, locale, { weekday: true }) : "—"}</h3>
            <ul className="historyList">
              {group.items.map((item, index) => {
                const label = who(item);
                const value = cashSigned(item.type, item.amount);
                return (
                  <li key={`${item.reference ?? ""}-${index}`} className="historyRow">
                    <div className="historyWho">
                      {label && item.ticker ? <AssetAvatar ticker={item.ticker} label={label} /> : <span className={`cashMark ${value < 0 ? "out" : "in"}`} aria-hidden="true">{value < 0 ? "−" : "+"}</span>}
                      <div>
                        {label && item.ticker
                          ? (onOpen ? <button type="button" className="inlineLink reviewName" disabled={busy} title={item.ticker} onClick={() => onOpen(item.ticker!)}>{label.name}</button> : <strong title={item.ticker}>{label.name}</strong>)
                          : <strong>{cashTypeLabel(item.type, t, true)}</strong>}
                        <small>
                          {label ? cashTypeLabel(item.type, t, true) : ""}
                          {item.grossPerShare !== undefined ? `${label ? " · " : ""}${fill(t("holdingPerShare"), { amount: amount(item.grossPerShare, item.perShareCurrency, locale, { digits: 4 }) })}` : ""}
                          {item.quantity !== undefined ? ` · ${qty(item.quantity, locale)}` : ""}
                          {!label && item.date.length > 10 ? time(item.date, locale) : ""}
                        </small>
                      </div>
                    </div>
                    <strong className={`historyAmount ${signedClass(value)}`}>{money(value, item.currency || currency, locale, { signed: true })}</strong>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {data.count > data.items.length && <p className="panelNote">{fill(t("historyShowingNewest"), { shown: String(data.items.length), count: String(data.count) })}</p>}
      </section>
    </main>
  );
}

export function TaxYearView({ data, book, locale, t, busy, onKind, onYear, onRule }: {
  data: TaxYearSummary; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy: boolean;
  onKind: (next: HistoryKind) => void; onYear: (year: number) => void; onRule: (rule: TaxRule) => void;
}) {
  const currency = data.accountCurrency || "EUR";
  const m = (value: number | undefined, signed = false) => money(value, currency, locale, { signed });
  const rule = taxRuleOf(data.yearStart);
  const yearLabel = taxYearLabel(data.year, data.yearStart);
  const rules: Array<[TaxRule, MessageKey]> = [["calendar", "taxRuleCalendar"], ["uk", "taxRuleUk"]];
  return (
    <main className="contentStack">
      <div className="viewToolbar reviewToolbar">
        <HistorySwitch value="tax_year" onChange={onKind} t={t} disabled={busy} />
        <div className="taxControls">
          <div className="segmented" role="radiogroup" aria-label={t("taxRule")}>
            {rules.map(([key, label]) => <button key={key} type="button" role="radio" aria-checked={rule === key} className={rule === key ? "active" : ""} disabled={busy} onClick={() => { if (rule !== key) onRule(key); }}>{t(label)}</button>)}
          </div>
          <div className="yearStepper" role="group" aria-label={t("taxYearLabel")}>
            <button type="button" aria-label={t("taxYearPrevious")} disabled={busy || data.year <= 2000} onClick={() => onYear(data.year - 1)}>‹</button>
            <strong aria-live="polite">{yearLabel}</strong>
            <button type="button" aria-label={t("taxYearNext")} disabled={busy || !data.ended} onClick={() => onYear(data.year + 1)}>›</button>
          </div>
        </div>
      </div>
      {data.truncated && <div className="notice warning compactNotice">{t("historyTruncated")}</div>}
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("taxNetGain")}{!data.ended && <span className="statusPill fired taxRunning">{t("taxRunning")}</span>}</span>
          <strong className={`heroValue ${signedClass(data.disposals.net)}`}>{m(data.disposals.net, true)}</strong>
          <span className="overviewSubline">{fill(t("taxSpan"), { from: dayLabel(data.firstDay, locale), to: dayLabel(data.lastDay, locale) })} · {data.timeZone}</span>
          <span className="overviewSubline">{plural(data.disposals.count, locale, t("taxSalesOne"), t("taxSales"))} · {fill(t("taxProceeds"), { amount: m(data.disposals.proceeds) })}</span>
        </div>
        <div className="metricGrid">
          <Metric label={t("taxGains")} value={m(data.disposals.gains)} tone={data.disposals.gains ? "positive" : undefined} />
          <Metric label={t("taxLosses")} value={m(data.disposals.losses)} tone={data.disposals.losses ? "negative" : undefined} />
          <Metric label={t("dividends")} value={m(data.income.dividends)} />
          <Metric label={t("interest")} value={m(data.income.interest)} />
          <Metric label={t("costs")} value={m(data.costs.total)} />
        </div>
      </section>
      <section className="dataPanel">
        {data.byTicker.length === 0 ? <div className="emptyState compact">{t("taxNoSales")}</div> : (
          <BarList title={t("taxByInstrument")} nameHeader={t("symbol")} valueHeader={t("realizedPnL")} labels={chartLabels(t)} tone="signed"
            data={data.byTicker.map((item) => ({ key: item.ticker, ...instrumentDatum(item.ticker, book), value: item.realizedProfitLoss, display: m(item.realizedProfitLoss, true) }))} />
        )}
      </section>
      {data.costs.byType.length > 0 && (
        <section className="dataPanel">
          <BarList title={t("costBreakdown")} nameHeader={t("costs")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
            data={data.costs.byType.map((item) => ({ key: item.key, label: costLabel(item.key, t), value: item.amount, display: m(item.amount) }))} />
        </section>
      )}
      <section className="dataPanel">
        <p className="panelNote">{fill(t("taxDisclaimer"), { currency })}</p>
      </section>
    </main>
  );
}
