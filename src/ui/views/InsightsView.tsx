import { useState, type ReactNode } from "react";
import type { Instrument } from "../../shared/contracts";
import type { AllocationAnalysis, AllocationDrift, BenchmarkOption, HoldingCovariancePayload, IncomeSummary, PerformanceSummary, ReturnPoint, TimeWeightedReturn, ValuePoint } from "../../shared/history";
import type { PricesMissing } from "../../shared/prices";
import type { MessageKey, SupportedLocale } from "../i18n";
import { localeTag } from "../i18n";
import { EmptyState, Metric, SectionHeader, type EmptyAction } from "../components/common";
import { axisMoney, BarList, ColumnChart, decimalsOf, LineChart, type ChartLabels, type Grid } from "../components/charts";
import { drawdownSeries } from "../../shared/drawdown";
import { DividendCalendar } from "../components/dividend-calendar";
import { GainChart } from "../components/gains";
import { HoldingMixPanel } from "../components/holding-mix";
import { HoldingParityPanel, type EqualRiskPlan } from "../components/holding-parity";
import { TargetEditor, type MeasuredRisk, type TargetPreset, type TargetSave } from "../components/target-editor";
import { HoldingRiskPanel } from "../components/holding-risk";
import { MarketSensitivityPanel } from "../components/market-sensitivity";
import { MonthlyReturns } from "../components/monthly-returns";
import { RiskPanel } from "../components/risk";
import { dayLabel, money, pct, signedClass } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { bandPoints, fill, instrumentTypeLabel, tradeEstimateText, type Translator } from "../lib/messages";
import { radioKeys, radioMoveKeys, radioTab, radioTabOf } from "../lib/radio";

export type InsightPeriod = "1m" | "3m" | "ytd" | "1y" | "all";

/** The period a performance window was read for, from its dates, to mark it on the period switch. */
export function periodOf(range: { from?: string; to: string }): InsightPeriod {
  if (!range.from) return "all";
  const from = new Date(range.from);
  // The server's year-to-date window starts at the very start of the UTC year; a 1m or 3m one starts at the time of asking.
  if (from.getTime() === Date.UTC(from.getUTCFullYear(), 0, 1)) return "ytd";
  // The server's 1m and 3m windows are 30 and 91 days long; any other bounded window shows as 12 months.
  const days = (Date.parse(range.to) - from.getTime()) / 86_400_000;
  return Math.abs(days - 30) < 1 ? "1m" : Math.abs(days - 91) < 1 ? "3m" : "1y";
}

const COST_KEYS: Record<string, MessageKey> = {
  CURRENCY_CONVERSION_FEE: "costCurrencyConversionFee",
  COMMISSION_TURNOVER: "costCommissionTurnover",
  FINRA_FEE: "costFinraFee",
  FRENCH_TRANSACTION_TAX: "costFrenchTransactionTax",
  PTM_LEVY: "costPtmLevy",
  STAMP_DUTY: "costStampDuty",
  STAMP_DUTY_RESERVE_TAX: "costStampDutyReserveTax",
  TRANSACTION_FEE: "costTransactionFee",
  ACCOUNT_FEE: "costAccountFee",
};

export function costLabel(code: string, t: Translator): string {
  const known = COST_KEYS[code];
  return known ? t(known) : code.replaceAll("_", " ").toLowerCase();
}

const FLAG_KEYS: Record<AllocationAnalysis["flags"][number]["code"], MessageKey> = {
  SINGLE_HOLDING_OVER_LIMIT: "flagSingleHolding",
  TOP5_OVER_LIMIT: "flagTop5",
  CASH_HIGH: "flagCashHigh",
  CASH_LOW: "flagCashLow",
  CURRENCY_CONCENTRATED: "flagCurrency",
  DRIFT_OVER_THRESHOLD: "flagDrift",
};

export const chartLabels = (t: Translator): ChartLabels => ({ table: t("tableView"), chart: t("chartView") });

/** A bar row for an instrument: its name, its symbol under it, the exact ticker on hover. */
export function instrumentDatum(ticker: string, book: InstrumentBook | undefined, name?: string) {
  const label = instrumentLabel(ticker, book, name ? { name } : undefined);
  return { label: label.name, ...(label.detail ? { sublabel: label.detail } : {}), title: ticker };
}

/** "Show all time", offered where a shorter period has nothing to show. */
export function allTimeAction(period: InsightPeriod | null, onPeriod: ((next: InsightPeriod) => void) | undefined, t: Translator, busy: boolean): EmptyAction | undefined {
  return period && period !== "all" && onPeriod ? { label: t("showAllTime"), onClick: () => onPeriod("all"), disabled: busy } : undefined;
}

export function PeriodSwitch({ value, onChange, t, disabled }: { value: InsightPeriod | null; onChange: (next: InsightPeriod) => void; t: Translator; disabled: boolean }) {
  // Short labels keep five periods on one line in a phone-width frame; the full name is the accessible name.
  const options: Array<[InsightPeriod, MessageKey, MessageKey]> = [
    ["1m", "period1mShort", "period1m"], ["3m", "period3mShort", "period3m"], ["ytd", "periodYtdShort", "periodYtd"], ["1y", "period1yShort", "period1y"], ["all", "periodAllShort", "periodAll"],
  ];
  return (
    <div className="segmented" role="radiogroup" onKeyDown={radioMoveKeys} aria-label={t("period")}>
      {/* Off while a period is read, but still focusable (aria-disabled), so the focus stays on the switch. */}
      {options.map(([key, short, full]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} tabIndex={radioTabOf(options.map(([option]) => option), value, key)} aria-label={t(full)} title={t(full)} className={value === key ? "active" : ""} aria-disabled={disabled || undefined} onClick={() => { if (!disabled && value !== key) onChange(key); }}>{t(short)}</button>
      ))}
    </div>
  );
}

/**
 * Each target as a bullet bar: the fill is today's weight, the tick the target, on one scale for all rows
 * so lengths compare. The drift is in weight points; past the notice threshold it turns amber.
 */
/** Below this much spare cash, in the account currency, a buy-only plan has nothing to buy (the planner's minimum trade). */
const MIN_SPARE_CASH = 1;

function DriftPanel({ drift, spareCash, book, locale, t, onRebalance, onInvestCash, onEdit, focusEdit, busy }: {
  drift: AllocationDrift; spareCash: number; book?: InstrumentBook; locale: SupportedLocale; t: Translator;
  /** Plans the rebalance to the targets; with a band, of only the ones further off than it. */
  onRebalance?: (band?: number) => void; onInvestCash?: () => void; onEdit?: () => void;
  /** Focus Edit targets as it shows: the target form it opened has just closed. */
  focusEdit?: boolean; busy?: boolean;
}) {
  // Buying with spare cash needs free cash above the cash target; it never sells.
  const investCash = spareCash >= MIN_SPARE_CASH ? onInvestCash : undefined;
  const rows = [
    ...drift.rows.map((row) => ({ key: row.ticker, ...instrumentDatum(row.ticker, book), ...row })),
    { key: "CASH", label: instrumentTypeLabel("CASH", t), title: "CASH", ...drift.cash },
  ];
  const scale = Math.max(0.01, ...rows.map((row) => Math.max(row.current, row.target)));
  const points = new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const share = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;
  const trades = drift.rebalance && tradeEstimateText(drift.rebalance, "drift", t, locale);
  // Only the ones over the threshold, when that trades fewer than a rebalance to every target.
  const over = drift.rebalanceOver;
  const threshold = bandPoints(drift.threshold, locale);
  const names = (tickers: string[]) => tickers.map((ticker) => instrumentLabel(ticker, book).name).join(locale === "zh-CN" ? "、" : ", ");
  const overTrades = over && [
    tradeEstimateText(over.totals, "over", t, locale, { points: threshold, list: names(over.tickers) }),
    over.cashTo?.length ? fill(t("driftOverCash"), { points: threshold, list: names(over.cashTo) }) : "",
  ].filter(Boolean).join(locale === "zh-CN" ? "" : " ");
  const rebalanceOver = over && (over.totals.bought > 0 || over.totals.sold > 0) && onRebalance ? () => onRebalance(drift.threshold) : undefined;
  return (
    <section className="dataPanel">
      <div className="panelHeading">
        <h2 className="panelTitle">{t("driftTitle")}</h2>
        {(onRebalance || investCash || onEdit) && (
          <div className="panelActions">
            {onEdit && <button type="button" className="secondaryButton compactButton" autoFocus={focusEdit} disabled={busy} onClick={onEdit}>{t("targetsEdit")}</button>}
            {investCash && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={investCash}>{t("investCashByTargets")}</button>}
            {rebalanceOver && (
              <button type="button" className="secondaryButton compactButton" disabled={busy} title={fill(t("rebalanceOverTargetsHint"), { count: String(over!.tickers.length), points: threshold })} onClick={rebalanceOver}>{t("rebalanceOverTargets")}</button>
            )}
            {onRebalance && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => onRebalance()}>{t("rebalanceToTargets")}</button>}
          </div>
        )}
      </div>
      <p className="panelNote">{fill(t("driftNote"), { points: points.format(drift.threshold * 100).replace(/^\+/, "") })}</p>
      {drift.volatility && (
        <p className="panelNote driftVolatility">
          {fill(t("driftVolatility"), { at: pct(drift.volatility.atTargets, locale), now: pct(drift.volatility.now, locale) })}
          {drift.volatility.account && <>{locale === "zh-CN" ? "" : " "}{fill(t("driftVolatilityAccount"), { at: pct(drift.volatility.account.atTargets, locale), now: pct(drift.volatility.account.now, locale) })}</>}
          {drift.volatility.leftOut?.length ? <>{locale === "zh-CN" ? "" : " "}{fill(t("targetsRiskLeftOut"), { list: drift.volatility.leftOut.map((ticker) => instrumentLabel(ticker, book).name).join(locale === "zh-CN" ? "、" : ", ") })}</> : null}
        </p>
      )}
      {trades && <p className="panelNote driftTrades">{trades}</p>}
      {overTrades && <p className="panelNote driftTrades driftOverTrades">{overTrades}</p>}
      <ul className="driftList" aria-label={t("driftTitle")}>
        {rows.map((row) => {
          const past = Math.abs(row.drift) > drift.threshold + 1e-9;
          return (
            <li key={row.key} className={past ? "over" : undefined}>
              <div className="driftHead">
                <span className="barLabel" title={row.title}>
                  <strong>{row.label}</strong>
                  {"sublabel" in row && row.sublabel && <small>{row.sublabel}</small>}
                </span>
                <span className={`driftValue ${past ? "over" : ""}`} aria-label={`${t("driftPointsHeader")} ${points.format(row.drift * 100)}`}>{points.format(row.drift * 100)}</span>
              </div>
              <div className="driftTrack" aria-hidden="true">
                <span className="driftFill" style={{ width: share(row.current) }} />
                <span className="driftTarget" style={{ left: share(row.target) }} />
              </div>
              <div className="driftFacts">
                <span>{fill(t("driftNow"), { value: pct(row.current, locale) })}</span>
                <span>{fill(t("driftTarget"), { value: pct(row.target, locale) })}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {drift.untargeted.length > 0 && (
        <p className="panelNote">{fill(t(drift.sellUntargeted ? "driftUntargetedSold" : "driftUntargeted"), { list: drift.untargeted.map((item) => `${instrumentLabel(item.ticker, book).name} ${pct(item.current, locale)}`).join(locale === "zh-CN" ? "、" : ", ") })}</p>
      )}
    </section>
  );
}

export function AllocationView({ data, book, locale, t, onRebalance, onInvestCash, onPlanEqualRisk, onSaveTargets, onClearTargets, onReadCovariance, onSearch, busy }: {
  data: AllocationAnalysis; book?: InstrumentBook; locale: SupportedLocale; t: Translator; onRebalance?: (band?: number) => void; onInvestCash?: () => void;
  /** Drafts the rebalance to the equal-risk weights as a basket to review; only with order tools. */
  onPlanEqualRisk?: (plan: EqualRiskPlan) => void;
  /** Save or remove the target weights; each resolves true once done. Targets never trade. */
  onSaveTargets?: (save: TargetSave) => Promise<boolean>;
  onClearTargets?: () => Promise<boolean>;
  /** Reads the holdings' covariance, with instruments not held beside them, for the risk at the targets typed in. */
  onReadCovariance?: (measured: MeasuredRisk, alongside: string[]) => Promise<HoldingCovariancePayload>;
  /** Searches Trading 212's instruments, to add a target not held. */
  onSearch?: (query: string) => Promise<Instrument[]>;
  busy?: boolean;
}) {
  // The target form, open on the saved targets or filled from a preset.
  const [editing, setEditing] = useState<TargetPreset | "saved" | null>(null);
  // Closed, the form hands the focus back to the button that opens it.
  const [refocus, setRefocus] = useState(false);
  const currency = data.accountCurrency || "EUR";
  const tableProps = { labels: chartLabels(t), valueHeader: t("weightColumn") };
  // The bars are shares of the total account value, cash included, so the parts add up to 100%.
  // Concentration is measured on invested value, as the checks below are, so a large cash balance does not hide it.
  const byType = [...data.byType, ...(data.cash > 0 ? [{ type: "CASH", value: data.cash, weight: data.cashWeight }] : [])].sort((a, b) => b.weight - a.weight);
  return (
    <main className="contentStack">
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("tabAllocation")}</span>
          <strong className="heroValue">{money(data.totalValue, currency, locale)}</strong>
          <span className="overviewSubline">{t("investedValue")} · {money(data.investedValue, currency, locale)}</span>
          <span className="overviewSubline">{t("allocationBasis")}</span>
        </div>
        <div className="metricGrid">
          <Metric label={t("cashShare")} value={pct(data.cashWeight, locale)} />
          <Metric label={t("largestHolding")} value={pct(data.concentration.largestWeight, locale)} />
          <Metric label={t("top5Share")} value={pct(data.concentration.top5Weight, locale)} />
          <Metric label={t("effectiveHoldings")} value={new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(data.concentration.effectiveHoldings)} />
        </div>
      </section>

      <section className="dataPanel">
        <SectionHeader title={t("allocationFlags")} count={data.flags.length} />
        {data.flags.length === 0
          ? <div className="emptyState compact">{t("noFlags")}</div>
          : <ul className="flagList">{data.flags.map((flag) => <li key={flag.code}><span className="flagIcon" aria-hidden="true">!</span>{t(FLAG_KEYS[flag.code])}</li>)}</ul>}
      </section>

      {onSaveTargets && editing ? (
        // Opened again from another button (Use as targets while editing), it starts afresh from that.
        <TargetEditor key={editing} data={data} {...(book ? { book } : {})} locale={locale} t={t} {...(busy === undefined ? {} : { busy })} {...(editing === "saved" ? {} : { start: editing })}
          onSave={onSaveTargets} {...(data.drift && onClearTargets ? { onClear: onClearTargets } : {})} {...(data.risk && onReadCovariance ? { onReadCovariance } : {})} {...(onSearch ? { onSearch } : {})}
          onClose={() => { setEditing(null); setRefocus(true); }} />
      ) : data.drift ? (
        <DriftPanel drift={data.drift} spareCash={(data.availableCash ?? data.cash) - data.drift.cash.target * data.totalValue} book={book} locale={locale} t={t} {...(onRebalance ? { onRebalance } : {})} {...(onInvestCash ? { onInvestCash } : {})}
          {...(onSaveTargets ? { onEdit: () => setEditing("saved") } : {})} focusEdit={refocus} {...(busy === undefined ? {} : { busy })} />
      ) : onSaveTargets && data.holdings.length > 0 && (
        <section className="dataPanel">
          <div className="panelHeading">
            <h2 className="panelTitle">{t("targetsTitle")}</h2>
            <div className="panelActions"><button type="button" className="secondaryButton compactButton" autoFocus={refocus} disabled={busy} onClick={() => setEditing("saved")}>{t("targetsSet")}</button></div>
          </div>
          <p className="panelNote">{t("targetsEmpty")}</p>
        </section>
      )}

      <section className="dataPanel">
        {data.holdings.length === 0 ? <div className="emptyState compact">{t("noPositions")}</div> : (
          <BarList
            title={t("weightsTitle")}
            nameHeader={t("symbol")}
            {...tableProps}
            max={data.holdings[0]?.weight}
            data={data.holdings.map((item) => ({ key: item.ticker, ...instrumentDatum(item.ticker, book, item.name), value: item.weight, display: pct(item.weight, locale) }))}
          />
        )}
      </section>

      <HoldingRiskPanel data={data} {...(book ? { book } : {})} locale={locale} t={t} />
      {data.risk?.mix && <HoldingMixPanel mix={data.risk.mix} currency={currency} locale={locale} t={t} />}
      {data.risk?.market && <MarketSensitivityPanel market={data.risk.market} data={data} {...(book ? { book } : {})} locale={locale} t={t} />}
      <HoldingParityPanel data={data} {...(book ? { book } : {})} locale={locale} t={t} {...(onPlanEqualRisk ? { onPlan: onPlanEqualRisk } : {})}
        {...(onSaveTargets ? { onUseAsTargets: () => setEditing("parity") } : {})} {...(busy === undefined ? {} : { busy })} />

      <div className="twoColumn">
        <section className="dataPanel">
          <BarList title={t("currencyExposure")} nameHeader={t("currencyExposure")} {...tableProps} max={1}
            data={data.byCurrency.map((item) => ({ key: item.currency, label: item.currency, value: item.weight, display: pct(item.weight, locale) }))} />
        </section>
        <section className="dataPanel">
          <BarList title={t("assetTypes")} nameHeader={t("assetTypes")} {...tableProps} max={1}
            data={byType.map((item) => ({ key: item.type, label: instrumentTypeLabel(item.type, t), value: item.weight, display: pct(item.weight, locale) }))} />
        </section>
      </div>
    </main>
  );
}

const BENCHMARK_MISSING: Record<PricesMissing | "instrument", MessageKey> = {
  instrument: "benchmarkMissingInstrument",
  provider: "benchmarkMissingProvider",
  plan: "benchmarkMissingPlan",
  symbol: "benchmarkMissingSymbol",
  data: "benchmarkMissingData",
  unit: "benchmarkMissingData",
  sample: "benchmarkMissingSample",
};

const benchmarkName = (option: BenchmarkOption) => option.shortName ?? option.ticker;
/** Pence are pounds: a GBX fund is in the currency of a GBP account. */
const major = (currency: string | undefined) => (currency?.toUpperCase() === "GBX" ? "GBP" : currency?.toUpperCase());

/** How the time-weighted return did against the benchmark over the same days, in words, and why there is none. */
function BenchmarkNote({ data, locale, t }: { data: PerformanceSummary; locale: SupportedLocale; t: Translator }) {
  const { benchmark, timeWeighted } = data;
  if (!timeWeighted) return null;
  if (!benchmark) {
    if (!data.benchmarkMissing) return null;
    const wanted = data.benchmarkOptions?.find((option) => option.ticker === data.benchmarkChoice);
    const name = wanted ? benchmarkName(wanted) : data.benchmarkChoice && data.benchmarkChoice !== "none" ? data.benchmarkChoice : t("benchmarkFallbackName");
    return <p className="panelNote benchmarkNote">{fill(t(BENCHMARK_MISSING[data.benchmarkMissing]), { name })}</p>;
  }
  const gap = timeWeighted.return - benchmark.return;
  const name = benchmarkName(benchmark);
  const points = pct(Math.abs(gap), locale, 1).replace(/\s*%$/, "");
  const key: MessageKey = Math.abs(gap) < 0.0005 ? "benchmarkLevel" : gap > 0 ? "benchmarkAhead" : "benchmarkBehind";
  return (
    <p className="panelNote benchmarkNote">
      <strong className={signedClass(Math.abs(gap) < 0.0005 ? 0 : gap)}>{fill(t(key), { gap: points, name })}</strong>
      {" · "}{fill(t("benchmarkReturn"), { name, value: pct(benchmark.return, locale, 1, { signed: true }) })}
      {benchmark.currencyCode && major(benchmark.currencyCode) !== major(data.accountCurrency) && <>{" "}{fill(t("benchmarkCurrency"), { name, currency: benchmark.currencyCode, account: data.accountCurrency })}</>}
      {benchmark.source === "sample" && <>{" "}{t("benchmarkSample")}</>}
    </p>
  );
}

/** Pick the fund to compare with: the default, then the ETFs held and on the watchlist, or none. */
function BenchmarkPicker({ data, busy, t, onBenchmark }: { data: PerformanceSummary; busy: boolean; t: Translator; onBenchmark: (choice: string) => void }) {
  const options = data.benchmarkOptions ?? [];
  if (!data.timeWeighted || !options.length) return null;
  // A query Trading 212 matched no fund for has no option of its own: there is no comparison.
  const chosen = data.benchmark?.ticker ?? data.benchmarkChoice;
  const current = chosen && options.some((option) => option.ticker === chosen) ? chosen : "none";
  return (
    <label className="benchmarkPicker">
      <span>{t("benchmarkLabel")}</span>
      <select value={current} disabled={busy} aria-label={t("benchmarkLabel")} onChange={(event) => onBenchmark(event.target.value)}>
        {options.map((option) => <option key={option.ticker} value={option.ticker}>{option.name ? `${benchmarkName(option)} · ${option.name}` : benchmarkName(option)}</option>)}
        <option value="none">{t("benchmarkNone")}</option>
      </select>
    </label>
  );
}

/** Each day's fall from the highest return before it, beside the benchmark's over the same days. */
export function DrawdownChart({ returns, data, controls, locale, t }: {
  returns: TimeWeightedReturn; data: PerformanceSummary; controls: ReactNode; locale: SupportedLocale; t: Translator;
}) {
  const percentAxis = (value: number, grid: Grid) => pct(value, locale, decimalsOf(grid.step * 100), { signed: value !== 0 });
  // Within 0.05% of the high is at it, as in the note.
  const falls = (series: ReturnPoint[]) => drawdownSeries(series).map((point) => (point.return > -0.0005 ? { ...point, return: 0 } : point));
  const fallen = falls(returns.series);
  const benchmark = data.benchmark ? new Map(falls(data.benchmark.series).map((point) => [point.date, point.return])) : undefined;
  const display = (value: number) => value === 0 ? t("drawdownAtHighShort") : pct(value, locale, 2);
  return (
    <LineChart title={t("drawdownTitle")} nameHeader={t("dateColumn")} valueHeader={t("drawdownColumn")} labels={chartLabels(t)} zero flat={0.01} belowZero controls={controls}
      axis={percentAxis}
      {...(data.benchmark && benchmark ? {
        compare: {
          name: benchmarkName(data.benchmark),
          mainName: t("drawdownYou"),
          points: fallen.map((point) => {
            const value = benchmark.get(point.date);
            return value === undefined ? undefined : { value, display: display(value) };
          }),
        },
      } : {})}
      data={fallen.map((point) => ({ key: point.date, label: dayLabel(point.date, locale), value: point.return, display: display(point.return), time: Date.parse(`${point.date}T00:00:00Z`) }))} />
  );
}

/** The deepest fall, whether it was made up, where the return stands against its high, and the benchmark's deepest. */
export function DrawdownNote({ returns, data, locale, t }: { returns: TimeWeightedReturn; data: PerformanceSummary; locale: SupportedLocale; t: Translator }) {
  const drawdown = returns.drawdown;
  if (!drawdown) return null;
  const day = (date: string | undefined) => date ? dayLabel(date, locale) : "";
  const fall = data.benchmark?.drawdown;
  return (
    <p className="panelNote">
      {drawdown.peak && drawdown.trough ? (
        <>
          <strong className="negative">{pct(drawdown.max, locale, 1)}</strong>
          {" · "}{fill(t(drawdown.recovered ? "drawdownMadeUp" : "drawdownOpen"), { peak: day(drawdown.peak), trough: day(drawdown.trough), recovered: day(drawdown.recovered) })}
          {" "}{drawdown.current < 0 ? fill(t("drawdownNow"), { amount: pct(-drawdown.current, locale, 1), date: day(drawdown.currentPeak) }) : t("drawdownAtHigh")}
        </>
      ) : fill(t("drawdownNone"), { days: String(returns.series.length) })}
      {data.benchmark && fall && <>{" "}{fall.peak ? fill(t("drawdownBenchmark"), { name: benchmarkName(data.benchmark), amount: pct(fall.max, locale, 1) }) : fill(t("drawdownBenchmarkNone"), { name: benchmarkName(data.benchmark) })}</>}
    </p>
  );
}

/**
 * The account value TradePilot recorded each day, with the change over the window. With a time-weighted
 * return it opens on that instead, since the value also moves with every deposit and withdrawal, and draws the
 * benchmark's return over the same days beside it; its drawdown view shows the falls from each high.
 */
function ValueHistoryPanel({ points, returns, data, currency, locale, t, busy, onBenchmark }: {
  points: ValuePoint[]; returns?: TimeWeightedReturn; data: PerformanceSummary; currency: string; locale: SupportedLocale; t: Translator; busy: boolean;
  onBenchmark?: (choice: string) => void;
}) {
  const [show, setShow] = useState<"return" | "value" | "drawdown">("return");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const change = last.totalValue - first.totalValue;
  const valueAxis = (value: number, grid: Grid) => axisMoney(value, grid, currency, locale);
  const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const asReturn = returns && show === "return";
  const asDrawdown = returns && show === "drawdown";
  // As many decimals as the gridline step needs: "+10%" a step of 10%, "+7.5%" a step of 2.5%.
  const percentAxis = (value: number, grid: Grid) => pct(value, locale, decimalsOf(grid.step * 100), { signed: true });
  const controls = returns && (
    <div className="segmented" role="radiogroup" onKeyDown={radioKeys} aria-label={t("chartShow")}>
      {(["return", "value", "drawdown"] as const).map((key) => (
        <button key={key} type="button" role="radio" aria-checked={show === key} tabIndex={radioTab(show === key)} className={show === key ? "active" : ""} onClick={() => setShow(key)}>{t(key === "return" ? "chartReturn" : key === "value" ? "chartValue" : "chartDrawdown")}</button>
      ))}
    </div>
  );
  return (
    <section className="dataPanel">
      {asDrawdown ? (
        <DrawdownChart returns={returns} data={data} controls={controls} locale={locale} t={t} />
      ) : asReturn ? (
        <LineChart title={t("returnHistoryTitle")} nameHeader={t("dateColumn")} valueHeader={t("returnColumn")} labels={chartLabels(t)} zero flat={0.01} controls={controls}
          axis={percentAxis}
          {...(data.benchmark ? {
            compare: {
              name: benchmarkName(data.benchmark),
              mainName: t("benchmarkYou"),
              // The benchmark comes on the same days as the return.
              points: returns.series.map((point) => {
                const match = data.benchmark!.series.find((item) => item.date === point.date);
                return match ? { value: match.return, display: pct(match.return, locale, 2, { signed: true }) } : undefined;
              }),
            },
          } : {})}
          data={returns.series.map((point) => ({ key: point.date, label: dayLabel(point.date, locale), value: point.return, display: pct(point.return, locale, 2, { signed: true }), time: time(point.date) }))} />
      ) : (
        <LineChart title={t("valueHistoryTitle")} nameHeader={t("dateColumn")} valueHeader={t("amountColumn")} labels={chartLabels(t)} axis={valueAxis} {...(controls ? { controls } : {})}
          data={points.map((point) => ({ key: point.date, label: dayLabel(point.date, locale), value: point.totalValue, display: money(point.totalValue, currency, locale), time: time(point.date) }))} />
      )}
      {asDrawdown ? <DrawdownNote returns={returns} data={data} locale={locale} t={t} /> : asReturn ? (
        <p className="panelNote">
          <strong className={signedClass(returns.return)}>{pct(returns.return, locale, 1, { signed: true })}</strong>
          {" · "}{fill(t(returns.netFlows > 0 ? "returnHistoryNoteDeposits" : returns.netFlows < 0 ? "returnHistoryNoteWithdrawals" : "returnHistoryNote"), { days: String(returns.series.length), amount: money(Math.abs(returns.netFlows), currency, locale) })}
        </p>
      ) : (
        <p className="panelNote">
          <strong className={signedClass(change)}>{money(change, currency, locale, { signed: true })}{first.totalValue ? ` (${pct(change / first.totalValue, locale, 1, { signed: true })})` : ""}</strong>
          {" · "}{fill(t("valueHistoryNote"), { days: String(points.length) })}
        </p>
      )}
      {(asReturn || asDrawdown) && (
        <div className="benchmarkRow">
          {/* In the drawdown view the note below names the benchmark's fall; only a missing one is said here. */}
          {asReturn || !data.benchmark ? <BenchmarkNote data={data} locale={locale} t={t} /> : <span />}
          {onBenchmark && <BenchmarkPicker data={data} busy={busy} t={t} onBenchmark={onBenchmark} />}
        </div>
      )}
    </section>
  );
}

export function PerformanceView({ data, book, locale, t, period, onPeriod, onBenchmark, onOpen, busy }: {
  data: PerformanceSummary; book?: InstrumentBook; locale: SupportedLocale; t: Translator; period: InsightPeriod; onPeriod: (next: InsightPeriod) => void; busy: boolean;
  /** Read the performance again compared with another fund, or "none". */
  onBenchmark?: (choice: string) => void;
  /** Open an instrument's page. */
  onOpen?: (ticker: string) => void;
}) {
  const currency = data.accountCurrency || "EUR";
  const m = (value: number | undefined) => money(value, currency, locale);
  const signed = (value: number | undefined) => money(value, currency, locale, { signed: true });
  const contributors = data.byTicker.filter((item) => item.realizedProfitLoss !== 0).sort((a, b) => Math.abs(b.realizedProfitLoss) - Math.abs(a.realizedProfitLoss)).slice(0, 10);
  return (
    <main className="contentStack">
      <div className="viewToolbar"><PeriodSwitch value={period} onChange={onPeriod} t={t} disabled={busy} /></div>
      {data.coverage.truncated && <div className="notice warning compactNotice">{t("historyTruncated")}</div>}
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("realizedPnL")}</span>
          <strong className={`heroValue ${signedClass(data.realizedProfitLoss)}`}>{signed(data.realizedProfitLoss)}</strong>
          <div className={`pnlBadge ${signedClass(data.unrealizedProfitLoss)}`}>{t("unrealizedPnL")} · {signed(data.unrealizedProfitLoss)}</div>
          {data.annualizedReturn !== undefined && (
            <span className="overviewSubline">
              {t("annualizedReturn")} · <strong className={signedClass(data.annualizedReturn)}>{pct(data.annualizedReturn, locale, 1, { signed: true })}</strong>
              {data.annualizedSince && <> · <span className="noWrap">{fill(t("annualizedSince"), { date: dayLabel(data.annualizedSince, locale) })}</span></>}
            </span>
          )}
          {data.timeWeighted && (
            <span className="overviewSubline">
              {t("timeWeightedReturn")} · <strong className={signedClass(data.timeWeighted.return)}>{pct(data.timeWeighted.return, locale, 1, { signed: true })}</strong>
              {" · "}<span className="noWrap">{fill(t("timeWeightedRange"), { from: dayLabel(data.timeWeighted.from, locale), to: dayLabel(data.timeWeighted.to, locale) })}</span>
            </span>
          )}
        </div>
        <div className="metricGrid">
          <Metric label={t("incomeTotal")} value={m(data.income.dividends + data.income.interest)} />
          <Metric label={t("costs")} value={m(data.costs.total)} />
          <Metric label={t("netContributions")} value={m(data.contributions.net)} />
          <Metric label={data.simpleReturn === undefined ? t("tradesCount") : t("simpleReturn")} value={data.simpleReturn === undefined ? `${data.trades.buys + data.trades.sells}` : pct(data.simpleReturn, locale, 1, { signed: true })} tone={data.simpleReturn === undefined ? undefined : signedClass(data.simpleReturn)} />
        </div>
      </section>

      {data.valueHistory && data.valueHistory.length >= 2 && (
        <ValueHistoryPanel points={data.valueHistory} {...(data.timeWeighted ? { returns: data.timeWeighted } : {})} data={data} currency={currency} locale={locale} t={t} busy={busy}
          {...(onBenchmark ? { onBenchmark } : {})} />
      )}

      {data.timeWeighted?.risk && (
        <section className="dataPanel">
          <RiskPanel returns={data.timeWeighted} {...(data.benchmark ? { benchmark: data.benchmark } : {})} locale={locale} t={t} />
        </section>
      )}

      {/* Two months or more, one of them the whole month: a 1m window's two part-months say no more than its chart. */}
      {data.timeWeighted?.months && data.timeWeighted.months.length >= 2 && data.timeWeighted.months.some((month) => !month.partial) && (
        <section className="dataPanel">
          <MonthlyReturns months={data.timeWeighted.months} years={data.timeWeighted.years ?? []} locale={locale} t={t} />
        </section>
      )}

      {data.attribution ? (
        <section className="dataPanel">
          <GainChart attribution={data.attribution} currency={currency} book={book} locale={locale} t={t} busy={busy} {...(onOpen ? { onOpen } : {})} />
        </section>
      ) : data.attributionProblem ? (
        <div className="notice compactNotice">{t(data.attributionMissing === "period" ? "gainsUnavailable" : data.attributionMissing === "history" ? "gainsUnavailableHistory" : "gainsUnavailableData")}</div>
      ) : null}

      <div className="twoColumn">
        <section className="dataPanel">
          <h2 className="panelTitle">{t("cashAndTrading")}</h2>
          <div className="factList">
            <div><span>{t("deposits")}</span><strong>{m(data.contributions.deposits)}</strong></div>
            <div><span>{t("withdrawals")}</span><strong>{m(data.contributions.withdrawals)}</strong></div>
            <div><span>{t("dividends")}</span><strong>{m(data.income.dividends)}</strong></div>
            <div><span>{t("interest")}</span><strong>{m(data.income.interest)}</strong></div>
            <div><span>{t("buys")} / {t("sells")}</span><strong>{data.trades.buys} / {data.trades.sells}</strong></div>
          </div>
        </section>
        <section className="dataPanel">
          {data.costs.byType.length === 0 ? <EmptyState title={t("costBreakdown")} text={t("costsNone")} /> : (
            <BarList title={t("costBreakdown")} nameHeader={t("costs")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
              data={data.costs.byType.map((item) => ({ key: item.key, label: costLabel(item.key, t), value: item.amount, display: m(item.amount) }))} />
          )}
        </section>
      </div>

      <section className="dataPanel">
        {contributors.length === 0 ? <EmptyState title={`${t("realizedPnL")} · ${t("topContributors")}`} text={t("contributorsNone")} action={allTimeAction(period, onPeriod, t, busy)} /> : (
          <BarList title={`${t("realizedPnL")} · ${t("topContributors")}`} nameHeader={t("symbol")} valueHeader={t("amountColumn")} labels={chartLabels(t)} tone="signed"
            data={contributors.map((item) => ({ key: item.ticker, ...instrumentDatum(item.ticker, book), value: item.realizedProfitLoss, display: signed(item.realizedProfitLoss) }))} />
        )}
      </section>
    </main>
  );
}

export function IncomeView({ data, book, locale, t, period, onPeriod, busy }: {
  data: IncomeSummary; book?: InstrumentBook; locale: SupportedLocale; t: Translator; period: InsightPeriod; onPeriod: (next: InsightPeriod) => void; busy: boolean;
}) {
  const currency = data.accountCurrency || "EUR";
  const m = (value: number | undefined) => money(value, currency, locale);
  const monthLabel = (key: string) => {
    const date = new Date(`${key}-01T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? key : new Intl.DateTimeFormat(localeTag(locale), { month: "short", year: "2-digit", timeZone: "UTC" }).format(date);
  };
  return (
    <main className="contentStack">
      <div className="viewToolbar"><PeriodSwitch value={period} onChange={onPeriod} t={t} disabled={busy} /></div>
      {data.truncated && <div className="notice warning compactNotice">{t("historyTruncated")}</div>}
      <section className="overviewPanel">
        <div className="overviewLead">
          <span className="sectionEyebrow">{t("incomeTotal")}</span>
          <strong className="heroValue">{m(data.total)}</strong>
          <span className="overviewSubline">{t("trailing12m")} · {m(data.trailing12Months)}</span>
          {data.forwardAnnual && <span className="overviewSubline">{t("forward12m")} · {m(data.forwardAnnual.total)}{data.forwardAnnual.yieldOnValue === null ? "" : ` (${pct(data.forwardAnnual.yieldOnValue, locale, 2)})`}</span>}
        </div>
        <div className="metricGrid">
          <Metric label={t("dividends")} value={m(data.dividends)} />
          <Metric label={t("interest")} value={m(data.interest)} />
        </div>
      </section>
      {data.forwardAnnual?.calendar && data.forwardAnnual.upcoming && (
        <section className="dataPanel">
          <DividendCalendar calendar={data.forwardAnnual.calendar} upcoming={data.forwardAnnual.upcoming} total={data.forwardAnnual.total} today={data.timestamp}
            currency={currency} book={book} locale={locale} t={t} />
        </section>
      )}
      <section className="dataPanel">
        {data.byMonth.length === 0 ? <EmptyState title={t("incomeByMonth")} text={t("incomeNone")} action={allTimeAction(period, onPeriod, t, busy)} /> : (
          <ColumnChart title={t("incomeByMonth")} nameHeader={t("monthColumn")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
            data={data.byMonth.map((item) => ({ key: item.key, label: monthLabel(item.key), value: item.amount, display: m(item.amount) }))} />
        )}
      </section>
      <section className="dataPanel">
        {data.byTicker.length === 0 ? <EmptyState title={t("incomeByTicker")} text={t("incomeNone")} /> : (
          <BarList title={t("incomeByTicker")} nameHeader={t("symbol")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
            data={data.byTicker.slice(0, 12).map((item) => ({ key: item.key, ...instrumentDatum(item.key, book), value: item.amount, display: m(item.amount) }))} />
        )}
      </section>
    </main>
  );
}
