// The Income tab's yields and cash: what the holdings held now pay against what they cost and are worth, and the
// cash not invested with the interest it earned.

import type { IdleCash, IncomeYields } from "../../shared/history";
import type { SupportedLocale } from "../i18n";
import { money, pct } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { Metric } from "./common";

const yieldText = (value: number | null, locale: SupportedLocale) => (value === null ? "—" : pct(value, locale, 2));

export function YieldPanel({ data, currency, book, locale, t }: { data: IncomeYields; currency: string; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const m = (value: number) => money(value, currency, locale);
  return (
    <section className="dataPanel yieldPanel">
      <h2 className="panelTitle">{t("yieldTitle")}</h2>
      <div className="metricGrid">
        <Metric label={t("yieldOnCost")} value={yieldText(data.onCost, locale)} />
        <Metric label={t("yieldOnValue")} value={yieldText(data.onValue, locale)} />
        <Metric label={t("yieldForwardOnCost")} value={yieldText(data.forwardOnCost, locale)} />
      </div>
      {data.byTicker.length > 0 && (
        <table className="chartTable yieldTable">
          <thead><tr><th>{t("symbol")}</th><th>{t("yieldOnCostShort")}</th><th>{t("yieldOnValueShort")}</th><th>{t("yieldPaidColumn")}</th></tr></thead>
          <tbody>
            {data.byTicker.map((row) => {
              const label = instrumentLabel(row.ticker, book);
              return (
                <tr key={row.ticker}>
                  <td title={label.ticker}><strong>{label.detail || label.name}</strong>{row.forward > 0 && <small>{fill(t("yieldExpected"), { amount: m(row.forward) })}</small>}</td>
                  <td>{yieldText(row.onCost, locale)}</td>
                  <td>{yieldText(row.onValue, locale)}</td>
                  <td>{m(row.trailing)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="panelNote">{fill(t("yieldNote"), { paid: m(data.trailing), cost: data.cost === null ? "—" : m(data.cost) })}</p>
    </section>
  );
}

export function CashPanel({ data, currency, locale, t }: { data: IdleCash; currency: string; locale: SupportedLocale; t: Translator }) {
  const m = (value: number) => money(value, currency, locale);
  return (
    <section className="dataPanel cashPanel">
      <h2 className="panelTitle">{t("idleCashTitle")}</h2>
      <div className="metricGrid">
        <Metric label={t("idleCash")} value={m(data.available)} />
        <Metric label={t("idleCashShare")} value={data.share === null ? "—" : pct(data.share, locale, 1)} />
        <Metric label={t("idleCashInterest")} value={m(data.interest12Months)} />
        <Metric label={t("idleCashRate")} value={yieldText(data.rateOnToday, locale)} />
      </div>
      <p className="panelNote">{t("idleCashNote")}</p>
    </section>
  );
}
