import { strict as assert } from "node:assert";
import { createHttpApp } from "../src/server/http.js";
import { readConfiguration } from "../src/infra/config.js";
import { MemoryStore } from "../src/infra/state.js";

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
assert.doesNotMatch(tools.text,/create_portfolio_watch_rule|place_order|execute_order|cancel_order/);
const analysis=await call("tools/call",{name:"analyze_portfolio_risk",arguments:{environment:"demo"}},3);
assert.equal(analysis.status,200,analysis.text);
assert.match(analysis.text,/analysis|100/);
const old=await call("initialize",{},4,true);
assert.notEqual(old.status,200,"Old MCP initialize must be rejected");
const missing=await app.request("/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:5,method:"tools/list"})});
assert.equal(missing.status,401);
const reg=await app.request("/oauth/register",{method:"POST"});
assert.equal(reg.status,404,"DCR must not exist in the clean-slate v3");
console.log("SMOKE_OK V3 modern-only MCP, PKCE, CIMD, refresh replay and read-only tools");
