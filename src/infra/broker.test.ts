import { describe, expect, it, vi } from "vitest";
import { readConfiguration } from "./config.js";
import { Trading212Reader } from "./broker.js";
const config = readConfiguration({
  OWNER_PASSWORD: "owner-password-length-at-least-24",
  JWT_SIGNING_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
  DATA_SOURCE: "trading212", T212_DEMO_KEY: "key", T212_DEMO_SECRET: "secret",
});
describe("read-only official broker adapter", () => {
  it("only sends GET, validates portfolio, and never guesses FX", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(String(input)).toContain("https://demo.trading212.com/api/v0/equity/");
      const isAccount = String(input).endsWith("/account/summary");
      return new Response(JSON.stringify(isAccount
        ? { currency: "EUR", totalValue: 1000, cash: { availableToTrade: 300 }, investments: { currentValue: 700 } }
        : [{ instrument: { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD" },
          quantity: 2, quantityAvailableForTrading: 2, currentPrice: 100 }]), { status: 200 });
    });
    const p = await new Trading212Reader(config, fetcher as typeof fetch).getPortfolio("demo");
    expect(p.holdings[0]?.valueInAccountCurrency).toBeNull();
    expect(p.notes).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses walletImpact.currentValue only with matching account currency", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/account/summary")
        ? { currency: "EUR", totalValue: 1000, cash: { availableToTrade: 300 }, investments: { currentValue: 700 } }
        : [{ instrument: { ticker: "TEST_US_EQ", currencyCode: "USD" },
          quantity: 2, quantityAvailableForTrading: 2, currentPrice: 100,
          walletImpact: { currency: "USD", currentValue: 700 } }]
    )));
    const rejected = await new Trading212Reader(config, fetcher as typeof fetch).getPortfolio("demo");
    expect(rejected.holdings[0]?.valueInAccountCurrency).toBeNull();
    fetcher.mockImplementation(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/account/summary")
        ? { currency: "EUR", totalValue: 1000, cash: { availableToTrade: 300 }, investments: { currentValue: 700 } }
        : [{ instrument: { ticker: "TEST_US_EQ", currencyCode: "USD" },
          quantity: 2, quantityAvailableForTrading: 2, currentPrice: 100,
          walletImpact: { currency: "EUR", currentValue: 700 } }]
    )));
    const accepted = await new Trading212Reader(config, fetcher as typeof fetch).getPortfolio("demo");
    expect(accepted.holdings[0]?.valueInAccountCurrency).toBe(700);
    expect(accepted.holdings[0]?.valueProvenance).toBe("broker_account_value");
  });
  it("displays actual average cost and account-currency P/L only with broker evidence", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes("/account/summary")
        ? { currency: "EUR", totalValue: 1000, cash: { availableToTrade: 300 },
            investments: { currentValue: 700, realizedProfitLoss: 12, totalCost: 650 } }
        : [{ instrument: { ticker: "TEST_US_EQ", currencyCode: "USD" },
          quantity: 2, quantityAvailableForTrading: 2, currentPrice: 100, averagePricePaid: 88,
          walletImpact: { currency: "USD", unrealizedProfitLoss: 25 } }]
    )));
    const result = await new Trading212Reader(config, fetcher as typeof fetch).getPortfolio("demo");
    expect(result.holdings[0]?.averagePricePaid).toBe(88);
    expect(result.holdings[0]?.unrealizedProfitLossInAccountCurrency).toBeNull();
    expect(result.account.realizedProfitLoss).toBe(12);
    expect(result.account.totalCost).toBe(650);
  });

  it("parses the official compact position instrument currency field", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes("/account/summary")
        ? { currency: "EUR", totalValue: 140, cash: { availableToTrade: 40 },
            investments: { currentValue: 100 } }
        : [{ instrument: { ticker: "ASML_NL_EQ", name: "ASML", currency: "EUR" },
             quantity: 2, quantityAvailableForTrading: 2, averagePricePaid: 42, currentPrice: 50,
             walletImpact: { currency: "EUR", currentValue: 100, unrealizedProfitLoss: 16 } }])));
    const result = await new Trading212Reader(config, fetcher as typeof fetch).getPortfolio("demo");
    expect(result.holdings[0]).toMatchObject({
      currency: "EUR", valueInAccountCurrency: 100,
      valueProvenance: "broker_account_value", averagePricePaid: 42,
      unrealizedProfitLossInAccountCurrency: 16,
    });
  });
  it("fails closed for missing or conflicting currency instead of inventing FX", async () => {
    for (const instrument of [
      { ticker: "TEST_US_EQ" },
      { ticker: "TEST_US_EQ", currency: "EUR", currencyCode: "USD" },
    ]) {
      const fetcher = vi.fn(async (input: RequestInfo | URL) =>
        new Response(JSON.stringify(String(input).includes("/account/summary")
          ? { currency: "EUR", totalValue: 100, cash: { availableToTrade: 0 },
              investments: { currentValue: 100 } }
          : [{ instrument, quantity: 1, quantityAvailableForTrading: 1, currentPrice: 100 }])));
      await expect(new Trading212Reader(config, fetcher as typeof fetch).getPortfolio("demo"))
        .rejects.toThrow(/currency|currencies/);
    }
  });
  it("rejects financial notional overflow rather than publishing Infinity as a portfolio valuation",async()=>{
    const fetcher=vi.fn(async (input:RequestInfo|URL)=>new Response(JSON.stringify(
      String(input).includes("/account/summary")
        ? { currency:"USD",totalValue:1000,cash:{availableToTrade:0},
            investments:{currentValue:1000} }
        : [{instrument:{ticker:"TEST_US_EQ",currency:"USD"},quantity:1e305,
            quantityAvailableForTrading:1e305,currentPrice:1e30}]
    )));
    await expect(new Trading212Reader(config,fetcher as typeof fetch).getPortfolio("demo"))
      .rejects.toThrow(/non-finite/);
  });
  it("fails closed for invalid broker payload, with no sample fallback", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ result: "unexpected" }), { status: 200 }));
    await expect(new Trading212Reader(config, fake as typeof fetch).getPortfolio("demo")).rejects.toThrow();
  });
  it("rejects forged pagination cursor", async () => {
    const fake = vi.fn();
    await expect(new Trading212Reader(config, fake as typeof fetch).getRecentOrders("demo", "../orders")).rejects.toThrow(/cursor/);
    expect(fake).not.toHaveBeenCalled();
  });
});
