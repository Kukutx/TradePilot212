import { DurableObject } from "cloudflare:workers";
import type { Stored, StateStore } from "../infra/state.js";
import type { RuntimeEnv } from "../infra/config.js";
import { readConfiguration } from "../infra/config.js";
import { Trading212Reader } from "../infra/broker.js";
import { BrokerPacer } from "../infra/broker-pacer.js";
import { IntelligenceService } from "../server/intelligence.js";
import { createHttpApp } from "../server/http.js";

interface WorkerEnv extends RuntimeEnv {
  ASSETS: Fetcher;
  INSIGHT_STORE: DurableObjectNamespace<InsightStore>;
}
export class InsightStore extends DurableObject<WorkerEnv> {
  async get<T>(key:string):Promise<T|undefined> {
    const value=await this.ctx.storage.get<Stored<T>>(key);
    if(!value)return undefined;
    if(value.expiresAt && value.expiresAt<=Date.now()){
      await this.ctx.storage.delete(key);return undefined;
    }
    return value.value;
  }
  async put<T>(key:string,value:T,expiresAt?:number) {
    await this.ctx.storage.put(key,{value,...(expiresAt?{expiresAt}:{})});
  }
  async take<T>(key:string):Promise<T|undefined>{
    return this.ctx.storage.transaction(async transaction=>{
      const value=await transaction.get<Stored<T>>(key);
      if(value)await transaction.delete(key);
      return value && (!value.expiresAt || value.expiresAt>Date.now()) ? value.value:undefined;
    });
  }
  async remove(key:string) {await this.ctx.storage.delete(key);}
  async list<T>(prefix:string):Promise<Array<{key:string;value:T}>>{
    const values=await this.ctx.storage.list<Stored<T>>({prefix});
    const result:Array<{key:string;value:T}>=[];
    for(const [key,item] of values){
      if(item.expiresAt && item.expiresAt<=Date.now()){await this.ctx.storage.delete(key);continue;}
      result.push({key,value:item.value});
    }
    return result;
  }
  async reserve(key:string,spacingMs:number,nowMs:number,maxWaitMs:number):Promise<number|null>{
    return this.ctx.storage.transaction(async transaction=>{
      if(!Number.isFinite(nowMs)||!Number.isFinite(spacingMs)||spacingMs<=0||maxWaitMs<0)
        throw new Error("Invalid broker reservation");
      const previous=await transaction.get<Stored<number>>(key);
      const next=previous && (!previous.expiresAt||previous.expiresAt>nowMs)?previous.value:nowMs;
      const allocatedAt=Math.max(nowMs,next);
      if(allocatedAt-nowMs>maxWaitMs)return null;
      await transaction.put(key,{value:allocatedAt+spacingMs,expiresAt:allocatedAt+spacingMs+60_000});
      return allocatedAt;
    });
  }
  async increment(key:string,durationMs:number):Promise<number>{
    return this.ctx.storage.transaction(async transaction=>{
      const stored=await transaction.get<Stored<number>>(key);
      const valid=stored && (!stored.expiresAt||stored.expiresAt>Date.now());
      const count=valid?stored.value+1:1;
      await transaction.put(key,{value:count,expiresAt:valid?stored.expiresAt:Date.now()+durationMs});
      return count;
    });
  }
}
function state(env:WorkerEnv):StateStore{
  const stub=env.INSIGHT_STORE.getByName("owner");
  return {
    get:<T>(k:string)=>stub.get(k) as Promise<T|undefined>,
    put:<T>(k:string,v:T,e?:number)=>stub.put(k,v,e),
    take:<T>(k:string)=>stub.take(k) as Promise<T|undefined>,
    remove:(k:string)=>stub.remove(k),
    list:<T>(p:string)=>stub.list(p) as Promise<Array<{key:string;value:T}>>,
    increment:(k:string,d:number)=>stub.increment(k,d),
    reserve:(k:string,d:number,n:number,m:number)=>stub.reserve(k,d,n,m),
  };
}
export default {
  async fetch(request:Request,env:WorkerEnv):Promise<Response>{
    if(!env.PUBLIC_ORIGIN)throw new Error("Configure PUBLIC_ORIGIN as an explicit deployment URL");
    const requestOrigin=new URL(request.url);
    if(!["localhost","127.0.0.1","::1"].includes(requestOrigin.hostname) && !env.PUBLIC_ORIGIN.startsWith("https://"))
      throw new Error("Production PUBLIC_ORIGIN must use HTTPS");
    const config=readConfiguration(env);
    const url=new URL(request.url);
    const app=createHttpApp({
      config,state:state(env),
      widgetHtml:async()=>{
        const html=await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
        if(!html.ok)throw new Error("MCP App UI resource missing");
        return html.text();
      },
    });
    return app.fetch(request,env);
  },
  async scheduled(_event:ScheduledController,env:WorkerEnv):Promise<void>{
    if(!env.PUBLIC_ORIGIN)throw new Error("Configure PUBLIC_ORIGIN before enabling scheduled monitoring");
    const config=readConfiguration(env);
    if(config.source==="sample")return;
    const store=state(env);
    const svc=new IntelligenceService(config,store,new Trading212Reader(config,fetch,new BrokerPacer(store)));
    for(const environment of ["demo","live"] as const){
      if(!config.broker[environment].key)continue;
      try{
        if((await svc.listRules(environment)).length)await svc.scan(environment);
      }catch(error){
        console.error("Read-only monitor failed:",error instanceof Error?error.name:"unknown");
      }
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
