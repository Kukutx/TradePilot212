import type { AllocationAnalysis, AllocationDrift, IncomeSummary, PerformanceSummary } from "../../shared/history";
import type { MessageKey, SupportedLocale } from "../i18n";
import { localeTag } from "../i18n";
import { Metric, SectionHeader } from "../components/common";
import { BarList, ColumnChart, type ChartLabels } from "../components/charts";
import { money, pct, signedClass } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, instrumentTypeLabel, type Translator } from "../lib/messages";

export type InsightPeriod = "ytd" | "1y" | "all";

function dayLabel(value: string, locale: SupportedLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : new Intl.DateTimeFormat(localeTag(locale), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
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

function costLabel(code: string, t: Translator): string {
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

const chartLabels = (t: Translator): ChartLabels => ({ table: t("tableView"), chart: t("chartView") });

/** A bar row for an instrument: its name, its symbol under it, the exact ticker on hover. */
function instrumentDatum(ticker: string, book: InstrumentBook | undefined, name?: string) {
  const label = instrumentLabel(ticker, book, name ? { name } : undefined);
  return { label: label.name, ...(label.detail ? { sublabel: label.detail } : {}), title: ticker };
}

export function PeriodSwitch({ value, onChange, t, disabled }: { value: InsightPeriod; onChange: (next: InsightPeriod) => void; t: Translator; disabled: boolean }) {
  const options: Array<[InsightPeriod, MessageKey]> = [["ytd", "periodYtd"], ["1y", "period1y"], ["all", "periodAll"]];
  return (
    <div className="segmented" role="radiogroup" aria-label={t("period")}>
      {options.map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "active" : ""} disabled={disabled} onClick={() => onChange(key)}>{t(label)}</button>
      ))}
    </div>
  );
}

/**
 * Each target as a bullet bar: the fill is today's weight, the tick the target, on one scale for all rows
 * so lengths compare. The drift is in weight points; past the notice threshold it turns amber.
 */
function DriftPanel({ drift, book, locale, t, onRebalance, busy }: {
  drift: AllocationDrift; book?: InstrumentBook; locale: SupportedLocale; t: Translator; onRebalance?: () => void; busy?: boolean;
}) {
  const rows = [
    ...drift.rows.map((row) => ({ key: row.ticker, ...instrumentDatum(row.ticker, book), ...row })),
    { key: "CASH", label: instrumentTypeLabel("CASH", t), title: "CASH", ...drift.cash },
  ];
  const scale = Math.max(0.01, ...rows.map((row) => Math.max(row.current, row.target)));
  const points = new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const share = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;
  return (
    <section className="dataPanel">
      <div className="panelHeading">
        <h2 className="panelTitle">{t("driftTitle")}</h2>
        {onRebalance && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={onRebalance}>{t("rebalanceToTargets")}</button>}
      </div>
      <p className="panelNote">{fill(t("driftNote"), { points: points.format(drift.threshold * 100).replace(/^\+/, "") })}</p>
      <ul className="driftList" aria-label={t("driftTitle")}>
        {rows.map((row) => {
          const over = Math.abs(row.drift) > drift.threshold + 1e-9;
          return (
            <li key={row.key} className={over ? "over" : undefined}>
              <div className="driftHead">
                <span className="barLabel" title={row.title}>
                  <strong>{row.label}</strong>
                  {"sublabel" in row && row.sublabel && <small>{row.sublabel}</small>}
                </span>
                <span className={`driftValue ${over ? "over" : ""}`} aria-label={`${t("driftPointsHeader")} ${points.format(row.drift * 100)}`}>{points.format(row.drift * 100)}</span>
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

export function AllocationView({ data, book, locale, t, onRebalance, busy }: {
  data: AllocationAnalysis; book?: InstrumentBook; locale: SupportedLocale; t: Translator; onRebalance?: () => void; busy?: boolean;
}) {
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

      {data.drift && <DriftPanel drift={data.drift} book={book} locale={locale} t={t} {...(onRebalance ? { onRebalance } : {})} {...(busy === undefined ? {} : { busy })} />}

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

export function PerformanceView({ data, book, locale, t, period, onPeriod, busy }: {
  data: PerformanceSummary; book?: InstrumentBook; locale: SupportedLocale; t: Translator; period: InsightPeriod; onPeriod: (next: InsightPeriod) => void; busy: boolean;
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
        </div>
        <div className="metricGrid">
          <Metric label={t("incomeTotal")} value={m(data.income.dividends + data.income.interest)} />
          <Metric label={t("costs")} value={m(data.costs.total)} />
          <Metric label={t("netContributions")} value={m(data.contributions.net)} />
          <Metric label={data.simpleReturn === undefined ? t("tradesCount") : t("simpleReturn")} value={data.simpleReturn === undefined ? `${data.trades.buys + data.trades.sells}` : pct(data.simpleReturn, locale, 1, { signed: true })} tone={data.simpleReturn === undefined ? undefined : signedClass(data.simpleReturn)} />
        </div>
      </section>

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
          {data.costs.byType.length === 0 ? <div className="emptyState compact">{t("noData")}</div> : (
            <BarList title={t("costBreakdown")} nameHeader={t("costs")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
              data={data.costs.byType.map((item) => ({ key: item.key, label: costLabel(item.key, t), value: item.amount, display: m(item.amount) }))} />
          )}
        </section>
      </div>

      <section className="dataPanel">
        {contributors.length === 0 ? <div className="emptyState compact">{t("noData")}</div> : (
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
      <section className="dataPanel">
        {data.byMonth.length === 0 ? <div className="emptyState compact">{t("noData")}</div> : (
          <ColumnChart title={t("incomeByMonth")} nameHeader={t("monthColumn")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
            data={data.byMonth.map((item) => ({ key: item.key, label: monthLabel(item.key), value: item.amount, display: m(item.amount) }))} />
        )}
      </section>
      <section className="dataPanel">
        {data.byTicker.length === 0 ? <div className="emptyState compact">{t("noData")}</div> : (
          <BarList title={t("incomeByTicker")} nameHeader={t("symbol")} valueHeader={t("amountColumn")} labels={chartLabels(t)}
            data={data.byTicker.slice(0, 12).map((item) => ({ key: item.key, ...instrumentDatum(item.key, book), value: item.amount, display: m(item.amount) }))} />
        )}
      </section>
    </main>
  );
}
