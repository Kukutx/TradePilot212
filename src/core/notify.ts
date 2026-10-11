// Optional webhook notifications for automation events, so a due plan, a filled stop or a price
// alert reaches you without opening the chat. The body carries `text` (Slack, Mattermost, ntfy-style
// relays) and `content` (Discord) plus the raw event. Delivery is best effort and never retried.

import type { ActivityEvent, ActivityType } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";

export const DEFAULT_NOTIFY_EVENTS: ActivityType[] = [
  "order_submitted",
  "order_status_unknown",
  "cancel_status_unknown",
  "basket_submitted",
  "plan_due",
  "plan_auto_executed",
  "plan_skipped",
  "protective_sibling_cancelled",
  "pie_submitted",
  "pie_status_unknown",
  "price_alert_triggered",
  "daily_digest",
];

const LABELS: Partial<Record<ActivityType, string>> = {
  order_submitted: "Order sent",
  order_status_unknown: "Order result unclear, check Trading 212",
  cancel_status_unknown: "Cancellation result unclear, check Trading 212",
  basket_submitted: "Basket sent",
  plan_due: "Investment plan is due and waits for your confirmation",
  plan_auto_executed: "Investment plan ran on Demo",
  plan_skipped: "Investment plan skipped",
  protective_sibling_cancelled: "Protective order filled; the other one was cancelled",
  pie_submitted: "Pie changed",
  pie_status_unknown: "Pie change result unclear, check Trading 212",
  price_alert_triggered: "Price alert",
  daily_digest: "Daily digest",
};

export function notificationText(event: ActivityEvent): string {
  const parts = [
    `[TradePilot ${event.environment.toUpperCase()}] ${LABELS[event.type] ?? event.type}`,
    event.ticker,
    event.side && event.quantity !== undefined ? `${event.side} ${event.quantity}` : undefined,
    event.price !== undefined ? `@ ${event.price}` : undefined,
    event.legs !== undefined ? `${event.legs} order(s)` : undefined,
    event.outcome,
  ];
  return parts.filter(Boolean).join(" · ");
}

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type Notifier = (event: ActivityEvent) => Promise<void>;

export function createNotifier(config: RuntimeConfig, fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): Notifier | undefined {
  if (!config.notifyWebhookUrl) return undefined;
  const wanted = new Set<string>(config.notifyEvents.length ? config.notifyEvents : DEFAULT_NOTIFY_EVENTS);
  return async (event) => {
    if (!wanted.has(event.type)) return;
    const text = notificationText(event);
    const body = JSON.stringify({ text, content: text, event });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.notifyWebhookSecret) headers["X-TradePilot-Signature"] = `sha256=${await signature(config.notifyWebhookSecret, body)}`;
    try {
      const response = await fetcher(config.notifyWebhookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
      if (!response.ok) console.error(JSON.stringify({ message: "TradePilot webhook rejected", status: response.status }));
    } catch (error) {
      console.error(JSON.stringify({ message: "TradePilot webhook failed", error: error instanceof Error ? error.message : String(error) }));
    }
  };
}
