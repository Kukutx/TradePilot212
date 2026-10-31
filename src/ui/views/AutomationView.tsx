import type { AutomationOverview, PriceAlert } from "../../shared/automation";
import { localeTag, type SupportedLocale } from "../i18n";
import { AccountAlertList, type AccountAlertRequest } from "../components/account-alerts";
import { AlertActions } from "../components/alerts";
import { PlanList, type PlanRequest } from "../components/plans";
import { DetailRow, InstrumentName } from "../components/common";
import { amount, dateTime, num, pct } from "../lib/format";
import { instrumentCurrency, instrumentLabel, type InstrumentBook } from "../lib/instruments";
import { alertConditionLabel, fill, instrumentTypeLabel, quoteProviderLabel, type Translator } from "../lib/messages";

/** A tax year's first day, MM-DD, as the locale writes a day of the year: "6 April", "4月6日". */
export function yearStartLabel(start: string, locale: SupportedLocale): string {
  const [month, day] = start.split("-").map(Number);
  if (!month || !day) return start;
  return new Intl.DateTimeFormat(localeTag(locale), { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2001, month - 1, day)));
}

/** A day's-move alert's last change from the previous close, after the alert's other figures. */
export function alertDayText(alert: PriceAlert, t: Translator, locale: SupportedLocale): string {
  return alert.condition === "day_move" && alert.lastDayChange !== undefined ? ` · ${fill(t("alertDayChange"), { change: pct(alert.lastDayChange, locale, 2, { signed: true }) })}` : "";
}

/** How much of a day's budget is used, as a bar once there is a limit; 0 is no limit. */
function UsageMeter({ label, used, limit, format, t }: { label: string; used: number; limit: number; format: (value: number) => string; t: Translator }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="usageMeter">
      <div className="usageMeterHead"><span>{label}</span><strong>{format(used)}{limit > 0 ? ` / ${format(limit)}` : ` · ${t("ruleNoLimit")}`}</strong></div>
      {limit > 0 && (
        <div className="usageMeterTrack" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-valuetext={`${format(used)} / ${format(limit)}`}>
          <i className={share >= 1 ? "full" : share >= 0.8 ? "near" : undefined} style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** The rules every order through TradePilot is checked against, and how much of today's budget is used. */
export function TradingRules({ data, book, locale, t }: { data: AutomationOverview; book?: InstrumentBook; locale: SupportedLocale; t: Translator }) {
  const { policy } = data;
  const sum = (value: number) => amount(value, data.currency, locale);
  const names = (tickers: string[]) => tickers.map((ticker) => instrumentLabel(ticker, book).name).join(", ");
  const limit = (value: number | undefined, format: (value: number) => string) => (value ? format(value) : t("ruleNoLimit"));
  return (
    <section className="dataPanel" aria-label={t("tradingRulesTitle")}>
      <div className="pieHeader"><h2>{t("tradingRulesTitle")}</h2></div>
      <div className="usageMeters">
        <UsageMeter label={t("ordersToday")} used={data.usageToday.orders} limit={policy.dailyOrderLimit} format={(value) => num(value, locale, 0)} t={t} />
        <UsageMeter label={t("valueToday")} used={data.usageToday.notional} limit={policy.dailyNotionalLimit} format={sum} t={t} />
      </div>
      <div className="confirmationRows">
        <DetailRow label={t("policyRuleMaxPositionWeight")} value={policy.maxPositionWeight > 0 && policy.maxPositionWeight < 1 ? pct(policy.maxPositionWeight, locale) : t("ruleNoLimit")} />
        <DetailRow label={t("ruleMaxOrderValue")} value={limit(data.orderLimits?.notional, sum)} />
        <DetailRow label={t("ruleMaxOrderQuantity")} value={limit(data.orderLimits?.quantity, (value) => num(value, locale, 0))} />
        <DetailRow label={t("policyRuleAllowedTickers")} value={policy.allowedTickers.length ? names(policy.allowedTickers) : t("ruleAny")} />
        <DetailRow label={t("policyRuleBlockedTickers")} value={policy.blockedTickers.length ? names(policy.blockedTickers) : t("ruleNone")} />
        <DetailRow label={t("policyRuleAllowedTypes")} value={policy.allowedTypes.length ? policy.allowedTypes.map((type) => instrumentTypeLabel(type, t)).join(", ") : t("ruleAny")} />
        <DetailRow label={t("policyRuleMarketClosed")} value={t(policy.marketOrdersWhenClosed ? "ruleMarketAnyTime" : "ruleMarketWaits")} />
        <DetailRow label={t("policyRuleReferenceAge")} value={policy.maxReferenceAgeSeconds > 0 ? fill(t("ruleReferenceNewer"), { seconds: String(policy.maxReferenceAgeSeconds) }) : t("policySkip")} />
      </div>
    </section>
  );
}

/** Alert prices are in the instrument's currency; percent conditions stay percentages. */
export function alertTarget(alert: PriceAlert, book: InstrumentBook | undefined, locale: SupportedLocale): string {
  return alert.price !== undefined ? amount(alert.price, instrumentCurrency(alert.ticker, book), locale) : `${num(alert.percent, locale, 2)}%`;
}

export function AutomationView({ data, book, locale, t, busy = false, onDeleteAlert, onRearmAlert, onSaveAccountAlert, onDeleteAccountAlert, onRearmAccountAlert, onSavePlan, onChangePlan, onDeletePlan, onReviewPlan }: {
  data: AutomationOverview;
  book?: InstrumentBook;
  locale: SupportedLocale;
  t: Translator;
  busy?: boolean;
  onDeleteAlert?: (alertId: string) => void;
  onRearmAlert?: (alertId: string) => void;
  onSaveAccountAlert?: (request: AccountAlertRequest) => Promise<boolean>;
  onDeleteAccountAlert?: (alertId: string) => void;
  onRearmAccountAlert?: (alertId: string) => void;
  /** Given where the account can be written to. */
  onSavePlan?: (request: PlanRequest) => Promise<boolean>;
  onChangePlan?: (planId: string, changes: Partial<PlanRequest> & { paused?: boolean }) => Promise<boolean>;
  onDeletePlan?: (planId: string) => void;
  onReviewPlan?: (planId: string) => void;
}) {
  const on = (value: boolean) => (value ? t("settingOn") : t("settingOff"));
  const sum = (value: number | undefined) => amount(value, data.currency, locale);
  const price = (ticker: string, value: number | undefined) => amount(value, instrumentCurrency(ticker, book), locale);
  return (
    <main className="contentStack">
      <section className="dataPanel" aria-label={t("automationTitle")}>
        <div className="pieHeader"><h2>{t("automationTitle")}</h2></div>
        <div className="confirmationRows">
          <DetailRow label={t("settingDemoAutomation")} value={on(data.settings.demoAutomation)} />
          <DetailRow label={t("settingLinking")} value={on(data.settings.protectiveLinking)} />
          <DetailRow label={t("settingOrderWatch")} value={on(data.settings.orderWatch)} />
          <DetailRow label={t("settingWebhook")} value={on(data.settings.webhook)} />
          <DetailRow label={t("settingDigest")} value={data.settings.digestHour === null ? t("settingOff") : `${String(data.settings.digestHour).padStart(2, "0")}:00 ${data.settings.digestTimeZone ?? "UTC"}`} />
          <DetailRow label={t("settingTimeZone")} value={data.settings.timeZone ?? "UTC"} />
          {data.settings.taxYearStart && <DetailRow label={t("settingTaxYear")} value={yearStartLabel(data.settings.taxYearStart, locale)} />}
          <DetailRow label={t("settingQuotes")} value={quoteProviderLabel(data.settings.quoteProvider, t)} />
        </div>
      </section>
      <TradingRules data={data} book={book} locale={locale} t={t} />

      <PlanList plans={data.plans} environment={data.environment} {...(data.currency ? { currency: data.currency } : {})} hasTargets={Boolean(data.targets)} {...(book ? { book } : {})}
        locale={locale} t={t} busy={busy} {...(onSavePlan ? { onSave: onSavePlan } : {})} {...(onChangePlan ? { onChange: onChangePlan } : {})}
        {...(onDeletePlan ? { onDelete: onDeletePlan } : {})} {...(onReviewPlan ? { onReview: onReviewPlan } : {})} />

      <section className="dataPanel" aria-label={t("alertsTitle")}>
        <div className="pieHeader"><h2>{t("alertsTitle")}</h2></div>
        {data.alerts.length === 0 ? <div className="emptyState compact">{t("automationNoAlerts")}</div> : (
          <ul className="automationList">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <div className="automationRow">
                  <InstrumentName ticker={alert.ticker} book={book} />
                  <span className={`statusPill ${alert.triggeredAt ? "fired" : ""}`}>{alert.triggeredAt ? t("alertTriggered") : t("alertArmed")}</span>
                </div>
                <small>{alertConditionLabel(alert.condition, t)} {alertTarget(alert, book, locale)}{alert.lastPrice !== undefined ? ` · ${t("lastPrice")} ${price(alert.ticker, alert.lastPrice)}` : ""}{alert.highWatermark !== undefined ? ` · ${t("highWatermark")} ${price(alert.ticker, alert.highWatermark)}` : ""}{alertDayText(alert, t, locale)}</small>
                {alert.triggeredAt && <small>{dateTime(alert.triggeredAt, locale)} · {price(alert.ticker, alert.triggeredPrice)}{alert.condition === "day_move" ? ` · ${t("alertDayAgain")}` : ""}</small>}
                {alert.note && <small className="mutedInline">{alert.note}</small>}
                {onDeleteAlert && onRearmAlert && <AlertActions alert={alert} t={t} busy={busy} onRearm={onRearmAlert} onDelete={onDeleteAlert} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AccountAlertList alerts={data.accountAlerts ?? []} {...(data.currency ? { currency: data.currency } : {})} now={data.account ?? {}} locale={locale} t={t} busy={busy}
        {...(onSaveAccountAlert ? { onSave: onSaveAccountAlert } : {})} {...(onDeleteAccountAlert ? { onDelete: onDeleteAccountAlert } : {})} {...(onRearmAccountAlert ? { onRearm: onRearmAccountAlert } : {})} />

      {data.targets && (
        <section className="dataPanel" aria-label={t("targetsTitle")}>
          <div className="pieHeader"><h2>{t("targetsTitle")}</h2></div>
          <ul className="automationList">
            {data.targets.targets.map((target) => (
              <li key={target.ticker}>
                <div className="automationRow"><InstrumentName ticker={target.ticker} book={book} /><strong>{pct(target.weight, locale)}</strong></div>
              </li>
            ))}
            <li>
              <div className="automationRow"><strong>{instrumentTypeLabel("CASH", t)}</strong><strong>{pct(data.targets.cashWeight, locale)}</strong></div>
            </li>
          </ul>
          <p className="panelNote">{fill(t("targetsNote"), { points: num(data.targets.driftThreshold * 100, locale, 1), date: dateTime(data.targets.updatedAt, locale) })} {t(data.targets.sellUntargeted ? "targetsSellUntargeted" : "targetsKeepUntargeted")}</p>
        </section>
      )}

      <section className="dataPanel" aria-label={t("linksTitle")}>
        <div className="pieHeader"><h2>{t("linksTitle")}</h2></div>
        {data.links.length === 0 ? <div className="emptyState compact">{data.settings.protectiveLinking ? t("noLinks") : t("noLinksOff")}</div> : (
          <ul className="automationList">
            {data.links.map((link) => (
              <li key={link.id}>
                <div className="automationRow"><InstrumentName ticker={link.ticker} book={book} /><small>{dateTime(link.createdAt, locale)}</small></div>
                <small>{link.orders.map((order) => `${order.role === "stop_loss" ? t("stopLoss") : t("takeProfit")} #${order.orderId}`).join(" · ")}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
