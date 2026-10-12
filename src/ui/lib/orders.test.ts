import { describe, expect, it } from "vitest";
import type { OrderDraft, OrderResolution, PendingOrder, Position } from "../../shared/contracts";
import { createTranslator } from "../i18n";
import { intentForAccount, riskAtStop, stopCoverageText, summarizeOrder } from "./orders";

const apple = { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD", type: "STOCK" };
const positions = [{ instrument: apple, quantity: 10, averagePricePaid: 150, currentPrice: 200 }] as unknown as Position[];
const t = createTranslator("en");

describe("pending order summaries", () => {
  it("says how far a held instrument's stop or limit price is from its last price", () => {
    const stop = { id: 1, ticker: "AAPL_US_EQ", type: "STOP", side: "SELL", quantity: -10, stopPrice: 190 } as PendingOrder;
    expect(summarizeOrder(stop, t, "en", positions).distance).toBe("5.0% below the last price ($200.00)");
    const limit = { id: 2, ticker: "AAPL_US_EQ", type: "LIMIT", side: "SELL", quantity: -5, limitPrice: 230 } as PendingOrder;
    expect(summarizeOrder(limit, t, "en", positions).distance).toBe("15.0% above the last price ($200.00)");
    // A Stop-Limit is measured from its trigger, not its limit.
    const stopLimit = { id: 3, ticker: "AAPL_US_EQ", type: "STOP_LIMIT", side: "SELL", quantity: -5, stopPrice: 200.05, limitPrice: 180 } as PendingOrder;
    expect(summarizeOrder(stopLimit, t, "en", positions).distance).toBe("At the last price ($200.00)");
    expect(summarizeOrder(stop, createTranslator("zh-CN"), "zh-CN", positions).distance).toBe("比现价 US$200.00 低 5.0%");
  });

  it("leaves the distance out without a last price or an order price", () => {
    const notHeld = { id: 4, ticker: "MSFT_US_EQ", type: "LIMIT", side: "BUY", quantity: 1, limitPrice: 300 } as PendingOrder;
    expect(summarizeOrder(notHeld, t, "en", positions).distance).toBeUndefined();
    const market = { id: 5, ticker: "AAPL_US_EQ", type: "MARKET", side: "BUY", quantity: 1 } as PendingOrder;
    expect(summarizeOrder(market, t, "en", positions).distance).toBeUndefined();
  });
});

describe("stop coverage", () => {
  const position = positions[0]!;
  it("says at least, or unknown, when a stop is placed by amount", () => {
    const base = { ticker: "AAPL_US_EQ", stopPrice: 190, orders: 2, levels: [] };
    expect(stopCoverageText({ ...base, covered: 4, coverage: 0.4, unsized: 1 }, position, "en", t)).toBe("Covers at least 4 of 10");
    expect(stopCoverageText({ ...base, covered: 0, coverage: 0, unsized: 1 }, position, "en", t)).toBe("Placed by amount; shares not known");
    expect(stopCoverageText({ ...base, covered: 4, coverage: 0.4 }, position, "en", t)).toBe("Covers 4 of 10");
  });
});

describe("risk at the stop", () => {
  // Sized for 30 EUR at 216 USD with a stop at 200: 16 USD a share, 14.81 EUR at 1.08.
  const resolution: OrderResolution = { sizing: { mode: "risk", percent: 1, stopLossPrice: 200 }, resolvedQuantity: 2.025, accountCurrency: "EUR", risk: { budget: 30, entryPrice: 216, perShare: 16 / 1.08 } };
  const draft: OrderDraft = { environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "market", quantity: 2.025, referencePrice: 216 };

  it("follows the quantity and entry price as they are edited", () => {
    expect(riskAtStop(draft, resolution)).toEqual({ loss: expect.closeTo(30, 8), budget: 30, over: false, cashCapped: false });
    expect(riskAtStop({ ...draft, quantity: 4 }, resolution)).toMatchObject({ loss: expect.closeTo(59.26, 2), over: true });
    // A limit at 208 halves the fall to the stop.
    expect(riskAtStop({ ...draft, type: "limit", limitPrice: 208 }, resolution)?.loss).toBeCloseTo(15, 8);
    expect(riskAtStop({ ...draft, type: "limit", limitPrice: 195 }, resolution)).toEqual({ budget: 30, over: false, cashCapped: false });
  });

  it("is only for risk-sized drafts", () => {
    expect(riskAtStop(draft, undefined)).toBeUndefined();
    expect(riskAtStop(draft, { sizing: { mode: "quantity", quantity: 2 }, resolvedQuantity: 2 })).toBeUndefined();
  });
});

describe("switching accounts", () => {
  const draft: OrderDraft = { environment: "demo", ticker: "AAPL_US_EQ", side: "buy", type: "limit", quantity: 7, limitPrice: 208, timeValidity: "DAY", referencePrice: 216 };
  it("sizes again what depends on the account, with the draft's own prices", () => {
    const risk: OrderResolution = { sizing: { mode: "risk", percent: 1, stopLossPrice: 200 }, resolvedQuantity: 2 };
    expect(intentForAccount(draft, risk, "live")).toEqual({ environment: "live", instrument: "AAPL_US_EQ", side: "buy", type: "limit", sizing: risk.sizing, limitPrice: 208, timeValidity: "DAY" });
    expect(intentForAccount(draft, { sizing: { mode: "cash_percent", percent: 10 }, resolvedQuantity: 2 }, "live")).toMatchObject({ sizing: { mode: "cash_percent" } });
  });

  it("leaves out an exchange rate given for the first account's currency", () => {
    const risk: OrderResolution = { sizing: { mode: "risk", amount: 50, stopLossPrice: 200, fxRateToInstrumentCurrency: 1.08 }, resolvedQuantity: 2 };
    expect(intentForAccount(draft, risk, "live")?.sizing).toEqual({ mode: "risk", amount: 50, stopLossPrice: 200 });
    expect(risk.sizing).toHaveProperty("fxRateToInstrumentCurrency", 1.08);
  });

  it("keeps a quantity or an amount as it is", () => {
    expect(intentForAccount(draft, { sizing: { mode: "quantity", quantity: 7 }, resolvedQuantity: 7 }, "live")).toBeUndefined();
    expect(intentForAccount(draft, { sizing: { mode: "notional", amount: 100 }, resolvedQuantity: 0.5 }, "live")).toBeUndefined();
    expect(intentForAccount(draft, undefined, "live")).toBeUndefined();
  });
});
