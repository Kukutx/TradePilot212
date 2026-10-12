// The day's move, as the dashboard and an instrument's page show it: since the last close before the trading day
// of Trading 212's price, for the holdings together and for each one.

import type { DayMissing, DayMove, PortfolioToday } from "../../shared/today";
import type { MessageKey, SupportedLocale } from "../i18n";
import { dayLabel, money, num, pct, signedClass } from "../lib/format";
import { fill, type Translator } from "../lib/messages";

/** The day's moves as the dashboard holds them: being read, read, or failed (the overview says so; the column goes). */
export interface TodayState { data?: PortfolioToday; loading: boolean; failed?: boolean }

const DAY_MISSING: Record<DayMissing, MessageKey> = {
  provider: "todayMissingProvider",
  plan: "todayMissingPlan",
  symbol: "todayMissingSymbol",
  data: "todayMissingData",
  unit: "todayMissingUnit",
  sample: "todayMissingSample",
  later: "todayMissingLater",
  lag: "todayMissingLag",
  fx: "todayMissingFx",
};

export const dayMissingText = (move: DayMove, t: Translator) => t(DAY_MISSING[move.missing ?? "data"]);

/** "Today's move", or the session's day when the latest one is an earlier one (before the open, at night, over a weekend). */
const sessionLabel = (day: string | undefined, timestamp: string, locale: SupportedLocale, t: Translator) =>
  !day || day === timestamp.slice(0, 10) ? t("todayLabel") : fill(t("todayLastSession"), { day: dayLabel(day, locale, { year: false, weekday: true }) });

/** The close a move is measured from, written out. */
const sinceText = (move: DayMove, currency: string, locale: SupportedLocale, t: Translator) => {
  const close = move.previousClose;
  return close ? fill(t("todaySince"), { date: dayLabel(close.date, locale, { year: false, weekday: true }), price: money(close.close, move.currencyCode ?? currency, locale) }) : "";
};

/** The holdings' move on the day, in the account currency, named "Today's move", or by its day when the latest session is an earlier one. */
export function DayTotal({ today, currency, locale, t }: { today: TodayState; currency: string; locale: SupportedLocale; t: Translator }) {
  const data = today.data;
  if (!data) {
    if (today.loading) return <div className="dayTotal loading" aria-busy="true"><span>{t("todayLoading")}</span></div>;
    return today.failed ? <div className="dayTotal"><span>{t("todayFailed")}</span></div> : null;
  }
  const days = [...new Set(data.moves.map((move) => move.day))].sort();
  const label = sessionLabel(days[days.length - 1], data.timestamp, locale, t);
  const total = data.total;
  if (!total) {
    const first = data.moves.find((move) => move.missing);
    return first ? <div className="dayTotal" title={first.problem}><span>{fill(t("todayNone"), { reason: dayMissingText(first, t) })}</span></div> : null;
  }
  const notes = [
    ...(days.length > 1 ? [t("todaySessions")] : []),
    ...(data.moves.some((move) => move.bought || move.sold) ? [t("todayTraded")] : []),
    ...(data.fillsProblem ? [t("todayFills")] : []),
    ...data.moves.filter((move) => move.profitLoss === undefined).map((move) => `${move.shortName ?? move.ticker}: ${dayMissingText(move, t)}.`),
    t("todayRates"),
  ];
  return (
    <div className="dayTotal" title={notes.join(" ")}>
      <b className={signedClass(total.profitLoss)}>
        {money(total.profitLoss, currency, locale, { signed: true })}
        {total.change !== undefined && ` (${pct(total.change, locale, 2, { signed: true })})`}
      </b>
      <span>
        {label}
        {total.counted < total.of && ` · ${fill(t("todayPartial"), { counted: num(total.counted, locale), of: num(total.of, locale) })}`}
        <span className="visuallyHidden"> {notes.join(" ")}</span>
      </span>
    </div>
  );
}

/** One holding's move on the day: the change since its previous close and, under it, what it made or lost. */
export function DayCell({ move, loading, currency, locale, t, layout = "stack" }: {
  move: DayMove | undefined;
  loading: boolean;
  currency: string;
  locale: SupportedLocale;
  t: Translator;
  /** The change over the amount (the Day column), side by side (under the price), or side by side with the close and any reason written out (the phone card). */
  layout?: "stack" | "row" | "card";
}) {
  const inline = layout !== "stack";
  if (!move) return <span className="mutedInline" {...(loading ? { "aria-busy": "true" } : {})}>{loading ? "…" : "—"}</span>;
  const card = layout === "card";
  if (move.change === undefined) return <span className="mutedInline dayMissing" title={move.problem}>{card ? dayMissingText(move, t) : <>—<span className="visuallyHidden"> {dayMissingText(move, t)}</span></>}</span>;
  const since = sinceText(move, currency, locale, t);
  const title = [since, move.bought || move.sold ? t("todayTraded") : "", move.problem ?? ""].filter(Boolean).join(" ");
  // The price's change and the amount each take their own sign: shares traded on the day can make them differ.
  return (
    <span className={`dayCell${inline ? " inline" : ""}`} title={title}>
      <strong className={signedClass(move.change)}>{pct(move.change, locale, 2, { signed: true })}</strong>
      {move.profitLoss !== undefined && <small className={signedClass(move.profitLoss)}>{money(move.profitLoss, currency, locale, { signed: true })}</small>}
      {card ? since && <small className="daySince">{since}</small> : since && <span className="visuallyHidden"> {since}</span>}
    </span>
  );
}

/**
 * One instrument's day on its page, under its value or price: what the holding made or lost and the price's change,
 * or the change alone for one not held, with the close it is measured from.
 */
export function DayLine({ move, timestamp, currency, locale, t }: { move: DayMove; timestamp: string; currency: string; locale: SupportedLocale; t: Translator }) {
  if (move.change === undefined) {
    return <div className="dayTotal" title={move.problem}><span>{fill(t("todayNone"), { reason: dayMissingText(move, t) })}</span></div>;
  }
  const since = sinceText(move, currency, locale, t);
  const notes = [move.bought || move.sold ? t("todayTraded") : "", move.profitLoss !== undefined ? t("todayRates") : ""].filter(Boolean).join(" ");
  return (
    <div className="dayTotal dayLine" {...(notes ? { title: notes } : {})}>
      <b>
        {move.profitLoss !== undefined && <span className={signedClass(move.profitLoss)}>{money(move.profitLoss, currency, locale, { signed: true })} </span>}
        <span className={signedClass(move.change)}>{move.profitLoss !== undefined ? `(${pct(move.change, locale, 2, { signed: true })})` : pct(move.change, locale, 2, { signed: true })}</span>
      </b>
      <span>{sessionLabel(move.day, timestamp, locale, t)}{notes && <span className="visuallyHidden"> {notes}</span>}</span>
      {since && <small className="daySince">{since}</small>}
    </div>
  );
}
