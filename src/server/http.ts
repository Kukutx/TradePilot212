import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { Configuration } from "../infra/config.js";
import { Trading212Reader, type BrokerReader } from "../infra/broker.js";
import { Trading212TradeGateway, type BrokerTradePort } from "../infra/trade-gateway.js";
import { BrokerPacer } from "../infra/broker-pacer.js";
import { PersonalTradingService } from "./trading.js";
import { installOwnerConsole } from "./owner-console.js";
import {ReferenceFxService} from "../infra/reference-fx.js";
import {SecResearchService} from "../infra/primary-research.js";
import {TwelveDataQuoteService} from "../infra/market-quotes.js";
import type { StateStore } from "../infra/state.js";
import { IntelligenceService } from "./intelligence.js";
import { authenticateBearer, installOAuth } from "./oauth.js";
import { buildMcpServer } from "./mcp.js";
export interface HttpDeps {
  config:Configuration;
  state:StateStore;
  widgetHtml:()=>Promise<string>;
  fetcher?:typeof fetch;
  broker?:BrokerReader;
  tradeGateway?:BrokerTradePort;
}
export function createHttpApp(deps:HttpDeps) {
  const app=new Hono();
  const fetcher=deps.fetcher??fetch;
  const pacer=new BrokerPacer(deps.state);
  const reader=deps.broker??new Trading212Reader(deps.config,fetcher,pacer);
  const service=new IntelligenceService(deps.config,deps.state,reader);
  const personal=new PersonalTradingService(
    deps.config,deps.state,reader,deps.tradeGateway??new Trading212TradeGateway(deps.config,fetcher,pacer),
  );
  const research={fx:new ReferenceFxService(deps.state,fetcher),
    sec:new SecResearchService(deps.config,deps.state,fetcher),
    quote:new TwelveDataQuoteService(deps.config,deps.state,fetcher)};
  const allowedOrigins=new Set([deps.config.publicOrigin,...deps.config.trustedClientOrigins]);
  app.use("*",async(c,next)=>{
    c.header("Cache-Control","no-store");
    c.header("X-Content-Type-Options","nosniff");
    c.header("Referrer-Policy","no-referrer");
    const origin=c.req.header("origin");
    if(origin && !allowedOrigins.has(origin))return c.json({error:"origin_not_allowed"},403);
    if(origin){c.header("Access-Control-Allow-Origin",origin);c.header("Vary","Origin");}
    await next();
  });
  app.options("/mcp",c=>{
    c.header("Access-Control-Allow-Methods","POST, OPTIONS");
    c.header("Access-Control-Allow-Headers","Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Accept");
    return c.body(null,204);
  });
  installOAuth(app,deps.config,deps.state,fetcher);
  installOwnerConsole(app,deps.config,deps.state,service,personal,research);
  app.get("/health",c=>c.json({ok:true,service:"TradePilot 212 Personal",version:"3.0.0-alpha.3"}));
  app.post("/mcp",async c=>{
    const scopes=await authenticateBearer(c.req.header("authorization"),deps.config);
    if(!scopes||!scopes.has("portfolio:read")){
      c.header("WWW-Authenticate",`Bearer resource_metadata="${deps.config.publicOrigin}/.well-known/oauth-protected-resource"`);
      return c.json({error:"unauthorized"},401);
    }
    const advertised=Number(c.req.header("content-length")||0);
    if(!Number.isFinite(advertised)||advertised>1_048_576)
      return c.json({error:"request_too_large"},413);
    let request:Request;
    try{
      if(!c.req.raw.body) return c.json({error:"invalid_request"},400);
      const reader=c.req.raw.body.getReader(),parts:Uint8Array[]=[];
      let size=0;
      try{
        while(true){
          const part=await reader.read();
          if(part.done)break;
          size+=part.value.byteLength;
          if(size>1_048_576)return c.json({error:"request_too_large"},413);
          parts.push(part.value);
        }
      }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;
      for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}
      const headers=new Headers(c.req.raw.headers);
      headers.delete("content-length");
      request=new Request(c.req.url,{method:"POST",headers,body:bytes,signal:c.req.raw.signal});
    }catch{return c.json({error:"invalid_request"},400);}
    // Reject all pre-2026 protocol requests. No `initialize` adapter.
    const handler=createMcpHandler(
      ()=>buildMcpServer(service,scopes,deps.widgetHtml,personal,research),
      {legacy:"reject",responseMode:"json"},
    );
    return handler.fetch(request);
  });
  app.notFound(c=>c.json({error:"not_found"},404));
  return app;
}
