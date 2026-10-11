import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "../shared/contracts.js";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { asStructuredError } from "./errors.js";
import { MemoryStateStore } from "./state-store.js";
import { describePayload } from "./text-summary.js";
import { priceNotices, validateOrderAgainstSnapshot } from "./trading-service.js";

const etf: Instrument = { ticker: "VUSA_EQ", name: "VUSA ETF", shortName: "VUSA", currencyCode: "EUR", type: "ETF" };
const held: Position = { instrument: etf, quantity: 10, quantityAvailableForTrading: 10, quantityInPies: 0, averagePricePaid: 40, currentPrice: 50, walletImpact: { currentValue: 500 } };
const caps = { maxOrderNotional: 550, maxOrderQuantity: 1000 };

/** A Trading 212 fake whose order endpoint can answer 429 a set number of times. */
function setup(env: RuntimeEnv = {}, cash = 1000) {
  const posts: Array<Record<string, unknown>> = [];
  const limited = { remaining: 0 };
  const book = { open: [] as Array<Record<string, unknown>>, history: [] as Array<Record<string, unknown>> };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method === "POST") {
      if (limited.remaining > 0) { limited.remaining -= 1; return json({ code: "TooManyRequests" }, 429, { "retry-after": "0" }); }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return json({ id: posts.length, status: "NEW", ...body });
    }
    if (url.endsWith("/equity/metadata/instruments")) return json([etf]);
    if (url.endsWith("/equity/positions")) return json([held]);
    if (url.endsWith("/equity/account/summary")) return json({ currency: "EUR", totalValue: 1500, cash: { availableToTrade: cash } });
    if (url.endsWith("/equity/orders")) return json(book.open);
    if (url.includes("/equity/history/orders")) return json({ items: book.history, nextPagePath: null });
    return json([]);
  }) as typeof fetch;
  const config = createConfig({ T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s", MAX_ORDER_NOTIONAL: "5000", ...env });
  return { ...createServices({ config, store: new MemoryStateStore(), fetcher }), posts, limited, book };
}

describe("order value and price checks", () => {
  it("values a stop buy at its stop price when that is above the market", () => {
    const stopBuy = { environment: "demo" as const, ticker: "VUSA_EQ", side: "buy" as const, type: "stop" as const, quantity: 10, stopPrice: 60 };
    expect(() => validateOrderAgainstSnapshot(stopBuy, etf, held, { currency: "EUR", cash: { availableToTrade: 10_000 } }, caps)).toThrow(/MAX_ORDER_NOTIONAL/);
    expect(validateOrderAgainstSnapshot({ ...stopBuy, stopPrice: 52 }, etf, held, { currency: "EUR", cash: { availableToTrade: 10_000 } }, caps).estimatedNotional).toBe(520);
    // A sell stop below the market keeps its stop price, so its proceeds are not overstated.
    expect(validateOrderAgainstSnapshot({ ...stopBuy, side: "sell", stopPrice: 45 }, etf, held, { currency: "EUR", cash: { availableToTrade: 0 } }, caps).estimatedNotional).toBe(450);
  });

  it("blocks a limit or stop price ten times away from the last price, as from a unit slip", async () => {
    const { trading } = setup();
    const error = await trading.prepareOrder({ environment: "demo", ticker: "VUSA_EQ", side: "sell", type: "limit", quantity: 1, limitPrice: 5000, timeValidity: "GOOD_TILL_CANCEL" }).catch((caught: unknown) => caught);
    expect(asStructuredError(error)).toMatchObject({ code: "PRICE_OUT_OF_RANGE", details: { field: "limitPrice", price: 5000, last: 50 } });
    await expect(trading.prepareOrder({ environment: "demo", ticker: "VUSA_EQ", side: "sell", type: "stop", quantity: 1, stopPrice: 4, timeValidity: "GOOD_TILL_CANCEL" })).rejects.toThrow(/below the last price/);
  });

  it("says when a stop triggers at once, a limit fills at once, or a price is far from the last one", () => {
    const base = { environment: "demo" as const, ticker: "VUSA_EQ", quantity: 1 };
    expect(priceNotices({ ...base, side: "buy", type: "stop", stopPrice: 45 }, 50, "EUR").map((notice) => notice.code)).toEqual(["STOP_ALREADY_TRIGGERED"]);
    expect(priceNotices({ ...base, side: "sell", type: "stop", stopPrice: 45 }, 50, "EUR")).toEqual([]);
    expect(priceNotices({ ...base, side: "buy", type: "limit", limitPrice: 52 }, 50, "EUR").map((notice) => notice.code)).toEqual(["LIMIT_FILLS_AT_ONCE"]);
    expect(priceNotices({ ...base, side: "sell", type: "limit", limitPrice: 70 }, 50, "EUR")).toEqual([expect.objectContaining({ code: "PRICE_FAR_FROM_LAST", details: { percent: 40, last: 50, currency: "EUR" } })]);
    expect(priceNotices({ ...base, side: "buy", type: "market" }, 50, "EUR")).toEqual([]);
  });

  it("counts earlier buys of the same instrument in a basket against the cash", async () => {
    const { trading } = setup({}, 800);
    const buy = { environment: "demo" as const, ticker: "VUSA_EQ", side: "buy" as const, type: "market" as const, quantity: 10, referencePrice: 50 };
    await expect(trading.prepareBasket({ environment: "demo", purpose: "custom", title: "x", drafts: [buy, buy] })).rejects.toThrow(/Leg 2.*cash/i);
  });
});

describe("order status", () => {
  it("counts fills before a reject or cancel of the remainder", async () => {
    const { trading, book } = setup();
    book.history = [{ order: { id: 7, ticker: "VUSA_EQ", status: "REJECTED", quantity: -10, filledQuantity: -4 }, fill: { quantity: -4, price: 50 } }];
    expect((await trading.orderStatus("demo", "7")).state).toBe("partly_filled");
    book.history = [{ order: { id: 8, ticker: "VUSA_EQ", status: "REJECTED", quantity: 1, filledQuantity: 0 } }];
    expect((await trading.orderStatus("demo", "8")).state).toBe("rejected");
  });

  it("shows how much of an open sell has filled", async () => {
    const { trading, book } = setup();
    book.open = [{ id: 9, ticker: "VUSA_EQ", type: "LIMIT", status: "NEW", quantity: -10, filledQuantity: -3, limitPrice: 60 }];
    const status = await trading.orderStatus("demo", "9");
    expect(status.state).toBe("partly_filled");
    expect(describePayload(status)).toContain("(NEW, filled 3)");
  });
});

describe("sending", () => {
  it("retries a rate-limited order once after the broker's delay", async () => {
    const { trading, posts, limited } = setup();
    const preview = await trading.prepareOrder({ environment: "demo", ticker: "VUSA_EQ", side: "buy", type: "limit", quantity: 1, limitPrice: 49, timeValidity: "DAY" });
    limited.remaining = 1;
    expect((await trading.executeOrder(preview.token)).status).toBe("submitted");
    expect(posts).toHaveLength(1);
  });

  it("does not let two confirmations sent together pass the daily order limit", async () => {
    const { trading, posts } = setup({ POLICY_APPLY_TO: "demo", POLICY_DAILY_ORDER_LIMIT: "1", POLICY_MAX_POSITION_WEIGHT: "0" });
    const draft = { environment: "demo" as const, ticker: "VUSA_EQ", side: "buy" as const, type: "limit" as const, quantity: 1, limitPrice: 49, timeValidity: "DAY" as const };
    const [first, second] = [await trading.prepareOrder(draft), await trading.prepareOrder(draft)];
    const results = await Promise.all([trading.executeOrder(first.token), trading.executeOrder(second.token)]);
    expect(results.map((result) => result.status).sort()).toEqual(["rejected", "submitted"]);
    expect(posts).toHaveLength(1);
  });
});
