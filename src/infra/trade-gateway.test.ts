import { describe,expect,it,vi } from "vitest";
import { readConfiguration } from "./config.js";
import { BrokerKnownRejection,BrokerOperationUnknown,Trading212TradeGateway } from "./trade-gateway.js";
import type { TradeDraft } from "../domain/trading.js";
import {MemoryStore} from "./state.js";
import {BrokerPacer} from "./broker-pacer.js";
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
  it("refuses unsafe int64 order IDs rather than rounding and targeting a different cancellation",async()=>{
    for(const invalid of [
      {id:Number.MAX_SAFE_INTEGER+10,ticker:"AAPL_US_EQ"},
      {id:"other",ticker:"AAPL_US_EQ"},{id:-2,ticker:"AAPL_US_EQ"},
    ]){
      const fetcher=vi.fn(async()=>new Response(JSON.stringify([invalid]),{status:200}));
      await expect(new Trading212TradeGateway(config,fetcher as typeof fetch)
        .getPendingOrders("demo")).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const preciseId="9223372036854775807";
    const safe=vi.fn(async()=>new Response(JSON.stringify([
      {id:preciseId,ticker:"AAPL_US_EQ",quantity:2},
    ]),{status:200}));
    const result=await new Trading212TradeGateway(config,safe as typeof fetch)
      .getPendingOrders("demo");
    expect(result[0]?.id).toBe(preciseId);
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
  it("paces independent personal broker writes before network transmission",async()=>{
    const store=new MemoryStore(),waits:number[]=[];
    const pacer=new BrokerPacer(store,()=>100_000,async ms=>{waits.push(ms)});
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:901}),{status:200}));
    const gateway=new Trading212TradeGateway(config,fetcher as typeof fetch,pacer);
    await gateway.placeOrder({...base,side:"buy"});
    await gateway.placeOrder({...base,side:"buy"});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1_500]);
  });
  it("rejects a saturated broker write quota before contacting Trading 212",async()=>{
    const store=new MemoryStore(),now=Date.now();
    // A longer external request backlog must not cause an unsafe outgoing write.
    for(let i=0;i<13;i++){
      const scheduled=await store.reserve("v3:broker-quota:demo:market-write",1500,now,30_000);
      expect(scheduled).not.toBeNull();
    }
    const fetcher=vi.fn();
    const pacer=new BrokerPacer(store,()=>now,async()=>{});
    const gateway=new Trading212TradeGateway(config,fetcher as typeof fetch,pacer);
    await expect(gateway.placeOrder({...base,side:"buy"})).rejects.toThrow(/quota is busy/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("treats an HTTP-success order without a safe acknowledgement ID as UNKNOWN, never as submitted",async()=>{
    for(const response of [
      null,{},{"status":"NEW"},{id:null},{id:"not-an-order"},
      {id:-1},{id:1.5},{id:Number.MAX_SAFE_INTEGER+1},
    ]){
      const fake=vi.fn(async()=>response===null
        ? new Response(null,{status:204})
        : new Response(JSON.stringify(response),{status:200}));
      const gateway=new Trading212TradeGateway(config,fake as typeof fetch);
      await expect(gateway.placeOrder({...base,side:"buy"}))
        .rejects.toBeInstanceOf(BrokerOperationUnknown);
      expect(fake).toHaveBeenCalledTimes(1);
    }
    const zero=vi.fn(async()=>new Response(JSON.stringify({id:0}),{status:200}));
    expect((await new Trading212TradeGateway(config,zero as typeof fetch)
      .placeOrder({...base,side:"buy"})).orderId).toBe("0");
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
