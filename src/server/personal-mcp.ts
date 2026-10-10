import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PersonalTradingService } from "./trading.js";
import { executionPermitted } from "../infra/config.js";
import type { TradeIdea, TradeIntent } from "../domain/trading.js";

const environment=z.enum(["demo","live"]);
const positive=z.number().finite().positive();
const sizing=z.discriminatedUnion("mode",[
  z.object({mode:z.literal("quantity"),quantity:positive}),
  z.object({mode:z.literal("notional"),amount:positive,currency:z.string().regex(/^[A-Z]{3}$/).optional(),fxToQuote:positive.optional()}),
  z.object({mode:z.literal("cash_percent"),percent:positive.max(100),fxToQuote:positive.optional()}),
  z.object({mode:z.literal("position_percent"),percent:positive.max(100)}),
  z.object({mode:z.literal("all_available")}),
]);
const orderFields={
  environment,ticker:z.string().min(1),side:z.enum(["buy","sell"]),
  type:z.enum(["market","limit","stop","stop_limit"]),quantity:positive,
  referencePrice:positive.optional(),referencePriceAt:z.string().datetime().optional(),
  fxRateAt:z.string().datetime().optional(),limitPrice:positive.optional(),
  stopPrice:positive.optional(),extendedHours:z.boolean().optional(),
  timeValidity:z.enum(["DAY","GOOD_TILL_CANCEL"]).optional(),
};
const intentSchema=z.object({
  environment,instrument:z.string().min(1),side:z.enum(["buy","sell"]),
  type:z.enum(["market","limit","stop","stop_limit"]).default("market"),
  sizing,referencePrice:positive.optional(),referencePriceAt:z.string().datetime().optional(),
  fxRateAt:z.string().datetime().optional(),limitPrice:positive.optional(),
  stopPrice:positive.optional(),extendedHours:z.boolean().optional(),
  timeValidity:z.enum(["DAY","GOOD_TILL_CANCEL"]).optional(),
});
const candidateSchema=z.object({
  ticker:z.string().optional(),symbol:z.string().optional(),name:z.string().optional(),
  horizon:z.enum(["short","medium","long"]),action:z.enum(["buy","sell","watch"]),
  score:z.number().min(0).max(100),risk:z.enum(["low","medium","high"]),
  rationale:z.string().min(1).max(3000),thesis:z.string().max(3000).optional(),
  catalysts:z.array(z.string().max(500)).max(12).optional(),
  risks:z.array(z.string().max(500)).max(12).optional(),
  counterCase:z.string().max(3000).optional(),
  sources:z.array(z.string().max(500)).max(12).optional(),
  analysisAsOf:z.string().datetime().optional(),
  suggestedQuantity:positive.optional(),referencePrice:positive.optional(),
  referencePriceAt:z.string().datetime().optional(),
});
const safeRead={readOnlyHint:true,destructiveHint:false,openWorldHint:true} as const;
const localPrepare={readOnlyHint:false,destructiveHint:false,openWorldHint:true} as const;
const externalWrite={readOnlyHint:false,destructiveHint:true,openWorldHint:true} as const;
const appOnly={visibility:["app"]} as const;
function ok(value:unknown,message:string) {
  return {content:[{type:"text" as const,text:message}],structuredContent:value as Record<string,unknown>};
}
function bad(error:unknown) {
  const message=error instanceof Error?error.message:"Personal trading operation failed";
  return {isError:true,content:[{type:"text" as const,text:message}],structuredContent:{kind:"error",message}};
}
export function registerPersonalTradingTools(
  server:McpServer,service:PersonalTradingService,scopes:ReadonlySet<string>,widgetUri:string,
):void{
  const canReview=scopes.has("trading:review")&&service.config.source==="trading212";
  const canExecute=scopes.has("trading:execute")&&service.config.personalTrading.enabled&&canReview;
  registerAppTool(server,"get_personal_trading_capabilities",{
    title:"Check private trading capabilities",
    description:"Show whether this single-owner connection can review or execute Demo/Live trades. Never places or cancels orders.",
    inputSchema:z.object({environment}),annotations:safeRead,
  },async({environment})=>ok({
    kind:"personal_capabilities",environment,
    source:service.config.source,
    canReview,canExecute:canExecute&&executionPermitted(service.config,environment),
    confirmationRequired:true,aiAutonomousExecution:false,
  },"Returned scoped private trading capabilities. No broker write."));
  if(!canReview)return;
  registerAppTool(server,"search_personal_instruments",{
    title:"Search owned Trading 212 account instruments",
    description:"Find exact broker ticker or company name for the selected Demo/Live environment; never submits a trade.",
    inputSchema:z.object({environment,query:z.string().min(1),limit:z.number().int().min(1).max(50).default(20)}),
    annotations:safeRead,
  },async({environment,query,limit})=>{try{
    const r=await service.searchInstruments(environment,query,limit);
    return ok(r,`Found ${r.matches.length} brokerage instruments.`);
  }catch(e){return bad(e);}});
  registerAppTool(server,"get_personal_pending_orders",{
    title:"Read pending Trading 212 orders",
    description:"Read current pending Demo/Live orders. This tool cannot submit, cancel or modify them.",
    inputSchema:z.object({environment}),annotations:safeRead,_meta:{ui:{resourceUri:widgetUri}},
  },async({environment})=>{try{
    const r=await service.pendingOrders(environment);
    return ok({...r,orders:r.orders.slice(0,50)},`${r.orders.length} pending orders retrieved.`);
  }catch(e){return bad(e);}});
  registerAppTool(server,"get_personal_trading_activity",{
    title:"Read TradePilot review/execution activity",
    description:"Read metadata-only personal TradePilot order and cancellation activity without broker writes.",
    inputSchema:z.object({environment}),annotations:safeRead,
  },async({environment})=>{try{
    const r=await service.activity(environment);
    return ok(r,`${r.events.length} recent personal trading activity records.`);
  }catch(e){return bad(e);}});
  registerAppTool(server,"review_personal_trade_intent",{
    title:"Review Trading 212 order proposal",
    description:"Convert a user's natural-language trading intent to an editable, precise broker ticker/quantity order. Supports quantity, target money, cash percentage, held percentage and all tradable shares. REVIEW ONLY: never submits; final broker writes require a separate human-only UI confirmation and private proof. Respect Demo vs Live.",
    inputSchema:intentSchema,annotations:safeRead,_meta:{ui:{resourceUri:widgetUri}},
  },async(intent)=>{try{
    const r=await service.reviewIntent(intent as TradeIntent);
    return ok(r,`Opened an editable ${r.draft.environment.toUpperCase()} ${r.draft.side} draft; NO order submitted.`);
  }catch(e){return bad(e);}});
  registerAppTool(server,"review_exact_personal_order",{
    title:"Review exact personal order",
    description:"Render an exact quantity-based Market, Limit, Stop or Stop-Limit order draft for human review. This is read-only; does not place orders.",
    inputSchema:z.object(orderFields),annotations:safeRead,_meta:{ui:{resourceUri:widgetUri}},
  },async(draft)=>{try{
    const r=await service.reviewIntent({
      environment:draft.environment,instrument:draft.ticker,
      side:draft.side,type:draft.type,sizing:{mode:"quantity",quantity:draft.quantity},
      ...(draft.referencePrice===undefined?{}:{referencePrice:draft.referencePrice}),
      ...(draft.referencePriceAt?{referencePriceAt:draft.referencePriceAt}:{}),
      ...(draft.fxRateAt?{fxRateAt:draft.fxRateAt}:{}),
      ...(draft.limitPrice===undefined?{}:{limitPrice:draft.limitPrice}),
      ...(draft.stopPrice===undefined?{}:{stopPrice:draft.stopPrice}),
      ...(draft.extendedHours===undefined?{}:{extendedHours:draft.extendedHours}),
      ...(draft.timeValidity?{timeValidity:draft.timeValidity}:{}),
    });
    return ok(r,"Exact order draft opened, no broker write or confirmation token created.");
  }catch(e){return bad(e);}});
  registerAppTool(server,"show_personal_trade_plan",{
    title:"Personal multi-horizon investment research plan",
    description:"Render model-supplied research hypotheses as short/medium/long cards with sources, timestamps, counterarguments and risk level. Does not certify the analysis or perform any trade. User may choose to review a separate order.",
    inputSchema:z.object({environment,candidates:z.array(candidateSchema).min(1).max(30)}),
    annotations:safeRead,_meta:{ui:{resourceUri:widgetUri}},
  },async({environment,candidates})=>{try{
    const r=await service.tradePlan(environment,candidates as TradeIdea[]);
    return ok(r,"Displayed research hypotheses with source and risk disclosures. No broker write.");
  }catch(e){return bad(e);}});
  registerAppTool(server,"app_prepare_personal_order",{
    title:"Validate personal order confirmation",
    description:"App-only: revalidate broker state and issue a short-lived one-use confirmation; sends no broker order.",
    inputSchema:z.object(orderFields),annotations:localPrepare,_meta:{ui:appOnly},
  },async(draft)=>{try{
    const r=await service.prepareOrder(draft);
    return ok(r,"Order validated for human review. No broker write.");
  }catch(e){return bad(e);}});
  registerAppTool(server,"app_prepare_personal_cancel",{
    title:"Review personal order cancellation",
    description:"App-only: validate a pending order and issue a one-use cancellation review token; no cancellation sent.",
    inputSchema:z.object({environment,orderId:z.string().regex(/^\d{1,20}$/)}),
    annotations:localPrepare,_meta:{ui:appOnly},
  },async({environment,orderId})=>{try{
    const r=await service.prepareCancel(environment,orderId);
    return ok(r,"Cancellation prepared. No broker write.");
  }catch(e){return bad(e);}});
  registerAppTool(server,"app_verify_personal_execution",{
    title:"Read back uncertain personal broker action",
    description:"App-only: observe pending orders and positions after an uncertain broker write, never retry it.",
    inputSchema:z.object({environment,verificationId:z.string().regex(/^[0-9a-f]{64}$/)}),
    annotations:safeRead,_meta:{ui:appOnly},
  },async({environment,verificationId})=>{try{
    const r=await service.verifyOutcome(verificationId,environment);
    return ok(r,r.message);
  }catch(e){return bad(e);}});
  if(!canExecute)return;
  registerAppTool(server,"app_execute_personal_order",{
    title:"Execute explicitly confirmed personal trade",
    description:"App-only, high-risk external broker WRITE. Requires separate human-held HMAC proof bound to the exact one-time token and environment, and fresh broker validation. No automatic retries.",
    inputSchema:z.object({environment,token:z.string().regex(/^[0-9a-f]{64}$/),proof:z.string().length(43)}),
    annotations:externalWrite,_meta:{ui:appOnly},
  },async({environment,token,proof})=>{try{
    if(!executionPermitted(service.config,environment))throw new Error("Personal execution disabled for this environment");
    const r=await service.executeOrder(token,proof,environment);
    return ok(r,r.message);
  }catch(e){return bad(e);}});
  registerAppTool(server,"app_execute_personal_cancel",{
    title:"Execute explicitly confirmed order cancellation",
    description:"App-only, high-risk broker DELETE. Requires separate human-held action-specific proof and one-time token. Never retries uncertain cancellation.",
    inputSchema:z.object({environment,token:z.string().regex(/^[0-9a-f]{64}$/),proof:z.string().length(43)}),
    annotations:externalWrite,_meta:{ui:appOnly},
  },async({environment,token,proof})=>{try{
    if(!executionPermitted(service.config,environment))throw new Error("Personal cancellation disabled for this environment");
    const r=await service.executeCancel(token,proof,environment);
    return ok(r,r.message);
  }catch(e){return bad(e);}});
}
