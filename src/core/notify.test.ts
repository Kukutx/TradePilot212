import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../shared/contracts.js";
import { createConfig, isLoopbackHost, type RuntimeEnv } from "./config.js";
import { deliveryFor, inQuietHours, Notifications, notificationMessage, notificationText, parseNotifyLocale, parseNotifyTargets, parseQuietHours, quietHoursEnd } from "./notify.js";
import { MemoryStateStore } from "./state-store.js";

const fill: ActivityEvent = {
  id: "e1", timestamp: "2026-10-31T10:00:00.000Z", environment: "live", type: "order_filled", ticker: "VUSAl_EQ", side: "buy", quantity: 3, filledQuantity: 3,
  price: 101.255, value: 1303.75, valueCurrency: "EUR",
};
const targets = (raw: string) => parseNotifyTargets(raw, isLoopbackHost);

describe("notification settings", () => {
  it("knows the services by their address, takes a format before any other, and reads several endpoints", () => {
    expect(targets([
      "https://hooks.slack.com/services/T/B/x",
      "https://discord.com/api/webhooks/1/abc,",
      "https://api.telegram.org/bot123:ABC/sendMessage?chat_id=-100",
      "https://ntfy.sh/my-topic?tags=a,b",
      "https://api.day.app/KEY/",
      "ntfy:https://push.example.com/alerts",
      "https://example.com/hook",
    ].join(" ")).map((target) => target.format)).toEqual(["slack", "discord", "telegram", "ntfy", "bark", "ntfy", "raw"]);
    // A comma inside an address (an ntfy tag list) is kept; a comma between addresses separates them.
    expect(targets("https://ntfy.sh/t?tags=a,b,https://example.com/x").map((target) => target.url)).toEqual(["https://ntfy.sh/t?tags=a,b", "https://example.com/x"]);
    expect(targets("")).toEqual([]);
    // Formats and schemes in capitals separate addresses too.
    expect(targets("https://a.example/h,NTFY:https://n.example/t,HTTPS://b.example/x").map((target) => target.format)).toEqual(["raw", "ntfy", "raw"]);
  });

  it("refuses what cannot be delivered, without repeating an address that may hold a token", () => {
    const refusal = (raw: string) => { try { targets(raw); return ""; } catch (error) { return (error as Error).message; } };
    expect(refusal("http://hooks.example/t")).toMatch(/HTTPS/);
    expect(refusal("https://a.example/x https://api.telegram.org/botSECRET/sendMessage")).toMatch(/second.*chat_id/);
    expect(refusal("https://api.telegram.org/botSECRET/sendMessage")).not.toContain("SECRET");
    expect(refusal("teams:https://example.com/x")).toMatch(/unknown format/);
    expect(refusal("ntfy:https://ntfy.example.com/")).toMatch(/topic/);
    expect(targets("http://localhost:8787/hook")[0]!.format).toBe("raw");
    expect(refusal("https://user:SECRET@hooks.example/t")).toMatch(/user name or password/);
    expect(refusal("https://user:SECRET@hooks.example/t")).not.toContain("SECRET");
    expect(refusal("https://a.example/x?next=https://b.example/y")).toMatch(/second address/);
    expect(() => createConfig({ NOTIFY_WEBHOOK_URL: "http://hooks.example/t" })).toThrow(/HTTPS/);
  });

  it("reads the language and the quiet hours", () => {
    expect(parseNotifyLocale(undefined)).toBe("en");
    expect(parseNotifyLocale("zh")).toBe("zh-CN");
    expect(() => parseNotifyLocale("fr")).toThrow(/en or zh-CN/);
    expect(parseQuietHours("22-07")).toEqual({ start: 22, end: 7 });
    expect(parseQuietHours("09:00-17:00")).toEqual({ start: 9, end: 17 });
    expect(() => parseQuietHours("7-7")).toThrow();
    expect(() => parseQuietHours("25-7")).toThrow();
    const config = createConfig({ NOTIFY_WEBHOOK_URL: "https://hooks.slack.com/services/x", NOTIFY_LOCALE: "zh-CN", NOTIFY_QUIET_HOURS: "22-7" });
    expect([config.notifyTargets[0]!.format, config.notifyLocale, config.notifyQuietHours]).toEqual(["slack", "zh-CN", { start: 22, end: 7 }]);
  });

  it("counts quiet hours in the zone's own clock, across midnight and summer time", () => {
    const quiet = { start: 22, end: 7 };
    // 23:30 in London in summer is 22:30 UTC.
    expect(inQuietHours(quiet, Date.parse("2026-07-01T22:30:00Z"), "Europe/London")).toBe(true);
    expect(inQuietHours(quiet, Date.parse("2026-07-01T06:30:00Z"), "Europe/London")).toBe(false);
    expect(new Date(quietHoursEnd(quiet, Date.parse("2026-07-01T22:30:00Z"), "Europe/London")).toISOString()).toBe("2026-07-02T06:00:00.000Z");
    // After midnight, the same morning; the night the clocks go back has its end in winter time.
    expect(new Date(quietHoursEnd(quiet, Date.parse("2026-10-25T02:00:00Z"), "Europe/London")).toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });
});

describe("notification text", () => {
  it("writes figures in the language's own way and names the account", () => {
    expect(notificationText(fill)).toBe("[TradePilot LIVE] Order filled · VUSAl_EQ · Buy 3 · @ 101.255 · €1,303.75");
    expect(notificationText(fill, "zh-CN")).toBe("[TradePilot 实盘] 订单已成交 · VUSAl_EQ · 买入 3 股 · @ 101.255 · €1,303.75");
    expect(notificationText({ ...fill, type: "order_partly_filled", quantity: 10, filledQuantity: 2.5 }, "zh-CN")).toContain("买入 10 股 · 成交 2.5 股");
    const message = notificationMessage({ id: "d", timestamp: "", environment: "demo", type: "daily_digest", outcome: "Total 1000 EUR · cash 50" }, "zh-CN");
    expect(message).toEqual({ title: "TradePilot · 模拟 · 每日摘要", lines: ["Total 1000 EUR", "cash 50"], urgent: false });
    expect(notificationMessage({ ...fill, type: "order_status_unknown" }).urgent).toBe(true);
  });

  it("lays a message out for each service", () => {
    const message = notificationMessage(fill);
    const text = notificationText(fill);
    const body = (raw: string) => JSON.parse(deliveryFor(targets(raw)[0]!, message, text, [fill]).body);
    expect(body("https://example.com/hook")).toEqual({ text, content: text, event: fill });
    expect(body("https://hooks.slack.com/services/x").blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "TradePilot · Live · Order filled" } });
    // A ticker's underscore is not italics on Discord, and nobody is pinged.
    expect(body("https://discord.com/api/webhooks/1/x")).toEqual({ content: "**TradePilot · Live · Order filled**\nVUSAl\\_EQ · Buy 3 · @ 101.255 · €1,303.75", allowed_mentions: { parse: [] } });
    const telegram = deliveryFor(targets("https://api.telegram.org/bot1:A/sendMessage?chat_id=42")[0]!, { ...message, title: "<b>&" }, text, [fill]);
    expect(telegram.url).toBe("https://api.telegram.org/bot1:A/sendMessage");
    expect(JSON.parse(telegram.body)).toMatchObject({ chat_id: "42", parse_mode: "HTML", text: expect.stringMatching(/^<b>&lt;b&gt;&amp;<\/b>\n/) });
    const ntfy = deliveryFor(targets("https://ntfy.sh/my-topic")[0]!, { ...message, urgent: true }, text, [fill]);
    expect([ntfy.url, JSON.parse(ntfy.body)]).toEqual(["https://ntfy.sh/", { topic: "my-topic", title: message.title, message: message.lines.join("\n"), priority: 4 }]);
    expect(body("https://api.day.app/KEY")).toMatchObject({ title: message.title, group: "TradePilot", level: "active" });
    // A long message is cut before it is escaped, so no entity is cut in two.
    const long = JSON.parse(deliveryFor(targets("https://api.telegram.org/bot1:A/sendMessage?chat_id=42")[0]!, { ...message, lines: Array.from({ length: 1500 }, () => "S&P") }, text, [fill]).body).text as string;
    expect(long.endsWith("…")).toBe(true);
    expect(long.replace(/&(amp|lt|gt);/g, "").includes("&")).toBe(false);
  });
});

function setup(env: RuntimeEnv, answer: (url: string, body: string) => number) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const clock = { now: Date.parse("2026-10-31T12:00:00Z") };
  const store = new MemoryStateStore();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: String(init?.body), headers: init?.headers as Record<string, string> };
    calls.push(call);
    return new Response("", { status: answer(call.url, call.body) });
  }) as typeof fetch;
  const notifications = new Notifications({ config: createConfig(env), store, fetcher, now: () => clock.now });
  return { notifications, calls, clock, store };
}

describe("sending notifications", () => {
  it("sends to every endpoint, signs each body, and tries again later where one failed, giving up after five more tries", async () => {
    let down = true;
    const { notifications, calls, clock } = setup({ NOTIFY_WEBHOOK_URL: "https://a.example/x https://b.example/y", NOTIFY_WEBHOOK_SECRET: "shh" }, (url) => (url.includes("b.example") && down ? 500 : 200));
    expect(await notifications.send(fill)).toBe(true);
    // Both at once, in either order.
    expect(calls.map((call) => call.url).sort()).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(calls[0]!.headers["X-TradePilot-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Not yet due: nothing is sent.
    calls.length = 0;
    expect(await notifications.flush()).toEqual([]);
    expect(calls).toHaveLength(0);
    clock.now += 61_000;
    expect(await notifications.flush()).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual(["https://b.example/y"]);
    down = false;
    clock.now += 5 * 60_000;
    expect(await notifications.flush()).toEqual(["e1"]);
    expect(await notifications.flush()).toEqual([]);

    down = true;
    calls.length = 0;
    await notifications.send({ ...fill, id: "e2" });
    for (const wait of [1, 5, 15, 60, 180, 600]) { clock.now += wait * 60_000 + 1000; await notifications.flush(); }
    // The first try and five more, then no more.
    expect(calls.filter((call) => call.url.includes("b.example"))).toHaveLength(6);
  });

  it("leaves a digest no endpoint took to its own retry, and only sends listed events unless forced", async () => {
    const { notifications, calls, clock } = setup({ NOTIFY_WEBHOOK_URL: "https://a.example/x", NOTIFY_EVENTS: "order_filled" }, () => 503);
    const digest: ActivityEvent = { id: "d1", timestamp: "", environment: "demo", type: "daily_digest", outcome: "Total 1" };
    expect(await notifications.send(digest)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await notifications.send(digest, { force: true })).toBe(false);
    clock.now += 3_600_000;
    calls.length = 0;
    await notifications.flush();
    expect(calls).toHaveLength(0);
  });

  it("holds what can wait during quiet hours and sends it as one message when they end; urgent events go at once", async () => {
    const { notifications, calls, clock } = setup({ NOTIFY_WEBHOOK_URL: "https://hooks.slack.com/services/x", NOTIFY_QUIET_HOURS: "22-07", TIMEZONE: "Europe/London", NOTIFY_LOCALE: "zh-CN" }, () => 200);
    clock.now = Date.parse("2026-10-31T23:15:00Z");
    expect(await notifications.send(fill)).toBe(true);
    expect(await notifications.send({ ...fill, id: "e2", type: "price_alert_triggered", timestamp: "2026-10-31T23:20:00.000Z", outcome: "VUSA above 100" })).toBe(true);
    expect(calls).toHaveLength(0);
    await notifications.send({ ...fill, id: "e3", type: "order_status_unknown" });
    expect(calls).toHaveLength(1);
    clock.now = Date.parse("2026-11-01T06:59:00Z");
    await notifications.flush();
    expect(calls).toHaveLength(1);
    clock.now = Date.parse("2026-11-01T07:00:00Z");
    expect((await notifications.flush()).sort()).toEqual(["e1", "e2"]);
    const body = JSON.parse(calls[1]!.body);
    expect(body.blocks[0].text.text).toBe("TradePilot · 静默时段内的 2 条通知");
    expect(body.blocks[1].text.text.split("\n")).toEqual([
      "[TradePilot 实盘] 订单已成交 · VUSAl_EQ · 买入 3 股 · @ 101.255 · €1,303.75",
      "[TradePilot 实盘] 价格提醒 · VUSAl_EQ · 买入 3 股 · @ 101.255 · VUSA above 100",
    ]);
  });

  it("tests each endpoint, saying only its kind and host", async () => {
    const { notifications, calls } = setup({ NOTIFY_WEBHOOK_URL: "https://api.telegram.org/botSECRET/sendMessage?chat_id=1 https://b.example/y" }, (url) => (url.includes("b.example") ? 404 : 200));
    const results = await notifications.test();
    expect(results).toEqual([{ format: "telegram", host: "api.telegram.org", ok: true, status: 200 }, { format: "raw", host: "b.example", ok: false, status: 404 }]);
    expect(JSON.stringify(results)).not.toContain("SECRET");
    expect(JSON.parse(calls.find((call) => call.url.includes("b.example"))!.body)).toMatchObject({ events: [] });
  });

  it("never passes on an error's own words, which can repeat the address", async () => {
    const config = createConfig({ NOTIFY_WEBHOOK_URL: "https://hooks.example/tok3n" });
    const fetcher = (async () => { throw new TypeError("fetch failed for https://hooks.example/tok3n"); }) as typeof fetch;
    const results = await new Notifications({ config, fetcher }).test();
    expect(results).toEqual([{ format: "raw", host: "hooks.example", ok: false, error: "could not connect" }]);
  });

  it("sends what it took from the store, and puts back one another scheduler set for later", async () => {
    const { notifications, calls, clock, store } = setup({ NOTIFY_WEBHOOK_URL: "https://a.example/x" }, () => 500);
    await notifications.send(fill);
    clock.now += 61_000;
    const [entry] = await store.list<{ dueAt: number; attempts: number }>("notify-outbox:");
    // Another scheduler already tried it again and set the next try for later; this one listed the older copy.
    const list = store.list.bind(store);
    store.list = (async (prefix: string) => {
      const listed = await list(prefix);
      await store.put(entry!.key, { ...entry!.value, attempts: 2, dueAt: clock.now + 5 * 60_000 });
      return listed;
    }) as typeof store.list;
    calls.length = 0;
    expect(await notifications.flush()).toEqual([]);
    expect(calls).toHaveLength(0);
    store.list = list;
    expect((await store.list<{ attempts: number }>("notify-outbox:"))[0]!.value.attempts).toBe(2);
  });
});
