// The investment goal on the Performance tab: how far the account is towards an amount by a date, and a range of
// where it may be by then at the return and volatility assumed, drawn as a band around a middle line with the target
// across it. The form redraws the range as it is typed; saving keeps the goal in TradePilot.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DEFAULT_GOAL_INFLATION, DEFAULT_GOAL_RETURN, DEFAULT_GOAL_VOLATILITY, MAX_GOAL_YEARS, projectGoal, type GoalInputs, type GoalProjection, type InvestmentGoal } from "../../shared/goal";
import type { SupportedLocale } from "../i18n";
import { dayLabel, money, num, parseAmount, pct, signedClass } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { axisMoney, niceTicks, ViewSwitch } from "./charts";
import { Field, Metric } from "./common";
import { Select } from "./select";
import { Slider } from "./slider";

/** The account's own return and volatility, from the time-weighted return over the days read (shared/risk.ts). */
export interface MeasuredGoalRisk { from: string; to: string; volatility: number; annualized?: number }

/** The slider's end for the amount added each month: a round amount at least three times the one set, and 1,000. */
export function monthlyScale(monthly: number): { max: number; step: number } {
  const want = Math.max(1_000, monthly * 3);
  const magnitude = 10 ** Math.floor(Math.log10(want));
  const max = Math.ceil(want / magnitude) * magnitude;
  return { max, step: max <= 2_000 ? 10 : max <= 10_000 ? 50 : 100 };
}

/** The sliders' ends and steps for the percentages, in percent; a value typed outside them sits at that end. */
export const GOAL_SLIDERS = {
  expectedReturn: { min: -5, max: 15, step: 0.5 },
  volatility: { min: 0, max: 40, step: 0.5 },
  inflation: { min: 0, max: 10, step: 0.1 },
} as const;

export interface GoalRequest { target: number; by: string; monthly: number; expectedReturn: number; volatility: number; inflation: number; name?: string }

const HEIGHT = 200;
const PAD = { top: 14, right: 14, bottom: 26, left: 64 };

/** The last day of a month, YYYY-MM-DD. */
export function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** A starting goal from the value now: about twice it, rounded, in ten years, adding a round amount a month. */
export function defaultGoal(value: number | undefined, now = new Date()): GoalInputs {
  const base = Math.max(1_000, (value ?? 0) * 2);
  const magnitude = 10 ** Math.floor(Math.log10(base));
  return {
    target: Math.ceil(base / magnitude) * magnitude,
    by: monthEnd(now.getUTCFullYear() + 10, now.getUTCMonth() + 1),
    monthly: 200,
    expectedReturn: DEFAULT_GOAL_RETURN,
    volatility: DEFAULT_GOAL_VOLATILITY,
    inflation: DEFAULT_GOAL_INFLATION,
  };
}

/** The fan: a band from the low to the high line, the middle line, what is added without growth, and the target. */
export function GoalChart({ projection, target, currency, locale, t }: {
  projection: GoalProjection; target: number; currency: string; locale: SupportedLocale; t: Translator;
}) {
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width))); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [asTable]);
  const points = projection.points;
  const m = (value: number) => money(value, currency, locale, { digits: 0 });
  const day = (date: string) => dayLabel(date, locale);
  const labels = { table: t("tableView"), chart: t("chartView") };
  const title = t("goalChartTitle");
  const values = [...points.flatMap((point) => [point.low, point.high, point.added]), target, 0];
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < 1e-9) high = low + 1;
  const grid = niceTicks(low, high);
  high += (high - low) * 0.06;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (points.length < 2 ? 0.5 : index / (points.length - 1)) * plotWidth;
  const y = (value: number) => PAD.top + (1 - (value - low) / (high - low)) * plotHeight;
  const path = (pick: (index: number) => number) => points.map((_, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(pick(index)).toFixed(1)}`).join("");
  const band = `${path((index) => points[index]!.high)}${points.map((_, index) => {
    const back = points.length - 1 - index;
    return `L${x(back).toFixed(1)},${y(points[back]!.low).toFixed(1)}`;
  }).join("")}Z`;
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left - PAD.left) / Math.max(1, rect.width - PAD.left - PAD.right);
    setActive(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  };
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = points.length - 1;
    setActive((current) => event.key === "Home" ? 0 : event.key === "End" ? last : Math.min(last, Math.max(0, (current ?? last) + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  const point = active === null ? undefined : points[active];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const targetY = y(target);
  return (
    <figure className="chartFigure goalChart">
      <figcaption><span>{title}</span><ViewSwitch asTable={asTable} labels={labels} onToggle={() => setAsTable(!asTable)} /></figcaption>
      {asTable ? (
        <table className="chartTable">
          <thead><tr><th>{t("goalDate")}</th><th>{t("goalLow")}</th><th>{t("goalMiddle")}</th><th>{t("goalHigh")}</th><th>{t("goalAddedLine")}</th></tr></thead>
          <tbody>{points.filter((_, index) => index === 0 || index === points.length - 1 || index % 12 === 0).map((item) => (
            <tr key={item.date}><td>{day(item.date)}</td><td>{m(item.low)}</td><td>{m(item.mid)}</td><td>{m(item.high)}</td><td>{m(item.added)}</td></tr>
          ))}</tbody>
        </table>
      ) : (
        <div className="lineChart" ref={box}>
          <svg width={width} height={HEIGHT} role="img" tabIndex={0}
            aria-label={fill(t("goalChartLabel"), { date: day(last.date), low: m(last.low), high: m(last.high), mid: m(last.mid), target: m(target) })}
            onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} onKeyDown={step} onBlur={() => setActive(null)}>
            {grid.ticks.map((tick) => (
              <g key={tick} className="lineGrid">
                <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{axisMoney(tick, grid, currency, locale)}</text>
              </g>
            ))}
            <path className="goalBand" d={band} />
            <path className="lineCompare" d={path((index) => points[index]!.added)} />
            <path className="linePath" d={path((index) => points[index]!.mid)} />
            <line className="goalTarget" x1={PAD.left} x2={width - PAD.right} y1={targetY} y2={targetY} />
            <text className="goalTargetLabel" x={width - PAD.right} y={targetY - 6} textAnchor="end">{fill(t("goalTargetLine"), { amount: m(target) })}</text>
            <text className="lineAxis" x={x(0)} y={HEIGHT - 6} textAnchor="start">{day(first.date)}</text>
            {points.length > 1 && <text className="lineAxis" x={x(points.length - 1)} y={HEIGHT - 6} textAnchor="end">{day(last.date)}</text>}
            {point && active !== null && (
              <g className="lineFocus">
                <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotHeight} />
                <circle cx={x(active)} cy={y(point.mid)} r={5} />
              </g>
            )}
          </svg>
          {point && active !== null && (
            <div className="lineTip withCompare goalTip" role="status" style={{ left: `${Math.min(width - 236, Math.max(0, x(active) - 118))}px` }}>
              <span>{day(point.date)}</span>
              <span className="tipSeries"><i className="swatch main" aria-hidden="true" />{t("goalMiddle")}<strong>{m(point.mid)}</strong></span>
              <span className="tipSeries"><i className="swatch band" aria-hidden="true" />{t("goalRange")}<strong>{m(point.low)} – {m(point.high)}</strong></span>
              <span className="tipSeries"><i className="swatch compare" aria-hidden="true" />{t("goalAddedLine")}<strong>{m(point.added)}</strong></span>
            </div>
          )}
        </div>
      )}
      <ul className="priceLegend lineLegend">
        <li><svg className="legendLine" width="20" height="4" aria-hidden="true"><line className="legendMain" x1="0" x2="20" y1="2" y2="2" /></svg>{t("goalMiddle")}</li>
        <li><span className="legendBand" aria-hidden="true" />{t("goalRange")}</li>
        <li><svg className="legendLine" width="20" height="4" aria-hidden="true"><line className="legendCompare" x1="0" x2="20" y1="2" y2="2" /></svg>{t("goalAddedLine")}</li>
        <li><svg className="legendLine" width="20" height="4" aria-hidden="true"><line className="goalTarget" x1="0" x2="20" y1="2" y2="2" /></svg>{t("goalTarget")}</li>
      </ul>
    </figure>
  );
}

const percentText = (fraction: number, locale: SupportedLocale) => num(Math.round(fraction * 1000) / 10, locale, 1);

export function GoalForm({ goal, value, measured, currency, locale, t, busy, onSave, onCancel, onDraft }: {
  goal?: InvestmentGoal; value?: number; measured?: MeasuredGoalRisk; currency: string; locale: SupportedLocale; t: Translator; busy: boolean;
  onSave: (request: GoalRequest) => void; onCancel: () => void;
  /** The inputs as typed, when they make a goal, for the chart beside the form. */
  onDraft: (inputs: GoalInputs | undefined) => void;
}) {
  const now = new Date();
  const start = goal ?? defaultGoal(value, now);
  const [targetText, setTargetText] = useState(String(start.target));
  const [year, setYear] = useState(start.by.slice(0, 4));
  const [month, setMonth] = useState(String(Number(start.by.slice(5, 7))));
  const [monthlyText, setMonthlyText] = useState(String(start.monthly));
  const [returnText, setReturnText] = useState(percentText(start.expectedReturn, locale));
  const [volatilityText, setVolatilityText] = useState(percentText(start.volatility, locale));
  const [inflationText, setInflationText] = useState(percentText(start.inflation ?? 0, locale));
  const [name, setName] = useState(goal?.name ?? "");
  const [touched, setTouched] = useState(false);
  // The monthly slider keeps its scale while the form is open, so the thumb does not jump under the finger.
  const [monthlyRange] = useState(() => monthlyScale(start.monthly));
  const [opened] = useState(() => ({
    target: parseAmount(String(start.target)), by: monthEnd(Number(start.by.slice(0, 4)), Number(start.by.slice(5, 7))), monthly: parseAmount(String(start.monthly)),
    expectedReturn: parseAmount(percentText(start.expectedReturn, locale)) / 100, volatility: parseAmount(percentText(start.volatility, locale)) / 100,
    inflation: parseAmount(percentText(start.inflation ?? 0, locale)) / 100, name: (goal?.name ?? "").trim(),
  }));
  const target = parseAmount(targetText);
  const monthly = monthlyText.trim() ? parseAmount(monthlyText) : 0;
  const expectedReturn = parseAmount(returnText) / 100;
  const volatility = parseAmount(volatilityText) / 100;
  const inflation = inflationText.trim() ? parseAmount(inflationText) / 100 : 0;
  const by = monthEnd(Number(year), Number(month));
  const errors = {
    target: !(target > 0) ? t("goalTargetRequired") : undefined,
    by: by <= now.toISOString().slice(0, 10) ? t("goalDateFuture") : undefined,
    monthly: !(monthly >= 0) ? t("goalMonthlyRange") : undefined,
    expectedReturn: !(expectedReturn >= -0.5 && expectedReturn <= 0.3) ? fill(t("goalPercentRange"), { low: "-50", high: "30" }) : undefined,
    volatility: !(volatility >= 0 && volatility <= 1) ? fill(t("goalPercentRange"), { low: "0", high: "100" }) : undefined,
    inflation: !(inflation >= 0 && inflation <= 0.2) ? fill(t("goalPercentRange"), { low: "0", high: "20" }) : undefined,
  };
  const valid = Object.values(errors).every((error) => !error);
  useEffect(() => {
    onDraft(valid ? { target, by, monthly, expectedReturn, volatility, inflation } : undefined);
  }, [valid, target, by, monthly, expectedReturn, volatility, inflation]);
  const years = Array.from({ length: MAX_GOAL_YEARS + 1 }, (_, index) => String(now.getUTCFullYear() + index));
  const months = Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, index, 1))) }));
  const show = (error: string | undefined) => (touched ? error : undefined);
  const percentSlider = (key: keyof typeof GOAL_SLIDERS, text: string, setText: (text: string) => void) => (labelId: string) => {
    const range = GOAL_SLIDERS[key];
    const typed = parseAmount(text);
    return <Slider {...range} value={Number.isFinite(typed) ? typed : range.min} labelledBy={labelId} valueText={`${num(Number.isFinite(typed) ? typed : range.min, locale, 1)}%`}
      onChange={(next) => setText(num(next, locale, 1))} />;
  };
  // A saved goal edited: the save button says there is something to save. It is measured against what the form
  // showed when it opened (the month's last day, percentages to one decimal), not the goal as stored.
  const changed = Boolean(goal && valid && (opened.target !== target || opened.by !== by || opened.monthly !== monthly || Math.abs(opened.expectedReturn - expectedReturn) > 1e-9
    || Math.abs(opened.volatility - volatility) > 1e-9 || Math.abs(opened.inflation - inflation) > 1e-9 || opened.name !== name.trim()));
  // The account's own figures, from a year of recorded values or more; the return is kept inside what a goal takes.
  const useMeasured = measured?.annualized === undefined ? undefined : () => {
    setReturnText(percentText(Math.min(0.3, Math.max(-0.5, measured.annualized!)), locale));
    setVolatilityText(percentText(Math.min(1, measured.volatility), locale));
  };
  const submit = () => {
    setTouched(true);
    if (!valid || busy) return;
    // An empty name is sent too: it clears the one saved.
    onSave({ target, by, monthly, expectedReturn, volatility, inflation, name: name.trim() });
  };
  return (
    <form className="alertForm goalForm" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="formGrid">
        <Field label={t("goalTarget")} unit={currency} error={show(errors.target)}>
          {(props) => <input {...props} data-focus-id="goal-target" inputMode="decimal" autoComplete="off" value={targetText} onChange={(event) => setTargetText(event.target.value)} />}
        </Field>
        <Field label={t("goalDate")} group error={show(errors.by)}>
          {(props) => (
            <div className="goalDate" role="group" aria-labelledby={`${props.id}-label`} {...(props["aria-describedby"] ? { "aria-describedby": props["aria-describedby"] } : {})}>
              <Select value={year} label={t("goalYear")} options={years.map((item) => ({ value: item, label: item }))} onChange={setYear} />
              <Select value={month} label={t("goalMonth")} options={months} onChange={setMonth} />
            </div>
          )}
        </Field>
        <Field label={t("goalMonthly")} unit={currency} error={show(errors.monthly)} below={(labelId) => (
          <Slider min={0} max={monthlyRange.max} step={monthlyRange.step} value={Number.isFinite(monthly) ? monthly : 0} labelledBy={labelId}
            valueText={money(Number.isFinite(monthly) ? monthly : 0, currency, locale, { digits: 0 })} onChange={(next) => setMonthlyText(String(next))} />
        )}>
          {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={monthlyText} onChange={(event) => setMonthlyText(event.target.value)} />}
        </Field>
        <Field label={t("goalReturn")} unit="%" hint={t("goalReturnHint")} error={show(errors.expectedReturn)} below={percentSlider("expectedReturn", returnText, setReturnText)}>
          {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={returnText} onChange={(event) => setReturnText(event.target.value)} />}
        </Field>
        <Field label={t("goalVolatility")} unit="%" hint={t("goalVolatilityHint")} error={show(errors.volatility)} below={percentSlider("volatility", volatilityText, setVolatilityText)}>
          {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={volatilityText} onChange={(event) => setVolatilityText(event.target.value)} />}
        </Field>
        <Field label={t("goalInflation")} unit="%" hint={t("goalInflationHint")} error={show(errors.inflation)} below={percentSlider("inflation", inflationText, setInflationText)}>
          {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={inflationText} onChange={(event) => setInflationText(event.target.value)} />}
        </Field>
        <Field label={t("goalName")}>
          {(props) => <input {...props} maxLength={80} autoComplete="off" value={name} placeholder={t("goalNamePlaceholder")} onChange={(event) => setName(event.target.value)} />}
        </Field>
      </div>
      <div className="goalMeasured">
        <button type="button" className="secondaryButton compactButton" disabled={!useMeasured} onClick={useMeasured}>{t("goalUseMeasured")}</button>
        <span className="fieldHint">{useMeasured && measured
          ? fill(t("goalMeasuredHint"), { from: dayLabel(measured.from, locale), to: dayLabel(measured.to, locale), rate: pct(measured.annualized, locale, 1, { signed: true }), volatility: pct(measured.volatility, locale, 1) })
          : t("goalMeasuredShort")}</span>
      </div>
      <div className="alertFormActions">
        {changed && <span className="goalUnsaved" role="status">{t("goalUnsaved")}</span>}
        <button type="button" className="secondaryButton" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primaryButton" disabled={busy} aria-disabled={Boolean(touched && !valid) || undefined}>{busy ? t("saving") : t("goalSave")}</button>
      </div>
    </form>
  );
}

export function GoalPanel({ goal, value, measured, currency, locale, t, busy, onSave, onRemove }: {
  goal?: InvestmentGoal; value?: number; currency: string; locale: SupportedLocale; t: Translator; busy: boolean;
  /** The account's own return and volatility over the days read, for the form's "use my account's figures". */
  measured?: MeasuredGoalRisk;
  /** Resolves to the goal as saved; rejects with the reason it was not. */
  onSave: (request: GoalRequest) => Promise<InvestmentGoal | undefined>;
  onRemove: () => Promise<boolean>;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState<InvestmentGoal | undefined>(goal);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<GoalInputs | undefined>();
  useEffect(() => setSaved(goal), [goal]);
  const m = (amount: number) => money(amount, currency, locale, { digits: 0 });
  const shown = editing ? draft : saved;
  const projection = shown && value !== undefined ? projectGoal(shown, value, new Date()) : undefined;
  const save = async (request: GoalRequest) => {
    setSaving(true);
    setFailed(null);
    try {
      const next = await onSave(request);
      if (next) { setSaved(next); setEditing(false); setDraft(undefined); }
    } catch (error) {
      setFailed(fill(t("goalSaveFailed"), { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setSaving(true);
    setFailed(null);
    try {
      if (await onRemove()) { setSaved(undefined); setEditing(false); setDraft(undefined); }
    } catch (error) {
      setFailed(fill(t("goalRemoveFailed"), { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  };
  const disabled = busy || saving;
  const share = shown && value !== undefined ? Math.min(1, Math.max(0, value / shown.target)) : undefined;
  return (
    <section className="dataPanel goalPanel" aria-labelledby="goal-title">
      <div className="pieHeader">
        <h2 id="goal-title">{saved?.name ? fill(t("goalTitleNamed"), { name: saved.name }) : t("goalTitle")}</h2>
        {saved && !editing && (
          <span className="goalActions">
            <button type="button" className="secondaryButton compactButton" data-reveals="form" disabled={disabled} onClick={() => setEditing(true)}>{t("goalEdit")}</button>
            <button type="button" className="secondaryButton compactButton" disabled={disabled} onClick={() => void remove()}>{t("goalRemove")}</button>
          </span>
        )}
      </div>
      {!saved && !editing && (
        <div className="emptyState compact goalEmpty">
          <span>{t("goalEmpty")}</span>
          <button type="button" className="primaryButton compactButton" data-reveals="form" disabled={disabled} onClick={() => setEditing(true)}>{t("goalStart")}</button>
        </div>
      )}
      {failed && <div className="notice error compactNotice" role="alert">{failed}</div>}
      {editing && <GoalForm {...(saved ? { goal: saved } : {})} {...(value === undefined ? {} : { value })} {...(measured ? { measured } : {})} currency={currency} locale={locale} t={t} busy={disabled} onSave={(request) => void save(request)} onCancel={() => { setEditing(false); setDraft(undefined); }} onDraft={setDraft} />}
      {shown && value === undefined && <p className="panelNote">{t("goalNoValue")}</p>}
      {shown && projection && share !== undefined && (
        <>
          <div className="goalProgress">
            <div className="goalProgressText">
              <span>{fill(t("goalNow"), { value: m(value!), target: m(shown.target), date: dayLabel(shown.by, locale) })}</span>
              <strong>{pct(value! / shown.target, locale, 1)}</strong>
            </div>
            <div className="goalBar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t("goalProgress")}>
              <i style={{ width: `${(share * 100).toFixed(1)}%` }} />
            </div>
            {projection.pace && !projection.reached && (
              <p className="goalPace">
                <strong className={signedClass(projection.pace.difference)}>{fill(t(projection.pace.difference >= 0 ? "goalPaceAhead" : "goalPaceBehind"), { amount: m(Math.abs(projection.pace.difference)) })}</strong>
                {fill(t("goalPaceSince"), { expected: m(projection.pace.expected), date: dayLabel(projection.pace.since.slice(0, 10), locale) })}
              </p>
            )}
          </div>
          <div className="metricGrid">
            <Metric label={t("goalChance")} value={projection.reached ? t("goalReached") : pct(projection.chance, locale, 0)} />
            <Metric label={fill(t("goalMiddleBy"), { date: dayLabel(shown.by, locale, { year: true }) })} value={m(projection.final.mid)} />
            <Metric label={t("goalRange")} tone="goalRangeValue" value={<><span className="noWrap">{m(projection.final.low)}</span> – <span className="noWrap">{m(projection.final.high)}</span></>} />
            <Metric label={t("goalNeeded")} value={projection.reached ? "—" : m(projection.neededMonthly)} />
          </div>
          {projection.months > 0 && <GoalChart projection={projection} target={shown.target} currency={currency} locale={locale} t={t} />}
          <p className="panelNote">{fill(t(shown.inflation ? "goalAssumptionsReal" : "goalAssumptions"), { monthly: m(shown.monthly), rate: pct(shown.expectedReturn, locale, 1), volatility: pct(shown.volatility, locale, 1), inflation: pct(shown.inflation ?? 0, locale, 1) })}</p>
        </>
      )}
    </section>
  );
}

/** The goal's progress under the dashboard's value: a short bar and the share of the target, opening the goal panel. */
export function GoalProgressLine({ goal, value, currency, locale, t, onOpen }: {
  goal: InvestmentGoal; value?: number; currency: string; locale: SupportedLocale; t: Translator;
  /** Opens the Performance tab, where the goal is. */
  onOpen?: () => void;
}) {
  if (value === undefined) return null;
  const share = value / goal.target;
  const label = fill(t("goalLine"), { name: goal.name ?? t("goalTitle"), share: pct(share, locale, 1), target: money(goal.target, currency, locale, { digits: 0 }), date: dayLabel(goal.by, locale) });
  const body = (
    <>
      <span className="goalLineText"><b>{goal.name ?? t("goalTitle")}</b> {fill(t("goalLineShare"), { share: pct(share, locale, 1), target: money(goal.target, currency, locale, { digits: 0 }) })}</span>
      <span className="goalBar small" aria-hidden="true"><i style={{ width: `${(Math.min(1, Math.max(0, share)) * 100).toFixed(1)}%` }} /></span>
    </>
  );
  return onOpen
    ? <button type="button" className="goalLine" aria-label={label} onClick={onOpen}>{body}</button>
    : <div className="goalLine" role="group" aria-label={label}>{body}</div>;
}
