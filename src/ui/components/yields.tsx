// The Income tab's yields and cash: what the holdings held now pay against what they cost and are worth, and the
// cash not invested with the interest it earned.

import { useId } from "react";
import type { IdleCash, IncomeYields } from "../../shared/history";
import type { SupportedLocale } from "../i18n";
import { dayLabel, money, pct } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { Metric } from "./common";

/** A dash for a figure Trading 212 gave nothing to work out, read out as words. */
function Unknown({ t }: { t: Translator }) {
  return <><span aria-hidden="true">—</span><span className="visuallyHidden">{t("figureUnknown")}</span></>;
}

const rate = (value: number | null, locale: SupportedLocale, t: Translator) => (value === null ? <Unknown t={t} /> : pct(value, locale, 2));

export function YieldPanel({ data, currency, book, locale, t }: { data: IncomeYields; currency: string; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const m = (value: number) => money(value, currency, locale);
  const titleId = useId();
  return (
    <section className="dataPanel yieldPanel" aria-labelledby={titleId}>
      <h2 className="panelTitle" id={titleId}>{t("yieldTitle")}</h2>
      <div className="metricGrid">
        <Metric label={t("yieldOnCost")} value={rate(data.onCost, locale, t)} />
        <Metric label={t("yieldOnValue")} value={rate(data.onValue, locale, t)} />
        <Metric label={t("yieldForwardOnCost")} value={rate(data.forwardOnCost, locale, t)} />
      </div>
      {data.byTicker.length > 0 && (
        <table className="chartTable yieldTable" aria-labelledby={titleId}>
          <thead><tr><th>{t("symbol")}</th><th>{t("yieldOnCostShort")}</th><th>{t("yieldOnValueShort")}</th><th>{t("yieldPaidColumn")}</th></tr></thead>
          <tbody>
            {data.byTicker.map((row) => {
              const label = instrumentLabel(row.ticker, book);
              return (
                <tr key={row.ticker}>
                  <td title={label.ticker}>
                    <strong>{label.name}</strong>
                    {(label.detail || row.forward > 0) && <small>{[label.detail, row.forward > 0 ? fill(t("yieldExpected"), { amount: m(row.forward) }) : ""].filter(Boolean).join(" · ")}</small>}
                  </td>
                  <td>{rate(row.onCost, locale, t)}</td>
                  <td>{rate(row.onValue, locale, t)}</td>
                  <td>{m(row.paid)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="panelNote">{fill(t("yieldNote"), { dividends: m(data.trailing), paid: m(data.paid), cost: data.cost === null ? "—" : m(data.cost) })}</p>
    </section>
  );
}

export function CashPanel({ data, currency, locale, t }: { data: IdleCash; currency: string; locale: SupportedLocale; t: Translator }) {
  const m = (value: number) => money(value, currency, locale);
  const titleId = useId();
  return (
    <section className="dataPanel cashPanel" aria-labelledby={titleId}>
      <h2 className="panelTitle" id={titleId}>{t("idleCashTitle")}</h2>
      <div className="metricGrid">
        <Metric label={t("idleCash")} value={m(data.total)} />
        <Metric label={t("idleCashShare")} value={data.share === null ? <Unknown t={t} /> : pct(data.share, locale, 1)} />
        <Metric label={t("idleCashInterest")} value={m(data.interest12Months)} />
        <Metric label={t("idleCashRate")} value={data.rate ? pct(data.rate.yearly, locale, 2) : <Unknown t={t} />} />
        {data.lending12Months > 0 && <Metric label={t("idleCashLending")} value={m(data.lending12Months)} />}
      </div>
      <p className="panelNote">{fill(t("idleCashParts"), { free: m(data.available), pies: m(data.inPies), reserved: m(data.reserved) })}</p>
      <p className="panelNote">{data.rate
        ? fill(t("idleCashRateNote"), { average: m(data.rate.averageCash), since: dayLabel(data.rate.since, locale), days: String(data.rate.days) })
        : t("idleCashNoRate")}</p>
    </section>
  );
}
