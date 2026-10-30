// The unrealized result in what the price did and what the exchange rate did, under the result on the
// overview and on a holding's page: a row each, with a bar from zero scaled to the larger part.

import type { SupportedLocale } from "../i18n";
import { money, signedClass } from "../lib/format";
import { fill, type Translator } from "../lib/messages";

/** Whether an exchange-rate part is worth showing: at least a cent either way. */
export const fxShown = (fx: number | undefined): fx is number => fx !== undefined && Math.abs(fx) >= 0.005;

export function ResultSplitBars({ price, fx, currency, locale, t }: { price: number; fx: number; currency: string; locale: SupportedLocale; t: Translator }) {
  const scale = Math.max(Math.abs(price), Math.abs(fx)) || 1;
  const rows = [{ key: "price", label: t("resultSplitPrice"), value: price }, { key: "fx", label: t("resultSplitFx"), value: fx }];
  return (
    <dl className="resultSplit" aria-label={t("resultSplitLabel")}>
      {rows.map((row) => (
        <div key={row.key} className="resultSplitRow">
          <dt>{row.label}</dt>
          <dd className="resultSplitTrack" aria-hidden="true">
            <span className={`resultSplitFill ${signedClass(row.value)}`} style={{ width: `${Math.max(2, (Math.abs(row.value) / scale) * 100)}%` }} />
          </dd>
          <dd className={`resultSplitValue ${signedClass(row.value)}`}>{money(row.value, currency, locale, { signed: true })}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "FX −€12.30" under a holding's result in the holdings list. */
export function FxPart({ fx, currency, locale, t }: { fx: number | undefined; currency: string; locale: SupportedLocale; t: Translator }) {
  if (!fxShown(fx)) return null;
  return <small className="pnlFx">{fill(t("pnlFxPart"), { amount: money(fx, currency, locale, { signed: true }) })}</small>;
}
