import { describe, expect, it } from "vitest";
import type { Instrument, OrderDraft } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { TradingService, validateOrderAgainstSnapshot } from "./trading-service.js";

const instrument: Instrument = {
  ticker: "AAPL_US_EQ",
  name: "Apple Inc.",
  shortName: "AAPL",
  currencyCode: "USD",
  maxOpenQuantity: 10,
  extendedHours: true,
};
const draft: OrderDraft = { environment: "demo", ticker: instrument.ticker, side: "buy", type: "market", quantity: 2, referencePrice: 100 };

describe("trade safety", () => {
  it("enforces cash and notional limits", () => {
    expect(() => validateOrderAgainstSnapshot(draft, instrument, undefined, { currency: "USD", cash: { availableToTrade: 150 } }, { maxOrderNotional: 500, maxOrderQuantity: 10 })).toThrow(/available cash/i);
    expect(() => validateOrderAgainstSnapshot(draft, instrument, undefined, { currency: "USD", cash: { availableToTrade: 1000 } }, { maxOrderNotional: 150, maxOrderQuantity: 10 })).toThrow(/MAX_ORDER_NOTIONAL/);
  });

  it("prevents selling more than the current tradable position", () => {
    expect(() => validateOrderAgainstSnapshot(
      { ...draft, side: "sell", quantity: 2 },
      instrument,
      { instrument, quantity: 2, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 },
      { currency: "USD" },
      { maxOrderNotional: 500, maxOrderQuantity: 10 },
    )).toThrow(/available quantity/i);
  });

  it("allows self-hosters to disable app-level caps with zero", () => {
    const result = validateOrderAgainstSnapshot(
      { environment: "demo", ticker: instrument.ticker, side: "buy", type: "market", quantity: 2 },
      { ...instrument, maxOpenQuantity: undefined },
      undefined,
      { currency: "EUR", cash: { availableToTrade: 1000 } },
      { maxOrderNotional: 0, maxOrderQuantity: 0 },
    );
    expect(result.estimatedNotional).toBeUndefined();
    expect(result.cashCheckApplied).toBe(false);
  });
});

function config(): RuntimeConfig {
  return {
    publicBaseUrl: "https://example.test",
    loginPassword: "0123456789abcdef",
    signingSecret: "0123456789abcdef0123456789abcdef",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    confirmationTtlSeconds: 90,
    maxOrderNotional: 5000,
    maxOrderQuantity: 100000,
    defaultTradingEnvironment: "demo",
    trading212: {
      demo: { baseUrl: "https://demo.test", apiKey: "key", apiSecret: "secret" },
      live: { baseUrl: "https://live.test", apiKey: "key", apiSecret: "secret" },
    },
  };
}

function fakeFetch(): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.endsWith("/equity/metadata/instruments")
      ? [instrument]
      : url.endsWith("/equity/positions")
        ? [{ instrument, quantity: 2, quantityAvailableForTrading: 1.6, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 }]
        : url.endsWith("/equity/account/summary")
          ? { currency: "EUR", cash: { availableToTrade: 1000 } }
          : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("flexible order intent", () => {
  it("resolves a company name and sells a percentage of the tradable position", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "Apple Inc.",
      side: "sell",
      type: "market",
      sizing: { mode: "position_percent", percent: 50 },
    });
    expect(resolved.draft.ticker).toBe("AAPL_US_EQ");
    expect(resolved.draft.quantity).toBe(0.8);
    expect(resolved.draft.referencePrice).toBe(100);
    expect(resolved.availableToSell).toBe(1.6);
  });

  it("converts a target amount to quantity using an explicit FX rate and reference price", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL",
      side: "buy",
      type: "market",
      sizing: { mode: "notional", amount: 100, currency: "EUR", fxRateToInstrumentCurrency: 1.1 },
      referencePrice: 220,
    });
    expect(resolved.draft.quantity).toBe(0.5);
    expect(resolved.requestedNotional).toBe(100);
    expect(resolved.requestedNotionalCurrency).toBe("EUR");
    expect(resolved.estimatedQuoteNotional).toBe(110);
  });

  it("sizes a buy from a percentage of available cash", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL",
      side: "buy",
      type: "market",
      sizing: { mode: "cash_percent", percent: 20, fxRateToInstrumentCurrency: 1.1 },
      referencePrice: 220,
    });
    expect(resolved.requestedNotional).toBe(200);
    expect(resolved.requestedNotionalCurrency).toBe("EUR");
    expect(resolved.draft.quantity).toBe(1);
  });

  it("supports selling all available shares", async () => {
    const service = new TradingService({ config: config(), store: new MemoryStateStore(), fetcher: fakeFetch() });
    const resolved = await service.resolveOrderIntent({
      environment: "demo",
      instrument: "AAPL_US_EQ",
      side: "sell",
      type: "market",
      sizing: { mode: "all_available" },
    });
    expect(resolved.draft.quantity).toBe(1.6);
  });
});
