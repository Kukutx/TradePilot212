// Changing an open order (2.100): an editor for what can change (quantity, limit or stop price, validity) and a final
// confirmation that shows the order as it is beside the order that replaces it. Trading 212 can't edit an order, so the
// server cancels it and places the new one only once the cancel shows nothing of it filled; both views say so.

import { useState } from "react";
import type { PendingOrder, Position, ReplaceChanges, ReplacePreview, TimeValidity, TradingEnvironment } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n";
import { Choices, Field, Icon, InstrumentName, useDialog } from "../components/common";
import { ambiguousComma, amount, dateTime, money, notional, parseAmount, qty, time } from "../lib/format";
import { orderCurrency, type InstrumentBook } from "../lib/instruments";
import { envLabel, fill, noticeText, orderTypeLabel, validityLabel, type Translator } from "../lib/messages";
import { cancelDescription, LiveAcknowledgement, OrderImpactRows, PolicyList } from "./OrderViews";

/** The open order's own figures, as the editor starts from them. */
export function openOrderTerms(order: PendingOrder) {
  const type = String(order.type ?? "").replaceAll("-", "_").toLowerCase();
  const validity = String(order.timeInForce ?? order.timeValidity ?? "").toUpperCase();
  return {
    type,
    side: String(order.side ?? "").toUpperCase() === "SELL" || Number(order.quantity ?? 0) < 0 ? "sell" as const : "buy" as const,
    quantity: Math.abs(Number(order.quantity ?? 0)),
    ...(typeof order.limitPrice === "number" ? { limitPrice: order.limitPrice } : {}),
    ...(typeof order.stopPrice === "number" ? { stopPrice: order.stopPrice } : {}),
    timeValidity: (validity === "GOOD_TILL_CANCEL" ? "GOOD_TILL_CANCEL" : "DAY") as TimeValidity,
    needsLimit: type === "limit" || type === "stop_limit",
    needsStop: type === "stop" || type === "stop_limit",
  };
}

/**
 * What the form changes, against the open order: only the fields that differ, so the review is of exactly that. An
 * empty or unreadable field changes nothing and is reported as an error instead.
 */
export function changesFrom(order: PendingOrder, form: { quantity: string; limitPrice: string; stopPrice: string; timeValidity: TimeValidity }): { changes: ReplaceChanges; invalid: Array<keyof ReplaceChanges> } {
  const terms = openOrderTerms(order);
  const changes: ReplaceChanges = {};
  const invalid: Array<keyof ReplaceChanges> = [];
  const read = (text: string) => { const value = parseAmount(text); return !ambiguousComma(text) && Number.isFinite(value) && value > 0 ? value : undefined; };
  const take = (key: "quantity" | "limitPrice" | "stopPrice", text: string, was: number | undefined) => {
    const value = read(text);
    if (value === undefined) invalid.push(key);
    else if (value !== was) changes[key] = value;
  };
  take("quantity", form.quantity, terms.quantity);
  if (terms.needsLimit) take("limitPrice", form.limitPrice, terms.limitPrice);
  if (terms.needsStop) take("stopPrice", form.stopPrice, terms.stopPrice);
  if (form.timeValidity !== terms.timeValidity) changes.timeValidity = form.timeValidity;
  return { changes, invalid };
}

export function ReplaceEditor({ environment, order, initial, positions, book, locale, t, busy, onClose, onReview }: {
  environment: TradingEnvironment;
  order: PendingOrder;
  /** A change proposed elsewhere (the model's), for the form to start from. */
  initial?: ReplaceChanges;
  positions?: Position[];
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onClose: () => void;
  onReview: (changes: ReplaceChanges) => void;
}) {
  const terms = openOrderTerms(order);
  const start = { ...terms, ...initial };
  const [quantity, setQuantity] = useState(String(start.quantity));
  const [limitPrice, setLimitPrice] = useState(start.limitPrice === undefined ? "" : String(start.limitPrice));
  const [stopPrice, setStopPrice] = useState(start.stopPrice === undefined ? "" : String(start.stopPrice));
  const [timeValidity, setTimeValidity] = useState<TimeValidity>(start.timeValidity);
  const [touched, setTouched] = useState(false);
  const { changes, invalid } = changesFrom(order, { quantity, limitPrice, stopPrice, timeValidity });
  const unchanged = Object.keys(changes).length === 0;
  const currency = orderCurrency(order, positions, book);
  const ticker = String(order.ticker ?? "");
  const errorFor = (key: keyof ReplaceChanges, text: string) => {
    if (!invalid.includes(key) || (!touched && text !== "")) return undefined;
    return ambiguousComma(text) ? fill(t("amountAmbiguous"), { decimal: text.trim().replace(",", "."), whole: text.trim().replace(",", "") }) : t(key === "quantity" ? "quantityRequired" : "priceRequired");
  };
  const review = () => { setTouched(true); if (!invalid.length && !unchanged && !busy) onReview(changes); };
  const live = environment === "live";
  return (
    <main className="transactionStage">
      <section className={`transactionPanel ${live ? "liveTransaction" : ""}`} aria-labelledby="change-editor-title">
        <div className="transactionHeader">
          <div>
            <span className={`environmentTag ${environment}`}>{envLabel(environment, t)}</span>
            <h2 id="change-editor-title">{t("changeOrderTitle")}</h2>
            <InstrumentName ticker={ticker} book={book} className="headerInstrument" />
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>
        </div>
        <div className="changeOriginal">
          <span>{t("changeOriginal")}</span>
          <strong>{cancelDescription({ orderId: String(order.id ?? ""), order }, t, locale, positions, book)}</strong>
        </div>
        <form className="formGrid" noValidate onSubmit={(event) => { event.preventDefault(); review(); }}>
          <Field label={t("quantity")} error={errorFor("quantity", quantity)}>
            {(props) => <input {...props} inputMode="decimal" autoComplete="off" required value={quantity} onChange={(event) => setQuantity(event.target.value)} />}
          </Field>
          {terms.needsLimit && (
            <Field label={t("limitPrice")} unit={currency} error={errorFor("limitPrice", limitPrice)}>
              {(props) => <input {...props} inputMode="decimal" autoComplete="off" required value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} />}
            </Field>
          )}
          {terms.needsStop && (
            <Field label={t("stopPrice")} unit={currency} error={errorFor("stopPrice", stopPrice)}>
              {(props) => <input {...props} inputMode="decimal" autoComplete="off" required value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} />}
            </Field>
          )}
          <Field label={t("validity")} group>{(props) => <Choices {...props} value={timeValidity} options={[["DAY", t("day")], ["GOOD_TILL_CANCEL", t("gtc")]]} onChange={setTimeValidity} />}</Field>
        </form>
        <div className="notice compactNotice changeHow">
          <span>{t("changeHow")}</span>
          <span>{t("changeKeeps")}</span>
        </div>
        {unchanged && touched && <div className="notice warning compactNotice" role="status">{t("changeNothing")}</div>}
        <div className="transactionFooter">
          <button type="button" className="secondaryButton" onClick={onClose}>{t("cancel")}</button>
          <button type="button" className="primaryButton" data-focus-id="review-change" data-reveals="confirmation" disabled={busy} aria-disabled={invalid.length > 0 || unchanged || undefined} onClick={review}>
            {busy ? t("checking") : t("reviewChange")}
          </button>
        </div>
      </section>
    </main>
  );
}

/** The order as it is beside the order that replaces it, with what changed marked in words, not color alone. */
export function ReplaceConfirmation({ preview, positions, book, locale, t, busy, onBack, onConfirm }: {
  preview: ReplacePreview;
  positions?: Position[];
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy: boolean;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
}) {
  const live = preview.environment === "live";
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useDialog();
  const was = openOrderTerms(preview.original);
  const draft = preview.draft;
  const currency = preview.instrument.currencyCode || orderCurrency(preview.original, positions, book);
  const price = (value: number | undefined) => (value === undefined ? "—" : amount(value, currency, locale));
  const rows: Array<{ key: string; label: string; before: string; after: string }> = [
    { key: "side", label: t("side"), before: was.side === "sell" ? t("sell") : t("buy"), after: draft.side === "sell" ? t("sell") : t("buy") },
    { key: "type", label: t("type"), before: orderTypeLabel(String(preview.original.type ?? ""), t), after: orderTypeLabel(draft.type, t) },
    { key: "quantity", label: t("quantity"), before: qty(was.quantity, locale), after: qty(draft.quantity, locale) },
    ...(was.needsLimit ? [{ key: "limit", label: t("limitPrice"), before: price(was.limitPrice), after: price(draft.limitPrice) }] : []),
    ...(was.needsStop ? [{ key: "stop", label: t("stopPrice"), before: price(was.stopPrice), after: price(draft.stopPrice) }] : []),
    { key: "validity", label: t("validity"), before: validityLabel(was.timeValidity, t), after: validityLabel(draft.timeValidity, t) },
  ];
  const blocked = (preview.policy ?? []).some((check) => check.status === "block");
  return (
    <main className="transactionStage">
      <section ref={dialog.panel} className={`transactionPanel confirmationPanel ${live ? "liveTransaction" : ""}`} {...dialog.props}>
        <div className="confirmationHero">
          <span className={`environmentTag ${preview.environment}`}>{envLabel(preview.environment, t)}</span>
          <span className="sectionEyebrow">{t("finalConfirmation")}</span>
          <h2 id={dialog.headingId} ref={dialog.heading} tabIndex={-1}>{live ? t("changeConfirmTitleLive") : t("changeConfirmTitleDemo")}</h2>
          <InstrumentName ticker={draft.ticker} book={book} instrument={preview.instrument} className="headerInstrument" />
          <strong className="confirmationAmount">{notional(preview.estimatedNotional, preview.estimatedNotionalCurrency || currency, locale)}</strong>
          {preview.estimatedAccountNotional !== undefined && preview.accountCurrency && (
            <span className="confirmationConverted">≈ {money(preview.estimatedAccountNotional, preview.accountCurrency, locale)} · {t("inAccountCurrency")}</span>
          )}
        </div>
        <table className="changeCompare">
          <caption className="visuallyHidden">{fill(t("orderNumber"), { id: preview.orderId })}</caption>
          <thead>
            <tr><th scope="col">{t("changeField")}</th><th scope="col">{t("changeOriginal")}</th><th scope="col">{t("changeNew")}</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const changed = row.before !== row.after;
              return (
                <tr key={row.key} className={changed ? "changed" : undefined}>
                  <th scope="row">{row.label}</th>
                  <td>{row.before}</td>
                  <td>{row.after}{changed && <span className="changeBadge">{t("changeChanged")}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="notice compactNotice changeHow"><span>{t("changeHow")}</span></div>
        {preview.impact && <OrderImpactRows impact={preview.impact} locale={locale} t={t} />}
        {(preview.notices ?? []).map((notice) => <div className="notice warning compactNotice" key={notice.code}>{noticeText(notice, t, locale)}</div>)}
        <PolicyList checks={preview.policy} t={t} locale={locale} />
        <div className="expiryLine">{t("snapshotAsOf")} · {dateTime(preview.snapshotAt, locale)} · {t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        {live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter">
          <button type="button" className="secondaryButton" onClick={onBack}>{t("backToEdit")}</button>
          <button type="button" className={live ? "dangerButton" : "primaryButton"} disabled={busy || (live && !acknowledged) || blocked} onClick={() => onConfirm(live && acknowledged)}>
            {busy ? t("submitting") : live ? t("confirmChangeLive") : t("confirmChangeDemo")}
          </button>
        </div>
      </section>
    </main>
  );
}

/** A reason a change stopped, in the widget's language. */
export function replaceReasonText(reason: string | undefined, t: Translator): string | undefined {
  switch (reason) {
    case "gone": return t("changeReasonGone");
    case "filled": return t("changeReasonFilled");
    case "partly_filled": return t("changeReasonPartlyFilled");
    case "changed": return t("changeReasonChanged");
    case "check_failed": return t("changeReasonCheckFailed");
    case "cancel_rejected": return t("changeReasonCancelRejected");
    case "not_confirmed": return t("changeReasonNotConfirmed");
    case "placement_rejected": return t("changeReasonPlacementRejected");
    default: return undefined;
  }
}

