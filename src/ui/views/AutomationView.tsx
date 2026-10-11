import type { AlertCondition, AutomationOverview, DcaPlan, PriceAlert } from "../../shared/automation";
import { localeTag, type MessageKey, type SupportedLocale } from "../i18n";
import { DetailRow } from "../components/common";
import { dateTime, money, num } from "../lib/format";
import type { Translator } from "../lib/messages";

const CONDITION_KEY: Record<AlertCondition, MessageKey> = {
  above: "alertAbove",
  below: "alertBelow",
  trailing_drop: "alertTrailing",
  gain_percent: "alertGain",
  loss_percent: "alertLoss",
};

/** Weekday 1 = Monday … 7 = Sunday, in the user's language. 2024-01-01 was a Monday. */
function weekdayName(weekday: number | undefined, locale: SupportedLocale): string {
  if (!weekday) return "";
  return new Intl.DateTimeFormat(localeTag(locale), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, weekday)));
}

function schedule(plan: DcaPlan, t: Translator, locale: SupportedLocale): string {
  const hour = `${String(plan.hourUtc).padStart(2, "0")}:00 UTC`;
  return plan.frequency === "monthly" ? `${t("planMonthly").replace("{day}", String(plan.dayOfMonth))} · ${hour}` : `${t("planWeekly")} ${weekdayName(plan.weekday, locale)} · ${hour}`;
}

function alertTarget(alert: PriceAlert, locale: SupportedLocale): string {
  return alert.price !== undefined ? num(alert.price, locale) : `${num(alert.percent, locale, 2)}%`;
}

export function AutomationView({ data, locale, t }: { data: AutomationOverview; locale: SupportedLocale; t: Translator }) {
  const on = (value: boolean) => (value ? t("settingOn") : t("settingOff"));
  const amount = (value: number | undefined) => (data.currency ? money(value, data.currency, locale) : num(value, locale, 2));
  return (
    <main className="contentStack">
      <section className="dataPanel" aria-label={t("automationTitle")}>
        <div className="pieHeader"><h2>{t("automationTitle")}</h2></div>
        <div className="confirmationRows">
          <DetailRow label={t("ordersToday")} value={`${data.usageToday.orders}${data.policy.dailyOrderLimit ? ` / ${data.policy.dailyOrderLimit}` : ""}`} />
          <DetailRow label={t("valueToday")} value={`${amount(data.usageToday.notional)}${data.policy.dailyNotionalLimit ? ` / ${amount(data.policy.dailyNotionalLimit)}` : ""}`} />
          <DetailRow label={t("settingDemoAutomation")} value={on(data.settings.demoAutomation)} />
          <DetailRow label={t("settingLinking")} value={on(data.settings.protectiveLinking)} />
          <DetailRow label={t("settingWebhook")} value={on(data.settings.webhook)} />
          <DetailRow label={t("settingDigest")} value={data.settings.digestHourUtc === null ? t("settingOff") : `${String(data.settings.digestHourUtc).padStart(2, "0")}:00 UTC`} />
          <DetailRow label={t("settingQuotes")} value={data.settings.quoteProvider} />
        </div>
      </section>

      <section className="dataPanel" aria-label={t("plansTitle")}>
        <div className="pieHeader"><h2>{t("plansTitle")}</h2></div>
        {data.plans.length === 0 ? <div className="emptyState compact">{t("noPlans")}</div> : (
          <ul className="automationList">
            {data.plans.map((plan) => (
              <li key={plan.id}>
                <div className="automationRow">
                  <strong>{plan.label}</strong>
                  <span className={`statusPill ${plan.paused ? "muted" : plan.autoExecute ? "auto" : ""}`}>{plan.paused ? t("planPaused") : plan.autoExecute ? t("planAuto") : t("planConfirm")}</span>
                </div>
                <small>{plan.legs.map((leg) => `${leg.ticker} ${amount(leg.amount)}${leg.orderType === "limit" ? ` (${t("limit")} +${num(leg.limitOffsetPercent, locale, 2)}%)` : ""}`).join(" · ")}</small>
                <small>{schedule(plan, t, locale)} · {t("nextRun")} {dateTime(plan.nextRunAt, locale)}</small>
                {plan.lastOutcome && <small className="mutedInline">{plan.lastOutcome}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dataPanel" aria-label={t("alertsTitle")}>
        <div className="pieHeader"><h2>{t("alertsTitle")}</h2></div>
        {data.alerts.length === 0 ? <div className="emptyState compact">{t("noAlerts")}</div> : (
          <ul className="automationList">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <div className="automationRow">
                  <strong>{alert.ticker}</strong>
                  <span className={`statusPill ${alert.triggeredAt ? "fired" : ""}`}>{alert.triggeredAt ? t("alertTriggered") : t("alertArmed")}</span>
                </div>
                <small>{t(CONDITION_KEY[alert.condition])} {alertTarget(alert, locale)}{alert.lastPrice !== undefined ? ` · ${t("lastPrice")} ${num(alert.lastPrice, locale)}` : ""}{alert.highWatermark !== undefined ? ` · ${t("highWatermark")} ${num(alert.highWatermark, locale)}` : ""}</small>
                {alert.triggeredAt && <small>{dateTime(alert.triggeredAt, locale)} · {num(alert.triggeredPrice, locale)}</small>}
                {alert.note && <small className="mutedInline">{alert.note}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dataPanel" aria-label={t("linksTitle")}>
        <div className="pieHeader"><h2>{t("linksTitle")}</h2></div>
        {data.links.length === 0 ? <div className="emptyState compact">{t("noLinks")}</div> : (
          <ul className="automationList">
            {data.links.map((link) => (
              <li key={link.id}>
                <div className="automationRow"><strong>{link.ticker}</strong><small>{dateTime(link.createdAt, locale)}</small></div>
                <small>{link.orders.map((order) => `${order.role === "stop_loss" ? t("stopLoss") : t("takeProfit")} #${order.orderId}`).join(" · ")}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
