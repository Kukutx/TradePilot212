import { describe, expect, it } from "vitest";
import { validateOrderAgainstSnapshot } from "./trading-service.js";
import type { Instrument, OrderDraft } from "../shared/contracts.js";

const instrument: Instrument = { ticker:"AAPL_US_EQ",name:"Apple",shortName:"AAPL",currencyCode:"USD",maxOpenQuantity:10 };
const draft: OrderDraft = { environment:"demo",ticker:instrument.ticker,side:"buy",type:"market",quantity:2,referencePrice:100 };
describe("trade safety", () => {
  it("enforces cash and notional limits", () => {
    expect(() => validateOrderAgainstSnapshot(draft,instrument,undefined,{currency:"USD",cash:{availableToTrade:150}},{maxOrderNotional:500,maxOrderQuantity:10})).toThrow(/available cash/i);
    expect(() => validateOrderAgainstSnapshot(draft,instrument,undefined,{currency:"USD",cash:{availableToTrade:1000}},{maxOrderNotional:150,maxOrderQuantity:10})).toThrow(/MAX_ORDER_NOTIONAL/);
  });
  it("prevents selling more than the current tradable position", () => {
    expect(() => validateOrderAgainstSnapshot({...draft,side:"sell",quantity:2},instrument,{instrument,quantity:2,quantityAvailableForTrading:1,quantityInPies:0,averagePricePaid:90,currentPrice:100},{currency:"USD"},{maxOrderNotional:500,maxOrderQuantity:10})).toThrow(/available quantity/i);
  });
});
