import { describe,expect,it } from "vitest";
import { resolveInstrument,resolveTradeIntent,checkDraft,type Instrument,type TradeIntent } from "./trading.js";
import type { PortfolioSnapshot } from "./types.js";
import { personalApprovalProof } from "./approval-proof.js";
const instruments:Instrument[]=[{ticker:"AAPL_US_EQ",name:"Apple Inc.",shortName:"AAPL",currencyCode:"USD",type:"STOCK",extendedHours:true,maxOpenQuantity:100}];
const snapshot:PortfolioSnapshot={
  kind:"portfolio",environment:"demo",source:"trading212",asOf:new Date().toISOString(),
  account:{currency:"USD",availableCash:1000,totalValue:1500,investmentValue:500,unrealizedProfitLoss:10},
  holdings:[{ticker:"AAPL_US_EQ",name:"Apple",currency:"USD",quantity:5,tradableQuantity:4,price:100,valueInAccountCurrency:500,valueProvenance:"same_currency_quote"}],
  notes:[],
};
const limits={maxNotional:2000,maxQuantity:100};
const intent=(sizing:TradeIntent["sizing"],side:TradeIntent["side"]="buy"):TradeIntent=>
  ({environment:"demo",instrument:"Apple",side,type:"market",sizing,referencePrice:100});
describe("personal trade intent and risk policy",()=>{
  it("finds company names without confusing derivatives",()=>{
    expect(resolveInstrument([...instruments,{ticker:"AAPY_EQ",name:"Option Income Apple",shortName:"AAPY",currencyCode:"EUR",type:"ETF"}],"Apple Inc.").ticker).toBe("AAPL_US_EQ");
  });
  it("resolves precise shares, target money, percentages, and all tradable",()=>{
    expect(resolveTradeIntent(intent({mode:"quantity",quantity:0.5}),instruments,snapshot,limits).draft.quantity).toBe(0.5);
    expect(resolveTradeIntent(intent({mode:"notional",amount:200,currency:"USD"}),instruments,snapshot,limits).draft.quantity).toBe(2);
    expect(resolveTradeIntent(intent({mode:"cash_percent",percent:20}),instruments,snapshot,limits).draft.quantity).toBe(2);
    expect(resolveTradeIntent(intent({mode:"position_percent",percent:50},"sell"),instruments,snapshot,limits).draft.quantity).toBe(2.5);
    expect(resolveTradeIntent(intent({mode:"all_available"},"sell"),instruments,snapshot,limits).draft.quantity).toBe(4);
  });
  it("rejects held percent exceeding tradable rather than silently resizing",()=>{
    expect(()=>resolveTradeIntent(intent({mode:"position_percent",percent:90},"sell"),instruments,snapshot,limits)).toThrow(/Insufficient tradable/);
  });
  it("enforces FX input, order quantity limits, reference prices, and market slippage notice",()=>{
    expect(()=>resolveTradeIntent(intent({mode:"notional",amount:100,currency:"EUR"}),instruments,snapshot,limits)).toThrow(/fxToQuote/);
    expect(()=>resolveTradeIntent(intent({mode:"quantity",quantity:101}),instruments,snapshot,limits)).toThrow(/MAX_ORDER_QUANTITY/);
    expect(resolveTradeIntent(intent({mode:"quantity",quantity:1}),instruments,snapshot,limits).warnings.join(" ")).toMatch(/slippage|different price/);
  });
  it("distinguishes action and token for HMAC proof",async()=>{
    const order=await personalApprovalProof("private-secret","order","token-a");
    expect(order).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await personalApprovalProof("private-secret","cancel","token-a")).not.toBe(order);
    expect(await personalApprovalProof("private-secret","order","token-b")).not.toBe(order);
  });
});
