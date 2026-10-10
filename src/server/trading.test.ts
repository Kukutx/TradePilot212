import {describe,expect,it,vi} from "vitest";
import type {BrokerReader} from "../infra/broker.js";
import {readConfiguration} from "../infra/config.js";
import {MemoryStore} from "../infra/state.js";
import type {BrokerTradePort} from "../infra/trade-gateway.js";
import {BrokerOperationUnknown} from "../infra/trade-gateway.js";
import type {PendingOrder,TradeDraft} from "../domain/trading.js";
import {personalApprovalProof} from "../domain/approval-proof.js";
import type {PortfolioSnapshot} from "../domain/types.js";
import {PersonalTradingService} from "./trading.js";
const secret="separate-personal-approval-secret-xxxxxxxxxxx";
const config=readConfiguration({
  OWNER_PASSWORD:"owner-password-length-at-least-24",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
  DATA_SOURCE:"trading212",T212_DEMO_KEY:"k",T212_DEMO_SECRET:"s",
  T212_LIVE_KEY:"livek",T212_LIVE_SECRET:"lives",
  PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:secret,
});
const snapshot:PortfolioSnapshot={
  kind:"portfolio",environment:"demo",source:"trading212",asOf:new Date().toISOString(),
  account:{currency:"USD",availableCash:1000,totalValue:1500,investmentValue:500,unrealizedProfitLoss:10},
  holdings:[{ticker:"AAPL_US_EQ",name:"Apple",currency:"USD",quantity:5,tradableQuantity:4,price:100,valueInAccountCurrency:500,valueProvenance:"same_currency_quote"}],
  notes:[],
};
function fixture(opts:{unknown?:boolean;source?:PortfolioSnapshot;pending?:PendingOrder[];pauseOrder?:Promise<void>;onWriteEntered?:()=>void}={}){
  const placeOrder=vi.fn(async(_draft:TradeDraft)=>{
    opts.onWriteEntered?.();
    if(opts.pauseOrder)await opts.pauseOrder;
    if(opts.unknown)throw new BrokerOperationUnknown("response lost");
    return {orderId:"11"};
  });
  const cancelOrder=vi.fn(async()=>({orderId:"11"}));
  const broker:BrokerTradePort={
    getInstruments:async()=>[{ticker:"AAPL_US_EQ",name:"Apple Inc.",shortName:"AAPL",currencyCode:"USD",extendedHours:true}],
    getPendingOrders:async()=>opts.pending??[],
    getOrder:async()=>({id:"11",ticker:"AAPL_US_EQ",quantity:1}),
    placeOrder,cancelOrder,
  };
  const reader:BrokerReader={
    getPortfolio:async(env)=>({...opts.source||snapshot,environment:env}),
    getRecentOrders:async()=>({items:[],nextCursor:null}),
  };
  return {svc:new PersonalTradingService(config,new MemoryStore(),reader,broker),placeOrder,cancelOrder};
}
describe("personal trading workflow",()=>{
  it("never executes without independent approval proof and token",async()=>{
    const {svc,placeOrder}=fixture();
    const draft:TradeDraft={environment:"demo",ticker:"AAPL_US_EQ",side:"buy",type:"limit",quantity:1,limitPrice:99};
    const preview=await svc.prepareOrder(draft);
    await expect(svc.executeOrder(preview.token,"invalid","demo")).rejects.toThrow();
    expect(placeOrder).not.toHaveBeenCalled();
    const proof=await personalApprovalProof(secret,"order",preview.token);
    const done=await svc.executeOrder(preview.token,proof,"demo");
    expect(done.status).toBe("submitted");
    expect(placeOrder).toHaveBeenCalledTimes(1);
    await expect(svc.executeOrder(preview.token,proof,"demo")).rejects.toThrow(/expired/);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
  it("keeps UNKNOWN results and never reissues",async()=>{
    const {svc,placeOrder}=fixture({unknown:true});
    const preview=await svc.prepareOrder({environment:"demo",ticker:"AAPL_US_EQ",side:"sell",type:"market",quantity:1,referencePrice:100});
    const proof=await personalApprovalProof(secret,"order",preview.token);
    const result=await svc.executeOrder(preview.token,proof,"demo");
    expect(result.status).toBe("unknown");
    expect(result.verificationId).toBeTruthy();
    await svc.verifyOutcome(result.verificationId!,"demo");
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
  it("does not confuse an old or opposite-side pending order with the uncertain write",async()=>{
    const newOrder:TradeDraft={environment:"demo",ticker:"AAPL_US_EQ",side:"buy",type:"market",quantity:1,referencePrice:100};
    for(const prior of [
      {id:"41",ticker:"AAPL_US_EQ",quantity:1,side:"SELL",type:"MARKET",createdAt:new Date().toISOString()},
      {id:"42",ticker:"AAPL_US_EQ",quantity:1,side:"BUY",type:"MARKET",createdAt:new Date(Date.now()-3_600_000).toISOString()},
      {id:"43",ticker:"AAPL_US_EQ",quantity:1,side:"BUY",type:"MARKET"},
    ]){
      const {svc,placeOrder}=fixture({unknown:true,pending:[prior]});
      const preview=await svc.prepareOrder(newOrder);
      const proof=await personalApprovalProof(secret,"order",preview.token);
      const execution=await svc.executeOrder(preview.token,proof,"demo");
      expect(execution.status).toBe("unknown");
      const result=await svc.verifyOutcome(execution.verificationId!,"demo");
      expect(result.status).toBe("inconclusive");
      expect(placeOrder).toHaveBeenCalledTimes(1);
    }
  });
  it("recognizes recent exact-side pending orders as potential matches only",async()=>{
    const {svc,placeOrder}=fixture({unknown:true,pending:[{
      id:"44",ticker:"AAPL_US_EQ",quantity:1,side:"BUY",type:"MARKET",
      createdAt:new Date().toISOString(),
    }]});
    const preview=await svc.prepareOrder({environment:"demo",ticker:"AAPL_US_EQ",
      side:"buy",type:"market",quantity:1,referencePrice:100});
    const proof=await personalApprovalProof(secret,"order",preview.token);
    const submission=await svc.executeOrder(preview.token,proof,"demo");
    const verified=await svc.verifyOutcome(submission.verificationId!,"demo");
    expect(verified.status).toBe("matching_pending");
    expect(verified.message).toMatch(/not definitive proof/);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
  it("does not allow concurrent reviewed orders to spend the same account balance",async()=>{
    let releaseBroker!:()=>void;
    let observedEntry!:()=>void;
    const blocked=new Promise<void>(resolve=>{releaseBroker=resolve;});
    const reachedBroker=new Promise<void>(resolve=>{observedEntry=resolve;});
    const {svc,placeOrder}=fixture({pauseOrder:blocked,onWriteEntered:observedEntry});
    const draft:TradeDraft={environment:"demo",ticker:"AAPL_US_EQ",side:"buy",
      type:"limit",quantity:2,limitPrice:100};
    const p1=await svc.prepareOrder(draft),p2=await svc.prepareOrder({...draft,quantity:1});
    const proof1=await personalApprovalProof(secret,"order",p1.token);
    const proof2=await personalApprovalProof(secret,"order",p2.token);
    const first=svc.executeOrder(p1.token,proof1,"demo");
    await reachedBroker;
    await expect(svc.executeOrder(p2.token,proof2,"demo"))
      .rejects.toThrow(/Another broker operation/);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    releaseBroker();
    expect((await first).status).toBe("submitted");
    // The lock is released after a known broker acknowledgement.
    expect((await svc.executeOrder(p2.token,proof2,"demo")).status).toBe("submitted");
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });
  it("keeps a safety cooldown after an uncertain broker write",async()=>{
    const {svc,placeOrder}=fixture({unknown:true});
    const draft:TradeDraft={environment:"demo",ticker:"AAPL_US_EQ",side:"buy",
      type:"limit",quantity:1,limitPrice:100};
    const p1=await svc.prepareOrder(draft),p2=await svc.prepareOrder(draft);
    const proof1=await personalApprovalProof(secret,"order",p1.token);
    const proof2=await personalApprovalProof(secret,"order",p2.token);
    expect((await svc.executeOrder(p1.token,proof1,"demo")).status).toBe("unknown");
    await expect(svc.executeOrder(p2.token,proof2,"demo"))
      .rejects.toThrow(/Another broker operation/);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });
  it("does not silently enable Live trading",async()=>{
    const {svc,placeOrder}=fixture();
    const draft:TradeDraft={environment:"live",ticker:"AAPL_US_EQ",side:"buy",type:"limit",quantity:1,limitPrice:99};
    const preview=await svc.prepareOrder(draft);
    expect(preview.personalExecutionEnabled).toBe(false);
    const proof=await personalApprovalProof(secret,"order",preview.token);
    await expect(svc.executeOrder(preview.token,proof,"live")).rejects.toThrow(/disabled/);
    expect(placeOrder).not.toHaveBeenCalled();
  });
  it("protects cancellation with separate action-bound proof",async()=>{
    const {svc,cancelOrder}=fixture();
    const p=await svc.prepareCancel("demo","11");
    const incorrect=await personalApprovalProof(secret,"order",p.token);
    await expect(svc.executeCancel(p.token,incorrect,"demo")).rejects.toThrow(/incorrect/);
    expect(cancelOrder).not.toHaveBeenCalled();
    const proof=await personalApprovalProof(secret,"cancel",p.token);
    const response=await svc.executeCancel(p.token,proof,"demo");
    expect(response.status).toBe("submitted");
    expect(cancelOrder).toHaveBeenCalledTimes(1);
  });
});
