// Target weights, set on the Allocation tab: a share of the account for each holding and for cash, typed in or
// filled from today's weights, equal weights or the equal-risk weights. Saved targets drive the drift panel, the
// rebalance to targets and the scheduler's drift notices; they never trade.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AllocationAnalysis, HoldingCovariance, HoldingCovariancePayload, HoldingRisk } from "../../shared/history";
import { equalRiskTargets, OVER_ACCOUNT, targetRiskOf, type TargetRisk } from "../../shared/holding-risk";
import { localeTag, type SupportedLocale } from "../i18n";
import { parseAmount, pct } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { Field } from "./common";

/** As many targets as the server keeps: a rebalance to them is one basket. */
export const MAX_TARGETS = 20;

export interface TargetSave {
  targets: Array<{ instrument: string; weight: number }>;
  /** Left out, the server keeps in cash whatever the targets leave. */
  cashWeight?: number;
  driftThreshold: number;
  sellUntargeted: boolean;
}

export type TargetPreset = "today" | "equal" | "parity";

type Data = Pick<AllocationAnalysis, "holdings" | "cashWeight" | "cash" | "availableCash" | "totalValue" | "drift" | "risk">;

export interface TargetForm {
  /** Percent typed for each ticker; empty for no target. */
  weights: Record<string, string>;
  /** Percent; empty for whatever the targets leave. */
  cash: string;
  threshold: string;
  sell: boolean;
}

/** A share as the form shows it: percent with at most two decimals, "12.5". */
const percentText = (share: number) => String(Math.round(share * 10_000) / 100);
/** Rounded down to 0.01%, so a preset never comes to more than the account. */
const downText = (share: number) => percentText(Math.max(0, Math.floor(share * 10_000 + 1e-9) / 10_000));
/** A share as the server keeps it: four decimals (0.01%). */
const serverShare = (share: number) => Math.round(share * 10_000) / 10_000;

/** The rows: the holdings, largest first, then the saved targets not held. */
export function targetRows(data: Pick<Data, "holdings" | "drift">): Array<{ ticker: string; name?: string; current: number; held: boolean }> {
  const held = data.holdings.filter((holding) => holding.value > 0).sort((a, b) => b.value - a.value)
    .map((holding) => ({ ticker: holding.ticker, name: holding.name, current: holding.weight, held: true }));
  const known = new Set(held.map((row) => row.ticker));
  const away = (data.drift?.rows ?? []).filter((row) => !known.has(row.ticker)).map((row) => ({ ticker: row.ticker, current: 0, held: false }));
  return [...held, ...away];
}

/** The form as it opens: the saved targets, or today's weights when none are saved. */
export function startingForm(data: Data): TargetForm {
  const { drift } = data;
  if (!drift) return { ...presetForm("today", data, percentText(data.cashWeight)), threshold: "5", sell: false };
  const saved = new Map(drift.rows.map((row) => [row.ticker, row.target]));
  return {
    weights: Object.fromEntries(targetRows(data).map((row) => [row.ticker, saved.has(row.ticker) ? percentText(saved.get(row.ticker)!) : ""])),
    cash: percentText(drift.cash.target),
    // A threshold to 0.0001 points, so a fine one does not read as 0.
    threshold: String(Math.round(drift.threshold * 1_000_000) / 10_000),
    sell: !!drift.sellUntargeted,
  };
}

/** The equal-risk weights of the holdings measured, as shares of the account. */
function parityShares(data: Data): Map<string, number> | undefined {
  const rows = data.risk?.rows ?? [];
  if (rows.length < 2 || !rows.every((row) => row.parity !== undefined) || !(data.totalValue > 0)) return undefined;
  const values = new Map(data.holdings.map((holding) => [holding.ticker, holding.value]));
  const measured = rows.reduce((sum, row) => sum + (values.get(row.ticker) ?? 0), 0);
  return new Map(rows.map((row) => [row.ticker, row.parity! * measured / data.totalValue]));
}

export const canUseParity = (data: Data) => parityShares(data) !== undefined;

/**
 * A preset's weights, rounded down to 0.01%. Today's weights keep today's cash; equal weights share what the cash
 * typed leaves; the equal-risk weights move the holdings measured among themselves and keep the others and the cash
 * at today's. With more holdings than a target list takes, only the MAX_TARGETS largest get one (for the equal-risk
 * weights, the furthest from them, as the plan moves), and the others are left without, at their share today.
 */
export function presetForm(preset: TargetPreset, data: Data, cashText: string): Pick<TargetForm, "weights" | "cash"> {
  const rows = targetRows(data);
  const held = rows.filter((row) => row.held);
  const chosen = new Set(held.slice(0, MAX_TARGETS).map((row) => row.ticker));
  const fillWith = (share: (row: (typeof rows)[number]) => number | undefined) =>
    Object.fromEntries(rows.map((row) => { const value = chosen.has(row.ticker) ? share(row) : undefined; return [row.ticker, value === undefined ? "" : downText(value)]; }));
  // What the holdings left without a target hold today: kept, they take that share.
  const rest = held.filter((row) => !chosen.has(row.ticker)).reduce((sum, row) => sum + row.current, 0);
  if (preset === "equal") {
    const typed = parseAmount(cashText);
    const cash = Number.isFinite(typed) && typed >= 0 && typed <= 100 ? typed / 100 : data.cashWeight;
    return { weights: fillWith(() => Math.max(0, 1 - cash - rest) / chosen.size), cash: percentText(cash) };
  }
  if (preset === "parity" && held.length > MAX_TARGETS) {
    // The plan's targets: the furthest from their equal-risk weight move, keeping their value together.
    const plan = equalRiskTargets(data);
    if (plan) {
      const planned = new Map(plan.targets.map((target) => [target.ticker, target.weight]));
      return { weights: Object.fromEntries(rows.map((row) => [row.ticker, planned.has(row.ticker) ? downText(planned.get(row.ticker)!) : ""])), cash: downText(data.cashWeight) };
    }
  }
  const parity = preset === "parity" ? parityShares(data) : undefined;
  return { weights: fillWith((row) => parity?.get(row.ticker) ?? row.current), cash: downText(data.cashWeight) };
}

export type TargetProblem = "weight" | "cash" | "threshold" | "none" | "many" | "over";

/**
 * What is wrong with the form, if anything, and what it would save: only the rows shown (`tickers`), checked as the
 * server checks them, on weights rounded to 0.01%. `cash` is what the targets leave when none is typed.
 */
export function readForm(form: TargetForm, tickers: string[] = Object.keys(form.weights)):
  { problem?: TargetProblem; invalid: string[]; total: number; cash: number; save?: TargetSave } {
  const targets: TargetSave["targets"] = [];
  const invalid: string[] = [];
  for (const ticker of tickers) {
    const text = form.weights[ticker] ?? "";
    if (!text.trim()) continue;
    const value = parseAmount(text);
    // A weight the server would round to 0 is no weight it keeps.
    if (!Number.isFinite(value) || value < 0 || value > 100 || (value > 0 && !(serverShare(value / 100) > 0))) invalid.push(ticker);
    else if (value > 0) targets.push({ instrument: ticker, weight: value / 100 });
  }
  const invested = serverShare(targets.reduce((sum, target) => sum + serverShare(target.weight), 0));
  const typedCash = form.cash.trim() ? parseAmount(form.cash) : undefined;
  const cash = typedCash === undefined ? Math.max(0, 1 - invested) : typedCash / 100;
  const threshold = parseAmount(form.threshold);
  const problem: TargetProblem | undefined = invalid.length ? "weight"
    : !Number.isFinite(cash) || cash < 0 || cash > 1 ? "cash"
    : !Number.isFinite(threshold) || threshold <= 0 || threshold >= 100 ? "threshold"
    : !targets.length ? "none"
    : targets.length > MAX_TARGETS ? "many"
    : invested + serverShare(cash) > 1 + 1e-9 ? "over"
    : undefined;
  return {
    invalid,
    total: invested * 100,
    cash: Number.isFinite(cash) ? cash * 100 : 0,
    ...(problem ? { problem } : { save: { targets, ...(typedCash === undefined ? {} : { cashWeight: cash }), driftThreshold: threshold / 100, sellUntargeted: form.sell } }),
  };
}

/** The targets typed that the server would keep, as shares of the account, for the risk at them. */
export function typedTargets(form: TargetForm, tickers: string[]): Map<string, number> {
  const typed = new Map<string, number>();
  for (const ticker of tickers) {
    const value = parseAmount(form.weights[ticker] ?? "");
    if (Number.isFinite(value) && value <= 100 && serverShare(value / 100) > 0) typed.set(ticker, serverShare(value / 100));
  }
  return typed;
}

/** The holdings' covariance as the form reads it: on its way, read, not to be had, or read for other holdings or weeks. */
export type CovarianceState = { state: "reading" } | { state: "read"; covariance: HoldingCovariance } | { state: "none" } | { state: "stale" };

/** What the risk by holding on screen measured: the covariance must be for the same. */
export type MeasuredRisk = Pick<HoldingRisk, "rows" | "to" | "weeks">;

/** Whether a covariance read is for the holdings and the weeks of the risk on screen. */
export function covarianceFits(payload: HoldingCovariancePayload, risk: MeasuredRisk): boolean {
  const tickers = payload.covariance?.tickers ?? [];
  const shown = new Set(risk.rows.map((row) => row.ticker));
  return tickers.length === shown.size && tickers.every((ticker) => shown.has(ticker)) && payload.weeks === risk.weeks && payload.to === risk.to;
}

/** Reads the covariance and hands the form what it shows, unless the form has closed or moved on (`open`). */
export async function loadCovariance(read: () => Promise<HoldingCovariancePayload>, risk: MeasuredRisk, open: () => boolean, show: (state: CovarianceState) => void): Promise<void> {
  let next: CovarianceState;
  try {
    const payload = await read();
    next = !payload.covariance ? { state: "none" } : covarianceFits(payload, risk) ? { state: "read", covariance: payload.covariance } : { state: "stale" };
  } catch {
    next = { state: "none" };
  }
  if (open()) show(next);
}

/**
 * The risk at the targets typed, with the cash share they leave or the one typed; or why there is none: a share typed
 * is not one the server keeps, or no holding measured has a share at the targets.
 */
export function riskOfForm(covariance: HoldingCovariance, holdings: Data["holdings"], form: TargetForm, tickers: string[]): TargetRisk | "invalid" | "unmeasured" {
  const read = readForm(form, tickers);
  if (read.invalid.length) return "invalid";
  return targetRiskOf(covariance, holdings, typedTargets(form, tickers), form.sell, read.cash / 100) ?? "unmeasured";
}

const RISK_STATUS = {
  reading: "targetsRiskReading",
  none: "targetsRiskNone",
  stale: "targetsRiskStale",
  invalid: "targetsRiskInvalid",
  unmeasured: "targetsRiskUnmeasured",
} as const;

/** The volatility a year now and at the targets typed, with what is left out. */
export function TargetRiskSummary({ risk, state, weeks, parity, book, locale, t }: {
  /** Worked out from the form once the covariance is read. */
  risk?: TargetRisk | "invalid" | "unmeasured"; state: CovarianceState;
  /** The weekly returns of risk by holding, which the covariance is read over. */
  weeks: number;
  /** Filled from the equal-risk weights, whose shares of the risk here are near, not quite, equal. */
  parity?: boolean;
  book?: InstrumentBook; locale: SupportedLocale; t: Translator;
}) {
  const titleId = useId();
  const points = useMemo(() => new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" }), [locale]);
  const figures = state.state === "read" && typeof risk === "object" ? risk : undefined;
  const status = state.state !== "read" ? RISK_STATUS[state.state] : typeof risk === "string" ? RISK_STATUS[risk] : undefined;
  const gap = locale === "zh-CN" ? "" : " ";
  const line = (label: string, now: number, at: number) => (
    <tr>
      <th scope="row">{label}</th>
      <td>{pct(now, locale, 1)}</td>
      <td><strong>{pct(at, locale, 1)}</strong>{Math.abs(at - now) >= 0.0005 && <small className="targetRiskChange">{fill(t("targetsRiskChange"), { points: points.format((at - now) * 100) })}</small>}</td>
    </tr>
  );
  return (
    <div className="targetRisk" role="group" aria-labelledby={titleId} aria-busy={state.state === "reading" || undefined}>
      <h3 id={titleId} className="targetRiskTitle">{t("targetsRiskTitle")}</h3>
      {/* Said when it changes (read, or not to be worked out), not at each figure typed. */}
      <p role="status" className={status ? "panelNote" : "visuallyHidden"}>{t(status ?? "targetsRiskReady")}</p>
      {figures && (
        <>
          <table className="targetRiskTable" aria-labelledby={titleId}>
            <thead><tr><th scope="col">{t("targetsRiskMeasure")}</th><th scope="col">{t("targetsRiskNow")}</th><th scope="col">{t("targetsRiskAt")}</th></tr></thead>
            <tbody>
              {line(t("targetsRiskHoldings"), figures.now.volatility, figures.atTargets.volatility)}
              {figures.account && line(t("targetsRiskAccount"), figures.account.now, figures.account.atTargets)}
            </tbody>
          </table>
          <p className="panelNote">
            {fill(t("targetsRiskNote"), { weeks: String(weeks) })}
            {figures.leftOut.length > 0 && <>{gap}{fill(t("targetsRiskLeftOut"), { list: figures.leftOut.map((ticker) => instrumentLabel(ticker, book).name).join(locale === "zh-CN" ? "、" : ", ") })}</>}
            {parity && <>{gap}{t("targetsRiskParity")}</>}
          </p>
        </>
      )}
    </div>
  );
}

const PROBLEM_KEYS = {
  weight: "targetsProblemWeight",
  cash: "targetsProblemCash",
  threshold: "targetsProblemThreshold",
  none: "targetsProblemNone",
  many: "targetsProblemMany",
  over: "targetsProblemOver",
} as const;

export function TargetEditor({ data, book, locale, t, busy, start, onSave, onClear, onReadCovariance, onClose }: {
  data: Data; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy?: boolean;
  /** A preset to fill the form with as it opens, instead of the saved targets. */
  start?: TargetPreset;
  /** Resolves true once saved, to close the form. */
  onSave: (save: TargetSave) => Promise<boolean>;
  /** Removes the saved targets; only when there are some. */
  onClear?: () => Promise<boolean>;
  /** Reads the holdings' covariance for the holdings measured, for the risk at the targets typed in; only with risk by holding. */
  onReadCovariance?: (measured: MeasuredRisk) => Promise<HoldingCovariancePayload>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<TargetForm>(() => {
    const opening = startingForm(data);
    return start ? { ...opening, ...presetForm(start, data, opening.cash) } : opening;
  });
  const [filled, setFilled] = useState<TargetPreset | undefined>(start);
  const [touched, setTouched] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // The risk by holding on screen, which the covariance is read for: again when a refresh measures other holdings or weeks.
  const measured = onReadCovariance ? data.risk : undefined;
  const measuredKey = measured ? `${measured.to}|${measured.weeks}|${measured.rows.map((row) => row.ticker).sort().join(",")}` : "";
  const [covariance, setCovariance] = useState<CovarianceState | undefined>(measured ? { state: "reading" } : undefined);
  const errorId = useId();
  // Read as the form opens; the risk at the targets is then worked out as they are typed.
  useEffect(() => {
    if (!measured || !onReadCovariance) { setCovariance(undefined); return undefined; }
    let open = true;
    setCovariance({ state: "reading" });
    void loadCovariance(() => onReadCovariance(measured), measured, () => open, setCovariance);
    return () => { open = false; };
  }, [measuredKey]);
  // Opened from a button, perhaps further down the page: brought into sight, with the focus on its heading.
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus?.({ preventScroll: true });
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.current?.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
  }, []);
  const rows = targetRows(data);
  const read = readForm(form, rows.map((row) => row.ticker));
  const left = 100 - read.total - read.cash;
  // Kept, the holdings without a target take their share today beside the targets and the cash.
  const typed = typedTargets(form, rows.map((row) => row.ticker));
  const kept = form.sell ? 0 : rows.filter((row) => row.held && !typed.has(row.ticker)).reduce((sum, row) => sum + row.current, 0) * 100;
  const keptOver = !read.problem && kept > 0 && read.total + read.cash + kept > 100 + OVER_ACCOUNT * 100;
  const risk = covariance?.state === "read" ? riskOfForm(covariance.covariance, data.holdings, form, rows.map((row) => row.ticker)) : undefined;
  const share = (value: number) => pct(value / 100, locale, 1);
  const crowded = rows.filter((row) => row.held).length > MAX_TARGETS;
  const problemKey = read.problem === "many" && form.sell ? "targetsProblemManySold" : read.problem && PROBLEM_KEYS[read.problem];
  const error = problemKey && fill(t(problemKey), { count: String(MAX_TARGETS), total: share(read.total + read.cash) });
  const shown = touched ? error : undefined;
  const apply = (preset: TargetPreset) => { setForm({ ...form, ...presetForm(preset, data, form.cash) }); setFilled(preset); setTouched(false); };
  const submit = async () => {
    setTouched(true);
    if (!read.save || busy) return;
    if (await onSave(read.save)) onClose();
  };
  const clear = async () => {
    if (!onClear) return;
    // A second press removes them: one press alone could lose targets set with care.
    if (!confirmClear) { setConfirmClear(true); return; }
    if (await onClear()) onClose();
  };
  return (
    <section ref={panel} className="dataPanel targetEditor" aria-label={t("targetsTitle")}>
      <div className="panelHeading">
        <h2 ref={heading} tabIndex={-1} className="panelTitle">{t("targetsTitle")}</h2>
        <div className="panelActions targetPresets" role="group" aria-label={t("targetsFillFrom")}>
          <span>{t("targetsFillFrom")}</span>
          <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => apply("today")}>{t("targetsPresetToday")}</button>
          <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => apply("equal")}>{t("targetsPresetEqual")}</button>
          {canUseParity(data) && <button type="button" className="secondaryButton compactButton" disabled={busy} onClick={() => apply("parity")}>{t("targetsPresetParity")}</button>}
        </div>
      </div>
      <p className="panelNote">{t("targetsEditorNote")}</p>
      {filled === "parity" && <p className="panelNote">{t("targetsParityNote")}</p>}
      {crowded && <p className="panelNote">{fill(t(form.sell ? "targetsMoreSold" : "targetsMoreKept"), { count: String(MAX_TARGETS) })}</p>}
      <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset className="targetFieldset" disabled={busy}>
          <ul className="targetRows">
            {rows.map((row) => {
              const label = instrumentLabel(row.ticker, book, row.name ? { name: row.name } : undefined);
              const wrong = touched && read.invalid.includes(row.ticker);
              return (
                <li key={row.ticker}>
                  <span className="barLabel"><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</span>
                  <span className="targetNow">
                    <span>{row.held ? fill(t("targetsNow"), { share: pct(row.current, locale, 1) }) : t("targetsNotHeld")}</span>
                    {typeof risk === "object" && risk.now.shares.has(row.ticker) && (() => {
                      const shares = { now: pct(risk.now.shares.get(row.ticker)!, locale, 0), at: pct(risk.atTargets.shares.get(row.ticker)!, locale, 0) };
                      return <span className="targetRiskShare"><span className="visuallyHidden">{fill(t("targetsRiskShareLabel"), shares)}</span><span aria-hidden="true">{fill(t("targetsRiskShare"), shares)}</span></span>;
                    })()}
                  </span>
                  <span className={`field targetField${wrong ? " invalid" : ""}`}>
                    <span className="fieldControl withUnit">
                      <input aria-label={fill(t("targetsWeightLabel"), { name: label.detail ? `${label.name} (${label.detail})` : label.name })} inputMode="decimal" autoComplete="off" placeholder="0"
                        {...(wrong ? { "aria-invalid": true, "aria-describedby": errorId } : {})}
                        value={form.weights[row.ticker] ?? ""} onChange={(event) => { setForm({ ...form, weights: { ...form.weights, [row.ticker]: event.target.value } }); setFilled(undefined); }} />
                      <span className="fieldUnit" aria-hidden="true">%</span>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="formGrid targetSettings">
            <Field label={t("targetsCash")} unit="%" hint={fill(t("targetsCashHint"), { share: pct(data.cashWeight, locale, 1) })}
              {...(read.problem === "cash" && shown ? { error: shown } : {})}>
              {(props) => <input {...props} inputMode="decimal" autoComplete="off" placeholder={share(Math.max(0, 100 - read.total)).replace(/\s?%$/, "")} value={form.cash} onChange={(event) => setForm({ ...form, cash: event.target.value })} />}
            </Field>
            <Field label={t("targetsThreshold")} unit={t("targetsPoints")} hint={t("targetsThresholdHint")}
              {...(read.problem === "threshold" && shown ? { error: shown } : {})}>
              {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={form.threshold} onChange={(event) => setForm({ ...form, threshold: event.target.value })} />}
            </Field>
          </div>
          <label className="toggleField targetToggle">
            <input type="checkbox" checked={form.sell} onChange={(event) => setForm({ ...form, sell: event.target.checked })} />
            <span className="toggleTrack"><span /></span>
            <span>{t("targetsSellToggle")}</span>
          </label>
          <p className={`targetTotal${read.problem === "over" ? " over" : ""}`}>
            {fill(t("targetsTotal"), { targets: share(read.total), cash: share(read.cash), total: share(read.total + read.cash) })}
            {left >= 0.05 && !read.problem && <>{locale === "zh-CN" ? "" : " "}{fill(t(form.sell ? "targetsLeftSold" : "targetsLeftKept"), { share: share(left) })}</>}
          </p>
          {keptOver && <p className="panelNote targetKeptOver">{fill(t("targetsKeptOver"), { kept: share(kept), total: share(read.total + read.cash + kept) })}</p>}
          {covariance && measured && <TargetRiskSummary {...(risk ? { risk } : {})} state={covariance} weeks={measured.weeks} parity={filled === "parity"} {...(book ? { book } : {})} locale={locale} t={t} />}
          {shown && read.problem !== "cash" && read.problem !== "threshold" && <p className="fieldError targetError" id={errorId} role="alert">{shown}</p>}
          <div className="alertFormActions">
            {onClear && <button type="button" className="secondaryButton targetClear" onClick={() => void clear()}>{t(confirmClear ? "targetsClearConfirm" : "targetsClear")}</button>}
            <button type="button" className="secondaryButton" onClick={onClose}>{t("cancel")}</button>
            <button type="submit" className="primaryButton" aria-disabled={Boolean(shown) || undefined}>{busy ? t("saving") : t("targetsSave")}</button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
