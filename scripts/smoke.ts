import { strict as assert } from "node:assert";
import { createHttpApp } from "../src/server/http.js";
import { readConfiguration } from "../src/infra/config.js";
import { MemoryStore } from "../src/infra/state.js";
import { personalApprovalProof } from "../src/domain/approval-proof.js";

const publicOrigin = "https://insight.example.test";
const config=readConfiguration({
  PUBLIC_ORIGIN:publicOrigin, DATA_SOURCE:"sample",
  OWNER_PASSWORD:"sample-test-owner-password-12345",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
});
const clientId="https://chatgpt.com/oauth/client.json";
const redirectUri="https://chatgpt.com/connector_platform_oauth_redirect";
const fakeFetch=(async()=>new Response(JSON.stringify({
  client_id:clientId,redirect_uris:[redirectUri],
  token_endpoint_auth_methods_supported:["none","private_key_jwt"],
}),{status:200})) as typeof fetch;
const app=createHttpApp({
  config,state:new MemoryStore(),fetcher:fakeFetch,widgetHtml:async()=>"<html>Risk dashboard</html>",
});
const verifier="test-verifier-with-at-least-43-characters-required-and-extra-letters";
const challengeRaw=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)));
let challengeBinary="";for(const b of challengeRaw)challengeBinary+=String.fromCharCode(b);
const challenge=btoa(challengeBinary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const authParams=new URLSearchParams({
  client_id:clientId,redirect_uri:redirectUri,response_type:"code",
  code_challenge:challenge,code_challenge_method:"S256",resource:`${publicOrigin}/mcp`,
  scope:"portfolio:read offline_access",state:"request-state",
});
const page=await app.request(`/oauth/authorize?${authParams}`);
assert.equal(page.status,200);
const authorization=await app.request("/oauth/authorize",{
  method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
  body:new URLSearchParams({...Object.fromEntries(authParams),password:config.ownerPassword}).toString(),
});
assert.equal(authorization.status,302);
const redirect=new URL(authorization.headers.get("location")!);
assert.equal(redirect.searchParams.get("iss"),publicOrigin);
const code=redirect.searchParams.get("code")!;
const exchange=async(b:Record<string,string>)=>{
  const response=await app.request("/oauth/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:clientId,...b}).toString(),
  });
  return {status:response.status,body:await response.json() as Record<string,string>};
};
const first=await exchange({grant_type:"authorization_code",code,redirect_uri:redirectUri,code_verifier:verifier,resource:`${publicOrigin}/mcp`});
assert.equal(first.status,200);
const rotated=await exchange({grant_type:"refresh_token",refresh_token:first.body.refresh_token!});
assert.equal(rotated.status,200);
assert.equal((await exchange({grant_type:"refresh_token",refresh_token:first.body.refresh_token!})).status,400);
const token=first.body.access_token;
const envelope={"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"tradepilot-smoke",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}};
async function call(method:string,params:Record<string,unknown>,id:number,legacy=false){
  const response=await app.request("/mcp",{
    method:"POST",headers:{
      Authorization:`Bearer ${token}`,
      "Content-Type":"application/json",Accept:"application/json, text/event-stream",
      "MCP-Protocol-Version":legacy?"2025-11-25":"2026-07-28",
      "Mcp-Method":method,...(params.name?{"Mcp-Name":String(params.name)}:{}),
    },
    body:JSON.stringify({jsonrpc:"2.0",id,method,params:legacy?params:{...params,_meta:envelope}}),
  });
  return {status:response.status,text:await response.text()};
}
const discover=await call("server/discover",{},1);
assert.equal(discover.status,200,discover.text);
assert.match(discover.text,/2026-07-28/);
const tools=await call("tools/list",{},2);
assert.equal(tools.status,200,tools.text);
assert.match(tools.text,/analyze_portfolio_risk/);
assert.match(tools.text,/get_personal_attention_center/);
assert.doesNotMatch(tools.text,/enable_basic_portfolio_monitoring/);
assert.doesNotMatch(tools.text,/create_portfolio_watch_rule|place_order|execute_order|cancel_order/);
const analysis=await call("tools/call",{name:"analyze_portfolio_risk",arguments:{environment:"demo"}},3);
assert.equal(analysis.status,200,analysis.text);
assert.match(analysis.text,/analysis|100/);
const today=await call("tools/call",{name:"get_personal_attention_center",arguments:{environment:"demo"}},6);
assert.equal(today.status,200,today.text);
assert.match(today.text,/attention_center|Synthetic/);
const old=await call("initialize",{},4,true);
assert.notEqual(old.status,200,"Old MCP initialize must be rejected");
const missing=await app.request("/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:5,method:"tools/list"})});
assert.equal(missing.status,401);
const reg=await app.request("/oauth/register",{method:"POST"});
assert.equal(reg.status,404,"DCR must not exist in the clean-slate v3");
console.log("SMOKE_OK V3 modern-only MCP, PKCE, CIMD, refresh replay and read-only tools");


/**
 * Private-owner compatibility acceptance against *mocked* broker ports.
 * CI never has real brokerage keys, and no Trading 212 POST/DELETE is emitted.
 */
const personalOrigin="https://private-insight.example.test";
const privateConfig=readConfiguration({
  PUBLIC_ORIGIN:personalOrigin,DATA_SOURCE:"trading212",
  OWNER_PASSWORD:"private-test-owner-password-1234567",
  JWT_SIGNING_SECRET:"1234567890abcdef".repeat(3),
  T212_DEMO_KEY:"synthetic-demo-test-key",T212_DEMO_SECRET:"synthetic-demo-test-secret",
  PERSONAL_TRADING_ENABLED:"true",PERSONAL_APPROVAL_SECRET:"fake-independent-human-approval-secret-12345",
});
let mockBrokerWrites=0;
const privateApp=createHttpApp({
  config:privateConfig,state:new MemoryStore(),fetcher:fakeFetch,
  widgetHtml:async()=>"<html>Private test dashboard</html>",
  broker:{
    async getPortfolio(environment){
      return {
        kind:"portfolio" as const,environment,source:"trading212" as const,
        asOf:new Date().toISOString(),
        account:{currency:"USD",availableCash:1500,totalValue:2500,investmentValue:1000,unrealizedProfitLoss:75},
        holdings:[{ticker:"AAPL_US_EQ",name:"Apple",currency:"USD",quantity:5,tradableQuantity:4,price:100,
          valueInAccountCurrency:500,valueProvenance:"same_currency_quote" as const}],
        notes:[],
      };
    },
    async getRecentOrders(){return {items:[],nextCursor:null};},
  },
  tradeGateway:{
    async getInstruments(){return [{ticker:"AAPL_US_EQ",name:"Apple",shortName:"AAPL",currencyCode:"USD",extendedHours:true}];},
    async getPendingOrders(){return [];},
    async getOrder(_environment,id){return {id,ticker:"AAPL_US_EQ",quantity:1};},
    async placeOrder(){mockBrokerWrites++;return {orderId:"999"};},
    async cancelOrder(_environment,id){mockBrokerWrites++;return {orderId:id};},
  },
});
async function personalToken(scope:string):Promise<string>{
  const params=new URLSearchParams({...Object.fromEntries(authParams),
    resource:`${personalOrigin}/mcp`,scope});
  const authorized=await privateApp.request("/oauth/authorize",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({...Object.fromEntries(params),password:privateConfig.ownerPassword}).toString(),
  });
  assert.equal(authorized.status,302,await authorized.text());
  const code=new URL(authorized.headers.get("location")!).searchParams.get("code")!;
  const exchange=await privateApp.request("/oauth/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:clientId,grant_type:"authorization_code",
      code,redirect_uri:redirectUri,code_verifier:verifier,resource:`${personalOrigin}/mcp`}).toString(),
  });
  const tokenText=await exchange.text();
  assert.equal(exchange.status,200,tokenText);
  const token=JSON.parse(tokenText) as {access_token:string};
  return token.access_token;
}
async function personalCall(token:string,method:string,params:Record<string,unknown>,id:number){
  const response=await privateApp.request("/mcp",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${token}`,"Content-Type":"application/json",
      Accept:"application/json, text/event-stream",
      "MCP-Protocol-Version":"2026-07-28","Mcp-Method":method,
      ...(params.name?{"Mcp-Name":String(params.name)}:{}),
    },
    body:JSON.stringify({jsonrpc:"2.0",id,method,params:{...params,_meta:envelope}}),
  });
  return {status:response.status,text:await response.text()};
}
const readonlyToken=await personalToken("portfolio:read");
const privateRead=await personalCall(readonlyToken,"tools/list",{},21);
assert.equal(privateRead.status,200,privateRead.text);
assert.doesNotMatch(privateRead.text,/review_personal_trade_intent|app_execute_personal_order/);
const reviewToken=await personalToken("portfolio:read trading:review");
const reviewList=await personalCall(reviewToken,"tools/list",{},22);
assert.equal(reviewList.status,200,reviewList.text);
assert.match(reviewList.text,/review_personal_trade_intent/);
assert.doesNotMatch(reviewList.text,/app_execute_personal_order/);
const reviewed=await personalCall(reviewToken,"tools/call",{
  name:"review_personal_trade_intent",arguments:{
    environment:"demo",instrument:"Apple",side:"buy",type:"market",
    sizing:{mode:"quantity",quantity:0.5},referencePrice:100,
  },
},23);
assert.equal(reviewed.status,200,reviewed.text);
assert.match(reviewed.text,/trade_draft/);
const executionToken=await personalToken("portfolio:read trading:review trading:execute");
const forged=await personalCall(executionToken,"tools/call",{
  name:"app_execute_personal_order",arguments:{
    environment:"demo",token:"a".repeat(64),proof:"b".repeat(43),
  },
},24);
assert.equal(forged.status,200,forged.text);
assert.match(forged.text,/incorrect|error/i);
assert.equal(mockBrokerWrites,0,"Host tool calls without human proof must never reach brokerage writes");
function structured(text:string):Record<string,unknown>{
  const result=JSON.parse(text) as {result?:{structuredContent?:Record<string,unknown>}};
  assert.ok(result.result?.structuredContent,"MCP did not return structuredContent");
  return result.result.structuredContent;
}
const prepared=await personalCall(executionToken,"tools/call",{
  name:"app_prepare_personal_order",
  arguments:{environment:"demo",ticker:"AAPL_US_EQ",side:"buy",type:"limit",
    quantity:1,limitPrice:99,referencePrice:100},
},25);
assert.equal(prepared.status,200,prepared.text);
const preview=structured(prepared.text) as {kind?:string;token?:string};
assert.equal(preview.kind,"trade_preview");
assert.ok(preview.token);
const orderProof=await personalApprovalProof(
  privateConfig.personalTrading.approvalSecret,"order",preview.token,
);
const submitted=await personalCall(executionToken,"tools/call",{
  name:"app_execute_personal_order",
  arguments:{environment:"demo",token:preview.token,proof:orderProof},
},26);
assert.equal(submitted.status,200,submitted.text);
assert.equal(structured(submitted.text).status,"submitted");
assert.equal(mockBrokerWrites,1,"exactly one mocked broker order should be sent");
const repeated=await personalCall(executionToken,"tools/call",{
  name:"app_execute_personal_order",
  arguments:{environment:"demo",token:preview.token,proof:orderProof},
},27);
assert.equal(repeated.status,200,repeated.text);
assert.match(repeated.text,/expired|error/);
assert.equal(mockBrokerWrites,1,"reuse of a one-time proof cannot send another broker write");
const cancelPrepared=await personalCall(executionToken,"tools/call",{
  name:"app_prepare_personal_cancel",arguments:{environment:"demo",orderId:"11"},
},28);
assert.equal(cancelPrepared.status,200,cancelPrepared.text);
const cancelPreview=structured(cancelPrepared.text) as {token?:string};
assert.ok(cancelPreview.token);
const cancelProof=await personalApprovalProof(
  privateConfig.personalTrading.approvalSecret,"cancel",cancelPreview.token!,
);
const cancelled=await personalCall(executionToken,"tools/call",{
  name:"app_execute_personal_cancel",
  arguments:{environment:"demo",token:cancelPreview.token,proof:cancelProof},
},29);
assert.equal(cancelled.status,200,cancelled.text);
assert.equal(structured(cancelled.text).status,"submitted");
assert.equal(mockBrokerWrites,2,"one mocked order and one mocked cancellation, zero real broker writes");
const monitorToken=await personalToken("portfolio:read monitor:write");
const monitorTools=await personalCall(monitorToken,"tools/list",{},30);
assert.equal(monitorTools.status,200,monitorTools.text);
assert.match(monitorTools.text,/enable_basic_portfolio_monitoring/);
assert.doesNotMatch(monitorTools.text,/app_execute_personal_order/);
const starter=await personalCall(monitorToken,"tools/call",{
  name:"enable_basic_portfolio_monitoring",arguments:{environment:"demo"},
},31);
assert.equal(starter.status,200,starter.text);
assert.equal(structured(starter.text).kind,"monitoring_setup");
assert.equal(structured(starter.text).brokerWrites,0);
assert.equal(mockBrokerWrites,2,"Setting up automation must never trigger an additional brokerage operation");
console.log("SMOKE_OK Attention Center, opt-in monitoring presets, correct OAuth scope separation");
console.log("SMOKE_OK Personal scope isolation, HMAC approval, single-use order and cancellation (mock broker)");

