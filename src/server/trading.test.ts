import {describe,expect,it,vi} from "vitest";
import type {BrokerReader} from "../infra/broker.js";
import {readConfiguration} from "../infra/config.js";
import {MemoryStore} from "../infra/state.js";
import type {BrokerTradePort} from "../infra/trade-gateway.js";
import {BrokerOperationUnknown} from "../infra/trade-gateway.js";
import type {TradeDraft} from "../domain/trading.js";
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
function fixture(opts:{unknown?:boolean;source?:PortfolioSnapshot}={}){
  const placeOrder=vi.fn(async(_draft:TradeDraft)=>{
    if(opts.unknown)throw new BrokerOperationUnknown("response lost");
    return {orderId:"11"};
  });
  const cancelOrder=vi.fn(async()=>({orderId:"11"}));
  const broker:BrokerTradePort={
    getInstruments:async()=>[{ticker:"AAPL_US_EQ",name:"Apple Inc.",shortName:"AAPL",currencyCode:"USD",extendedHours:true}],
    getPendingOrders:async()=>[],
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
