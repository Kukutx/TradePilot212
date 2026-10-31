// A UK tax year's sales matched as HMRC matches them (same day, 30 days, section 104 pool), beside Trading 212's
// average-price figures: the gain a return would start from, and why it differs. An estimate.

import type { UkMatching } from "../../shared/history";
import { splitTerms } from "../../shared/splits";
import type { SupportedLocale } from "../i18n";
import { dayLabel, num, money, qty, signedClass } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { Metric } from "./common";

/** How an instrument's shares sold were matched, the rules that matched none left out. */
export function matchedText(row: UkMatching["byTicker"][number], locale: SupportedLocale, t: Translator): string {
  const parts: Array<[number, string]> = [[row.sameDay, t("ukMatchSameDay")], [row.thirtyDay, t("ukMatchThirtyDay")], [row.pool, t("ukMatchPool")], [row.unmatched, t("ukMatchNone")]];
  return parts.filter(([quantity]) => quantity > 1e-9).map(([quantity, label]) => fill(label, { quantity: qty(quantity, locale) })).join(" · ");
}

/** Why an instrument's UK gain cannot be trusted as it stands: no value, fills that do not add up to what is held, or not trades. */
export function rowProblems(row: UkMatching["byTicker"][number], locale: SupportedLocale, t: Translator): string[] {
  return [
    ...(row.unvalued ? [t("ukMatchingRowUnvalued")] : []),
    ...(row.reconciliation ? [fill(t("ukMatchingRowOff"), { fills: qty(row.reconciliation.fills, locale), held: qty(row.reconciliation.held, locale) })] : []),
    ...(row.notTrades ? [fill(t("ukMatchingRowNotTrades"), { count: String(row.notTrades) })] : []),
  ];
}

/** Each split of an instrument, "3-for-2 split on 10 Jun 2026", or a consolidation's "10-into-1". */
export function splitText(row: UkMatching["byTicker"][number], locale: SupportedLocale, t: Translator): string[] {
  return (row.splits ?? []).map((split) => {
    const terms = splitTerms(split.ratio) ?? (split.ratio >= 1 ? { after: split.ratio, before: 1 } : { after: 1, before: 1 / split.ratio });
    return fill(t(split.ratio >= 1 ? "ukMatchingRowSplit" : "ukMatchingRowConsolidation"), { after: num(terms.after, locale), before: num(terms.before, locale), date: dayLabel(split.on, locale) });
  });
}

export function UkMatchingPanel({ data, book, locale, t }: { data: UkMatching; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const currency = data.currency || "GBP";
  const m = (value: number, signed = false) => money(value, currency, locale, { signed });
  // Only a complete matching compares like with like: an unmatched or unvalued sale is in Trading 212's figure alone.
  const difference = data.complete ? Math.round((data.net - data.realizedProfitLoss) * 100) / 100 : 0;
  return (
    <section className="dataPanel ukMatching">
      <h2 className="panelTitle">{t("ukMatchingTitle")}</h2>
      <p className="panelNote">{t("ukMatchingIntro")}</p>
      <div className="metricGrid">
        <Metric label={t("ukMatchingNet")} value={m(data.net, true)} tone={signedClass(data.net)} />
        <Metric label={t("ukMatchingT212")} value={m(data.realizedProfitLoss, true)} />
        <Metric label={t("ukMatchingGains")} value={m(data.gains)} tone={data.gains ? "positive" : undefined} />
        <Metric label={t("ukMatchingLosses")} value={m(Math.abs(data.losses))} tone={data.losses ? "negative" : undefined} />
      </div>
      {difference !== 0 && <p className="panelNote">{fill(t(difference > 0 ? "ukMatchingMore" : "ukMatchingLess"), { amount: m(Math.abs(difference)) })}</p>}
      {data.byTicker.length > 0 && (
        <table className="chartTable ukTable">
          <thead><tr><th>{t("symbol")}</th><th>{t("ukMatchingGainColumn")}</th><th>{t("ukMatchingT212Column")}</th></tr></thead>
          <tbody>
            {data.byTicker.map((row) => {
              const label = instrumentLabel(row.ticker, book);
              const problems = rowProblems(row, locale, t);
              return (
                <tr key={row.ticker}>
                  <td title={label.ticker}>
                    <strong>{label.detail || label.name}</strong><small>{matchedText(row, locale, t)}</small>
                    {row.splits?.length ? <small>{splitText(row, locale, t).join(" · ")}</small> : null}
                    {problems.length > 0 && <small className="ukProblem">{problems.join(" · ")}</small>}
                  </td>
                  <td className={signedClass(row.gain)}>{m(row.gain, true)}</td>
                  <td>{m(row.realizedProfitLoss, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!data.complete && <div className="notice warning compactNotice">{t("ukMatchingIncomplete")}</div>}
      {data.provisional && <p className="panelNote">{t("ukMatchingProvisional")}</p>}
      <p className="panelNote">{currency === "GBP" ? t("ukMatchingNote") : fill(t("ukMatchingNotGbp"), { currency })}</p>
    </section>
  );
}
