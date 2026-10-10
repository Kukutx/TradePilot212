import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { IntelligenceService } from "./intelligence.js";
const URI="ui://tradepilot-insight/overview.html";
const environment=z.enum(["demo","live"]);
const ruleKind=z.enum(["cash_below","largest_position_above","unrealized_loss_below"]);
const read={readOnlyHint:true,destructiveHint:false,openWorldHint:false} as const;
const localWrite={readOnlyHint:false,destructiveHint:false,openWorldHint:false} as const;
function ok(data:Record<string,unknown>,description:string){
  return { content:[{type:"text" as const,text:description}],structuredContent:data };
}
function fail(e:unknown){
  const message=e instanceof Error?e.message:"Unexpected internal error";
  return {isError:true,content:[{type:"text" as const,text:message}],structuredContent:{kind:"error",message}};
}
export function buildMcpServer(
  service:IntelligenceService, scopes:ReadonlySet<string>,widgetHtml:()=>Promise<string>,
):McpServer{
  const server=new McpServer({name:"tradepilot-insight",version:"3.0.0-alpha.1"});
  registerAppResource(server,"TradePilot intelligence workspace",URI,{},async()=>({
    contents:[{uri:URI,mimeType:RESOURCE_MIME_TYPE,text:await widgetHtml()}],
  }));
  registerAppTool(server,"get_portfolio_intelligence",{
    title:"Portfolio overview",
    description:"Read the connected owner's Trading 212 account, current holdings and portfolio valuation. Never places or cancels orders. Labels synthetic data clearly.",
    inputSchema:z.object({environment}),
    annotations:read,_meta:{ui:{resourceUri:URI}},
  },async({environment})=>{try{const snapshot=await service.portfolio(environment);return ok(snapshot as unknown as Record<string,unknown>,
    `Portfolio snapshot loaded: ${snapshot.source}; ${snapshot.holdings.length} positions.`);}catch(e){return fail(e);}});
  registerAppTool(server,"analyze_portfolio_risk",{
    title:"Analyze portfolio risk",
    description:"Compute coverage-checked allocation, cash percentage and concentration indicators from connected account data. Incomplete FX valuation yields unknown metrics, never invented numbers. No orders.",
    inputSchema:z.object({environment}),
    annotations:read,_meta:{ui:{resourceUri:URI}},
  },async({environment})=>{try{
    const value=await service.analysis(environment);
    return ok(value as unknown as Record<string,unknown>,`Portfolio risk computed; source: ${value.source}, valuation coverage: ${value.exposureCoveragePercent ?? "unknown"}%.`);
  }catch(e){return fail(e);}});
  registerAppTool(server,"simulate_portfolio_scenario",{
    title:"Simulate portfolio shock",
    description:"Compute a hypothetical uniform holdings price shock between -80% and +80%. This is arithmetic stress testing, not a price forecast or a trade suggestion.",
    inputSchema:z.object({environment,shockPercent:z.number().min(-80).max(80)}),
    annotations:read,_meta:{ui:{resourceUri:URI}},
  },async({environment,shockPercent})=>{try{
    const value=await service.stress(environment,shockPercent);
    return ok(value as unknown as Record<string,unknown>,`Hypothetical ${shockPercent}% shock computed; not a forecast.`);
  }catch(e){return fail(e);}});
  registerAppTool(server,"get_portfolio_review_brief",{
    title:"Portfolio review brief",
    description:"Summarize verified account balances, deterministic risk thresholds, limitations and follow-up research topics. Does not browse news, hallucinate sources, make trades or deliver forecasts.",
    inputSchema:z.object({environment}),
    annotations:read,_meta:{ui:{resourceUri:URI}},
  },async({environment})=>{try{
    const value=await service.dailyBrief(environment);
    return ok(value as Record<string,unknown>,`Read-only portfolio review prepared from ${value.source} data.`);
  }catch(e){return fail(e);}});
  registerAppTool(server,"get_broker_order_history",{
    title:"Read completed order history",
    description:"Read one bounded page of Trading 212 historical orders, without submitting, cancelling or modifying orders. A numeric cursor may be supplied from a prior response.",
    inputSchema:z.object({environment,cursor:z.string().regex(/^\d{1,20}$/).optional()}),
    annotations:read,
  },async({environment,cursor})=>{try{
    const value=await service.recentOrders(environment,cursor);
    return ok(value as unknown as Record<string,unknown>,`Returned ${value.orders.length} historical broker events.`);
  }catch(e){return fail(e);}});
  registerAppTool(server,"list_portfolio_watch_rules",{
    title:"List saved portfolio watch rules",
    description:"List self-hosted threshold watches for this environment. Rules are local notifications only, never Trading 212 automated trades.",
    inputSchema:z.object({environment}),annotations:read,
  },async({environment})=>{try{
    const rules=await service.listRules(environment);
    return ok({kind:"rules",environment,rules},`${rules.length} portfolio watch rules.`);
  }catch(e){return fail(e);}});
  registerAppTool(server,"check_portfolio_watch_rules",{
    title:"Check portfolio watch thresholds",
    description:"Evaluate saved watch thresholds against current or recently cached portfolio state. This check is read-only and does not enqueue alerts or execute trades.",
    inputSchema:z.object({environment}),annotations:read,
  },async({environment})=>{try{
    const evaluations=await service.inspectRules(environment);
    return ok({kind:"rule_evaluations",environment,evaluations},`${evaluations.length} rules checked without broker writes.`);
  }catch(e){return fail(e);}});
  registerAppTool(server,"get_portfolio_alerts",{
    title:"Get recorded risk threshold alerts",
    description:"Read locally generated concentration, cash or loss threshold alerts; alerts are not broker orders and may require a manual/scheduled scan.",
    inputSchema:z.object({environment}),annotations:read,
  },async({environment})=>{try{
    const value=await service.events(environment);
    return ok(value as unknown as Record<string,unknown>,`${value.events.length} recent threshold alerts.`);
  }catch(e){return fail(e);}});
  if(scopes.has("monitor:write")){
    registerAppTool(server,"create_portfolio_watch_rule",{
      title:"Save portfolio monitoring threshold",
      description:"Persist a local cash, concentration or P/L threshold to be checked by read-only scheduled portfolio scans. Updates TradePilot state only; does not place or schedule trades.",
      inputSchema:z.object({environment,kind:ruleKind,thresholdPercent:z.number().min(-100).max(100)}),
      annotations:localWrite,
    },async({environment,kind,thresholdPercent})=>{try{
      const rule=await service.createRule(environment,kind,thresholdPercent);
      return ok({kind:"rule_created",rule},`Saved local portfolio watch rule ${rule.id}.`);
    }catch(e){return fail(e);}});
    registerAppTool(server,"remove_portfolio_watch_rule",{
      title:"Remove portfolio monitoring threshold",
      description:"Delete a local monitoring rule by ID. Does not contact any Trading 212 order endpoint.",
      inputSchema:z.object({id:z.string().uuid()}),
      annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false},
    },async({id})=>{try{
      const removed=await service.deleteRule(id);
      return ok({kind:"rule_removed",removed},removed?"Monitoring rule removed.":"Rule not found.");
    }catch(e){return fail(e);}});
    registerAppTool(server,"run_portfolio_monitor_scan",{
      title:"Run monitoring scan",
      description:"Read current portfolio and save threshold-crossing events locally. May create TradePilot alert state, but NEVER modifies broker accounts, holdings or orders.",
      inputSchema:z.object({environment}),annotations:localWrite,
    },async({environment})=>{try{
      const value=await service.scan(environment);
      return ok(value as unknown as Record<string,unknown>,`Read-only broker scan completed, ${value.created} local alerts created.`);
    }catch(e){return fail(e);}});
  }
  return server;
}
