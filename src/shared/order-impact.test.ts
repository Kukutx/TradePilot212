import { describe, expect, it } from "vitest";
import type { Position } from "./contracts";
import { orderImpact } from "./order-impact";

const held: Position = {
  instrument: { ticker: "AAPL_US_EQ", name: "Apple", currencyCode: "USD" },
  quantity: 10, quantityAvailableForTrading: 10, averagePricePaid: 150, currentPrice: 200,
  walletImpact: { currentValue: 1800, totalCost: 1400, unrealizedProfitLoss: 400 },
};
const account = { currency: "EUR", totalValue: 10_000, cash: { availableToTrade: 2000 } };

describe("what an order would change", () => {
  it("adds a buy's value to the holding and takes it, with the conversion fee, from the cash", () => {
    const impact = orderImpact({ side: "buy", quantity: 5, position: held, account, instrumentCurrency: "USD", accountNotional: 900, fxFeeRate: 0.0015, ukTaxYear: true });
    expect(impact).toEqual({
      currency: "EUR", sharesBefore: 10, sharesAfter: 15, weightBefore: 0.18, weightAfter: 0.2700,
      cashBefore: 2000, cashAfter: 1098.65, fxFee: 1.35, fxFeeRate: 0.0015,
    });
    // A buy has no UK note: what it is matched with is a sale's business.
    expect(impact).not.toHaveProperty("ukRule");
  });

  it("counts a sell's gain against the average price, keeps the rest at its value, and notes the UK rule", () => {
    const gain = orderImpact({ side: "sell", quantity: 4, position: held, account, instrumentCurrency: "USD", accountNotional: 720, fxFeeRate: 0.0015, ukTaxYear: true });
    // 720 less 4/10 of the 1400 cost, less the fee of 1.08.
    expect(gain).toMatchObject({ sharesAfter: 6, weightBefore: 0.18, weightAfter: 0.108, cashAfter: 2718.92, realized: 158.92, ukRule: "sell" });
    const loss = orderImpact({ side: "sell", quantity: 10, position: held, account, instrumentCurrency: "USD", accountNotional: 1300, fxFeeRate: 0.0015, ukTaxYear: true });
    expect(loss).toMatchObject({ sharesAfter: 0, weightAfter: 0, ukRule: "sell_loss" });
    expect(loss!.realized).toBeLessThan(0);
    expect(orderImpact({ side: "sell", quantity: 4, position: held, account, instrumentCurrency: "USD", accountNotional: 720, fxFeeRate: 0.0015, ukTaxYear: false })).not.toHaveProperty("ukRule");
  });

  it("converts nothing in the account's own currency, pence included, and leaves out what it cannot know", () => {
    const pounds = orderImpact({ side: "buy", quantity: 2, account: { currency: "GBP", totalValue: 1000, cash: { availableToTrade: 500 } }, instrumentCurrency: "GBX", accountNotional: 100, fxFeeRate: 0.0015, ukTaxYear: false });
    expect(pounds).toEqual({ currency: "GBP", sharesBefore: 0, sharesAfter: 2, weightBefore: 0, weightAfter: 0.1, cashBefore: 500, cashAfter: 400 });
    // No value in the account currency: shares only.
    expect(orderImpact({ side: "buy", quantity: 1, position: held, account, instrumentCurrency: "USD", fxFeeRate: 0.0015, ukTaxYear: false }))
      .toEqual({ currency: "EUR", sharesBefore: 10, sharesAfter: 11, cashBefore: 2000 });
    expect(orderImpact({ side: "buy", quantity: 1, account: {}, instrumentCurrency: "USD", accountNotional: 1, fxFeeRate: 0, ukTaxYear: false })).toBeUndefined();
  });
});
