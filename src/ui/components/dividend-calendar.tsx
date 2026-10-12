// The dividend calendar: this month and the next 11, each month's column what was paid so far (solid) and what is
// expected (hatched), with the expected payments listed soonest first. A table view gives every figure.

import { useState } from "react";
import type { IncomeSummary } from "../../shared/history";
import { localeTag, type SupportedLocale } from "../i18n";
import { dayLabel, money } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { ViewSwitch } from "./charts";

type Forward = NonNullable<IncomeSummary["forwardAnnual"]>;

/** Payments listed before "show all". */
const LISTED = 8;

/** A month as "October 2026", "Oct 2026", or "Oct" under its column, where the legend gives the years. */
const monthName = (key: string, locale: SupportedLocale, style: "long" | "short" | "column") => {
  const date = new Date(`${key}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? key : new Intl.DateTimeFormat(localeTag(locale), {
    month: style === "long" ? "long" : "short", ...(style === "column" ? {} : { year: "numeric" }), timeZone: "UTC",
  }).format(date);
};

export function DividendCalendar({ forward, today, currency, book, locale, t }: {
  forward: Forward;
  /** The summary's end (ISO): a payment expected before it this month is due and not paid yet. */
  today: string;
  currency: string;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
}) {
  const [asTable, setAsTable] = useState(false);
  const [all, setAll] = useState(false);
  const m = (value: number) => money(value, currency, locale);
  const { calendar, upcoming } = forward;
  const top = Math.max(...calendar.map((month) => month.paid + month.expected), 0);
  const largest = calendar.reduce<(typeof calendar)[number] | undefined>((best, month) => (month.paid + month.expected > (best ? best.paid + best.expected : 0) ? month : best), undefined);
  const paidAny = calendar.some((month) => month.paid > 0);
  const expected = upcoming.reduce((sum, payment) => sum + payment.amount, 0);
  const describe = (month: Forward["calendar"][number]) => {
    const name = monthName(month.month, locale, "long");
    if (month.paid > 0) return fill(t("calendarMonthPaid"), { month: name, paid: m(month.paid), expected: m(month.expected) });
    return fill(t(month.expected > 0 ? "calendarMonth" : "calendarMonthNone"), { month: name, expected: m(month.expected) });
  };
  const day = today.slice(0, 10);
  const shown = all ? upcoming : upcoming.slice(0, LISTED);
  const title = t("calendarTitle");
  if (top === 0) {
    return (
      <figure className="chartFigure">
        <figcaption><span>{title}</span></figcaption>
        <div className="emptyState compact">{t("calendarEmpty")}</div>
      </figure>
    );
  }
  return (
    <>
      <figure className="chartFigure dividendCalendar">
        <figcaption><span>{title}</span><ViewSwitch asTable={asTable} labels={{ table: t("tableView"), chart: t("chartView") }} onToggle={() => setAsTable(!asTable)} /></figcaption>
        {asTable ? (
          <table className="chartTable">
            <thead><tr><th>{t("monthColumn")}</th>{paidAny && <th>{t("calendarPaid")}</th>}<th>{t("calendarExpected")}</th></tr></thead>
            <tbody>{calendar.map((month) => (
              <tr key={month.month}><td>{monthName(month.month, locale, "long")}</td>{paidAny && <td>{m(month.paid)}</td>}<td>{m(month.expected)}</td></tr>
            ))}</tbody>
          </table>
        ) : (
          <div className="columnChart" role="img" aria-label={`${title}: ${calendar.map(describe).join("; ")}`}>
            {calendar.map((month) => {
              const sum = month.paid + month.expected;
              return (
                <div className="column" key={month.month} title={describe(month)}>
                  <span className="columnValue">{month === largest ? m(sum) : ""}</span>
                  {sum > 0 && (
                    <span className="calendarStack" style={{ height: `${Math.round(Math.max(2, (sum / top) * 100) * 10) / 10}%` }}>
                      {month.expected > 0 && <span className="calendarExpected" style={{ flexGrow: month.expected }} />}
                      {month.paid > 0 && <span className="calendarPaid" style={{ flexGrow: month.paid }} />}
                    </span>
                  )}
                  <span className="columnLabel">{monthName(month.month, locale, "column")}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="calendarLegend">
          <span className="calendarRange">{fill(t("calendarRange"), { from: monthName(calendar[0]!.month, locale, "short"), to: monthName(calendar[calendar.length - 1]!.month, locale, "short") })}</span>
          {paidAny && <span><i className="calendarPaid" aria-hidden="true" />{t("calendarPaidThisMonth")}</span>}
          <span><i className="calendarExpected" aria-hidden="true" />{fill(t("calendarExpectedTotal"), { amount: m(expected) })}</span>
        </p>
      </figure>
      {upcoming.length > 0 && (
        <div className="upcomingDividends">
          <h3>{t("upcomingDividends")}</h3>
          <ul className="historyList">
            {shown.map((payment) => {
              const label = instrumentLabel(payment.ticker, book);
              const due = payment.on < day;
              return (
                <li key={`${payment.ticker}-${payment.on}`}>
                  <div>
                    <strong title={payment.ticker}>{label.name}</strong>
                    <small>{label.detail ? `${label.detail} · ` : ""}{fill(t(due ? "dividendDue" : "dividendAbout"), { date: dayLabel(payment.on, locale, { year: payment.on.slice(0, 4) !== day.slice(0, 4) }) })}</small>
                  </div>
                  <strong className="historyAmount expectedAmount">{fill(t("aboutAmount"), { amount: m(payment.amount) })}</strong>
                </li>
              );
            })}
          </ul>
          {upcoming.length > LISTED && (
            <button type="button" className="linkButton" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? t("showFewer") : fill(t("showAllCount"), { count: String(upcoming.length) })}
            </button>
          )}
          <p className="panelNote">{t("calendarNote")}</p>
        </div>
      )}
    </>
  );
}
