// Alerts on the account as a whole, on the automation page: the account value or free cash crossing an amount, and
// the account's day move. Each row says what it watches, the last value read, and when it fired; a form adds one.
// Alerts notify; they never trade.

import { useState } from "react";
import type { AccountAlert, AccountAlertCondition } from "../../shared/automation";
import type { SupportedLocale } from "../i18n";
import { amount, dateTime, dayLabel, num, parseAmount, pct } from "../lib/format";
import { fill, type Translator } from "../lib/messages";
import { AlertActions, readAsHint } from "./alerts";
import { Field } from "./common";

export interface AccountAlertRequest {
  condition: AccountAlertCondition;
  amount?: number;
  percent?: number;
  note?: string;
}

const CONDITIONS: AccountAlertCondition[] = ["value_below", "value_above", "day_move", "cash_above", "cash_below"];
const LABEL_KEY = {
  value_above: "accountAlertValueAbove",
  value_below: "accountAlertValueBelow",
  cash_above: "accountAlertCashAbove",
  cash_below: "accountAlertCashBelow",
  day_move: "accountAlertDayMove",
} as const;

export function accountAlertLabel(condition: AccountAlertCondition, t: Translator): string {
  return t(LABEL_KEY[condition]);
}

/** A starting amount from what the account holds now: 5% either side of its value, or round figures for cash. */
export function defaultAccountAlertValue(condition: AccountAlertCondition, now: { value?: number; cash?: number }): string {
  const round = (value: number) => String(Math.max(1, Math.round(value / 10) * 10));
  switch (condition) {
    case "day_move": return "2";
    case "value_above": return now.value ? round(now.value * 1.05) : "";
    case "value_below": return now.value ? round(now.value * 0.95) : "";
    case "cash_above": return now.cash !== undefined ? round(Math.max(now.cash * 2, 100)) : "";
    case "cash_below": return now.cash ? round(now.cash / 2) : "";
  }
}

/** The same limits the server applies: a positive amount, and a percent below 100. */
export function accountAlertProblem(condition: AccountAlertCondition, text: string): "required" | "range" | undefined {
  const value = parseAmount(text);
  if (!text.trim() || !Number.isFinite(value) || value <= 0) return "required";
  return condition === "day_move" && value >= 100 ? "range" : undefined;
}

export function AccountAlertForm({ currency, now, locale, t, busy, onSave, onCancel }: {
  currency?: string;
  /** For saying what a typed number was read as. */
  locale?: SupportedLocale;
  /** The account's value and free cash now, for starting amounts. */
  now: { value?: number; cash?: number };
  t: Translator;
  busy: boolean;
  onSave: (request: AccountAlertRequest) => void;
  onCancel: () => void;
}) {
  const [condition, setCondition] = useState<AccountAlertCondition>("value_below");
  const [valueText, setValueText] = useState(() => defaultAccountAlertValue("value_below", now));
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const byPercent = condition === "day_move";
  const problem = accountAlertProblem(condition, valueText);
  const error = problem === "required" ? t("alertValueRequired") : problem === "range" ? fill(t("alertPercentRange"), { limit: "100" }) : undefined;
  const readAs = locale ? readAsHint(valueText, (read) => (byPercent ? `${num(read, locale, 2)}%` : amount(read, currency, locale)), t) : undefined;
  const submit = () => {
    setTouched(true);
    if (error || busy) return;
    const value = parseAmount(valueText);
    onSave({ condition, ...(byPercent ? { percent: value } : { amount: value }), ...(note.trim() ? { note: note.trim() } : {}) });
  };
  return (
    <form className="alertForm" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="formGrid">
        <Field label={t("alertCondition")}>
          {(props) => (
            <select {...props} value={condition} onChange={(event) => {
              const next = event.target.value as AccountAlertCondition;
              setCondition(next);
              setValueText(defaultAccountAlertValue(next, now));
              setTouched(false);
            }}>
              {CONDITIONS.map((item) => <option key={item} value={item}>{accountAlertLabel(item, t)}</option>)}
            </select>
          )}
        </Field>
        <Field label={byPercent ? t("alertPercent") : t("accountAlertAmount")} unit={byPercent ? "%" : currency} error={touched ? error : undefined}
          {...(readAs ? { hint: readAs } : {})}>
          {(props) => <input {...props} data-focus-id="account-alert-value" inputMode="decimal" autoComplete="off" value={valueText} onChange={(event) => setValueText(event.target.value)} />}
        </Field>
        <Field label={t("alertNote")} hint={t("alertNoteHint")}>
          {(props) => <input {...props} maxLength={200} autoComplete="off" value={note} onChange={(event) => setNote(event.target.value)} />}
        </Field>
      </div>
      <p className="panelNote">{t("accountAlertsNote")}</p>
      <div className="alertFormActions">
        <button type="button" className="secondaryButton" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primaryButton" disabled={busy} aria-disabled={Boolean(touched && error) || undefined}>{busy ? t("saving") : t("saveAlert")}</button>
      </div>
    </form>
  );
}

/** What an alert watches, as its row's title: "Account value at or below £10,000.00", "Account's day move either way of 2%". */
export function accountAlertTarget(alert: AccountAlert, locale: SupportedLocale): string {
  return alert.condition === "day_move" ? `${num(alert.percent, locale, 2)}%` : amount(alert.amount, alert.currency, locale);
}

/** The last value read, and when it fired: a day's move with its day, value and cash in the account currency. */
function accountAlertDetail(alert: AccountAlert, locale: SupportedLocale, t: Translator): { last?: string; fired?: string } {
  const value = (figure: number | undefined, day?: string) => (alert.condition === "day_move"
    ? fill(t("accountAlertDayValue"), { change: pct(figure, locale, 2, { signed: true }), day: day ? dayLabel(day, locale, { year: false }) : "" })
    : amount(figure, alert.currency, locale));
  return {
    ...(alert.lastValue !== undefined ? { last: fill(t("accountAlertLast"), { value: value(alert.lastValue, alert.lastDay) }) } : {}),
    ...(alert.triggeredAt ? { fired: `${dateTime(alert.triggeredAt, locale)} · ${value(alert.triggeredValue, alert.triggeredDay)}${alert.condition === "day_move" ? ` · ${t("alertDayAgain")}` : ""}` } : {}),
  };
}

export function AccountAlertList({ alerts, currency, now, locale, t, busy, onSave, onDelete, onRearm }: {
  alerts: AccountAlert[];
  currency?: string;
  now: { value?: number; cash?: number };
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  /** Resolves true once saved, to close the form. */
  onSave?: (request: AccountAlertRequest) => Promise<boolean>;
  onDelete?: (alertId: string) => void;
  onRearm?: (alertId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="dataPanel" aria-label={t("accountAlertsTitle")}>
      <div className="pieHeader">
        <h2>{t("accountAlertsTitle")}</h2>
        {onSave && !adding && <button type="button" className="secondaryButton compactButton" onClick={() => setAdding(true)}>{t("addAlert")}</button>}
      </div>
      {adding && onSave && (
        <AccountAlertForm {...(currency ? { currency } : {})} now={now} locale={locale} t={t} busy={busy}
          onCancel={() => setAdding(false)}
          onSave={(request) => void onSave(request).then((saved) => { if (saved) setAdding(false); })} />
      )}
      {alerts.length === 0 ? (!adding && <div className="emptyState compact">{t("noAccountAlerts")}</div>) : (
        <ul className="automationList">
          {alerts.map((alert) => {
            const detail = accountAlertDetail(alert, locale, t);
            return (
              <li key={alert.id}>
                <div className="automationRow">
                  <strong>{accountAlertLabel(alert.condition, t)} {accountAlertTarget(alert, locale)}</strong>
                  <span className={`statusPill ${alert.triggeredAt ? "fired" : ""}`}>{alert.triggeredAt ? t("alertTriggered") : t("alertArmed")}</span>
                </div>
                {detail.last && <small>{detail.last}</small>}
                {detail.fired && <small>{detail.fired}</small>}
                {alert.note && <small className="mutedInline">{alert.note}</small>}
                {onDelete && onRearm && <AlertActions alert={alert} t={t} busy={busy} onRearm={onRearm} onDelete={onDelete} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
