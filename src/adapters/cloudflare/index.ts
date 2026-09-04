import { DurableObject } from "cloudflare:workers";
import { createApp } from "../../app/create-app.js";
import { createConfig } from "../../core/config.js";
import type { StateStore } from "../../core/state-store.js";
import type { InstrumentCache } from "../../core/trading-service.js";

type Row = { key: string; value: string; expires_at: number | null };
const instrumentCache: InstrumentCache = new Map();
export class TradePilotState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx,env); ctx.blockConcurrencyWhile(async () => { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER); CREATE INDEX IF NOT EXISTS state_expiry ON state(expires_at)"); }); }
  put(key: string, value: unknown, expiresAt?: number): void { this.ctx.storage.sql.exec("INSERT INTO state(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",key,JSON.stringify(value),expiresAt ?? null); }
  get(key: string): unknown { const row = this.ctx.storage.sql.exec<Row>("SELECT key,value,expires_at FROM state WHERE key=?",key).toArray()[0]; if (!row) return undefined; if (row.expires_at !== null && row.expires_at <= Date.now()) { this.ctx.storage.sql.exec("DELETE FROM state WHERE key=?",key); return undefined; } return JSON.parse(row.value) as unknown; }
  consume(key: string): unknown { const row = this.ctx.storage.sql.exec<Row>("DELETE FROM state WHERE key=? AND (expires_at IS NULL OR expires_at>?) RETURNING key,value,expires_at",key,Date.now()).toArray()[0]; return row ? JSON.parse(row.value) as unknown : undefined; }
  delete(key: string): void { this.ctx.storage.sql.exec("DELETE FROM state WHERE key=?",key); }
  list(prefix: string): Array<{key:string;value:unknown}> { this.ctx.storage.sql.exec("DELETE FROM state WHERE expires_at IS NOT NULL AND expires_at<=?",Date.now()); return this.ctx.storage.sql.exec<Row>("SELECT key,value,expires_at FROM state WHERE key LIKE ?",`${prefix}%`).toArray().map((r) => ({key:r.key,value:JSON.parse(r.value) as unknown})); }
  increment(key: string, windowMs: number, now: number): {count:number;retryAfterSeconds:number} { this.ctx.storage.sql.exec("DELETE FROM state WHERE key=? AND expires_at<=?",key,now); const existing = this.ctx.storage.sql.exec<Row>("SELECT key,value,expires_at FROM state WHERE key=?",key).toArray()[0], count = existing ? Number(JSON.parse(existing.value))+1 : 1, expiresAt = existing?.expires_at ?? now+windowMs; this.put(key,count,expiresAt); return {count,retryAfterSeconds:Math.max(1,Math.ceil((expiresAt-now)/1000))}; }
}
class DurableStateStore implements StateStore {
  constructor(private readonly stub: DurableObjectStub<TradePilotState>) {}
  put<T>(k:string,v:T,e?:number){return this.stub.put(k,v,e)} get<T>(k:string){return this.stub.get(k) as Promise<T|undefined>} consume<T>(k:string){return this.stub.consume(k) as Promise<T|undefined>} delete(k:string){return this.stub.delete(k)} list<T>(p:string){return this.stub.list(p) as Promise<Array<{key:string;value:T}>>} increment(k:string,w:number,n=Date.now()){return this.stub.increment(k,w,n)}
}
export default { async fetch(request: Request, env: Env): Promise<Response> { const origin = new URL(request.url).origin, config = createConfig(env,origin), store = new DurableStateStore(env.TRADEPILOT_STATE.getByName("global")); const app = createApp({config,store,instrumentCache,widgetHtml:async()=>{const response=await env.ASSETS.fetch(new Request(`${origin}/index.html`)); if(!response.ok) throw new Error("Widget asset unavailable"); return response.text();}}); return app.fetch(request,env); } } satisfies ExportedHandler<Env>;
