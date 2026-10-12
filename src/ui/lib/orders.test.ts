import { describe, expect, it } from "vitest";
import type { PendingOrder, Position } from "../../shared/contracts";
import { createTranslator } from "../i18n";
import { stopCoverageText, summarizeOrder } from "./orders";

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
