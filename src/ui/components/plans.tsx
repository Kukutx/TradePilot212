// Standing investment plans on the automation page: each plan's buys and schedule, and, where the account can be
// written to, what can be done with it there rather than in the chat: open its orders now as a basket to review, pause
// or resume it, change it, delete it, and a form for a new one. Saving a plan places no order; a basket opened from
// it is sent only once confirmed, as any other.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { DcaLeg, DcaPlan, PlanFrequency } from "../../shared/automation";
import type { TradingEnvironment } from "../../shared/contracts";
import { symbolFromTicker } from "../../shared/ticker";
import { localeTag, type SupportedLocale } from "../i18n";
import { ambiguousComma, amount, dateTime, num, parseAmount } from "../lib/format";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { fill, type Translator } from "../lib/messages";
import { readAsHint } from "./alerts";
import { Choices, Field, Icon } from "./common";
import { fieldSelect, Select } from "./select";

/** As the server keeps them: up to ten buys a plan, names of up to 80 characters. */
export const MAX_LEGS = 10;
const MAX_LABEL = 80;
/** The hour a new plan becomes due, as the server's default: inside the US and European sessions. */
const DEFAULT_HOUR_UTC = 15;

/** What a plan is saved as, from the form. */
export interface PlanRequest {
  label?: string;
  legs?: DcaLeg[];
  targetAmount?: number;
  frequency: PlanFrequency;
  dayOfMonth?: number;
  weekday?: number;
  hourUtc: number;
  autoExecute?: boolean;
}

/** Weekday 1 = Monday … 7 = Sunday, in the user's language. 2024-01-01 was a Monday. */
export function weekdayName(weekday: number | undefined, locale: SupportedLocale): string {
  if (!weekday) return "";
  return new Intl.DateTimeFormat(localeTag(locale), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, weekday)));
}

export function planSchedule(plan: Pick<DcaPlan, "frequency" | "dayOfMonth" | "weekday" | "hourUtc">, t: Translator, locale: SupportedLocale): string {
  const hour = `${String(plan.hourUtc).padStart(2, "0")}:00 UTC`;
  return plan.frequency === "monthly" ? `${t("planMonthly").replace("{day}", String(plan.dayOfMonth))} · ${hour}` : `${t("planWeekly")} ${weekdayName(plan.weekday, locale)} · ${hour}`;
}

/** A buy as typed. `saved` is the saved leg's ticker and limit, which stay while the same instrument is named. */
interface LegDraft { ticker: string; amount: string; saved?: { ticker: string; limitOffsetPercent?: number } }
interface PlanDraft { label: string; mode: "legs" | "targets"; legs: LegDraft[]; targetAmount: string; frequency: PlanFrequency; dayOfMonth: number; weekday: number; hourUtc: number; autoExecute: boolean }

/** A typed amount above zero, as the other forms read it; a comma that could be either mark is not taken. */
const positive = (text: string) => { const value = parseAmount(text); return !ambiguousComma(text) && Number.isFinite(value) && value > 0; };

/** Whether a typed instrument is the saved leg's: its ticker, its symbol, or its short name, in any case. */
export function sameInstrument(typed: string, ticker: string, book?: InstrumentBook): boolean {
  const wanted = typed.trim().toUpperCase();
  return Boolean(wanted) && [ticker, symbolFromTicker(ticker), book?.[ticker]?.shortName].some((name) => name?.toUpperCase() === wanted);
}

/** The saved leg a typed one still names, if any: its ticker and limit (a percent above the last price) are kept. */
const savedLeg = (leg: LegDraft, book?: InstrumentBook) => (leg.saved && sameInstrument(leg.ticker, leg.saved.ticker, book) ? leg.saved : undefined);

/** What is wrong with the form, field by field: the server checks the same, and also that each instrument exists. */
export function planProblems(draft: PlanDraft): { legs: Array<{ ticker?: true; amount?: true }>; targetAmount?: true } {
  if (draft.mode === "targets") return { legs: [], ...(positive(draft.targetAmount) ? {} : { targetAmount: true as const }) };
  return { legs: draft.legs.map((leg) => ({ ...(leg.ticker.trim() ? {} : { ticker: true as const }), ...(positive(leg.amount) ? {} : { amount: true as const }) })) };
}

const hasProblem = (problems: ReturnType<typeof planProblems>) => Boolean(problems.targetAmount) || problems.legs.some((leg) => leg.ticker || leg.amount);

/** The form's starting values: the plan's own when changing one, a monthly plan on the 1st when adding one. */
export function planDraft(plan: DcaPlan | undefined): PlanDraft {
  // Plain figures, as typed: "1,250" would be refused as either mark.
  const figure = (value: number) => String(Math.round(value * 100) / 100);
  return {
    label: plan?.label ?? "",
    mode: plan?.targetAmount !== undefined ? "targets" : "legs",
    legs: plan?.legs.length ? plan.legs.map((leg) => ({ ticker: leg.ticker, amount: figure(leg.amount), saved: { ticker: leg.ticker, ...(leg.orderType === "limit" ? { limitOffsetPercent: leg.limitOffsetPercent ?? 0.5 } : {}) } })) : [{ ticker: "", amount: "" }],
    targetAmount: plan?.targetAmount !== undefined ? figure(plan.targetAmount) : "",
    frequency: plan?.frequency ?? "monthly",
    dayOfMonth: plan?.dayOfMonth ?? 1,
    weekday: plan?.weekday ?? 1,
    hourUtc: plan?.hourUtc ?? DEFAULT_HOUR_UTC,
    autoExecute: plan?.autoExecute ?? false,
  };
}

/**
 * The form as the plan it saves. A leg that still names its saved instrument, however typed, keeps that ticker and the
 * limit it had (set in the chat). A blank name is left to the server, which names the plan by what it buys.
 */
export function planRequest(draft: PlanDraft, environment: TradingEnvironment, book?: InstrumentBook): PlanRequest {
  const label = draft.label.trim();
  return {
    ...(label ? { label } : {}),
    ...(draft.mode === "targets"
      ? { targetAmount: parseAmount(draft.targetAmount) }
      : { legs: draft.legs.map((leg) => {
          const saved = savedLeg(leg, book);
          return { ticker: saved ? saved.ticker : leg.ticker.trim(), amount: parseAmount(leg.amount), ...(saved?.limitOffsetPercent !== undefined ? { orderType: "limit" as const, limitOffsetPercent: saved.limitOffsetPercent } : {}) };
        }) }),
    frequency: draft.frequency,
    ...(draft.frequency === "monthly" ? { dayOfMonth: draft.dayOfMonth } : { weekday: draft.weekday }),
    hourUtc: draft.hourUtc,
    ...(environment === "demo" ? { autoExecute: draft.autoExecute } : {}),
  };
}

/**
 * Only what changed, for a plan being changed: a schedule sent again, even the same, would start it again from now,
 * and buys sent again would be looked up again.
 */
export function planChanges(plan: DcaPlan, request: PlanRequest): Partial<PlanRequest> {
  const changes: Partial<PlanRequest> = {};
  if (request.label && request.label !== plan.label) changes.label = request.label;
  if (request.targetAmount !== undefined && request.targetAmount !== plan.targetAmount) changes.targetAmount = request.targetAmount;
  if (request.legs && JSON.stringify(request.legs) !== JSON.stringify(plan.legs.map((leg) => ({ ticker: leg.ticker, amount: leg.amount, ...(leg.orderType === "limit" ? { orderType: leg.orderType, limitOffsetPercent: leg.limitOffsetPercent ?? 0.5 } : {}) })))) changes.legs = request.legs;
  if (request.frequency !== plan.frequency || request.dayOfMonth !== plan.dayOfMonth || request.weekday !== plan.weekday || request.hourUtc !== plan.hourUtc) {
    Object.assign(changes, { frequency: request.frequency, hourUtc: request.hourUtc, ...(request.frequency === "monthly" ? { dayOfMonth: request.dayOfMonth } : { weekday: request.weekday }) });
  }
  if (request.autoExecute !== undefined && request.autoExecute !== plan.autoExecute) changes.autoExecute = request.autoExecute;
  return changes;
}

/** Focus the control a form names by its `data-focus-id` once it is drawn, then forget it. */
function useFocusAfter(scope: RefObject<HTMLElement | null>, deps: unknown[]) {
  const [target, setTarget] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!target) return;
    scope.current?.querySelector<HTMLElement>(`[data-focus-id="${target}"]`)?.focus();
    setTarget(null);
  }, [target, ...deps]);
  return setTarget;
}

export function PlanForm({ plan, environment, currency, hasTargets, book, locale, t, busy, error, onSave, onCancel }: {
  plan?: DcaPlan;
  /** For the name of an instrument typed by its ticker. */
  book?: InstrumentBook;
  environment: TradingEnvironment;
  currency?: string;
  /** Whether target weights are saved, for a plan that invests by them. */
  hasTargets: boolean;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  /** Why the last save failed, shown above the form's buttons. */
  error?: string;
  onSave: (request: PlanRequest) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => planDraft(plan));
  const [touched, setTouched] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const focus = useFocusAfter(formRef, [draft.legs.length]);
  // The name field takes focus as the form opens, from the button that opened it.
  useEffect(() => { formRef.current?.querySelector<HTMLElement>('[data-focus-id="plan-name"]')?.focus(); }, []);
  // A failed save is said where the form is, not only at the top of the page.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" }); }, [error]);
  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setLeg = (index: number, patch: Partial<LegDraft>) => setDraft((current) => ({ ...current, legs: current.legs.map((leg, at) => (at === index ? { ...leg, ...patch } : leg)) }));
  const problems = planProblems(draft);
  // An instrument the widget knows, typed by its ticker, is named under it.
  const named = (ticker: string) => { const label = book?.[ticker.trim()] ? instrumentLabel(ticker.trim(), book) : undefined; return label && label.name !== ticker.trim() ? label.name : undefined; };
  const wrong = hasProblem(problems);
  const submit = () => {
    setTouched(true);
    if (busy) return;
    // An invalid form says so at its first wrong field.
    if (wrong) { requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    onSave(planRequest(draft, environment, book));
  };
  const sum = (value: number) => amount(value, currency, locale);
  // A comma that could be either mark names both readings; a number typed with a separator says how it was read.
  const amountError = (text: string) => {
    if (ambiguousComma(text)) { const typed = text.normalize("NFKC").trim(); return fill(t("amountAmbiguous"), { decimal: typed.replace(",", "."), whole: typed.replace(",", "") }); }
    return touched && !positive(text) ? t("alertValueRequired") : undefined;
  };
  const readAs = (text: string) => (ambiguousComma(text) ? undefined : readAsHint(text, sum, t));
  const hints = (...parts: Array<string | undefined>) => { const hint = parts.filter(Boolean).join(" · "); return hint ? { hint } : {}; };
  const removeLeg = (index: number) => {
    set("legs", draft.legs.filter((_, at) => at !== index));
    // Focus moves to the buy that takes its place, or the one before the last.
    focus(`plan-leg-${Math.min(index, draft.legs.length - 2)}`);
  };
  const addLeg = () => { set("legs", [...draft.legs, { ticker: "", amount: "" }]); focus(`plan-leg-${draft.legs.length}`); };
  const days = Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));
  const weekdays = Array.from({ length: 7 }, (_, index) => ({ value: String(index + 1), label: weekdayName(index + 1, locale) }));
  const hours = Array.from({ length: 24 }, (_, index) => ({ value: String(index), label: `${String(index).padStart(2, "0")}:00 UTC` }));
  return (
    <form ref={formRef} className="alertForm planForm" noValidate aria-label={plan ? t("planEdit") : t("planNew")} onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <div className="formGrid">
        <Field label={t("planName")}>
          {(props) => <input {...props} data-focus-id="plan-name" maxLength={MAX_LABEL} autoComplete="off" placeholder={t("planNamePlaceholder")} value={draft.label} onChange={(event) => set("label", event.target.value)} />}
        </Field>
        <Field label={t("planBuys")} group hint={draft.mode === "targets" && !hasTargets ? t("planNoTargets") : undefined}>
          {(props) => <Choices {...props} value={draft.mode} options={[["legs", t("planByInstruments")], ["targets", t("planByTargetWeights")]]} onChange={(next) => set("mode", next)} />}
        </Field>
      </div>
      {draft.mode === "legs" ? (
        <fieldset className="planLegs">
          <legend>{t("planLegs")}</legend>
          {draft.legs.map((leg, index) => {
            const number = String(index + 1);
            const ticker = leg.ticker.trim();
            const saved = savedLeg(leg, book);
            return (
              <div className="planLeg" key={index}>
                <Field label={fill(t("planLegInstrument"), { number })} error={touched && problems.legs[index]?.ticker ? t("planLegTickerRequired") : undefined}
                  {...hints(named(leg.ticker))}>
                  {(props) => <input {...props} data-focus-id={`plan-leg-${index}`} autoComplete="off" spellCheck={false} placeholder={t("planLegPlaceholder")} value={leg.ticker} onChange={(event) => setLeg(index, { ticker: event.target.value })} />}
                </Field>
                <Field label={t("planLegAmount")} unit={currency} {...(amountError(leg.amount) ? { error: amountError(leg.amount)! } : {})}
                  {...hints(readAs(leg.amount), saved?.limitOffsetPercent !== undefined ? fill(t("planLegLimit"), { percent: num(saved.limitOffsetPercent, locale, 2) }) : undefined)}>
                  {(props) => <input {...props} aria-label={fill(t("planLegAmountName"), { number })} inputMode="decimal" autoComplete="off" value={leg.amount} onChange={(event) => setLeg(index, { amount: event.target.value })} />}
                </Field>
                {draft.legs.length > 1 && (
                  <button type="button" className="removeLegButton planLegRemove" aria-label={fill(t(ticker ? "planLegRemoveNamed" : "planLegRemove"), { number, ticker })} title={fill(t(ticker ? "planLegRemoveNamed" : "planLegRemove"), { number, ticker })}
                    onClick={() => removeLeg(index)}>
                    <Icon name="close" />
                  </button>
                )}
              </div>
            );
          })}
          {draft.legs.length < MAX_LEGS && <button type="button" className="linkButton" onClick={addLeg}>{t("planLegAdd")}</button>}
        </fieldset>
      ) : (
        <div className="formGrid">
          <Field label={t("planTargetAmount")} unit={currency} {...(amountError(draft.targetAmount) ? { error: amountError(draft.targetAmount)! } : {})} {...hints(readAs(draft.targetAmount), t("planTargetAmountHint"))}>
            {(props) => <input {...props} inputMode="decimal" autoComplete="off" value={draft.targetAmount} onChange={(event) => set("targetAmount", event.target.value)} />}
          </Field>
        </div>
      )}
      <div className="formGrid planSchedule">
        <Field label={t("planFrequency")} group>
          {(props) => <Choices {...props} value={draft.frequency} options={[["monthly", t("planEveryMonth")], ["weekly", t("planEveryWeek")]]} onChange={(next) => set("frequency", next)} />}
        </Field>
        {draft.frequency === "monthly" ? (
          <Field label={t("planDay")}>
            {(props) => <Select {...fieldSelect(props)} value={String(draft.dayOfMonth)} options={days} onChange={(next) => set("dayOfMonth", Number(next))} />}
          </Field>
        ) : (
          <Field label={t("planWeekday")}>
            {(props) => <Select {...fieldSelect(props)} value={String(draft.weekday)} options={weekdays} onChange={(next) => set("weekday", Number(next))} />}
          </Field>
        )}
        <Field label={t("planHour")} hint={t("planHourHint")}>
          {(props) => <Select {...fieldSelect(props)} value={String(draft.hourUtc)} options={hours} onChange={(next) => set("hourUtc", Number(next))} />}
        </Field>
      </div>
      {environment === "demo" && (
        <label className="toggleField">
          <input type="checkbox" checked={draft.autoExecute} onChange={(event) => set("autoExecute", event.target.checked)} />
          <span className="toggleTrack"><span /></span><span>{t("planAutoExecute")}</span>
        </label>
      )}
      <p className="panelNote">{environment === "demo" ? t("planFormNoteDemo") : t("planFormNoteLive")}</p>
      {error && (
        <div ref={errorRef} className="notice error compactNotice" role="alert">
          <div className="noticeCopy"><strong>{t("errorTitlePlan")}</strong><span>{error}</span></div>
        </div>
      )}
      <div className="alertFormActions">
        <button type="button" className="secondaryButton" onClick={onCancel}>{t("cancel")}</button>
        <button type="submit" className="primaryButton" aria-disabled={busy || Boolean(touched && wrong) || undefined}>{busy ? t("saving") : t("planSave")}</button>
      </div>
    </form>
  );
}

/** A plan's buttons: open its orders now, pause or resume, change, delete (asked once more first). */
function PlanActions({ plan, t, busy, onReview, onPause, onEdit, onDelete }: {
  plan: DcaPlan; t: Translator; busy: boolean;
  onReview: (id: string) => void; onPause: (id: string, paused: boolean) => void; onEdit: () => void; onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  const focus = useFocusAfter(scope, [confirming]);
  // While a change is saved the buttons stay focusable, so focus is not dropped from the one just pressed.
  const guarded = (action: () => void) => () => { if (!busy) action(); };
  const props = (action: () => void) => ({ "aria-disabled": busy || undefined, onClick: guarded(action) });
  return (
    <div ref={scope}>
      {confirming ? (
        <div className="alertActions" role="group" aria-label={t("planDeleteConfirm")}>
          <span className="mutedInline">{t("planDeleteConfirm")}</span>
          <button type="button" className="linkButton" data-focus-id="plan-keep" {...props(() => { setConfirming(false); focus("plan-delete"); })}>{t("planKeep")}</button>
          <button type="button" className="linkButton danger" {...props(() => { setConfirming(false); onDelete(plan.id); })}>{t("planDelete")}</button>
        </div>
      ) : (
        <div className="alertActions">
          <button type="button" className="linkButton" title={t("planReviewHint")} {...props(() => onReview(plan.id))}>{t("planReview")}</button>
          <button type="button" className="linkButton" {...props(() => onPause(plan.id, !plan.paused))}>{plan.paused ? t("planResume") : t("planPause")}</button>
          <button type="button" className="linkButton" data-focus-id={`plan-change-${plan.id}`} data-reveals="form" {...props(onEdit)}>{t("planChange")}</button>
          <button type="button" className="linkButton danger" data-focus-id="plan-delete" {...props(() => { setConfirming(true); focus("plan-keep"); })}>{t("planDelete")}</button>
        </div>
      )}
    </div>
  );
}

/** What a save resolved to: true once saved, or why it was not. */
export type PlanSaveResult = true | string;

export function PlanList({ plans, environment, currency, hasTargets, book, locale, t, busy, onSave, onChange, onDelete, onReview }: {
  plans: DcaPlan[];
  environment: TradingEnvironment;
  currency?: string;
  hasTargets: boolean;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  /** These are given only where the account can be written to. A form's save resolves true once saved, to close it. */
  onSave?: (request: PlanRequest) => Promise<PlanSaveResult>;
  onChange?: (planId: string, changes: Partial<PlanRequest> & { paused?: boolean }, inForm?: boolean) => Promise<PlanSaveResult>;
  onDelete?: (planId: string) => void;
  onReview?: (planId: string) => void;
}) {
  // The form open: "new", or the id of the plan being changed; and why its last save failed.
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | undefined>();
  const section = useRef<HTMLElement>(null);
  const focus = useFocusAfter(section, [editing, plans]);
  // A save still running when its form is closed, or another opened, does not close the one open then.
  const current = useRef(editing);
  current.current = editing;
  const open = (id: string | null) => { setEditing(id); setFailure(undefined); };
  const close = (id: string) => { open(null); focus(id === "new" ? "plan-add" : `plan-change-${id}`); };
  const sum = (value: number | undefined) => amount(value, currency, locale);
  const manage = Boolean(onSave && onChange && onDelete && onReview);
  const form = (plan?: DcaPlan) => {
    const id = plan?.id ?? "new";
    return (
      <PlanForm key={id} {...(plan ? { plan } : {})} {...(book ? { book } : {})} environment={environment} {...(currency ? { currency } : {})} hasTargets={hasTargets} locale={locale} t={t} busy={busy}
        {...(failure ? { error: failure } : {})}
        onCancel={() => close(id)}
        onSave={(request) => {
          const changes = plan ? planChanges(plan, request) : undefined;
          // Nothing changed is nothing to save.
          if (changes && Object.keys(changes).length === 0) { close(id); return; }
          setFailure(undefined);
          void (plan ? onChange!(plan.id, changes!, true) : onSave!(request)).then((result) => {
            if (current.current !== id) return;
            if (result === true) close(id);
            else setFailure(result);
          });
        }} />
    );
  };
  return (
    <section ref={section} className="dataPanel" aria-label={t("plansTitle")}>
      <div className="pieHeader">
        <h2 tabIndex={-1} data-focus-id="plans-heading">{t("plansTitle")}</h2>
        {manage && editing !== "new" && <button type="button" className="secondaryButton compactButton" data-focus-id="plan-add" data-reveals="form" onClick={() => open("new")}>{t("planAdd")}</button>}
      </div>
      {editing === "new" && manage && form()}
      {plans.length === 0 ? (editing !== "new" && <div className="emptyState compact">{manage ? t("noPlansManage") : t("noPlans")}</div>) : (
        <ul className="automationList">
          {plans.map((plan) => editing === plan.id && manage ? <li key={plan.id}>{form(plan)}</li> : (
            <li key={plan.id}>
              <div className="automationRow">
                <strong>{plan.label}</strong>
                <span className={`statusPill ${plan.paused ? "muted" : plan.autoExecute ? "auto" : ""}`}>{plan.paused ? t("planPaused") : plan.autoExecute ? t("planAuto") : t("planConfirm")}</span>
              </div>
              <small>{plan.targetAmount !== undefined
                ? fill(t("planByTargets"), { amount: sum(plan.targetAmount) })
                : plan.legs.map((leg) => `${instrumentLabel(leg.ticker, book).name} ${sum(leg.amount)}${leg.orderType === "limit" ? ` (${t("limit")} +${num(leg.limitOffsetPercent ?? 0.5, locale, 2)}%)` : ""}`).join(" · ")}</small>
              <small>{planSchedule(plan, t, locale)}{plan.paused ? "" : ` · ${t("nextRun")} ${dateTime(plan.nextRunAt, locale)}`}</small>
              {plan.lastOutcome && <small className="mutedInline">{plan.lastRunAt ? `${dateTime(plan.lastRunAt, locale)} · ` : ""}{plan.lastOutcome}</small>}
              {manage && <PlanActions plan={plan} t={t} busy={busy} onReview={onReview!} onPause={(id, paused) => void onChange!(id, { paused })} onEdit={() => open(plan.id)}
                onDelete={(id) => { onDelete!(id); focus("plans-heading"); }} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
