// Today's mix over the year, on the Allocation tab: what the holdings measured for risk by holding, at today's
// weights kept each week, did over the same weeks. The line is where the mix stood at each weekly close (with a table
// view); the tiles give its return, a bad week (one in 20) in percent and in the account currency, its worst and best
// weeks and its deepest fall.

import type { HoldingMix } from "../../shared/history";
import type { SupportedLocale } from "../i18n";
import { dayLabel, money, pct } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { decimalsOf, LineChart, type Grid } from "./charts";
import { Tile } from "./risk";

export function HoldingMixPanel({ mix, currency, locale, t }: { mix: HoldingMix; currency: string; locale: SupportedLocale; t: Translator }) {
  const signed = (value: number, digits = 1) => pct(value, locale, digits, { signed: true });
  const tone = (value: number) => (value > 0 ? "positive" : value < 0 ? "negative" : undefined);
  const day = (date: string | undefined) => (date ? dayLabel(date, locale) : "");
  // As many decimals as the gridline step needs, as on the return chart.
  const percentAxis = (value: number, grid: Grid) => pct(value, locale, decimalsOf(grid.step * 100), { signed: value !== 0 });
  const fall = mix.drawdown?.peak && mix.drawdown.trough ? mix.drawdown : undefined;
  return (
    <section className="dataPanel holdingMix">
      <LineChart title={t("holdingMixTitle")} nameHeader={t("dateColumn")} valueHeader={t("returnColumn")} labels={{ table: t("tableView"), chart: t("chartView") }}
        zero flat={0.01} axis={percentAxis}
        data={mix.series.map((point) => ({ key: point.date, label: day(point.date), value: point.return, display: signed(point.return, 2), time: Date.parse(`${point.date}T00:00:00Z`) }))} />
      <div className="riskGrid four">
        <Tile label={t("holdingMixReturn")} value={signed(mix.return)} tone={tone(mix.return)} sub={fill(t("holdingMixReturnSub"), { up: String(mix.up), weeks: String(mix.counted) })} />
        {mix.badWeek < 0
          ? <Tile label={t("holdingMixBadWeek")} value={signed(mix.badWeek, mix.badWeek > -0.0005 ? 2 : 1)} tone="negative"
            sub={fill(t("holdingMixBadWeekSub"), { amount: money(-mix.badWeek * mix.value, currency, locale, { digits: 0 }), value: money(mix.value, currency, locale, { digits: 0 }), average: signed(mix.badWeeks) })} />
          // Even its worst one week in 20 rose: there is no bad week to put a figure on.
          : <Tile label={t("holdingMixBadWeek")} value={t("holdingMixBadWeekNone")} sub={fill(t("holdingMixBadWeekNoneSub"), { week: signed(mix.badWeek) })} />}
        <Tile label={t("holdingMixWorst")} value={signed(mix.worst.return)} tone={tone(mix.worst.return)}
          sub={fill(t("holdingMixWorstSub"), { date: day(mix.worst.date), best: signed(mix.best.return), bestDate: day(mix.best.date) })} />
        {fall
          ? <Tile label={t("holdingMixFall")} value={pct(fall.max, locale, 1)} tone="negative"
            sub={fill(t(fall.recovered ? "holdingMixFallMadeUp" : "holdingMixFallOpen"), { peak: day(fall.peak), trough: day(fall.trough), recovered: day(fall.recovered) })} />
          : <Tile label={t("holdingMixFall")} value={pct(0, locale, 1)} sub={t("holdingMixFallNone")} />}
      </div>
      <p className="panelNote">{t("holdingMixNote")}</p>
    </section>
  );
}
