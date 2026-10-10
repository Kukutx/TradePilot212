import type { Environment, PortfolioSnapshot } from "./types.js";

/** Clearly synthetic fixtures for local testing and independent app review. */
export function samplePortfolio(environment: Environment, now = new Date()): PortfolioSnapshot {
  return {
    kind: "portfolio", source: "sample", environment, asOf: now.toISOString(),
    account: { currency: "USD", totalValue: 2800, availableCash: 500, investmentValue: 2300, unrealizedProfitLoss: 180 },
    holdings: [
      { ticker: "NVDA_US_EQ", name: "Example Semiconductor", currency: "USD", quantity: 5, tradableQuantity: 5, price: 120, averagePricePaid: 100, unrealizedProfitLossInAccountCurrency: 100, valueInAccountCurrency: 600, valueProvenance: "same_currency_quote" },
      { ticker: "MSFT_US_EQ", name: "Example Software", currency: "USD", quantity: 3, tradableQuantity: 3, price: 300, averagePricePaid: 285, unrealizedProfitLossInAccountCurrency: 45, valueInAccountCurrency: 900, valueProvenance: "same_currency_quote" },
      { ticker: "AAPL_US_EQ", name: "Example Consumer Tech", currency: "USD", quantity: 4, tradableQuantity: 4, price: 200, averagePricePaid: 191.25, unrealizedProfitLossInAccountCurrency: 35, valueInAccountCurrency: 800, valueProvenance: "same_currency_quote" },
    ],
    notes: ["SYNTHETIC DEMONSTRATION — tickers and prices are not real quotes."],
  };
}
