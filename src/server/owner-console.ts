import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Configuration } from "../infra/config.js";
import type { StateStore } from "../infra/state.js";
import type { IntelligenceService } from "./intelligence.js";
import type { PersonalTradingService } from "./trading.js";
import { OwnerAuthentication } from "./owner-auth.js";
import { renderOwnerPage } from "./owner-page.js";
import type {ResearchServices} from "./research-mcp.js";

const environment=z.enum(["demo","live"]);
const positive=z.number().finite().positive();
const draft=z.object({
  environment,ticker:z.string().min(1).max(100),side:z.enum(["buy","sell"]),
  type:z.enum(["market","limit","stop","stop_limit"]),quantity:positive,
  referencePrice:positive.optional(),referencePriceAt:z.string().datetime().optional(),
  fxRateAt:z.string().datetime().optional(),limitPrice:positive.optional(),
  stopPrice:positive.optional(),extendedHours:z.boolean().optional(),
  timeValidity:z.enum(["DAY","GOOD_TILL_CANCEL"]).optional(),
}).strict();
const intent=z.object({
  environment,instrument:z.string().min(1).max(100),side:z.enum(["buy","sell"]),
  type:z.enum(["market","limit","stop","stop_limit"]),
  sizing:z.discriminatedUnion("mode",[
    z.object({mode:z.literal("quantity"),quantity:positive}),
    z.object({mode:z.literal("notional"),amount:positive,currency:z.string().regex(/^[A-Z]{3}$/).optional(),fxToQuote:positive.optional()}),
    z.object({mode:z.literal("cash_percent"),percent:positive.max(100),fxToQuote:positive.optional()}),
    z.object({mode:z.literal("position_percent"),percent:positive.max(100)}),
    z.object({mode:z.literal("all_available")}),
  ]),
  limitPrice:positive.optional(),stopPrice:positive.optional(),
  referencePrice:positive.optional(),referencePriceAt:z.string().datetime().optional(),
  fxRateAt:z.string().datetime().optional(),extendedHours:z.boolean().optional(),
  timeValidity:z.enum(["DAY","GOOD_TILL_CANCEL"]).optional(),
}).strict();
const execute=z.object({
  environment,token:z.string().regex(/^[a-f0-9]{64}$/),proof:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

async function body(c:Context):Promise<unknown> {
  if(!c.req.header("content-type")?.startsWith("application/json"))
    throw new Error("JSON request required");
  const announced=Number(c.req.header("content-length")||0);
  if(!Number.isFinite(announced)||announced>32_768)throw new Error("Body too large");
  const stream=c.req.raw.body;
  if(!stream)throw new Error("JSON body required");
  const reader=stream.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try{
    while(true){
      const item=await reader.read();
      if(item.done)break;
      size+=item.value.byteLength;
      // Limit by actual received bytes, including chunked uploads that have
      // no Content-Length and Unicode whose byte count exceeds char count.
      if(size>32_768)throw new Error("Body too large");
      chunks.push(item.value);
    }
  }finally{
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown;
}
function exceptionMessage(error:unknown){
  if(error instanceof z.ZodError)return "Invalid operation fields or values";
  return error instanceof Error?error.message:"Owner operation unavailable";
}
export function installOwnerConsole(
  app:Hono,config:Configuration,store:StateStore,
  service:IntelligenceService,trading:PersonalTradingService,research:ResearchServices,
):void {
  const auth=new OwnerAuthentication(store,config);
  const root=config.publicOrigin;
  app.get("/owner",async c=>{
    const page=await renderOwnerPage();
    c.header("Content-Security-Policy",page.csp);
    c.header("X-Frame-Options","DENY");
    c.header("Referrer-Policy","no-referrer");
    return c.html(page.html);
  });
  // Owner Console is independent of AI-host OAuth. Every state-changing browser
  // request must have a matching same-origin Origin header; cookie is Strict,
  // and an unpredictable CSRF token is checked for every authenticated POST.
  app.use("/owner/api/*",async(c,next)=>{
    if(c.req.method!=="GET"){
      if(c.req.header("origin")!==root)return c.json({error:"origin_mismatch"},403);
      if(c.req.header("sec-fetch-site")==="cross-site")return c.json({error:"cross_site_request"},403);
    }
    if(c.req.path==="/owner/api/login")return next();
    const session=await auth.get(c.req.header("cookie"));
    if(!session)return c.json({error:"owner_session_required"},401);
    if(c.req.method!=="GET" && !(await auth.verifyCsrf(session,c.req.header("x-owner-csrf"))))
      return c.json({error:"csrf_mismatch"},403);
    return next();
  });
  app.post("/owner/api/login",async c=>{
    try{
      const parsed=z.object({password:z.string().min(1).max(4096)}).strict().parse(await body(c));
      const logged=await auth.login(parsed.password);
      if(!logged)return c.json({error:"invalid_owner_credentials"},401);
      c.header("Set-Cookie",logged.setCookie);
      return c.json({authenticated:true,csrf:logged.session.csrf,expiresAt:logged.session.expiresAt});
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/me",async c=>{
    const session=await auth.get(c.req.header("cookie"));
    if(!session)return c.json({error:"owner_session_required"},401);
    return c.json({
      authenticated:true,csrf:session.csrf,expiresAt:session.expiresAt,
      source:config.source,canReview:config.source==="trading212",
      demoTradingEnabled:config.personalTrading.enabled,
      liveTradingEnabled:config.personalTrading.enabled&&config.personalTrading.liveEnabled,
    });
  });
  app.post("/owner/api/logout",async c=>{
    c.header("Set-Cookie",await auth.logout(c.req.header("cookie")));
    return c.json({authenticated:false});
  });
  app.get("/owner/api/research/fx",async c=>{
    try{
      const args=z.object({from:z.string().regex(/^[A-Z]{3}$/),
        to:z.string().regex(/^[A-Z]{3}$/)}).parse({
        from:c.req.query("from"),to:c.req.query("to"),
      });
      return c.json(await research.fx.rate(args.from,args.to));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/research/filings",async c=>{
    try{
      const symbol=z.string().regex(/^[A-Z0-9.\\-]{1,15}$/).parse(c.req.query("symbol"));
      return c.json(await research.sec.filings(symbol));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/research/quote",async c=>{
    try{
      const args=z.object({
        symbol:z.string().regex(/^[A-Z0-9.\\-]{1,20}$/),
        currency:z.string().regex(/^[A-Z]{3}$/).optional(),
        exchange:z.string().regex(/^[A-Za-z0-9.\\-]{1,32}$/).optional(),
      }).parse({symbol:c.req.query("symbol"),currency:c.req.query("currency"),
        exchange:c.req.query("exchange")});
      return c.json(await research.quote.quote(args.symbol,args.currency,args.exchange));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/preferences",async c=>{
    try{return c.json({kind:"owner_preferences",preferences:await service.preferences(),
      emailProviderConfigured:config.notifications.provider==="resend"});}
    catch(error){return c.json({error:exceptionMessage(error)},500);}
  });
  app.post("/owner/api/preferences",async c=>{
    try{
      const preferences=await service.updatePreferences(await body(c));
      return c.json({kind:"owner_preferences",preferences});
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.post("/owner/api/monitoring/setup",async c=>{
    try{
      const {environment:env}=z.object({environment}).strict().parse(await body(c));
      return c.json(await service.enableBasicMonitoring(env));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/reports",async c=>{
    const parsed=environment.safeParse(c.req.query("environment")||"demo");
    if(!parsed.success)return c.json({error:"Invalid account environment"},400);
    const rows=await store.list<unknown>(`v3:daily-report:${parsed.data}:`);
    return c.json({kind:"daily_reports",environment:parsed.data,
      reports:rows.map(row=>row.value).slice(-30)});
  });
  app.get("/owner/api/overview",async c=>{
    const parsed=environment.safeParse(c.req.query("environment")||"demo");
    if(!parsed.success)return c.json({error:"Invalid environment"},400);
    try{
      const env=parsed.data,center=await service.attention(env);
      const portfolio=await service.portfolio(env);
      let pending:unknown={kind:"pending_orders",orders:[]};
      if(config.source==="trading212"){
        try{pending=await trading.pendingOrders(env);}
        catch{pending={kind:"pending_unavailable",message:"Pending orders could not be read from the broker."};}
      }
      return c.json({kind:"owner_overview",environment:env,center,portfolio,pending,
        unresolved:await trading.unresolvedWrite(env),
        executionEnabled:config.source==="trading212" && config.personalTrading.enabled &&
          (env==="demo"||config.personalTrading.liveEnabled)});
    }catch(error){return c.json({error:exceptionMessage(error)},502);}
  });
  app.post("/owner/api/review",async c=>{
    try{
      const parsed=intent.parse(await body(c));
      return c.json(await trading.reviewIntent(parsed));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.post("/owner/api/prepare",async c=>{
    try{return c.json(await trading.prepareOrder(draft.parse(await body(c))));}
    catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.post("/owner/api/execute",async c=>{
    try{
      const args=execute.parse(await body(c));
      return c.json(await trading.executeOrder(args.token,args.proof,args.environment));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.post("/owner/api/cancel/prepare",async c=>{
    try{
      const args=z.object({environment,orderId:z.string().regex(/^\d{1,20}$/)}).strict().parse(await body(c));
      return c.json(await trading.prepareCancel(args.environment,args.orderId));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.post("/owner/api/cancel/execute",async c=>{
    try{
      const args=execute.parse(await body(c));
      return c.json(await trading.executeCancel(args.token,args.proof,args.environment));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/unresolved",async c=>{
    const parsed=environment.safeParse(c.req.query("environment")||"demo");
    if(!parsed.success)return c.json({error:"Invalid environment"},400);
    return c.json({kind:"unresolved_status",environment:parsed.data,
      incident:await trading.unresolvedWrite(parsed.data)});
  });
  app.post("/owner/api/reconcile",async c=>{
    try{
      const args=z.object({
        environment,
        verificationId:z.string().regex(/^[a-f0-9]{64}$/),
        proof:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        confirmation:z.literal("I CHECKED TRADING 212"),
      }).strict().parse(await body(c));
      return c.json(await trading.acknowledgeUnresolved(
        args.environment,args.verificationId,args.proof,args.confirmation,
      ));
    }catch(error){return c.json({error:exceptionMessage(error)},400);}
  });
  app.get("/owner/api/verify",async c=>{
    const parsed=environment.safeParse(c.req.query("environment")||"demo");
    const id=c.req.query("id")||"";
    if(!parsed.success||!/^[a-f0-9]{64}$/.test(id))
      return c.json({error:"Invalid verification request"},400);
    try{return c.json(await trading.verifyOutcome(id,parsed.data));}
    catch(error){return c.json({error:exceptionMessage(error)},502);}
  });
}
