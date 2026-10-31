// Optional notifications for automation events, so a due plan, a filled stop or a price alert reaches you without
// opening the chat. NOTIFY_WEBHOOK_URL names one or more endpoints; each gets the message laid out for what it is
// (Slack, Discord, Telegram, ntfy, Bark, or the plain JSON of earlier versions), in English or Chinese (NOTIFY_LOCALE).
// A delivery that fails is tried again from the scheduler, a few times over some hours; during quiet hours
// (NOTIFY_QUIET_HOURS) only what needs you at once goes out, and the rest follows in one message when they end.

import type { ActivityEvent, ActivityType } from "../shared/contracts.js";
import { localDay, localHour, localHourStart } from "../shared/time-zone.js";
import type { RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";

export const DEFAULT_NOTIFY_EVENTS: ActivityType[] = [
  "order_submitted",
  "order_status_unknown",
  "order_filled",
  "order_partly_filled",
  "order_outcome_unknown",
  "cancel_status_unknown",
  "basket_submitted",
  "plan_due",
  "plan_auto_executed",
  "plan_skipped",
  "protective_sibling_cancelled",
  "protective_attention",
  "cancel_rejected",
  "pie_submitted",
  "pie_status_unknown",
  "price_alert_triggered",
  "account_alert_triggered",
  "new_listings",
  "allocation_drift",
  "daily_digest",
  "weekly_report",
  "monthly_report",
];

/** Sent at an hour chosen for them, quiet hours or not, and tried again by their own schedule when no endpoint takes them. */
export const SCHEDULED_EVENTS = new Set<ActivityType>(["daily_digest", "weekly_report", "monthly_report"]);

/** Events that need you now: sent during quiet hours too. */
export const URGENT_EVENTS = new Set<ActivityType>([
  "order_status_unknown", "order_outcome_unknown", "cancel_status_unknown", "pie_status_unknown", "protective_attention", "cancel_rejected",
]);

export const NOTIFY_FORMATS = ["raw", "slack", "discord", "telegram", "ntfy", "bark"] as const;
export type NotifyFormat = (typeof NOTIFY_FORMATS)[number];
export interface NotifyTarget { url: string; format: NotifyFormat }
export type NotifyLocale = "en" | "zh-CN";
/** Local hours in TIMEZONE (UTC without one): from `start` o'clock up to `end` o'clock, across midnight when end < start. */
export interface QuietHours { start: number; end: number }

const LABELS: Record<NotifyLocale, Partial<Record<ActivityType, string>>> = {
  en: {
    order_submitted: "Order sent",
    order_status_unknown: "Order result unclear, check Trading 212",
    order_filled: "Order filled",
    order_partly_filled: "Order partly filled",
    order_closed: "Order closed",
    order_outcome_unknown: "An order left the order book and how it ended is unclear, check Trading 212",
    cancel_status_unknown: "Cancellation result unclear, check Trading 212",
    basket_submitted: "Basket sent",
    plan_due: "Investment plan is due and waits for your confirmation",
    plan_auto_executed: "Investment plan ran on Demo",
    plan_skipped: "Investment plan skipped",
    protective_sibling_cancelled: "Protective order filled; the other one was cancelled",
    protective_attention: "Protective orders need your attention",
    cancel_rejected: "Cancellation was rejected",
    pie_submitted: "Pie changed",
    pie_status_unknown: "Pie change result unclear, check Trading 212",
    price_alert_triggered: "Price alert",
    account_alert_triggered: "Account alert",
    new_listings: "New on Trading 212",
    allocation_drift: "Allocation has drifted from your targets",
    daily_digest: "Daily digest",
    weekly_report: "Weekly report",
    monthly_report: "Monthly report",
  },
  "zh-CN": {
    order_submitted: "订单已发送",
    order_status_unknown: "订单结果不明，请到 Trading 212 查看",
    order_filled: "订单已成交",
    order_partly_filled: "订单部分成交",
    order_closed: "订单已结束",
    order_outcome_unknown: "有订单已离开挂单簿，结果不明，请到 Trading 212 查看",
    cancel_status_unknown: "撤单结果不明，请到 Trading 212 查看",
    basket_submitted: "篮子订单已发送",
    plan_due: "定投计划已到期，等你确认",
    plan_auto_executed: "定投计划已在模拟账户执行",
    plan_skipped: "定投计划已跳过",
    protective_sibling_cancelled: "保护单已成交，另一张已撤销",
    protective_attention: "保护单需要你处理",
    cancel_rejected: "撤单被拒绝",
    pie_submitted: "Pie 已修改",
    pie_status_unknown: "Pie 修改结果不明，请到 Trading 212 查看",
    price_alert_triggered: "价格提醒",
    account_alert_triggered: "账户提醒",
    new_listings: "Trading 212 新上架",
    allocation_drift: "持仓配置已偏离目标",
    daily_digest: "每日摘要",
    weekly_report: "周报",
    monthly_report: "月报",
  },
};

const WORDS = {
  en: {
    env: { demo: "Demo", live: "Live" }, side: { buy: "Buy", sell: "Sell" },
    shares: (count: string) => count, filled: (count: string) => `filled ${count}`,
    orders: (count: number) => (count === 1 ? "1 order" : `${count} orders`),
    held: (count: number) => (count === 1 ? "1 notification during quiet hours" : `${count} notifications during quiet hours`),
    test: "Test notification", testBody: "TradePilot can reach this endpoint. Nothing was traded.",
  },
  "zh-CN": {
    env: { demo: "模拟", live: "实盘" }, side: { buy: "买入", sell: "卖出" },
    shares: (count: string) => `${count} 股`, filled: (count: string) => `成交 ${count} 股`,
    orders: (count: number) => `${count} 笔订单`,
    held: (count: number) => `静默时段内的 ${count} 条通知`,
    test: "测试通知", testBody: "TradePilot 能连到这个地址。没有进行任何交易。",
  },
} as const;

/** One message, before it is laid out for an endpoint: a title, its lines, and whether it needs you now. */
export interface NotificationMessage { title: string; lines: string[]; urgent: boolean }

function figures(event: ActivityEvent, locale: NotifyLocale): string[] {
  const words = WORDS[locale];
  const count = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  const price = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  const money = (value: number, currency?: string) => {
    try {
      return currency ? new Intl.NumberFormat(locale, { style: "currency", currency }).format(value) : price(value);
    } catch {
      return `${price(value)} ${currency}`;
    }
  };
  const side = event.side ? words.side[event.side] : undefined;
  return [
    event.ticker,
    side && event.quantity !== undefined ? `${side} ${words.shares(count(event.quantity))}` : undefined,
    event.filledQuantity !== undefined && event.filledQuantity !== event.quantity ? words.filled(count(event.filledQuantity)) : undefined,
    event.price !== undefined ? `@ ${price(event.price)}` : undefined,
    // A fill's value; an alert's figures are in its own words.
    event.value !== undefined && event.type.startsWith("order_") ? money(event.value, event.valueCurrency) : undefined,
    event.legs !== undefined ? words.orders(event.legs) : undefined,
  ].filter((part): part is string => Boolean(part));
}

export function notificationMessage(event: ActivityEvent, locale: NotifyLocale = "en"): NotificationMessage {
  const label = LABELS[locale][event.type] ?? LABELS.en[event.type] ?? event.type;
  const details = figures(event, locale);
  // A digest or report is one line of " · " parts; laid out, each is a line of its own.
  const outcome = event.outcome ? (SCHEDULED_EVENTS.has(event.type) ? event.outcome.split(" · ") : [event.outcome]) : [];
  return {
    title: `TradePilot · ${WORDS[locale].env[event.environment]} · ${label}`,
    lines: [...(details.length ? [details.join(" · ")] : []), ...outcome],
    urgent: URGENT_EVENTS.has(event.type),
  };
}

/** The event as one line, as the plain JSON body's `text` has always been. */
export function notificationText(event: ActivityEvent, locale: NotifyLocale = "en"): string {
  const label = LABELS[locale][event.type] ?? LABELS.en[event.type] ?? event.type;
  const env = locale === "en" ? event.environment.toUpperCase() : WORDS[locale].env[event.environment];
  return [`[TradePilot ${env}] ${label}`, ...figures(event, locale), event.outcome].filter(Boolean).join(" · ");
}

// ---- Settings ----

const KNOWN_HOSTS: Array<[NotifyFormat, (url: URL) => boolean]> = [
  ["slack", (url) => url.hostname === "hooks.slack.com"],
  ["discord", (url) => /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(url.hostname) && url.pathname.startsWith("/api/webhooks/")],
  ["telegram", (url) => url.hostname === "api.telegram.org"],
  ["ntfy", (url) => url.hostname === "ntfy.sh"],
  ["bark", (url) => url.hostname === "api.day.app"],
];

const ordinal = (index: number) => ["first", "second", "third"][index] ?? `${index + 1}th`;

/**
 * NOTIFY_WEBHOOK_URL: one or more HTTPS URLs, separated by spaces or commas, each optionally led by its format
 * (`ntfy:https://ntfy.example.com/alerts`); a known service's address needs none. Errors never repeat the URL, which
 * may hold a token.
 */
export function parseNotifyTargets(raw: string, loopback: (hostname: string) => boolean): NotifyTarget[] {
  const entries = raw.trim().split(/[\s,]+(?=(?:[a-z]+:)?https?:\/\/)|\s+/i).map((item) => item.trim().replace(/,$/, "")).filter(Boolean);
  return entries.map((entry, index) => {
    const which = entries.length > 1 ? `The ${ordinal(index)} NOTIFY_WEBHOOK_URL entry` : "NOTIFY_WEBHOOK_URL";
    const prefixed = /^([a-z]+):(https?:\/\/.+)$/i.exec(entry);
    const named = prefixed?.[1]?.toLowerCase();
    if (named && !(NOTIFY_FORMATS as readonly string[]).includes(named)) throw new Error(`${which} starts with an unknown format; use one of ${NOTIFY_FORMATS.join(", ")}`);
    const address = prefixed ? prefixed[2]! : entry;
    if (address.slice(address.indexOf("://") + 3).includes("://")) throw new Error(`${which} holds a second address; separate addresses with a space or a comma`);
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new Error(`${which} is not a URL`);
    }
    if (url.protocol !== "https:" && !(loopback(url.hostname) && url.protocol === "http:")) throw new Error(`${which} must use HTTPS`);
    if (url.hash) throw new Error(`${which} must not have a fragment`);
    // fetch refuses such a URL, and its error repeats the address with the password in it.
    if (url.username || url.password) throw new Error(`${which} must not hold a user name or password; put a token in the path or query`);
    const format = (named as NotifyFormat | undefined) ?? KNOWN_HOSTS.find(([, test]) => test(url))?.[0] ?? "raw";
    if (format === "telegram" && !/\/bot[^/]+\/sendMessage$/.test(url.pathname)) throw new Error(`${which} for Telegram must be https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat>`);
    if (format === "telegram" && !url.searchParams.get("chat_id")) throw new Error(`${which} for Telegram needs ?chat_id=<chat>`);
    if (format === "ntfy" && url.pathname.split("/").filter(Boolean).length === 0) throw new Error(`${which} for ntfy must name a topic, such as https://ntfy.sh/my-topic`);
    return { url: url.toString(), format };
  });
}

export function parseNotifyLocale(raw: string | undefined): NotifyLocale {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "en") return "en";
  if (["zh", "zh-cn", "zh-hans", "zh_cn"].includes(value)) return "zh-CN";
  throw new Error("NOTIFY_LOCALE must be en or zh-CN");
}

/** NOTIFY_QUIET_HOURS: "22-07" or "22:00-07:00", in TIMEZONE (UTC without one). */
export function parseQuietHours(raw: string | undefined): QuietHours | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const match = /^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/.exec(value);
  const start = Number(match?.[1]), end = Number(match?.[2]);
  if (!match || start > 23 || end > 23 || start === end) throw new Error("NOTIFY_QUIET_HOURS must be two different whole hours from 0 to 23, such as 22-07");
  return { start, end };
}

export function inQuietHours(quiet: QuietHours, instant: number, timeZone: string): boolean {
  const hour = localHour(instant, timeZone);
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

/** The instant quiet hours end, from an instant inside them. */
export function quietHoursEnd(quiet: QuietHours, instant: number, timeZone: string): number {
  let day = localDay(instant, timeZone);
  for (let tries = 0; tries < 3; tries++) {
    const end = localHourStart(day, quiet.end, timeZone);
    if (end > instant) return end;
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    day = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  }
  return instant + 3_600_000;
}

// ---- Laying a message out for an endpoint ----

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Marks that style text anywhere, and those that do at a line's start (a heading, a quote, a list).
const escapeDiscord = (text: string) => text.replace(/([\\*_~`|])/g, "\\$1").replace(/^([#>-])/gm, "\\$1");
const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

interface Delivery { url: string; body: string; headers: Record<string, string> }

/** The request one endpoint takes for a message; `raw` keeps the JSON of earlier versions, the event or events in it. */
export function deliveryFor(target: NotifyTarget, message: NotificationMessage, text: string, events: ActivityEvent[]): Delivery {
  const json = (url: string, value: unknown): Delivery => ({ url, body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });
  const body = message.lines.join("\n");
  switch (target.format) {
    case "slack":
      // Plain text blocks: a ticker's underscores are not taken as italics.
      return json(target.url, {
        text: cut(text, 3000),
        blocks: [
          { type: "header", text: { type: "plain_text", text: cut(message.title, 150) } },
          ...(body ? [{ type: "section", text: { type: "plain_text", text: cut(body, 3000) } }] : []),
        ],
      });
    case "discord":
      return json(target.url, { content: cut(`**${escapeDiscord(message.title)}**${body ? `\n${escapeDiscord(body)}` : ""}`, 2000), allowed_mentions: { parse: [] } });
    case "telegram": {
      const url = new URL(target.url);
      const params = Object.fromEntries(url.searchParams);
      // Cut before escaping, so an entity is never cut in two; Telegram counts the text after reading its entities.
      const title = cut(message.title, 256);
      const lines = body ? cut(body, 4096 - title.length - 1) : "";
      return json(`${url.origin}${url.pathname}`, { ...params, text: `<b>${escapeHtml(title)}</b>${lines ? `\n${escapeHtml(lines)}` : ""}`, parse_mode: "HTML", disable_web_page_preview: true });
    }
    case "ntfy": {
      // JSON publishing, to the server's root with the topic in the body, carries a title in any script.
      const url = new URL(target.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const topic = parts.pop()!;
      return json(`${url.origin}/${parts.map((part) => `${part}/`).join("")}${url.search}`, { topic, title: message.title, message: body || message.title, priority: message.urgent ? 4 : 3 });
    }
    case "bark":
      return json(target.url, { title: message.title, body: body || message.title, group: "TradePilot", level: message.urgent ? "timeSensitive" : "active" });
    default:
      return json(target.url, events.length === 1 ? { text, content: text, event: events[0] } : { text, content: text, events });
  }
}

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestOf(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...hash].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- Sending, holding and trying again ----

/** Resolves true when an endpoint accepted the event or it is held for later. `force` sends it even when NOTIFY_EVENTS leaves its type out. */
export type Notifier = (event: ActivityEvent, options?: { force?: boolean }) => Promise<boolean>;

/** A delivery to one endpoint still to make: held for quiet hours' end, or tried again after failing. */
interface Pending { event: ActivityEvent; target: string; attempts: number; dueAt: number; held?: boolean }

const PREFIX = "notify-outbox:";
/** Waits before each try again: a minute, five, a quarter of an hour, an hour, three. Then it is given up. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const KEEP_MS = 30 * 60 * 60_000;
const MAX_PENDING = 200;

export interface NotifyTestResult { format: NotifyFormat; host: string; ok: boolean; status?: number; error?: string }

/** A fixed reason for a request that got no answer: an error's own message can repeat the address, token and all. */
function failureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "no answer within 5 seconds";
  return "could not connect";
}

export class Notifications {
  private readonly wanted: Set<string>;
  private keys?: Promise<string[]>;

  constructor(private readonly deps: { config: RuntimeConfig; store?: StateStore; fetcher: typeof fetch; now?: () => number }) {
    this.wanted = new Set<string>(deps.config.notifyEvents.length ? deps.config.notifyEvents : DEFAULT_NOTIFY_EVENTS);
  }

  private get targets(): NotifyTarget[] { return this.deps.config.notifyTargets; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private get zone(): string { return this.deps.config.timeZone ?? "UTC"; }
  /** Each endpoint's name in the store: a hash, so a token in its URL is never written there. */
  private targetKeys(): Promise<string[]> { return (this.keys ??= Promise.all(this.targets.map((target) => digestOf(`${target.format}:${target.url}`)))); }

  /** One request to one endpoint; true when it answered 2xx. */
  private async deliver(target: NotifyTarget, message: NotificationMessage, text: string, events: ActivityEvent[]): Promise<{ ok: boolean; status?: number; error?: string }> {
    const request = deliveryFor(target, message, text, events);
    if (this.deps.config.notifyWebhookSecret) request.headers["X-TradePilot-Signature"] = `sha256=${await signature(this.deps.config.notifyWebhookSecret, request.body)}`;
    try {
      const response = await this.deps.fetcher(request.url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(5000) });
      if (!response.ok) console.error(JSON.stringify({ message: "TradePilot notification rejected", format: target.format, host: new URL(target.url).hostname, status: response.status }));
      return { ok: response.ok, status: response.status };
    } catch (error) {
      const reason = failureReason(error);
      console.error(JSON.stringify({ message: "TradePilot notification failed", format: target.format, host: new URL(target.url).hostname, error: reason }));
      return { ok: false, error: reason };
    }
  }

  private async keep(item: Pending): Promise<void> {
    if (!this.deps.store) return;
    await this.deps.store.put(`${PREFIX}${item.event.id}:${item.target}`, item, this.now() + KEEP_MS);
  }

  readonly send: Notifier = async (event, options) => {
    if (!options?.force && !this.wanted.has(event.type)) return false;
    const keys = await this.targetKeys();
    const now = this.now();
    const quiet = this.deps.config.notifyQuietHours;
    // Quiet hours hold what can wait for one message when they end; a digest or report comes at the hour chosen for it.
    if (quiet && this.deps.store && !URGENT_EVENTS.has(event.type) && !SCHEDULED_EVENTS.has(event.type) && inQuietHours(quiet, now, this.zone)) {
      const dueAt = quietHoursEnd(quiet, now, this.zone);
      try {
        await Promise.all(keys.map((target) => this.keep({ event, target, attempts: 0, dueAt, held: true })));
        return true;
      } catch (error) {
        console.error(JSON.stringify({ message: "TradePilot notification could not be held; sending it now", error: error instanceof Error ? error.message : String(error) }));
      }
    }
    const message = notificationMessage(event, this.deps.config.notifyLocale);
    const text = notificationText(event, this.deps.config.notifyLocale);
    const results = await Promise.all(this.targets.map((target) => this.deliver(target, message, text, [event])));
    const accepted = results.some((result) => result.ok);
    // A digest or report tries again by itself when no endpoint took it; one that some took is tried again here for the rest.
    if (!SCHEDULED_EVENTS.has(event.type) || accepted) {
      await Promise.all(results.map((result, index) => result.ok ? undefined
        : this.keep({ event, target: keys[index]!, attempts: 1, dueAt: now + RETRY_DELAYS_MS[0]! }).catch(() => {})));
    }
    return accepted;
  };

  /** Deliveries now due: held ones in one message per endpoint, failed ones each again. Run from the scheduler. */
  async flush(): Promise<string[]> {
    const store = this.deps.store;
    if (!store) return [];
    const now = this.now();
    const keys = await this.targetKeys();
    const entries = await store.list<Pending>(PREFIX);
    // Kept to the newest few hundred; one for an endpoint no longer set is dropped.
    const stale = entries.filter((item) => !keys.includes(item.value.target))
      .concat([...entries].sort((a, b) => b.value.event.timestamp.localeCompare(a.value.event.timestamp)).slice(MAX_PENDING));
    await Promise.all(stale.map((item) => store.delete(item.key)));
    const due = entries.filter((item) => item.value.dueAt <= now && !stale.includes(item));
    const delivered: string[] = [];
    for (const [index, target] of this.targets.entries()) {
      const mine = due.filter((item) => item.value.target === keys[index]);
      // Taken from the store before sending, so a second scheduler sends none of them twice.
      // What is sent is what was taken, which another scheduler may have put back since the list was read.
      const consumed = await Promise.all(mine.map(async (item) => ({ key: item.key, value: await store.consume<Pending>(item.key) })));
      const notYet = consumed.filter((item) => item.value && item.value.dueAt > now);
      await Promise.all(notYet.map((item) => this.keep(item.value!).catch(() => {})));
      const taken = consumed.map((item) => item.value).filter((item): item is Pending => Boolean(item) && item!.dueAt <= now);
      const held = taken.filter((item) => item.held).sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp));
      const batches: Pending[][] = [...(held.length ? [held] : []), ...taken.filter((item) => !item.held).map((item) => [item])];
      for (const batch of batches) {
        const events = batch.map((item) => item.event);
        const locale = this.deps.config.notifyLocale;
        const message = events.length === 1 && !batch[0]!.held ? notificationMessage(events[0]!, locale)
          : { title: `TradePilot · ${WORDS[locale].held(events.length)}`, lines: events.map((event) => notificationText(event, locale)), urgent: false };
        const text = events.length === 1 && !batch[0]!.held ? notificationText(events[0]!, locale) : [message.title, ...message.lines].join("\n");
        const result = await this.deliver(target, message, text, events);
        if (result.ok) { delivered.push(...events.map((event) => event.id)); continue; }
        for (const item of batch) {
          const attempts = item.attempts + 1;
          if (attempts > RETRY_DELAYS_MS.length) {
            console.error(JSON.stringify({ message: "TradePilot notification given up", type: item.event.type, format: target.format, attempts: item.attempts }));
            continue;
          }
          await this.keep({ ...item, attempts, dueAt: now + RETRY_DELAYS_MS[attempts - 1]! }).catch(() => {});
        }
      }
    }
    return delivered;
  }

  /** One test message to each endpoint, sent at once whatever the hour, with what each answered. Never held or retried. */
  async test(): Promise<NotifyTestResult[]> {
    const words = WORDS[this.deps.config.notifyLocale];
    const message = { title: `TradePilot · ${words.test}`, lines: [words.testBody], urgent: false };
    // The plain JSON body carries no event: a receiver that acts on events has nothing to act on.
    return Promise.all(this.targets.map(async (target) => ({ format: target.format, host: new URL(target.url).hostname, ...(await this.deliver(target, message, `${message.title} · ${words.testBody}`, [])) })));
  }
}

export function createNotifications(config: RuntimeConfig, store?: StateStore, fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): Notifications | undefined {
  if (!config.notifyTargets.length) return undefined;
  return new Notifications({ config, ...(store ? { store } : {}), fetcher });
}
