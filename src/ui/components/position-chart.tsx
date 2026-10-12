// A holding's value on each day of its closes, beside a dashed line of what it would be had the price not moved since
// the first close: the gap between them is what the price did for the position, whatever was bought or sold.

import type { PositionHistory } from "../../shared/position-history";
import type { SupportedLocale } from "../i18n";
import { dayLabel, money, qty, signedClass } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { axisMoney, LineChart, type Grid } from "./charts";

export function PositionChart({ history, currency, locale, t }: { history: PositionHistory; currency: string; locale: SupportedLocale; t: Translator }) {
  const m = (value: number) => money(value, currency, locale);
  const first = history.days[0]!;
  const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
  return (
    <>
      <LineChart title={t("positionTitle")} nameHeader={t("dateColumn")} valueHeader={t("positionChartValue")} labels={{ table: t("tableView"), chart: t("chartView") }}
        axis={(value: number, grid: Grid) => axisMoney(value, grid, currency, locale)}
        compare={{ name: t("positionBase"), mainName: t("positionChartValue"), points: history.days.map((day) => ({ value: day.base, display: m(day.base) })) }}
        data={history.days.map((day) => ({ key: day.date, label: dayLabel(day.date, locale), value: day.value, display: m(day.value), time: time(day.date) }))} />
      <p className="panelNote">
        <strong className={signedClass(history.gain)}>{money(history.gain, currency, locale, { signed: true })}</strong>
        {" · "}{fill(t(history.startShares > 0 ? "positionNote" : "positionNoteBought"), { date: dayLabel(first.date, locale), shares: qty(history.startShares, locale) })}
      </p>
    </>
  );
}
