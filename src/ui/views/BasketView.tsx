import { useState, type ReactNode } from "react";
import { BASKET_ORDER_NOTE } from "../../shared/automation";
import type {
  BasketDraftPayload,
  BasketExecutionResult,
  BasketLeg,
  BasketPreview,
  RebalancePlan,
  RebalanceTrade,
} from "../../shared/automation";
import type { ExecutionVerificationResult, OrderNotice } from "../../shared/contracts";
import { tradeTotals, type TradeTotals } from "../../shared/trade-cost";
import type { MessageKey, SupportedLocale } from "../i18n";
import { AssetAvatar, DetailRow, Icon, InstrumentName, useDialog } from "../components/common";
import { amount, dateTime, money, notional, pct, qty, time } from "../lib/format";
import { instrumentCurrency, instrumentLabel, type InstrumentBook } from "../lib/instruments";
import {
  basketNoteText,
  basketResultText,
  basketTitle,
  countText,
  envLabel,
  formatProblem,
  legReason,
  legSkipText,
  noticeText,
  orderTypeLabel,
  purposeLabel,
  rebalanceNoteText,
  rebalanceSkipText,
  validityLabel,
  verificationText,
  type Translator,
} from "../lib/messages";
import { LiveAcknowledgement, PolicyList } from "./OrderViews";

export type BasketDraftView = BasketDraftPayload & { rebalance?: RebalancePlan };

type BasketShape = Pick<BasketDraftPayload, "purpose" | "title"> & { legs: BasketLeg[] };

/** What a leg costs or raises: the server's estimate, the rebalance value, or quantity times its price. */
function legAmount(leg: BasketLeg, trade: RebalanceTrade | undefined, accountCurrency: string | undefined, book: InstrumentBook | undefined, locale: SupportedLocale): string | undefined {
  if (leg.estimatedNotional !== undefined) {
    const currency = leg.estimatedNotionalCurrency ?? instrumentCurrency(leg.draft.ticker, book, leg.instrument) ?? accountCurrency;
    return notional(leg.estimatedNotional, currency, locale);
  }
  if (trade && accountCurrency) return `≈ ${money(trade.value, accountCurrency, locale)}`;
  const price = leg.draft.limitPrice ?? leg.draft.stopPrice ?? leg.draft.referencePrice;
  const currency = instrumentCurrency(leg.draft.ticker, book, leg.instrument);
  if (price === undefined || !currency) return undefined;
  return `≈ ${notional(price * leg.draft.quantity, currency, locale)}`;
}

/** One line per order: name and symbol, side and quantity, amount, and the remove button when there is one. */
function LegRow({ leg, trade, accountCurrency, book, t, locale, children }: {
  leg: BasketLeg;
  trade?: RebalanceTrade;
  accountCurrency?: string;
  book?: InstrumentBook;
  t: Translator;
  locale: SupportedLocale;
  children?: ReactNode;
}) {
  const draft = leg.draft;
  const label = instrumentLabel(draft.ticker, book, leg.instrument);
  const sum = legAmount(leg, trade, accountCurrency, book, locale);
  return (
    <div className="legRow">
      <AssetAvatar ticker={draft.ticker} label={label} />
      <InstrumentName ticker={draft.ticker} book={book} instrument={leg.instrument} className="legName" />
      <span className={`sideBadge ${draft.side}`}>{draft.side === "buy" ? t("buy") : t("sell")} · {qty(draft.quantity, locale)}</span>
      {sum && <span className="legAmount">{sum}</span>}
      {children}
    </div>
  );
}

function LegFacts({ leg, trade, basket, accountCurrency, book, t, locale }: { leg: BasketLeg; trade?: RebalanceTrade; basket: BasketShape; accountCurrency?: string; book?: InstrumentBook; t: Translator; locale: SupportedLocale }) {
  const draft = leg.draft;
  const priceCurrency = instrumentCurrency(draft.ticker, book, leg.instrument) ?? trade?.currency;
  const price = (value: number) => amount(value, priceCurrency, locale);
  const reason = trade ? undefined : legReason(leg, basket, t);
  return (
    <dl className="basketFacts">
      <div><dt>{t("type")}</dt><dd>{orderTypeLabel(draft.type, t)}{draft.type !== "market" ? ` · ${validityLabel(draft.timeValidity, t)}` : ""}</dd></div>
      {draft.limitPrice !== undefined && <div><dt>{t("limitPrice")}</dt><dd>{price(draft.limitPrice)}</dd></div>}
      {draft.stopPrice !== undefined && <div><dt>{t("stopPrice")}</dt><dd>{price(draft.stopPrice)}</dd></div>}
      {draft.referencePrice !== undefined && draft.type === "market" && <div><dt>{t("referencePrice")}</dt><dd>{price(draft.referencePrice)}</dd></div>}
      {leg.estimatedAccountNotional !== undefined && accountCurrency && <div><dt>{t("inAccountCurrency")}</dt><dd>≈ {money(leg.estimatedAccountNotional, accountCurrency, locale)}</dd></div>}
      {trade && (
        <div className="wide">
          <dt>{t("weightCurrentToResulting")}</dt>
          <dd>{pct(trade.currentWeight, locale)} → {pct(trade.resultingWeight, locale)} <span className="mutedInline">({t("targetWeight")} {pct(trade.targetWeight, locale)})</span></dd>
        </div>
      )}
      {reason && <div className="wide"><dt>{t("reason")}</dt><dd>{reason}</dd></div>}
    </dl>
  );
}

function BasketHeader({
  environment,
  basket,
  count,
  book,
  t,
  locale,
  onClose,
  headingProps,
}: {
  environment: BasketDraftView["environment"];
  basket: BasketShape;
  count: number;
  book?: InstrumentBook;
  t: Translator;
  locale: SupportedLocale;
  onClose?: () => void;
  headingProps?: { id: string };
}) {
  const title = basketTitle(basket, t, book);
  const purpose = purposeLabel(basket.purpose, t, basket.legs);
  return (
    <div className="transactionHeader">
      <div>
        <span className={`environmentTag ${environment}`}>{envLabel(environment, t)}</span>
        {purpose !== title && <span className="purposeTag">{purpose}</span>}
        <h2 {...headingProps}>{title}</h2>
        <p>{countText("orders", count, t, locale)}</p>
      </div>
      {onClose && <button className="closeButton" type="button" onClick={onClose} aria-label={t("close")}><Icon name="close" /></button>}
    </div>
  );
}

function Notes({ notes, basket, plan, book, t, locale }: { notes: string[]; basket: BasketShape; plan?: RebalancePlan; book?: InstrumentBook; t: Translator; locale: SupportedLocale }) {
  if (!notes.length) return null;
  const details = new Map((plan?.noteDetails ?? []).map((note) => [note.message, note]));
  const text = (note: string) => {
    const known = details.get(note);
    return known ? rebalanceNoteText(known, t, locale, book) : basketNoteText(note, basket, t, locale, book);
  };
  return (
    <div className="basketNotes">
      <span className="policyTitle">{t("basketNotes")}</span>
      <ul>{notes.map((note, index) => <li key={`${index}-${note}`}>{text(note)}</li>)}</ul>
    </div>
  );
}

/**
 * Skipped instruments are listed in the rebalance summary, so their copies in the notes are dropped,
 * as is the server's sending-order note, which the widget shows in its own language.
 */
function withoutSkipped(all: string[], plan?: RebalancePlan): string[] {
  const notes = all.filter((note) => note !== BASKET_ORDER_NOTE);
  if (!plan?.skipped.length) return notes;
  const skipped = new Set(plan.skipped.map((item) => `${item.ticker}: ${item.reason}`));
  return notes.filter((note) => !skipped.has(note) && !note.startsWith(`Skipped ${plan.skipped.length} instrument(s)`));
}

/**
 * What the trades still in the basket come to, and the cash after them: the plan's own figures while every trade is
 * there, worked out again from the ones left once some are taken out (the fee at the plan's rate).
 */
export function basketTotals(plan: RebalancePlan, kept: readonly RebalanceTrade[]): { totals?: TradeTotals; cashAfter: number } {
  if (kept.length === plan.trades.length) return { ...(plan.totals ? { totals: plan.totals } : {}), cashAfter: plan.cashAfter };
  const totals = tradeTotals(kept, plan.accountCurrency, plan.totals?.fxFeeRate ?? 0);
  // The fee comes off what a sell raises and on top of what a buy costs.
  const cashAfter = Math.round((plan.cashBefore + totals.sold - totals.bought - totals.fxFee) * 100) / 100;
  return { ...(plan.totals ? { totals } : {}), cashAfter };
}

function RebalanceSummary({ plan, kept, book, t, locale }: { plan: RebalancePlan; kept: readonly RebalanceTrade[]; book?: InstrumentBook; t: Translator; locale: SupportedLocale }) {
  // What the trades come to, and the conversion fee on the ones in other currencies (its note says when there is none).
  const { totals, cashAfter } = basketTotals(plan, kept);
  return (
    <section className="rebalanceSummary" aria-label={t("rebalanceSummary")}>
      <span className="policyTitle">{t("rebalanceSummary")}</span>
      <div className="confirmationRows">
        <DetailRow label={t("totalValue")} value={money(plan.totalValue, plan.accountCurrency, locale)} />
        <DetailRow label={t("cashBefore")} value={money(plan.cashBefore, plan.accountCurrency, locale)} />
        <DetailRow label={t("cashAfter")} value={money(cashAfter, plan.accountCurrency, locale)} />
        {totals && totals.bought > 0 && <DetailRow label={t("rebalanceBought")} value={money(totals.bought, plan.accountCurrency, locale)} />}
        {totals && totals.sold > 0 && <DetailRow label={t("rebalanceSold")} value={money(totals.sold, plan.accountCurrency, locale)} />}
        {totals && totals.converted > 0 && totals.fxFeeRate > 0 && <DetailRow label={t("rebalanceFxFee")} value={money(totals.fxFee, plan.accountCurrency, locale)} />}
      </div>
      {plan.skipped.length > 0 && (
        <div className="basketNotes">
          <span className="policyTitle">{t("skippedTickers")}</span>
          <ul>{plan.skipped.map((item, index) => <li key={`${item.ticker}-${index}`}><strong title={item.ticker}>{instrumentLabel(item.ticker, book).name}</strong> · {rebalanceSkipText(item, t)}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

export function BasketView({
  payload,
  legs,
  preview,
  result,
  verifications,
  canReview,
  busy,
  book,
  locale,
  t,
  onRemoveLeg,
  onReview,
  onBack,
  onConfirm,
  onClose,
  onVerify,
}: {
  payload: BasketDraftView;
  legs: BasketLeg[];
  preview: BasketPreview | null;
  result: BasketExecutionResult | null;
  verifications: Record<string, ExecutionVerificationResult>;
  canReview: boolean;
  busy: boolean;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onRemoveLeg: (index: number) => void;
  onReview: () => void;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
  onClose: () => void;
  onVerify: (verificationId: string) => void;
}) {
  // The legs still in the basket, so removing one relabels it ("Stop-loss" once only the stop is left).
  const basket: BasketShape = { purpose: payload.purpose, title: payload.title, legs };
  if (result) return <BasketResultView result={result} basket={basket} verifications={verifications} busy={busy} book={book} locale={locale} t={t} onClose={onClose} onVerify={onVerify} />;
  if (preview) return <BasketConfirmation preview={preview} basket={basket} rebalance={payload.rebalance} busy={busy} book={book} locale={locale} t={t} onBack={onBack} onConfirm={onConfirm} />;

  const tradeFor = (leg: BasketLeg) => payload.rebalance?.trades.find((trade) => trade.ticker === leg.draft.ticker && trade.side === leg.draft.side);
  const live = payload.environment === "live";
  const accountCurrency = payload.rebalance?.accountCurrency;
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${live ? "liveTransaction" : ""}`} aria-labelledby="basket-title">
        <BasketHeader environment={payload.environment} basket={basket} count={legs.length} book={book} t={t} locale={locale} onClose={onClose} headingProps={{ id: "basket-title" }} />
        {payload.rebalance && <RebalanceSummary plan={payload.rebalance} kept={legs.map(tradeFor).filter((trade): trade is RebalanceTrade => !!trade)} book={book} t={t} locale={locale} />}
        {legs.length === 0 ? <div className="emptyState compact">{t("basketEmpty")}</div> : (
          <ol className="basketLegList">
            {legs.map((leg, index) => (
              <li className="basketLeg" key={`${leg.draft.ticker}-${leg.draft.side}-${index}`}>
                <LegRow leg={leg} trade={tradeFor(leg)} accountCurrency={accountCurrency} book={book} t={t} locale={locale}>
                  <button className="removeLegButton" type="button" disabled={busy} onClick={() => onRemoveLeg(index)} aria-label={`${t("removeLeg")} · ${instrumentLabel(leg.draft.ticker, book, leg.instrument).name}`} title={t("removeLeg")}>
                    <Icon name="close" />
                  </button>
                </LegRow>
                <LegFacts leg={leg} trade={tradeFor(leg)} basket={basket} accountCurrency={accountCurrency} book={book} t={t} locale={locale} />
              </li>
            ))}
          </ol>
        )}
        <Notes notes={withoutSkipped(payload.notes, payload.rebalance)} basket={basket} plan={payload.rebalance} book={book} t={t} locale={locale} />
        <p className="basketHint">{legs.length > 1 ? `${t("basketRemoveHint")} ${t("basketOrderNote")}` : t("basketRemoveHint")}</p>
        {!canReview && <div className="notice warning compactNotice">{t("basketReadonlyHint")}</div>}
        <div className="transactionFooter">
          <button className="secondaryButton" type="button" onClick={onClose}>{t("cancel")}</button>
          <button className="primaryButton" type="button" data-focus-id="review-basket" disabled={busy || !canReview || legs.length === 0} onClick={onReview}>{busy ? t("checking") : t("reviewBasket")}</button>
        </div>
      </section>
    </main>
  );
}

function BasketConfirmation({
  preview,
  basket,
  rebalance,
  busy,
  book,
  locale,
  t,
  onBack,
  onConfirm,
}: {
  preview: BasketPreview;
  basket: BasketShape;
  rebalance?: RebalancePlan;
  busy: boolean;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onBack: () => void;
  onConfirm: (liveAcknowledged: boolean) => void;
}) {
  const live = preview.environment === "live";
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useDialog();
  // A LIVE_FUNDS notice applies to the whole basket; show it once instead of on every leg.
  const liveFunds = preview.legs.flatMap((leg) => leg.notices).find((notice) => notice.code === "LIVE_FUNDS");
  const legNotices = (notices: OrderNotice[]) => notices.filter((notice) => notice.code !== "LIVE_FUNDS");
  const blocked = preview.legs.some((leg) => leg.policy.some((check) => check.status === "block"));
  const tradeFor = (leg: BasketLeg) => rebalance?.trades.find((trade) => trade.ticker === leg.draft.ticker && trade.side === leg.draft.side);
  // The review rebuilds the legs from their drafts alone; keep the reason each leg had in the draft basket.
  const legs = withDraftReasons(preview.legs, basket.legs);
  const shape: BasketShape = { ...basket, legs };
  const accountCurrency = rebalance?.accountCurrency ?? preview.accountCurrency;
  return (
    <main className="transactionStage">
      <section ref={dialog.panel} className={`transactionPanel confirmationPanel basketPanel ${live ? "liveTransaction" : ""}`} {...dialog.props}>
        <div className="confirmationHero">
          <span className={`environmentTag ${preview.environment}`}>{envLabel(preview.environment, t)}</span>
          <span className="sectionEyebrow">{t("finalConfirmation")} · {purposeLabel(preview.purpose, t, preview.legs)}</span>
          <h2 id={dialog.headingId} ref={dialog.heading} tabIndex={-1}>{live ? t("realBasket") : t("demoBasket")}</h2>
          <strong className="confirmationAmount basketCount">{countText("orders", preview.legs.length, t, locale)}</strong>
          <span className="basketSubtitle">{basketTitle(shape, t, book)}</span>
        </div>
        {liveFunds && <div className="notice warning compactNotice basketLiveNotice">{noticeText(liveFunds, t, locale)}</div>}
        <ol className="basketLegList">
          {legs.map((leg, index) => (
            <li className="basketLeg" key={`${leg.draft.ticker}-${leg.draft.side}-${index}`}>
              <LegRow leg={leg} trade={tradeFor(leg)} accountCurrency={accountCurrency} book={book} t={t} locale={locale} />
              <LegFacts leg={leg} trade={tradeFor(leg)} basket={shape} accountCurrency={accountCurrency} book={book} t={t} locale={locale} />
              {legNotices(leg.notices).map((notice) => <div className="notice warning compactNotice" key={notice.code}>{noticeText(notice, t, locale)}</div>)}
              <PolicyList checks={leg.policy} t={t} locale={locale} />
            </li>
          ))}
        </ol>
        <Notes notes={withoutSkipped(preview.notes, rebalance)} basket={shape} plan={rebalance} book={book} t={t} locale={locale} />
        {preview.legs.length > 1 && <p className="basketHint">{t("basketOrderNote")}</p>}
        <div className="expiryLine">{t("snapshotAsOf")} · {dateTime(preview.snapshotAt, locale)} · {t("tokenExpires")} · {time(preview.expiresAt, locale)}</div>
        {live && <LiveAcknowledgement checked={acknowledged} onChange={setAcknowledged} t={t} />}
        <div className="transactionFooter">
          <button className="secondaryButton" type="button" onClick={onBack}>{t("backToEdit")}</button>
          <button className={live ? "dangerButton" : "primaryButton"} type="button" disabled={busy || blocked || (live && !acknowledged)} onClick={() => onConfirm(live && acknowledged)}>
            {busy ? t("submitting") : live ? t("confirmLiveBasket") : t("confirmDemoBasket")}
          </button>
        </div>
      </section>
    </main>
  );
}

/** Preview legs with the reason their draft leg gave, matched by instrument, side and order type (the review reorders sells first). */
export function withDraftReasons<T extends BasketLeg>(legs: T[], drafts: BasketLeg[]): T[] {
  return legs.map((leg) => {
    if (leg.reason) return leg;
    const reason = drafts.find((draft) => draft.draft.ticker === leg.draft.ticker && draft.draft.side === leg.draft.side && draft.draft.type === leg.draft.type)?.reason;
    return reason ? { ...leg, reason } : leg;
  });
}

const RESULT_GLYPH = { submitted: "✓", rejected: "✕", unknown: "?", skipped: "–" } as const;

function BasketResultView({
  result,
  basket,
  verifications,
  busy,
  book,
  locale,
  t,
  onClose,
  onVerify,
}: {
  result: BasketExecutionResult;
  basket: BasketShape;
  verifications: Record<string, ExecutionVerificationResult>;
  busy: boolean;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  onClose: () => void;
  onVerify: (verificationId: string) => void;
}) {
  const statusKey: MessageKey =
    result.status === "submitted" ? "basketStatusSubmitted" : result.status === "partial" ? "basketStatusPartial" : result.status === "stopped" ? "basketStatusStopped" : "basketStatusRejected";
  const tone = result.status === "submitted" ? "success" : result.status === "rejected" ? "error" : "warning";
  const known = new Map(basket.legs.map((leg) => [leg.draft.ticker, leg.instrument]));
  return (
    <main className="transactionStage">
      <section className={`transactionPanel basketPanel ${result.environment === "live" ? "liveTransaction" : ""}`} aria-labelledby="basket-result-title">
        <BasketHeader environment={result.environment} basket={{ ...basket, purpose: result.purpose }} count={result.legs.length} book={book} t={t} locale={locale} onClose={onClose} headingProps={{ id: "basket-result-title" }} />
        <div className={`notice ${tone}`} role="status" aria-live="polite">
          <div className="noticeCopy"><strong>{t(statusKey)}</strong><span>{basketResultText(result, t, locale)}</span></div>
        </div>
        <ol className="basketLegList">
          {result.legs.map((leg, index) => {
            const outcome = leg.result ? leg.result.status : "skipped";
            const label = outcome === "submitted" ? t("submitted") : outcome === "rejected" ? t("notSubmitted") : outcome === "unknown" ? t("unknownStatus") : t("legSkipped");
            const verificationId = leg.result?.verificationId;
            const verification = verificationId ? verifications[verificationId] : undefined;
            const name = instrumentLabel(leg.draft.ticker, book, known.get(leg.draft.ticker));
            return (
              <li className={`basketLeg resultLeg ${outcome}`} key={`${leg.draft.ticker}-${index}`}>
                <div className="legRow">
                  <AssetAvatar ticker={leg.draft.ticker} label={name} />
                  <span className="instrumentName legName" title={name.ticker}>
                    <strong>{name.name}</strong>
                    <small>{leg.draft.side === "buy" ? t("buy") : t("sell")} · {orderTypeLabel(leg.draft.type, t)} · {qty(leg.draft.quantity, locale)}</small>
                  </span>
                  <span className={`resultBadge ${outcome}`}><span aria-hidden="true">{RESULT_GLYPH[outcome]}</span> {label}</span>
                </div>
                {leg.result && !leg.result.ok && <p className="resultMessage">{leg.result.error ? formatProblem(leg.result.error, t, locale) : leg.result.message}</p>}
                {!leg.result && leg.skipped && <p className="resultMessage">{legSkipText(leg.skipped, t, book)}</p>}
                {verificationId && (
                  <div className="verificationLine">
                    <span>{t("verificationIdLabel")} · <code>{verificationId}</code></span>
                    {outcome === "unknown" && (
                      <button className="secondaryButton" type="button" disabled={busy} onClick={() => onVerify(verificationId)}>
                        {busy ? t("verifying") : t("verifyExecution")}
                      </button>
                    )}
                  </div>
                )}
                {verification && <p className="resultMessage verificationResult">{verificationText(verification, t)}</p>}
              </li>
            );
          })}
        </ol>
        {!result.ok && <p className="basketHint">{t("basketNoRetry")}</p>}
        <div className="transactionFooter">
          <button className="primaryButton" type="button" onClick={onClose}>{t("done")}</button>
        </div>
      </section>
    </main>
  );
}
