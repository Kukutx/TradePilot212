import { describe,expect,it,vi } from "vitest";
import { readConfiguration } from "./config.js";
import { BrokerKnownRejection,BrokerOperationUnknown,Trading212TradeGateway } from "./trade-gateway.js";
import type { TradeDraft } from "../domain/trading.js";
const config=readConfiguration({
  DATA_SOURCE:"trading212",
  OWNER_PASSWORD:"owner-password-at-least-24-characters",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
  T212_DEMO_KEY:"k",T212_DEMO_SECRET:"s",
  PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:"a".repeat(48),
});
const base:TradeDraft={environment:"demo",ticker:"AAPL_US_EQ",side:"sell",type:"market",quantity:0.5};
describe("Trading 212 personal command gateway",()=>{
  it("implements all 4 order types with negative sell quantity and never retries",async()=>{
    for(const type of ["market","limit","stop","stop_limit"] as const){
      const fetcher=vi.fn(async(_url:unknown,init:RequestInit)=>{
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string).quantity).toBe(-0.5);
        return new Response(JSON.stringify({id:42}),{status:200});
      });
      const result=await new Trading212TradeGateway(config,fetcher as typeof fetch)
        .placeOrder({...base,type,limitPrice:100,stopPrice:90,timeValidity:"DAY"});
      expect(result.orderId).toBe("42");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("preserves actual broker partial fills and pending status without pretending quantity is remaining",async()=>{
    const response={
      id:901,ticker:"AAPL_US_EQ",quantity:3,filledQuantity:1.25,filledValue:125,
      currency:"USD",side:"BUY",type:"LIMIT",status:"PARTIALLY_FILLED",
      createdAt:"2026-10-10T12:00:00Z",timeInForce:"GOOD_TILL_CANCEL",
    };
    const broker=new Trading212TradeGateway(config,
      vi.fn(async()=>new Response(JSON.stringify([response])) ) as typeof fetch);
    const orders=await broker.getPendingOrders("demo");
    expect(orders).toEqual([{
      id:"901",ticker:"AAPL_US_EQ",quantity:3,filledQuantity:1.25,filledValue:125,
      currency:"USD",side:"BUY",type:"LIMIT",status:"PARTIALLY_FILLED",
      createdAt:"2026-10-10T12:00:00Z",timeInForce:"GOOD_TILL_CANCEL",
    }]);
    expect(Math.abs(orders[0]!.quantity)-orders[0]!.filledQuantity!).toBe(1.75);
  });
  it("never retries an ambiguous server response or unreadable body",async()=>{
    const refused=vi.fn(async()=>new Response("failure",{status:503}));
    await expect(new Trading212TradeGateway(config,refused as typeof fetch).placeOrder(base))
      .rejects.toBeInstanceOf(BrokerOperationUnknown);
    expect(refused).toHaveBeenCalledTimes(1);
    const disconnected=vi.fn(async()=>{throw new Error("reset");});
    await expect(new Trading212TradeGateway(config,disconnected as typeof fetch).placeOrder(base))
      .rejects.toBeInstanceOf(BrokerOperationUnknown);
    expect(disconnected).toHaveBeenCalledTimes(1);
    const unreadable=vi.fn(async()=>new Response(new ReadableStream({
      start(controller){controller.error(new Error("stream reset"));}
    }),{status:200}));
    await expect(new Trading212TradeGateway(config,unreadable as typeof fetch).placeOrder(base))
      .rejects.toBeInstanceOf(BrokerOperationUnknown);
    expect(unreadable).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid cancellation ID before network access",async()=>{
    const fetcher=vi.fn();
    await expect(new Trading212TradeGateway(config,fetcher as typeof fetch).cancelOrder("demo","../bad"))
      .rejects.toThrow(/ID/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("classifies GET order 404 as a known missing pending order even with plain-text body", async()=>{
    const fetcher=vi.fn(async()=>new Response("Not Found",{status:404}));
    await expect(new Trading212TradeGateway(config,fetcher as typeof fetch).getOrder("demo","11"))
      .rejects.toMatchObject({name:"BrokerKnownRejection",status:404});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("treats explicit broker 400 as a known rejection",async()=>{
    const fetcher=vi.fn(async()=>new Response("bad",{status:400}));
    await expect(new Trading212TradeGateway(config,fetcher as typeof fetch).placeOrder(base))
      .rejects.toBeInstanceOf(BrokerKnownRejection);
  });
});
