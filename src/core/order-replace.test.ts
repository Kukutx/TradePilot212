import { describe, expect, it } from "vitest";
import type { ActivityEvent, PendingOrder } from "../shared/contracts.js";
import type { ProtectiveLink } from "../shared/automation.js";
import { createConfig } from "./config.js";
import { confirmationMessage } from "./order-confirm.js";
import { heldBack, replacementDraft, sameOpenOrder } from "./order-replace.js";
import { ProtectiveLinks } from "./protective-links.js";
import { createSampleBroker } from "./sample-broker.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";
import { TradingService } from "./trading-service.js";

const limitBuy: PendingOrder = { id: 81234, ticker: "TSLA_US_EQ", side: "BUY", quantity: 3, filledQuantity: 0, status: "NEW", type: "LIMIT", limitPrice: 215, timeInForce: "GOOD_TILL_CANCEL", strategy: "QUANTITY" };
const stopSell: PendingOrder = { id: 81235, ticker: "NVDA_US_EQ", side: "SELL", quantity: -5, filledQuantity: 0, status: "NEW", type: "STOP", stopPrice: 118, timeInForce: "GOOD_TILL_CANCEL", strategy: "QUANTITY" };

describe("the order that replaces an open one", () => {
  it("keeps the instrument, side, type and what is not changed", () => {
    expect(replacementDraft("demo", limitBuy, { limitPrice: 210 })).toEqual({ environment: "demo", ticker: "TSLA_US_EQ", side: "buy", type: "limit", quantity: 3, limitPrice: 210, timeValidity: "GOOD_TILL_CANCEL" });
    expect(replacementDraft("demo", stopSell, { quantity: 8, timeValidity: "DAY" })).toEqual({ environment: "demo", ticker: "NVDA_US_EQ", side: "sell", type: "stop", quantity: 8, stopPrice: 118, timeValidity: "DAY" });
    const stopLimit = { ...limitBuy, type: "STOP_LIMIT", stopPrice: 220, limitPrice: 225 };
    expect(replacementDraft("demo", stopLimit, { stopPrice: 221 })).toMatchObject({ type: "stop_limit", stopPrice: 221, limitPrice: 225 });
  });

  it("refuses what it can't change this way", () => {
    expect(() => replacementDraft("demo", { ...limitBuy, type: "MARKET" }, { quantity: 2 })).toThrow(/fills at once/);
    expect(() => replacementDraft("demo", { ...limitBuy, strategy: "VALUE" }, { quantity: 2 })).toThrow(/by amount/);
    expect(() => replacementDraft("demo", { ...limitBuy, filledQuantity: 1 }, { quantity: 2 })).toThrow(/already filled 1 of 3/);
    expect(() => replacementDraft("demo", limitBuy, { stopPrice: 200 })).toThrow(/no stop price/);
    expect(() => replacementDraft("demo", stopSell, { limitPrice: 200 })).toThrow(/no limit price/);
    expect(() => replacementDraft("demo", limitBuy, { limitPrice: 215 })).toThrow(/nothing to send/);
    expect(() => replacementDraft("demo", limitBuy, { quantity: -1 })).toThrow(/positive/);
  });

  it("knows what an open order holds back, and when it changed since the review", () => {
    expect(heldBack(limitBuy)).toEqual({ shares: 0, value: 645 });
    expect(heldBack(stopSell)).toEqual({ shares: 5, value: 0 });
    expect(sameOpenOrder(limitBuy, { ...limitBuy })).toBe(true);
    expect(sameOpenOrder(limitBuy, { ...limitBuy, limitPrice: 214 })).toBe(false);
    expect(sameOpenOrder(limitBuy, { ...limitBuy, filledQuantity: 1 })).toBe(false);
  });
});

type Handler = (method: string, path: string, response: () => Promise<Response>) => Promise<Response> | undefined;

/** The sample account, with `handle` able to answer a request itself (or pass it on), and every write recorded. */
function setup(handle: Handler = () => undefined) {
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" });
  const sample = createSampleBroker((async () => new Response("{}")) as typeof fetch);
  const writes: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v0/, "");
    if (method !== "GET") writes.push(`${method} ${path}`);
    return handle(method, path, () => sample(input, init)) ?? sample(input, init);
  }) as typeof fetch;
  const store = new MemoryStateStore();
  const links: { trading?: TradingService; links?: ProtectiveLinks } = {};
  const trading = new TradingService({
    config, store, fetcher,
    beforeReplace: (environment, orderId) => links.links!.hold(environment, orderId),
    afterReplace: (environment, orderId, newOrderId) => links.links!.swap(environment, orderId, newOrderId),
  });
  links.links = new ProtectiveLinks({ config, store, trading });
  return { trading, writes, store, links: links.links };
}

const activity = async (trading: TradingService) => (await trading.getActivity("demo", 30)).map((event: ActivityEvent) => event.type);

describe("changing an open order on the sample account", () => {
  it("cancels it, waits for the cancel, then places the new one, and keeps a protective pair linked", async () => {
    const { trading, writes, store, links } = setup();
    const link: ProtectiveLink = { id: "pair", environment: "demo", ticker: "NVDA_US_EQ", orders: [{ orderId: "81235", role: "stop_loss" }, { orderId: "81299", role: "take_profit" }], createdAt: new Date().toISOString() };
    await store.put("link:pair", link, Date.now() + 86_400_000);

    // 20 held, 4 in pies, 5 held back by the stop itself: 16 can be covered once it is cancelled, 17 can't.
    await expect(trading.prepareReplace("demo", "81235", { quantity: 17 })).rejects.toThrow(/exceeds available quantity 16/);
    const preview = await trading.prepareReplace("demo", "81235", { quantity: 16, stopPrice: 112 });
    expect(preview).toMatchObject({ kind: "replace_preview", orderId: "81235", original: { stopPrice: 118 }, draft: { side: "sell", type: "stop", quantity: 16, stopPrice: 112 }, availableToSell: 16 });
    expect(confirmationMessage(await trading.describePending(preview.token, "replace"), "zh-CN")).toBe([
      "修改你 Trading 212 模拟账户里的订单 81235？会先撤掉原单，等 Trading 212 显示原单没有任何成交后再下新单。",
      "原单： 卖出 5 股 NVDA_US_EQ，止损价 118，撤销前有效",
      "新单： 卖出 16 股 NVDA_US_EQ，止损价 112，撤销前有效",
    ].join("\n"));
    expect(describePayload(preview as never)).toMatch(/Ready to change on DEMO: #81235 SELL 5 [^\n]*\nIt becomes: SELL 16 NVDA_US_EQ \(NVIDIA\) stop @ 112 /);
    expect(writes).toEqual([]);

    const result = await trading.executeReplace(preview.token);
    expect(result).toMatchObject({ kind: "replace_execution", ok: true, stage: "replaced", orderId: "81235" });
    expect(writes).toEqual(["DELETE /equity/orders/81235", "POST /equity/orders/stop"]);
    const orders = await trading.pendingOrders("demo");
    expect(orders.find((order) => String(order.id) === "81235")).toBeUndefined();
    expect(orders.find((order) => String(order.id) === result.newOrderId)).toMatchObject({ quantity: -16, stopPrice: 112 });
    // The pair now links the new stop, and is no longer held.
    const [kept] = await links.list();
    expect(kept!.orders[0]).toEqual({ orderId: result.newOrderId, role: "stop_loss" });
    expect(kept!.hold).toBeUndefined();
    expect(await activity(trading)).toEqual(expect.arrayContaining(["replace_prepared", "cancel_submitted", "order_submitted", "order_replaced"]));
    // A token is used once.
    await expect(trading.executeReplace(preview.token)).rejects.toThrow(/expired/);
  });

  it("counts the cash an open buy holds back as free for the buy that replaces it, with room for the fees", async () => {
    const { trading } = setup();
    // Another open buy: Trading 212's reserved figure covers it too, and it is not freed by this change.
    await trading.executeOrder((await trading.prepareOrder({ environment: "demo", ticker: "MSFT", side: "buy", type: "limit", quantity: 1, limitPrice: 300, timeValidity: "DAY" })).token);
    const account = await trading.accountSummary("demo");
    const cash = account.cash!.availableToTrade!;
    const reserved = account.cash!.reservedForOrders!;
    const msft = reserved - (await trading.prepareReplace("demo", "81234", { limitPrice: 214 })).availableCash! + cash;
    const tsla = reserved - msft;
    expect(msft).toBeGreaterThan(0);
    const perShare = tsla / 3;
    // USD bought from EUR: the conversion fee (0.15%) must fit too, so the largest size is the one whose value and fee fit.
    const fits = Math.floor((cash + tsla) / (perShare * 1.0015));
    expect(fits * perShare).toBeGreaterThan(cash);
    const preview = await trading.prepareReplace("demo", "81234", { quantity: fits });
    expect(preview.availableCash).toBeCloseTo(cash + tsla, 2);
    // All of it, to the cent: it fits without the fee, but a change is not sent unless the fee fits too.
    const all = Math.floor(((cash + tsla) / perShare) * 1e4) / 1e4;
    await expect(trading.prepareReplace("demo", "81234", { quantity: all })).rejects.toThrow(/With fees, the changed order needs/);
    expect((await trading.executeReplace(preview.token)).stage).toBe("replaced");
  });

  it("leaves an order alone that Trading 212 shows as no longer working", async () => {
    let ended = false;
    const { trading, writes } = setup((method, path) => (ended && method === "GET" && path === "/equity/orders/81234"
      ? Promise.resolve(Response.json({ ...limitBuy, status: "CANCELLED" })) : undefined));
    const preview = await trading.prepareReplace("demo", "81234", { limitPrice: 210 });
    ended = true;
    expect(await trading.executeReplace(preview.token)).toMatchObject({ stage: "unchanged", reason: "gone" });
    expect(writes).toEqual([]);
  });

  it("leaves the order alone when it changed since the review or the new order fails its checks", async () => {
    let edited = false;
    const { trading, writes } = setup((method, path) => (edited && method === "GET" && path === "/equity/orders/81234"
      ? Promise.resolve(Response.json({ ...limitBuy, limitPrice: 205 })) : undefined));
    const preview = await trading.prepareReplace("demo", "81234", { limitPrice: 210 });
    edited = true;
    expect(await trading.executeReplace(preview.token)).toMatchObject({ ok: false, stage: "unchanged", reason: "changed" });
    expect(writes).toEqual([]);
    expect(await activity(trading)).not.toContain("replace_stopped");
  });

  it("does not place the new order when the old one filled while it was cancelled", async () => {
    // Trading 212 reports the cancelled order with one share filled.
    const { trading, writes } = setup((method, path, response) => {
      if (method !== "GET" || !path.startsWith("/equity/history/orders") || !writes.length) return undefined;
      return response().then(async (page) => {
        const body = await page.json() as { items: Array<{ order?: { id?: number } }>; nextPagePath: string | null };
        const items = body.items.map((item) => (item.order?.id === 81234 ? { order: { ...item.order, filledQuantity: 1 }, fill: { id: 1, quantity: 1, price: 214, filledAt: new Date().toISOString() } } : item));
        return Response.json({ ...body, items });
      });
    });
    const preview = await trading.prepareReplace("demo", "81234", { limitPrice: 210 });
    expect(await trading.executeReplace(preview.token)).toMatchObject({ ok: false, stage: "cancelled_not_placed", reason: "filled" });
    expect(writes).toEqual(["DELETE /equity/orders/81234"]);
    expect(await activity(trading)).toContain("replace_stopped");
  });

  it("does not place the new order when the history does not show the cancel yet", async () => {
    const { trading, writes } = setup((method, path, response) => {
      if (method !== "GET" || !path.startsWith("/equity/history/orders") || !writes.length) return undefined;
      return response().then(async (page) => {
        const body = await page.json() as { items: Array<{ order?: { id?: number } }>; nextPagePath: string | null };
        return Response.json({ ...body, items: body.items.filter((item) => item.order?.id !== 81234) });
      });
    });
    const preview = await trading.prepareReplace("demo", "81234", { limitPrice: 210 });
    expect(await trading.executeReplace(preview.token)).toMatchObject({ stage: "cancelled_not_placed", reason: "not_confirmed" });
    expect(writes).toEqual(["DELETE /equity/orders/81234"]);
  }, 15_000);

  it("does not place the new order while Trading 212 still lists the old one after the cancel", async () => {
    // The cancel is answered, but the order only ever reads as being cancelled: that is not cancelled yet.
    let sent = false;
    const { trading, writes } = setup((method, path) => {
      if (method === "DELETE") { sent = true; return Promise.resolve(new Response(null, { status: 200 })); }
      return sent && method === "GET" && path === "/equity/orders/81234" ? Promise.resolve(Response.json({ ...limitBuy, status: "CANCELLING" })) : undefined;
    });
    const preview = await trading.prepareReplace("demo", "81234", { limitPrice: 210 });
    const result = await trading.executeReplace(preview.token);
    expect(result).toMatchObject({ ok: false, stage: "unknown", reason: "cancel_unknown" });
    expect(result.verificationId).toBeTruthy();
    expect(writes).toEqual(["DELETE /equity/orders/81234"]);
  }, 20_000);

  it("says plainly when the old order was cancelled and Trading 212 refused the new one", async () => {
    const { trading, writes, store, links } = setup((method, path) => (method === "POST" && path === "/equity/orders/limit"
      ? Promise.resolve(Response.json({ code: "InsufficientFreeForStocksException" }, { status: 400 })) : undefined));
    const link: ProtectiveLink = { id: "pair", environment: "demo", ticker: "TSLA_US_EQ", orders: [{ orderId: "81234", role: "take_profit" }, { orderId: "81299", role: "stop_loss" }], createdAt: new Date().toISOString() };
    await store.put("link:pair", link, Date.now() + 86_400_000);
    const preview = await trading.prepareReplace("demo", "81234", { limitPrice: 210 });
    const result = await trading.executeReplace(preview.token);
    expect(result).toMatchObject({ ok: false, stage: "cancelled_not_placed", reason: "placement_rejected" });
    expect(result.message).toMatch(/neither is open now/);
    expect(writes).toEqual(["DELETE /equity/orders/81234", "POST /equity/orders/limit"]);
    // Nothing replaced it: the pair is released to be checked as before, with the old id.
    expect((await links.list())[0]).toEqual(link);
  });

  it("leaves a protective pair alone while one of its orders is being changed", async () => {
    const { trading, store, links } = setup();
    const link: ProtectiveLink = { id: "pair", environment: "demo", ticker: "NVDA_US_EQ", orders: [{ orderId: "81235", role: "stop_loss" }, { orderId: "81234", role: "take_profit" }], createdAt: new Date().toISOString() };
    await store.put("link:pair", link, Date.now() + 86_400_000);
    await links.hold("demo", "81235");
    await trading.executeCancel((await trading.prepareCancel("demo", "81235")).token);
    // Held: the stop is out of the book for a moment, which is not a fill or a cancel of the pair.
    expect(await links.reconcile()).toEqual([]);
    expect(await links.list()).toHaveLength(1);
    // Released with nothing in its place: the stop closed without a fill, so the pair is unlinked as before.
    await links.swap("demo", "81235");
    expect(await links.reconcile()).toEqual([expect.objectContaining({ action: "unlinked" })]);
    expect(await links.list()).toEqual([]);
  });
});
