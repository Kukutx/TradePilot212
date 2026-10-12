// Equal-risk weights, on the Allocation tab: for each holding measured for risk by holding, the weight at which each
// brings the same share of their risk, beside its weight today. Each row is a dumbbell, a ring at today's weight and a
// dot at the equal-risk one, furthest from it first; the table view lists them all. With order tools, a button drafts
// the rebalance to them as one basket to review; nothing is sent from here.

import { useState } from "react";
import type { AllocationAnalysis, HoldingRiskRow } from "../../shared/history";
import { equalRiskTargets, MAX_PARITY_TARGETS, PARITY_MIN_VOLATILITY, type EqualRiskPlan } from "../../shared/holding-risk";
import { localeTag, type SupportedLocale } from "../i18n";
import { money, pct } from "../lib/format";
import { instrumentLabel, instrumentText, type InstrumentBook } from "../lib/instruments";
import { fill, sentences, type Translator } from "../lib/messages";
import { ViewSwitch } from "./charts";
import { Tile } from "./risk";

/** At most this many dumbbells: those furthest from their equal-risk weight. */
const MAX_ROWS = 12;

export type { EqualRiskPlan };

type Parity = HoldingRiskRow & { parity: number };

export function HoldingParityPanel({ data, book, locale, t, onPlan, onUseAsTargets, busy }: {
  data: Pick<AllocationAnalysis, "risk" | "holdings" | "totalValue" | "cash" | "availableCash" | "accountCurrency">;
  book?: InstrumentBook; locale: SupportedLocale; t: Translator; onPlan?: (plan: EqualRiskPlan) => void;
  /** Opens the target weights filled with these. */
  onUseAsTargets?: () => void; busy?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  const { risk } = data;
  if (!risk || risk.parityVolatility === undefined || !risk.rows.every((row): row is Parity => row.parity !== undefined)) return null;
  const rows = [...risk.rows as Parity[]].sort((a, b) => Math.abs(b.parity - b.weight) - Math.abs(a.parity - a.weight) || b.weight - a.weight);
  const plan = equalRiskTargets(data);
  const values = new Map(data.holdings.map((holding) => [holding.ticker, holding.value]));
  const measured = risk.rows.reduce((sum, row) => sum + (values.get(row.ticker) ?? 0), 0);
  // What moves: the value sold, which buys the same again; with the plan offered, what it sells (fewer holdings when
  // a basket cannot take them all).
  const turnover = onPlan && plan ? plan.sold : rows.reduce((sum, row) => sum + Math.max(0, row.weight - row.parity), 0);
  const share = (value: number) => pct(value, locale, value > 0 && value < 0.1 ? 1 : 0);
  const points = new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const furthest = rows[0]!;
  const furthestLabel = instrumentLabel(furthest.ticker, book);
  const shown = rows.slice(0, MAX_ROWS);
  const top = Math.max(0.01, ...shown.map((row) => Math.max(row.weight, row.parity)));
  const at = (value: number) => `${(value / top) * 100}%`;
  const rowTitle = (row: Parity) => fill(t("holdingParityRowTitle"), {
    name: instrumentText(row.ticker, book), parity: share(row.parity), weight: share(row.weight), volatility: pct(row.volatility, locale, 0),
  });
  const currency = data.accountCurrency;
  return (
    <section className="dataPanel holdingParity">
      <figure className="chartFigure">
        <figcaption><span>{t("holdingParityTitle")}</span><ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} /></figcaption>
        <div className="riskGrid">
          <Tile label={t("holdingParityVolatility")} value={pct(risk.parityVolatility, locale, 1)} sub={fill(t("holdingParityVolatilitySub"), { now: pct(risk.volatility, locale, 1) })} />
          <Tile label={t("holdingParityMove")} value={money(turnover * measured, currency, locale, { digits: 0 })}
            sub={fill(t("holdingParityMoveSub"), { share: share(turnover), value: money(measured, currency, locale, { digits: 0 }) })} />
          <Tile label={t("holdingParityFurthest")} value={`${furthestLabel.detail || furthestLabel.name} ${share(furthest.weight)} → ${share(furthest.parity)}`}
            sub={furthestLabel.detail ? furthestLabel.name : fill(t("holdingParityFurthestSub"), { points: points.format((furthest.parity - furthest.weight) * 100) })} />
        </div>
        {asTable ? (
          <table className="chartTable parityTable">
            <thead><tr><th>{t("symbol")}</th><th>{t("holdingParityNow")}</th><th>{t("holdingParityEqual")}</th><th>{t("holdingParityChange")}</th><th>{t("holdingRiskVolatilityColumn")}</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.ticker}><td title={row.ticker}>{instrumentText(row.ticker, book)}</td><td>{share(row.weight)}</td><td>{share(row.parity)}</td><td>{points.format((row.parity - row.weight) * 100)}</td><td>{pct(row.volatility, locale, 0)}</td></tr>
            ))}</tbody>
          </table>
        ) : (
          <>
            <div className="riskShareLegend" aria-hidden="true">
              <span><i className="parityMark now" />{t("holdingParityNow")}</span>
              <span><i className="parityMark equal" />{t("holdingParityEqual")}</span>
            </div>
            <ul className="parityList">
              {shown.map((row) => {
                const label = instrumentLabel(row.ticker, book);
                const low = Math.min(row.weight, row.parity);
                const high = Math.max(row.weight, row.parity);
                return (
                  <li key={row.ticker} title={rowTitle(row)}>
                    <span className="barLabel" aria-hidden="true"><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</span>
                    <span className="parityTrack" aria-hidden="true">
                      <span className="paritySpan" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
                      <span className="parityMark now" style={{ left: at(row.weight) }} />
                      <span className="parityMark equal" style={{ left: at(row.parity) }} />
                    </span>
                    <span className="riskShareValues" aria-hidden="true"><strong>{share(row.parity)}</strong><small>{share(row.weight)}</small></span>
                    <span className="visuallyHidden">{rowTitle(row)}</span>
                  </li>
                );
              })}
            </ul>
            {rows.length > shown.length && <p className="panelNote">{fill(t("holdingParityMore"), { count: String(rows.length - shown.length) })}</p>}
          </>
        )}
        {((onPlan && plan) || onUseAsTargets) && (
          <div className="parityPlan">
            {onPlan && plan && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => onPlan(plan)}>{t("holdingParityPlan")}</button>}
            {onUseAsTargets && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={onUseAsTargets}>{t("targetsUseParity")}</button>}
            {onPlan && plan && <span>{sentences(locale, [t("holdingParityPlanNote"), plan.partial && fill(t("holdingParityPartial"), { count: String(MAX_PARITY_TARGETS) })])}</span>}
          </div>
        )}
        <p className="panelNote">{fill(t("holdingParityNote"), { floor: pct(PARITY_MIN_VOLATILITY, locale, 0) })}</p>
      </figure>
    </section>
  );
}
