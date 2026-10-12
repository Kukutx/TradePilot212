// Target weights, set on the Allocation tab: a share of the account for each holding and for cash, typed in or
// filled from today's weights, equal weights or the equal-risk weights. Saved targets drive the drift panel, the
// rebalance to targets and the scheduler's drift notices; they never trade.

import { useEffect, useRef, useState } from "react";
import type { AllocationAnalysis } from "../../shared/history";
import type { SupportedLocale } from "../i18n";
import { parseAmount, pct } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { Field } from "./common";

/** As many targets as the server keeps: a rebalance to them is one basket. */
export const MAX_TARGETS = 20;
/** Weights and cash may come to this much over 100%, in percent: the server's rounding. */
const SLACK = 0.005;

export interface TargetSave {
  targets: Array<{ instrument: string; weight: number }>;
  cashWeight: number;
  driftThreshold: number;
  sellUntargeted: boolean;
}

export type TargetPreset = "today" | "equal" | "parity";

type Data = Pick<AllocationAnalysis, "holdings" | "cashWeight" | "totalValue" | "drift" | "risk">;

export interface TargetForm {
  /** Percent typed for each ticker; empty for no target. */
  weights: Record<string, string>;
  cash: string;
  threshold: string;
  sell: boolean;
}

/** A share as the form shows it: percent with at most two decimals, "12.5". */
const percentText = (share: number) => String(Math.round(share * 10_000) / 100);

/** The rows: the holdings, largest first, then the saved targets not held. */
export function targetRows(data: Data): Array<{ ticker: string; name?: string; current: number; held: boolean }> {
  const held = data.holdings.filter((holding) => holding.value > 0).map((holding) => ({ ticker: holding.ticker, name: holding.name, current: holding.weight, held: true }));
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
    threshold: percentText(drift.threshold),
    sell: !!drift.sellUntargeted,
  };
}

/** The weights the equal-risk weights give each holding measured, as shares of the account; the others' today's. */
function parityShares(data: Data): Map<string, number> | undefined {
  const rows = data.risk?.rows ?? [];
  if (rows.length < 2 || !rows.every((row) => row.parity !== undefined) || !(data.totalValue > 0)) return undefined;
  const values = new Map(data.holdings.map((holding) => [holding.ticker, holding.value]));
  const measured = rows.reduce((sum, row) => sum + (values.get(row.ticker) ?? 0), 0);
  return new Map(rows.map((row) => [row.ticker, row.parity! * measured / data.totalValue]));
}

export const canUseParity = (data: Data) => parityShares(data) !== undefined;

/**
 * A preset's weights, rounded down to 0.01% so they never come to more than the account. Today's weights keep
 * today's cash; equal weights share what the cash typed leaves; the equal-risk weights move the holdings measured
 * among themselves and keep the others and the cash at today's.
 */
export function presetForm(preset: TargetPreset, data: Data, cashText: string): Pick<TargetForm, "weights" | "cash"> {
  const rows = targetRows(data);
  const down = (share: number) => percentText(Math.floor(share * 10_000) / 10_000);
  if (preset === "equal") {
    const typed = parseAmount(cashText);
    const cash = Number.isFinite(typed) && typed >= 0 && typed < 100 ? typed / 100 : data.cashWeight;
    const held = rows.filter((row) => row.held);
    return { weights: Object.fromEntries(rows.map((row) => [row.ticker, row.held ? down((1 - cash) / held.length) : ""])), cash: percentText(cash) };
  }
  const parity = preset === "parity" ? parityShares(data) : undefined;
  return {
    weights: Object.fromEntries(rows.map((row) => [row.ticker, row.held ? down(parity?.get(row.ticker) ?? row.current) : ""])),
    cash: down(data.cashWeight),
  };
}

export type TargetProblem = "weight" | "cash" | "threshold" | "none" | "many" | "over";

/** What is wrong with the form, if anything, and what it would save. */
export function readForm(form: TargetForm): { problem?: TargetProblem; total: number; cash: number; save?: TargetSave } {
  const targets: TargetSave["targets"] = [];
  let bad = false;
  for (const [ticker, text] of Object.entries(form.weights)) {
    if (!text.trim()) continue;
    const value = parseAmount(text);
    if (!Number.isFinite(value) || value < 0 || value > 100) bad = true;
    else if (value > 0) targets.push({ instrument: ticker, weight: value / 100 });
  }
  const total = targets.reduce((sum, target) => sum + target.weight * 100, 0);
  const cash = form.cash.trim() ? parseAmount(form.cash) : 0;
  const threshold = parseAmount(form.threshold);
  const problem: TargetProblem | undefined = bad ? "weight"
    : !Number.isFinite(cash) || cash < 0 || cash > 100 ? "cash"
    : !Number.isFinite(threshold) || threshold <= 0 || threshold >= 100 ? "threshold"
    : !targets.length ? "none"
    : targets.length > MAX_TARGETS ? "many"
    : total + cash > 100 + SLACK ? "over"
    : undefined;
  return {
    total,
    cash: Number.isFinite(cash) ? cash : 0,
    ...(problem ? { problem } : { save: { targets, cashWeight: cash / 100, driftThreshold: threshold / 100, sellUntargeted: form.sell } }),
  };
}

const PROBLEM_KEYS = {
  weight: "targetsProblemWeight",
  cash: "targetsProblemCash",
  threshold: "targetsProblemThreshold",
  none: "targetsProblemNone",
  many: "targetsProblemMany",
  over: "targetsProblemOver",
} as const;

export function TargetEditor({ data, book, locale, t, busy, start, onSave, onClear, onClose }: {
  data: Data; book?: InstrumentBook; locale: SupportedLocale; t: Translator; busy?: boolean;
  /** A preset to fill the form with as it opens, instead of the saved targets. */
  start?: TargetPreset;
  /** Resolves true once saved, to close the form. */
  onSave: (save: TargetSave) => Promise<boolean>;
  /** Removes the saved targets; only when there are some. */
  onClear?: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<TargetForm>(() => {
    const opening = startingForm(data);
    return start ? { ...opening, ...presetForm(start, data, opening.cash) } : opening;
  });
  const [touched, setTouched] = useState(false);
  // Opened from a button further down the page: brought into sight.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, []);
  const rows = targetRows(data);
  const read = readForm(form);
  const left = 100 - read.total - read.cash;
  const share = (value: number) => pct(value / 100, locale, 1);
  const error = read.problem && fill(t(PROBLEM_KEYS[read.problem]), { count: String(MAX_TARGETS), total: share(read.total + read.cash) });
  const apply = (preset: TargetPreset) => { setForm({ ...form, ...presetForm(preset, data, form.cash) }); setTouched(false); };
  const submit = async () => {
    setTouched(true);
    if (!read.save || busy) return;
    if (await onSave(read.save)) onClose();
  };
  return (
    <section ref={panel} className="dataPanel targetEditor" aria-label={t("targetsTitle")}>
      <div className="panelHeading">
        <h2 className="panelTitle">{t("targetsTitle")}</h2>
        <div className="panelActions targetPresets" role="group" aria-label={t("targetsFillFrom")}>
          <span>{t("targetsFillFrom")}</span>
          <button type="button" className="secondaryButton compactButton" onClick={() => apply("today")}>{t("targetsPresetToday")}</button>
          <button type="button" className="secondaryButton compactButton" onClick={() => apply("equal")}>{t("targetsPresetEqual")}</button>
          {canUseParity(data) && <button type="button" className="secondaryButton compactButton" onClick={() => apply("parity")}>{t("targetsPresetParity")}</button>}
        </div>
      </div>
      <p className="panelNote">{t("targetsEditorNote")}</p>
      <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <ul className="targetRows">
          {rows.map((row) => {
            const label = instrumentLabel(row.ticker, book, row.name ? { name: row.name } : undefined);
            return (
              <li key={row.ticker}>
                <span className="barLabel"><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</span>
                <span className="targetNow">{row.held ? fill(t("targetsNow"), { share: pct(row.current, locale, 1) }) : t("targetsNotHeld")}</span>
                <span className="field targetField">
                  <span className="fieldControl withUnit">
                    <input aria-label={fill(t("targetsWeightLabel"), { name: label.detail ? `${label.name} (${label.detail})` : label.name })} inputMode="decimal" autoComplete="off" placeholder="0"
                      value={form.weights[row.ticker] ?? ""} onChange={(event) => setForm({ ...form, weights: { ...form.weights, [row.ticker]: event.target.value } })} />
                    <span className="fieldUnit" aria-hidden="true">%</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="formGrid targetSettings">
          <Field label={t("targetsCash")} unit="%" hint={fill(t("targetsCashHint"), { share: pct(data.cashWeight, locale, 1) })}>
            {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={form.cash} onChange={(event) => setForm({ ...form, cash: event.target.value })} />}
          </Field>
          <Field label={t("targetsThreshold")} unit={t("targetsPoints")} hint={t("targetsThresholdHint")}>
            {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={form.threshold} onChange={(event) => setForm({ ...form, threshold: event.target.value })} />}
          </Field>
        </div>
        <label className="toggleField targetToggle">
          <input type="checkbox" checked={form.sell} onChange={(event) => setForm({ ...form, sell: event.target.checked })} />
          <span className="toggleTrack"><span /></span>
          <span>{t("targetsSellToggle")}</span>
        </label>
        <p className={`targetTotal${read.problem === "over" ? " over" : ""}`} aria-live="polite">
          {fill(t("targetsTotal"), { targets: share(read.total), cash: share(read.cash), total: share(read.total + read.cash) })}
          {left >= 0.05 && !read.problem && <> {fill(t("targetsLeft"), { share: share(left) })}</>}
        </p>
        {touched && error && <p className="fieldError targetError" role="alert">{error}</p>}
        <div className="alertFormActions">
          {onClear && <button type="button" className="secondaryButton targetClear" disabled={busy} onClick={() => void onClear().then((done) => { if (done) onClose(); })}>{t("targetsClear")}</button>}
          <button type="button" className="secondaryButton" onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="primaryButton" disabled={busy} aria-disabled={Boolean(touched && error) || undefined}>{busy ? t("saving") : t("targetsSave")}</button>
        </div>
      </form>
    </section>
  );
}
