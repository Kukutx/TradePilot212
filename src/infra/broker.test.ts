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
