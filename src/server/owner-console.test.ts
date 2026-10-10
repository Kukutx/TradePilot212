import {describe,expect,it,vi} from "vitest";
import { createHttpApp } from "./http.js";
import { readConfiguration } from "../infra/config.js";
import { MemoryStore } from "../infra/state.js";
import { personalApprovalProof } from "../domain/approval-proof.js";
import type { BrokerReader } from "../infra/broker.js";
import type { BrokerTradePort } from "../infra/trade-gateway.js";

const origin="https://owner.tradepilot.example.test";
const password="private-human-password-0123456789";
const approvalSecret="independent-trade-signature-key-0123456789";
const config=readConfiguration({
  PUBLIC_ORIGIN:origin,DATA_SOURCE:"trading212",OWNER_PASSWORD:password,
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
  T212_DEMO_KEY:"mock-only",T212_DEMO_SECRET:"mock-secret",
  PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:approvalSecret,
  PERSONAL_LIVE_TRADING_ENABLED:"false",
});
function setup(){
  const store=new MemoryStore();
  const written=vi.fn(async()=>({orderId:"1234"}));
  const cancelled=vi.fn(async()=>({orderId:"1234"}));
  const broker:BrokerReader={
    async getPortfolio(environment){return {
      kind:"portfolio",source:"trading212",environment,asOf:new Date().toISOString(),
      account:{currency:"USD",totalValue:1500,availableCash:1000,
        investmentValue:500,unrealizedProfitLoss:30},
      holdings:[{ticker:"AAPL_US_EQ",name:"Apple",currency:"USD",
        quantity:5,tradableQuantity:4,price:100,valueInAccountCurrency:500,
        valueProvenance:"same_currency_quote"}],
      notes:[],
    };},
    async getRecentOrders(){return {items:[],nextCursor:null};},
  };
  const command:BrokerTradePort={
    async getInstruments(){return [{
      ticker:"AAPL_US_EQ",name:"Apple",shortName:"AAPL",
      currencyCode:"USD",extendedHours:true,
    }];},
    async getOrder(_environment,id){return {id,ticker:"AAPL_US_EQ",quantity:1};},
    async getPendingOrders(){return [{id:"1234",ticker:"AAPL_US_EQ",quantity:1}];},
    placeOrder:written,cancelOrder:cancelled,
  };
  const app=createHttpApp({config,state:store,broker,tradeGateway:command,
    widgetHtml:async()=>"<html>Mock only</html>"});
  return {app,written,cancelled};
}
type ApiApp=ReturnType<typeof createHttpApp>;
async function signIn(app:ApiApp){
  const response=await app.request("/owner/api/login",{
    method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
    body:JSON.stringify({password}),
  });
  expect(response.status).toBe(200);
  const cookie=response.headers.get("set-cookie")?.split(";")[0];
  const data=await response.json() as {csrf:string};
  expect(cookie).toMatch(/^__Host-tp212owner=[0-9a-f]{64}$/);
  return {cookie:cookie!,csrf:data.csrf};
}
function ownerPost(app:ApiApp,path:string,credentials:{cookie:string;csrf:string},body:unknown,
  changes:Record<string,string>={}){
  return app.request(path,{method:"POST",headers:{
    Origin:origin,"Content-Type":"application/json",Cookie:credentials.cookie,
    "X-Owner-CSRF":credentials.csrf,...changes,
  },body:JSON.stringify(body)});
}
describe("separate authenticated Owner Console",()=>{
  it("refuses anonymous account access and prevents cross-origin login",async()=>{
    const {app}=setup();
    expect((await app.request("/owner/api/me")).status).toBe(401);
    expect((await app.request("/owner/api/overview?environment=demo")).status).toBe(401);
    expect((await app.request("/owner/api/login",{
      method:"POST",headers:{Origin:"https://hostile.example","Content-Type":"application/json"},
      body:JSON.stringify({password}),
    })).status).toBe(403);
    const page=await app.request("/owner");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    const html=await page.text();
    expect(html).toContain("Personal Owner Console");
    expect(html).not.toContain(approvalSecret);
  });
  it("rejects oversized chunked login data before JSON buffering",async()=>{
    const {app}=setup();
    const stream=new ReadableStream<Uint8Array>({
      start(controller){
        controller.enqueue(new Uint8Array(34_000));
        controller.close();
      },
    });
    const request=new Request(origin+"/owner/api/login",{
      method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
      body:stream,duplex:"half",
    } as RequestInit);
    const response=await app.fetch(request);
    expect(response.status).toBe(400);
    expect((await response.json() as {error:string}).error).toBe("Body too large");
  });
  it("sets secure, strict cookie and requires matching CSRF for all owner actions",async()=>{
    const {app}=setup();
    const credentials=await signIn(app);
    const session=await app.request("/owner/api/me",{headers:{Cookie:credentials.cookie}});
    expect(session.status).toBe(200);
    expect((await session.json() as {csrf:string}).csrf).toBe(credentials.csrf);
    const noCsrf=await app.request("/owner/api/prepare",{
      method:"POST",headers:{Origin:origin,Cookie:credentials.cookie,"Content-Type":"application/json"},
      body:JSON.stringify({environment:"demo",ticker:"AAPL_US_EQ",side:"buy",
        type:"limit",quantity:1,limitPrice:100}),
    });
    expect(noCsrf.status).toBe(403);
    const wrongOrigin=await ownerPost(app,"/owner/api/prepare",credentials,{}, {Origin:"https://evil.test"});
    expect(wrongOrigin.status).toBe(403);
    const logout=await ownerPost(app,"/owner/api/logout",credentials,{});
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.request("/owner/api/me",{headers:{Cookie:credentials.cookie}})).status).toBe(401);
  });
  it("reviews, prepares, and executes precisely once with independent human proof",async()=>{
    const {app,written,cancelled}=setup();
    const credentials=await signIn(app);
    const overview=await app.request("/owner/api/overview?environment=demo",
      {headers:{Cookie:credentials.cookie}});
    expect(overview.status).toBe(200);
    expect((await overview.json() as {center:{kind:string}}).center.kind).toBe("attention_center");
    const reviewed=await ownerPost(app,"/owner/api/review",credentials,{
      environment:"demo",instrument:"Apple",side:"buy",type:"limit",
      sizing:{mode:"notional",amount:200,currency:"USD"},limitPrice:100,
    });
    expect(reviewed.status).toBe(200);
    const draft=(await reviewed.json() as {draft:Record<string,unknown>}).draft;
    expect(draft.quantity).toBe(2);
    const prepared=await ownerPost(app,"/owner/api/prepare",credentials,draft);
    expect(prepared.status).toBe(200);
    const token=(await prepared.json() as {token:string}).token;
    const proof=await personalApprovalProof(approvalSecret,"order",token);
    const executed=await ownerPost(app,"/owner/api/execute",credentials,{
      environment:"demo",token,proof,
    });
    expect(executed.status).toBe(200);
    expect((await executed.json() as {status:string}).status).toBe("submitted");
    expect(written).toHaveBeenCalledTimes(1);
    const replay=await ownerPost(app,"/owner/api/execute",credentials,{
      environment:"demo",token,proof,
    });
    expect(replay.status).toBe(400);
    expect(written).toHaveBeenCalledTimes(1);
    const cancellation=await ownerPost(app,"/owner/api/cancel/prepare",credentials,{
      environment:"demo",orderId:"1234",
    });
    expect(cancellation.status).toBe(200);
    const cancelToken=(await cancellation.json() as {token:string}).token;
    const cancelProof=await personalApprovalProof(approvalSecret,"cancel",cancelToken);
    const cancel=await ownerPost(app,"/owner/api/cancel/execute",credentials,{
      environment:"demo",token:cancelToken,proof:cancelProof,
    });
    expect(cancel.status).toBe(200);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("protects personal preferences and read-only monitor setup behind cookie and CSRF",async()=>{
    const {app,written,cancelled}=setup();
    const credentials=await signIn(app);
    expect((await app.request("/owner/api/preferences")).status).toBe(401);
    const current=await app.request("/owner/api/preferences",{headers:{Cookie:credentials.cookie}});
    expect(current.status).toBe(200);
    const state=await current.json() as {preferences:{dailyBrief:{enabled:boolean}}};
    expect(state.preferences.dailyBrief.enabled).toBe(false);
    const changes={
      locale:"zh",defaultEnvironment:"demo",timezone:"Europe/Rome",
      dailyBrief:{enabled:true,hour:8,onlyOnChange:true,includeLive:false,email:false},
    };
    const saved=await ownerPost(app,"/owner/api/preferences",credentials,changes);
    expect(saved.status).toBe(200);
    const returned=await saved.json() as {preferences:typeof changes};
    expect(returned.preferences).toEqual(changes);
    const invalid=await ownerPost(app,"/owner/api/preferences",credentials,
      {...changes,approvalSecret:"should not be in preferences"});
    expect(invalid.status).toBe(400);
    const noCsrf=await app.request("/owner/api/monitoring/setup",{
      method:"POST",headers:{"Content-Type":"application/json",Origin:origin,Cookie:credentials.cookie},
      body:JSON.stringify({environment:"demo"}),
    });
    expect(noCsrf.status).toBe(403);
    const setupRules=await ownerPost(app,"/owner/api/monitoring/setup",credentials,{environment:"demo"});
    expect(setupRules.status).toBe(200);
    const rules=await setupRules.json() as {kind:string;activeRules:unknown[];brokerWrites:number};
    expect(rules.kind).toBe("monitoring_setup");
    expect(rules.activeRules).toHaveLength(3);
    expect(rules.brokerWrites).toBe(0);
    expect(written).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });
  it("restricts optional market/filings and identity FX tools to an authenticated owner",async()=>{
    const {app,written}=setup();
    const fxPath="/owner/api/research/fx?from=EUR&to=EUR";
    expect((await app.request(fxPath)).status).toBe(401);
    const credentials=await signIn(app);
    const identity=await app.request(fxPath,{headers:{Cookie:credentials.cookie}});
    expect(identity.status).toBe(200);
    expect((await identity.json() as {kind:string;status:string;rate:number})).toMatchObject({
      kind:"reference_fx",status:"identity",rate:1,
    });
    const noSec=await app.request("/owner/api/research/filings?symbol=AAPL",
      {headers:{Cookie:credentials.cookie}});
    expect(noSec.status).toBe(400);
    expect((await noSec.json() as {error:string}).error).toContain("SEC_CONTACT_EMAIL");
    const noVendor=await app.request("/owner/api/research/quote?symbol=AAPL",
      {headers:{Cookie:credentials.cookie}});
    expect(noVendor.status).toBe(400);
    expect(written).not.toHaveBeenCalled();
  });
  it("does not enable LIVE execution or bypass owner confirmation",async()=>{
    const {app,written}=setup();
    const credentials=await signIn(app);
    const pending=await ownerPost(app,"/owner/api/prepare",credentials,{
      environment:"live",ticker:"AAPL_US_EQ",side:"buy",type:"limit",quantity:1,limitPrice:100,
    });
    expect(pending.status).toBe(200);
    const token=(await pending.json() as {token:string}).token;
    const proof=await personalApprovalProof(approvalSecret,"order",token);
    const send=await ownerPost(app,"/owner/api/execute",credentials,{
      environment:"live",token,proof,
    });
    expect(send.status).toBe(400);
    expect(written).not.toHaveBeenCalled();
  });
});
