import type {McpServer} from "@modelcontextprotocol/server";
import {z} from "zod";
import type {ReferenceFxService} from "../infra/reference-fx.js";
import type {SecResearchService} from "../infra/primary-research.js";
import type {TwelveDataQuoteService} from "../infra/market-quotes.js";

export interface ResearchServices {
  fx:ReferenceFxService;
  sec:SecResearchService;
  quote:TwelveDataQuoteService;
}
const readOnly={readOnlyHint:true,destructiveHint:false,openWorldHint:true} as const;
function result(data:unknown,message:string){
  return {content:[{type:"text" as const,text:message}],structuredContent:data as Record<string,unknown>};
}
function failure(error:unknown){
  const message=error instanceof Error?error.message:"Research provider unavailable";
  return {isError:true,content:[{type:"text" as const,text:message}],
    structuredContent:{kind:"research_unavailable",message}};
}
export function registerResearchTools(server:McpServer,services:ResearchServices):void{
  server.registerTool("get_ecb_reference_fx",{
    title:"Read official ECB reference exchange rate",
    description:"Retrieve a dated European Central Bank daily reference FX conversion from fixed official ECB API sources. NOT live FX, not a Trading 212 conversion price and never used for an automatic trade. Supports EUR or cross-rates only when observations are from the same date.",
    inputSchema:{from:z.string().regex(/^[A-Z]{3}$/),to:z.string().regex(/^[A-Z]{3}$/)},
    annotations:readOnly,
  },async({from,to})=>{try{
    const value=await services.fx.rate(from,to);
    return result(value,`ECB reference ${from}/${to}: ${value.rate??"unavailable"}, date: ${value.asOf??"unavailable"}. Not an executable FX quote.`);
  }catch(e){return failure(e);}});
  server.registerTool("get_official_sec_company_filings",{
    title:"Read primary-source SEC EDGAR filing index",
    description:"Retrieve official United States Securities and Exchange Commission filing metadata and document links for a US public-company ticker from SEC domains. Requires owner SEC contact email for fair access. Reports metadata only; filing content is not fact-checked or summarized.",
    inputSchema:{symbol:z.string().regex(/^[A-Z0-9.\-]{1,15}$/)},
    annotations:readOnly,
  },async({symbol})=>{try{
    const value=await services.sec.filings(symbol);
    return result(value,`${value.company}: ${value.filings.length} official SEC filings, with direct source URLs and dates. Contents not analyzed.`);
  }catch(e){return failure(e);}});
  server.registerTool("get_optional_verified_market_quote",{
    title:"Read optional timestamped market vendor quote",
    description:"Read a quote from the owner's explicitly configured Twelve Data vendor account. Return quote timestamp, venue, currency, staleness and warnings. Never treat vendor data as a guaranteed Trading 212 execution price or enable broker order submission.",
    inputSchema:{
      symbol:z.string().regex(/^[A-Z0-9.\-]{1,20}$/),
      expectedCurrency:z.string().regex(/^[A-Z]{3}$/).optional(),
      expectedExchange:z.string().regex(/^[A-Za-z0-9.\-]{1,32}$/).optional(),
    },annotations:readOnly,
  },async({symbol,expectedCurrency,expectedExchange})=>{try{
    const value=await services.quote.quote(symbol,expectedCurrency,expectedExchange);
    return result(value,`${value.symbol}: ${value.price} ${value.currency} at ${value.quoteAsOf??"unknown time"} (${value.provider}, stale=${value.isStale}). Research only.`);
  }catch(e){return failure(e);}});
}
