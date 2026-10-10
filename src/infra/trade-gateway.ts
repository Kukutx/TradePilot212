import { z } from "zod";
import type { Environment } from "../domain/types.js";
import type { Instrument, PendingOrder, TradeDraft } from "../domain/trading.js";
import type { Configuration } from "./config.js";

export class BrokerOperationUnknown extends Error {
  constructor(message:string) { super(message); this.name="BrokerOperationUnknown"; }
}
export class BrokerKnownRejection extends Error {
  constructor(readonly status:number) {super(`Trading 212 rejected the request (HTTP ${status}).`);this.name="BrokerKnownRejection";}
}
export interface BrokerTradePort {
  getInstruments(environment:Environment):Promise<Instrument[]>;
  getPendingOrders(environment:Environment):Promise<PendingOrder[]>;
  getOrder(environment:Environment,id:string):Promise<PendingOrder>;
  placeOrder(draft:TradeDraft):Promise<{orderId?:string}>;
  cancelOrder(environment:Environment,id:string):Promise<{orderId:string}>;
}
const instrumentSchema=z.object({
  ticker:z.string().min(1),name:z.string().min(1),
  shortName:z.string().optional(),currencyCode:z.string().regex(/^[A-Z]{3}$/),
  type:z.string().optional(),extendedHours:z.boolean().optional(),
  maxOpenQuantity:z.number().finite().nonnegative().optional(),
});
const instrumentList=z.union([z.array(instrumentSchema),z.object({items:z.array(instrumentSchema)})]);
const rawOrder=z.object({
  id:z.union([z.number().int().nonnegative(),z.string().min(1)]),
  ticker:z.string().optional(),
  instrument:z.object({ticker:z.string().min(1)}).optional(),
  quantity:z.number().finite().optional(),
  side:z.string().optional(),
  type:z.string().optional(),
  status:z.string().optional(),
  createdAt:z.string().optional(),
});
const orderList=z.union([z.array(rawOrder),z.object({items:z.array(rawOrder)})]);
function normalizeOrder(value:z.infer<typeof rawOrder>):PendingOrder{
  return {id:String(value.id),ticker:value.ticker||value.instrument?.ticker||"",
    quantity:value.quantity??0,
    ...(value.side?{side:value.side}:{}),
    ...(value.type?{type:value.type}:{}),
    ...(value.status?{status:value.status}:{}),
    ...(value.createdAt?{createdAt:value.createdAt}:{})};
}
function basic(value:string):string{
  let encoded="";for(const ch of new TextEncoder().encode(value))encoded+=String.fromCharCode(ch);
  return btoa(encoded);
}
async function responseJson(response:Response,maxBytes=8*1024*1024):Promise<unknown>{
  if(response.status===204)return null;
  const announced=Number(response.headers.get("content-length")||0);
  if(announced>maxBytes)throw new Error("Broker response exceeds the size limit");
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>maxBytes)throw new Error("Broker response exceeds the size limit");
      chunks.push(part.value);
    }
  }finally{
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
  const content=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.byteLength;}
  if(!content.length)return null;
  return JSON.parse(new TextDecoder().decode(content)) as unknown;
}
function assertOrderId(id:string):void {
  if(!/^\d{1,20}$/.test(id))throw new Error("Invalid broker order ID");
}
export class Trading212TradeGateway implements BrokerTradePort {
  constructor(readonly config:Configuration,private readonly fetcher:typeof fetch=fetch){}
  private async request(
    environment:Environment,method:"GET"|"POST"|"DELETE",path:string,body?:unknown,
  ):Promise<unknown>{
    const creds=this.config.broker[environment];
    if(!creds.key||!creds.secret)throw new Error(`${environment.toUpperCase()} broker credentials missing`);
    const url=`${creds.origin}/api/v0/equity/${path}`;
    const options:RequestInit={
      method,redirect:"error",headers:{
        Authorization:`Basic ${basic(creds.key+":"+creds.secret)}`,
        Accept:"application/json",
        ...(body===undefined?{}:{"Content-Type":"application/json"}),
      },...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(15_000),
    };
    const tries=method==="GET"?3:1;
    for(let i=1;i<=tries;i++){
      let response:Response;
      try{response=await this.fetcher(url,options);}
      catch {
        if(method!=="GET")throw new BrokerOperationUnknown("Broker write response was lost. Do not retry automatically.");
        if(i===tries)throw new Error("Trading 212 read failed after retries");
        await new Promise(r=>setTimeout(r,250*i));continue;
      }
      // For write requests HTTP 4xx is a known rejection even if its error
      // body is plain text or malformed JSON. HTTP 408/5xx remain ambiguous.
      if(method!=="GET" && !response.ok){
        if(response.status===408||response.status>=500)
          throw new BrokerOperationUnknown(`Broker write returned ${response.status}. Execution status is unknown.`);
        throw new BrokerKnownRejection(response.status);
      }
      let parsed:unknown;
      try{parsed=await responseJson(response,method==="GET"?8*1024*1024:256*1024);}
      catch{
        if(method!=="GET")throw new BrokerOperationUnknown("Broker write response was unreadable. Check current orders before retrying.");
        if(i===tries)throw new Error("Trading 212 returned an unreadable GET response");
        await new Promise(r=>setTimeout(r,250*i));continue;
      }
      if(response.ok)return parsed;
      if(method!=="GET"){
        if(response.status===408||response.status>=500)
          throw new BrokerOperationUnknown(`Broker write returned ${response.status}. Execution status is unknown.`);
        throw new BrokerKnownRejection(response.status);
      }
      if([408,429,500,502,503,504].includes(response.status)&&i<tries){
        const delay=Number(response.headers.get("retry-after")||0);
        await new Promise(r=>setTimeout(r,Number.isFinite(delay)&&delay>0?Math.min(delay*1000,5000):300*i));
        continue;
      }
      if(method==="GET" && response.status===404)throw new BrokerKnownRejection(404);
      throw new Error(`Trading 212 GET failed (HTTP ${response.status}).`);
    }
    throw new Error("Unexpected broker request state");
  }
  async getInstruments(environment:Environment){
    const value=instrumentList.parse(await this.request(environment,"GET","metadata/instruments"));
    const list=Array.isArray(value)?value:value.items;
    return list.map(item=>({...item,shortName:item.shortName||item.ticker}));
  }
  async getPendingOrders(environment:Environment){
    const value=orderList.parse(await this.request(environment,"GET","orders"));
    return (Array.isArray(value)?value:value.items).map(normalizeOrder);
  }
  async getOrder(environment:Environment,id:string){
    assertOrderId(id);
    return normalizeOrder(rawOrder.parse(await this.request(environment,"GET",`orders/${id}`)));
  }
  async placeOrder(draft:TradeDraft){
    const qty=draft.side==="buy"?draft.quantity:-draft.quantity;
    let path:string;let body:Record<string,unknown>={ticker:draft.ticker,quantity:qty};
    if(draft.type==="market"){
      path="orders/market";
      if(draft.extendedHours!==undefined)body.extendedHours=draft.extendedHours;
    }else{
      path=draft.type==="stop_limit"?"orders/stop_limit":`orders/${draft.type}`;
      body.timeValidity=draft.timeValidity||"DAY";
      if(draft.type==="limit"||draft.type==="stop_limit")body.limitPrice=draft.limitPrice;
      if(draft.type==="stop"||draft.type==="stop_limit")body.stopPrice=draft.stopPrice;
    }
    const response=await this.request(draft.environment,"POST",path,body);
    const id=response&&typeof response==="object"?
      (response as Record<string,unknown>).id:undefined;
    return id===undefined?{}:{orderId:String(id)};
  }
  async cancelOrder(environment:Environment,id:string){
    assertOrderId(id);
    await this.request(environment,"DELETE",`orders/${id}`);
    return {orderId:id};
  }
}
