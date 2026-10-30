import { DurableObject } from "cloudflare:workers";
import { createApp } from "../../app/create-app.js";
import { createServices, type Services } from "../../app/services.js";
import { createConfig, type RuntimeEnv } from "../../core/config.js";
import type { StateStore } from "../../core/state-store.js";
import type { InstrumentCache } from "../../core/trading-service.js";
import { shareReadsOnTheirWay } from "../../core/trading212-client.js";

type Row = { key: string; value: string; expires_at: number | null };
type WorkerEnv = RuntimeEnv & {
  ASSETS: Fetcher;
  TRADEPILOT_STATE: DurableObjectNamespace<TradePilotState>;
};
const instrumentCache: InstrumentCache = new Map();
// A request's fetch is cancelled once it has answered, so another request must not wait on it: share answers only.
shareReadsOnTheirWay(false);
export class TradePilotState extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) { super(ctx,env); ctx.blockConcurrencyWhile(async () => { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER); CREATE INDEX IF NOT EXISTS state_expiry ON state(expires_at)"); }); }
  put(key: string, value: unknown, expiresAt?: number): void { this.ctx.storage.sql.exec("INSERT INTO state(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",key,JSON.stringify(value),expiresAt ?? null); }
  get(key: string): unknown { const row = this.ctx.storage.sql.exec<Row>("SELECT key,value,expires_at FROM state WHERE key=?",key).toArray()[0]; if (!row) return undefined; if (row.expires_at !== null && row.expires_at <= Date.now()) { this.ctx.storage.sql.exec("DELETE FROM state WHERE key=?",key); return undefined; } return JSON.parse(row.value) as unknown; }
  consume(key: string): unknown { const row = this.ctx.storage.sql.exec<Row>("DELETE FROM state WHERE key=? AND (expires_at IS NULL OR expires_at>?) RETURNING key,value,expires_at",key,Date.now()).toArray()[0]; return row ? JSON.parse(row.value) as unknown : undefined; }
  delete(key: string): void { this.ctx.storage.sql.exec("DELETE FROM state WHERE key=?",key); }
  list(prefix: string): Array<{key:string;value:unknown}> { this.ctx.storage.sql.exec("DELETE FROM state WHERE expires_at IS NOT NULL AND expires_at<=?",Date.now()); return this.ctx.storage.sql.exec<Row>("SELECT key,value,expires_at FROM state WHERE key LIKE ?",`${prefix}%`).toArray().map((r) => ({key:r.key,value:JSON.parse(r.value) as unknown})); }
  increment(key: string, windowMs: number, now: number): {count:number;retryAfterSeconds:number} { this.ctx.storage.sql.exec("DELETE FROM state WHERE key=? AND expires_at<=?",key,now); const existing = this.ctx.storage.sql.exec<Row>("SELECT key,value,expires_at FROM state WHERE key=?",key).toArray()[0], count = existing ? Number(JSON.parse(existing.value))+1 : 1, expiresAt = existing?.expires_at ?? now+windowMs; this.put(key,count,expiresAt); return {count,retryAfterSeconds:Math.max(1,Math.ceil((expiresAt-now)/1000))}; }
}
/** Gets a fresh stub per call, so one store can serve every request in the isolate. */
class DurableStateStore implements StateStore {
  constructor(private readonly env: WorkerEnv) {}
  private get stub() { return this.env.TRADEPILOT_STATE.getByName("global"); }
  put<T>(k:string,v:T,e?:number){return this.stub.put(k,v,e)} get<T>(k:string){return this.stub.get(k) as Promise<T|undefined>} consume<T>(k:string){return this.stub.consume(k) as Promise<T|undefined>} delete(k:string){return this.stub.delete(k)} list<T>(p:string){return this.stub.list(p) as Promise<Array<{key:string;value:T}>>} increment(k:string,w:number,n=Date.now()){return this.stub.increment(k,w,n)}
}
// Built once per isolate (and per public origin), so instrument, exchange, FX and quote caches
// survive between requests instead of being rebuilt for every MCP call.
// Keyed by the env object too, so changed bindings or secrets never reuse an old configuration.
const appsByEnv = new WeakMap<WorkerEnv, Map<string, ReturnType<typeof createApp>>>();
let scheduler: { env: WorkerEnv; services: Services } | undefined;
function appFor(env: WorkerEnv, origin: string) {
  let apps = appsByEnv.get(env);
  if (!apps) appsByEnv.set(env, apps = new Map());
  let app = apps.get(origin);
  if (!app) {
    if (apps.size >= 8) apps.clear();
    app = createApp({ config: createConfig(env, origin), store: new DurableStateStore(env), instrumentCache, widgetHtml: async () => { const response = await env.ASSETS.fetch(new Request(`${origin}/index.html`)); if (!response.ok) throw new Error("Widget asset unavailable"); return response.text(); } });
    apps.set(origin, app);
  }
  return app;
}
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return appFor(env, new URL(request.url).origin).fetch(request, env);
  },
  // Cron Trigger (wrangler.jsonc): settle protective pairs, announce due plans, run Demo autoExecute plans when enabled, and check price alerts.
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    if (scheduler?.env !== env) scheduler = { env, services: createServices({ config: createConfig(env), store: new DurableStateStore(env), instrumentCache }) };
    const { links, plans, alerts } = await scheduler.services.runScheduled();
    const acted = links.filter((report) => report.action !== "waiting");
    const fired = alerts.filter((report) => report.action === "triggered");
    if (acted.length || plans.length || fired.length) console.log(JSON.stringify({ message: "TradePilot scheduler tick", links: acted, plans: plans.map(({ result: _result, ...report }) => report), alerts: fired }));
  },
} satisfies ExportedHandler<WorkerEnv>;
