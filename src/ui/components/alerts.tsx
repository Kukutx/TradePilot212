import { useState } from "react";
import type { AccountAlert, AlertCondition, PriceAlert } from "../../shared/automation";
import type { SupportedLocale } from "../i18n";
import { num, parseAmount } from "../lib/format";
import { alertConditionLabel, fill, type Translator } from "../lib/messages";
import { Field } from "./common";

/** What the alert form sends: a price for above/below, a percent otherwise. */
export interface AlertRequest {
  condition: AlertCondition;
  price?: number;
  percent?: number;
  note?: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** What a typed number was read as, under its field, once it has a separator in it: "10,000" is not 10. */
export function readAsHint(text: string, display: (value: number) => string, t: Translator): string | undefined {
  const value = parseAmount(text);
  return /[.,\s'\u2019]/.test(text.trim()) && Number.isFinite(value) && value > 0 ? fill(t("amountReadAs"), { value: display(value) }) : undefined;
}

/** The highest percent the server accepts: a gain can exceed 100%, a drop or a loss cannot. */
export function alertPercentLimit(condition: AlertCondition): number | undefined {
  if (condition === "above" || condition === "below") return undefined;
  return condition === "gain_percent" ? 10_000 : 100;
}

/** The same limits the server applies: a positive number, and a percent below its limit. */
export function alertValueProblem(condition: AlertCondition, text: string): "required" | "range" | undefined {
  const value = parseAmount(text);
  if (!text.trim() || !Number.isFinite(value) || value <= 0) return "required";
  const limit = alertPercentLimit(condition);
  return limit !== undefined && value >= limit ? "range" : undefined;
}
const PERCENT_DEFAULTS: Partial<Record<AlertCondition, number>> = { trailing_drop: 8, gain_percent: 20, loss_percent: 10, day_move: 5 };

/** A starting value for a condition: 5% either side of the last price, or a common percent. */
export function defaultAlertValue(condition: AlertCondition, last: number | undefined): string {
  if (condition === "above") return last ? String(round(last * 1.05)) : "";
  if (condition === "below") return last ? String(round(last * 0.95)) : "";
  return String(PERCENT_DEFAULTS[condition] ?? "");
}

/**
 * A new price alert on one instrument. Percent conditions need a holding (its average cost or last
 * price), so they are offered only when the instrument is held; the day's move, against the previous
 * close, is offered for any. Alerts notify; they never trade.
 */
export function AlertForm({ held, last, currency, locale, t, busy, onSave, onCancel }: {
  held: boolean;
  last?: number;
  /** For saying what a typed number was read as. */
  locale?: SupportedLocale;
  currency?: string;
  t: Translator;
  busy: boolean;
  onSave: (request: AlertRequest) => void;
  onCancel: () => void;
}) {
  const conditions: AlertCondition[] = held ? ["below", "above", "day_move", "trailing_drop", "loss_percent", "gain_percent"] : ["below", "above", "day_move"];
  const [condition, setCondition] = useState<AlertCondition>("below");
  const [valueText, setValueText] = useState(() => defaultAlertValue("below", last));
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const byPrice = condition === "above" || condition === "below";
  const value = parseAmount(valueText);
  const problem = alertValueProblem(condition, valueText);
  const error = problem === "required" ? t("alertValueRequired") : problem === "range" ? fill(t("alertPercentRange"), { limit: String(alertPercentLimit(condition)) }) : undefined;
  const readAs = locale ? readAsHint(valueText, (read) => (byPrice ? `${num(read, locale, 6)}${currency ? ` ${currency}` : ""}` : `${num(read, locale, 2)}%`), t) : undefined;
  const submit = () => {
    setTouched(true);
    if (error || busy) return;
    onSave({ condition, ...(byPrice ? { price: value } : { percent: value }), ...(note.trim() ? { note: note.trim() } : {}) });
  };
  return (
    <form className="alertForm" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="formGrid">
        <Field label={t("alertCondition")}>
          {(props) => (
            <select {...props} value={condition} onChange={(event) => {
              const next = event.target.value as AlertCondition;
              setCondition(next);
              setValueText(defaultAlertValue(next, last));
              setTouched(false);
            }}>
              {conditions.map((item) => <option key={item} value={item}>{alertConditionLabel(item, t)}</option>)}
            </select>
          )}
        </Field>
        <Field label={byPrice ? t("alertPrice") : t("alertPercent")} unit={byPrice ? currency : "%"} error={touched ? error : undefined}
          {...(readAs ? { hint: readAs } : {})}>
          {(props) => <input {...props} data-focus-id="alert-value" inputMode="decimal" autoComplete="off" value={valueText} onChange={(event) => setValueText(event.target.value)} />}
        </Field>
        <Field label={t("alertNote")} hint={t("alertNoteHint")}>
          {(props) => <input {...props} maxLength={200} autoComplete="off" value={note} onChange={(event) => setNote(event.target.value)} />}
        </Field>
      </div>
      <p className="panelNote">{t("alertsNotifyOnly")}</p>
      <div className="alertFormActions">
        <button type="button" className="secondaryButton" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primaryButton" disabled={busy} aria-disabled={Boolean(touched && error) || undefined}>{busy ? t("saving") : t("saveAlert")}</button>
      </div>
    </form>
  );
}

/** Re-arm (once triggered; a day's move arms itself on the next trading day) and delete for one alert; delete asks once more in place. */
export function AlertActions({ alert, t, busy, onRearm, onDelete }: { alert: PriceAlert | AccountAlert; t: Translator; busy: boolean; onRearm: (id: string) => void; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="alertActions" role="group" aria-label={t("deleteAlertConfirm")}>
        <span className="mutedInline">{t("deleteAlertConfirm")}</span>
        <button type="button" className="linkButton" disabled={busy} onClick={() => setConfirming(false)}>{t("keepAlert")}</button>
        <button type="button" className="linkButton danger" disabled={busy} onClick={() => { setConfirming(false); onDelete(alert.id); }}>{t("deleteAlert")}</button>
      </div>
    );
  }
  return (
    <div className="alertActions">
      {alert.triggeredAt && alert.condition !== "day_move" && <button type="button" className="linkButton" disabled={busy} onClick={() => onRearm(alert.id)}>{t("rearmAlert")}</button>}
      <button type="button" className="linkButton danger" disabled={busy} onClick={() => setConfirming(true)}>{t("deleteAlert")}</button>
    </div>
  );
}
