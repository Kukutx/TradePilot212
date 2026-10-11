import { describe, expect, it } from "vitest";
import { bookFromPayload, instrumentCurrency, instrumentLabel, symbolFromTicker } from "./instruments";

describe("instrument names", () => {
  it("strips the venue suffix from Trading 212 tickers", () => {
    expect(symbolFromTicker("AAPL_US_EQ")).toBe("AAPL");
    expect(symbolFromTicker("VUSAl_EQ")).toBe("VUSA");
    expect(symbolFromTicker("SAPd_EQ")).toBe("SAP");
  });

  it("learns names and currencies from the instruments an automation page sends", () => {
    const book = bookFromPayload({ kind: "automation", alerts: [{ ticker: "VUSAl_EQ", price: 8500 }], instruments: [{ ticker: "VUSAl_EQ", name: "Vanguard S&P 500 UCITS ETF (Dist)", shortName: "VUSA", currencyCode: "GBX" }] });
    expect(instrumentLabel("VUSAl_EQ", book)).toEqual({ name: "Vanguard S&P 500 UCITS ETF (Dist)", detail: "VUSA", ticker: "VUSAl_EQ" });
    expect(instrumentCurrency("VUSAl_EQ", book)).toBe("GBX");
    // Without anything learned, a London ticker has no known currency; a US one is in dollars.
    expect(instrumentCurrency("VUSAl_EQ", {})).toBeUndefined();
    expect(instrumentCurrency("AAPL_US_EQ", {})).toBe("USD");
  });
});
