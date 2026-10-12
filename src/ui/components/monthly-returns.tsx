// Each calendar month's time-weighted return in a year-by-month grid, latest year first, with the year's own return at
// the end of its row. A cell is tinted green or red by its size against the scale's end, and its value is written in it,
// so the colour is never the only way to read it.

import type { CSSProperties } from "react";
import type { CalendarReturn } from "../../shared/history";
import type { SupportedLocale } from "../i18n";
import { localeTag } from "../i18n";
import { dayLabel, pct } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { scaleEnd, strength } from "./holdings-map";

/** The colour scale's end, either way: the smallest of these that covers four in five months. */
const MONTH_STEPS = [0.02, 0.05, 0.1, 0.2];
const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));

export function MonthlyReturns({ months, years, locale, t }: { months: CalendarReturn[]; years: CalendarReturn[]; locale: SupportedLocale; t: Translator }) {
  const byPeriod = new Map([...months, ...years].map((item) => [item.period, item]));
  const rows = [...new Set(months.map((item) => item.period.slice(0, 4)))].sort().reverse();
  const end = scaleEnd(months.map((item) => item.return), MONTH_STEPS);
  const monthName = new Intl.DateTimeFormat(localeTag(locale), { month: "short", timeZone: "UTC" });
  const longMonth = new Intl.DateTimeFormat(localeTag(locale), { month: "long", year: "numeric", timeZone: "UTC" });
  const nameOf = (period: string) => (period.length === 4 ? period : longMonth.format(new Date(`${period}-01T00:00:00Z`)));
  const describe = (item: CalendarReturn) => fill(t(item.extended ? "monthlyCellExtended" : item.partial ? "monthlyCellPartial" : "monthlyCell"), {
    period: nameOf(item.period), value: pct(item.return, locale, 2, { signed: true }), from: dayLabel(item.from, locale), to: dayLabel(item.to, locale),
  });
  /** The tint and the text of one period's cell, or undefined without a return for it. */
  const shade = (period: string) => {
    const item = byPeriod.get(period);
    if (!item) return undefined;
    const tone = item.return > 0 ? " up" : item.return < 0 ? " down" : "";
    return {
      item,
      // Dashed: not exactly the month, either only part of it or reaching back before it.
      className: `${tone}${item.partial || item.extended ? " partial" : ""}`,
      style: { "--tile-strength": strength(item.return, end).toFixed(3) } as CSSProperties,
      text: pct(item.return, locale, 1, { signed: true }),
    };
  };
  const cell = (period: string, className: string) => {
    const shaded = shade(period);
    if (!shaded) return <td key={period} className={`${className} empty`}><span className="visuallyHidden">{t("monthlyNone")}</span></td>;
    return (
      <td key={period} className={`${className}${shaded.className}`} style={shaded.style} title={describe(shaded.item)}>
        <span aria-hidden="true">{shaded.text}</span>
        <span className="visuallyHidden">{describe(shaded.item)}</span>
      </td>
    );
  };
  return (
    <figure className="chartFigure monthlyReturns">
      <figcaption><span>{t("monthlyTitle")}</span></figcaption>
      <p className="mapLegend">
        <span className="visuallyHidden">{fill(t("monthlyLegend"), { end: pct(end, locale, 0) })}</span>
        <span className="mapScaleEnd" aria-hidden="true">{pct(-end, locale, 0)}</span>
        <span className="mapScale" aria-hidden="true" />
        <span className="mapScaleEnd" aria-hidden="true">{pct(end, locale, 0, { signed: true })}</span>
        {[...months, ...years].some((item) => item.partial || item.extended) && <span className="monthlyPartialKey" aria-hidden="true"><i />{t("monthlyPartialKey")}</span>}
      </p>
      <div className="monthlyWrap">
        <table className="monthlyTable">
          <thead>
            <tr>
              <th scope="col"><span className="visuallyHidden">{t("monthlyYearColumn")}</span></th>
              {MONTHS.map((month) => <th key={month} scope="col">{monthName.format(new Date(`2026-${month}-01T00:00:00Z`))}</th>)}
              <th scope="col" className="monthlyTotal">{t("monthlyYear")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((year) => (
              <tr key={year}>
                <th scope="row">{year}</th>
                {MONTHS.map((month) => cell(`${year}-${month}`, "monthlyCell"))}
                {cell(year, "monthlyCell monthlyTotal")}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Narrow: each year as four months a row, its own return beside the year. */}
      <div className="monthlyCompact">
        {rows.map((year) => {
          const total = shade(year);
          return (
            <section key={year} className="monthlyYear">
              <h3>
                {year}
                {total && <span className={`monthlyYearTotal${total.className}`} style={total.style} title={describe(total.item)}><span aria-hidden="true">{total.text}</span><span className="visuallyHidden">{describe(total.item)}</span></span>}
              </h3>
              <ol className="monthlyGrid">
                {MONTHS.map((month) => {
                  const shaded = shade(`${year}-${month}`);
                  const name = monthName.format(new Date(`2026-${month}-01T00:00:00Z`));
                  return (
                    <li key={month} className={`monthlyCell${shaded ? shaded.className : " empty"}`} style={shaded?.style} title={shaded ? describe(shaded.item) : undefined}>
                      <small aria-hidden="true">{name}</small>
                      <span aria-hidden="true">{shaded ? shaded.text : "–"}</span>
                      <span className="visuallyHidden">{shaded ? describe(shaded.item) : fill(t("monthlyEmpty"), { month: name })}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
      <p className="panelNote">{t("monthlyNote")}</p>
    </figure>
  );
}
