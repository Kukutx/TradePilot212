import { jwtVerify, SignJWT } from "jose";
import type { Context, Hono } from "hono";
import type { Configuration } from "../infra/config.js";
import type { StateStore } from "../infra/state.js";
import { lookupClient } from "./client-metadata.js";

const scopes = new Set(["portfolio:read", "monitor:write", "offline_access"]);
const encoder = new TextEncoder();
const codeKey = (value: string) => `v3:code:${value}`;
const refreshKey = (value: string) => `v3:refresh:${value}`;
const signKey = (config: Configuration) => encoder.encode(config.jwtSecret);
const resource = (config: Configuration) => `${config.publicOrigin}/mcp`;
type Code = { clientId: string; redirectUri: string; challenge: string; scope: string; expiresAt: number };
type Refresh = { clientId: string; scope: string };

function random(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}
function parseScopes(value: string): string {
  const list = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (!list.includes("portfolio:read") || list.some(scope => !scopes.has(scope)))
    throw new Error("Invalid requested OAuth scope");
  return list.join(" ");
}
function safe(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}
async function safeEqual(a: string,b: string): Promise<boolean> {
  const [left,right] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)),crypto.subtle.digest("SHA-256",encoder.encode(b))]);
  const aa = new Uint8Array(left), bb = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
async function sha256Base64url(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  let s = "";for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
async function issue(config: Configuration, kind: "access"|"refresh", clientId: string, scope: string, jti: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind, client_id:clientId, scope })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(config.publicOrigin)
    .setAudience(kind === "access" ? resource(config) : `${config.publicOrigin}/oauth/token`)
    .setSubject("owner").setIssuedAt(now).setExpirationTime(now + (kind === "access" ? 1800 : 14 * 86400))
    .setJti(jti).sign(signKey(config));
}
async function createRefresh(config: Configuration, store: StateStore, clientId: string, scope: string) {
  const jti = random(), token = await issue(config,"refresh",clientId,scope,jti);
  await store.put(refreshKey(jti), { clientId, scope } satisfies Refresh, Date.now()+14*86400_000);
  return token;
}
async function validateJwt(config: Configuration, token: string, kind: "access"|"refresh") {
  const checked = await jwtVerify(token, signKey(config), {
    algorithms:["HS256"],issuer:config.publicOrigin,
    audience:kind === "access" ? resource(config) : `${config.publicOrigin}/oauth/token`,
  });
  const value = checked.payload;
  if (value.kind !== kind || value.sub !== "owner" ||
      typeof value.client_id !== "string" || typeof value.scope !== "string" || typeof value.jti !== "string")
    throw new Error("Invalid OAuth JWT claims");
  return { clientId:value.client_id,scope:value.scope,jti:value.jti };
}
async function fields(c: Context): Promise<URLSearchParams> {
  const contentType=c.req.header("content-type")??"";
  if (!contentType.includes("application/x-www-form-urlencoded")) throw new Error("Form body required");
  if (Number(c.req.header("content-length") || 0)>16_384) throw new Error("Form too large");
  const value=await c.req.text();
  if (value.length>16_384) throw new Error("Form too large");
  return new URLSearchParams(value);
}
async function validateAuthorization(
  query: URLSearchParams, config: Configuration, store: StateStore, fetcher: typeof fetch,
) {
  const clientId=query.get("client_id") || "";
  const client=await lookupClient(clientId,config,store,fetcher);
  const redirectUri=query.get("redirect_uri") || "";
  const challenge=query.get("code_challenge") || "";
  if (!client.redirect_uris.includes(redirectUri) || query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      (query.get("resource") || "") !== resource(config))
    throw new Error("OAuth redirect, PKCE or resource mismatch");
  const scope=parseScopes(query.get("scope") || "portfolio:read");
  return { clientId,redirectUri,challenge,scope,clientName:client.client_name || "AI client",state:query.get("state")||"" };
}
export function installOAuth(
  app: Hono, config: Configuration, store: StateStore, fetcher: typeof fetch = fetch,
): void {
  const metadata={resource:resource(config),authorization_servers:[config.publicOrigin],bearer_methods_supported:["header"],scopes_supported:["portfolio:read","monitor:write"]};
  app.get("/.well-known/oauth-protected-resource",c=>c.json(metadata));
  app.get("/.well-known/oauth-protected-resource/mcp",c=>c.json(metadata));
  app.get("/.well-known/oauth-authorization-server",c=>c.json({
    issuer:config.publicOrigin,
    authorization_endpoint:`${config.publicOrigin}/oauth/authorize`,
    token_endpoint:`${config.publicOrigin}/oauth/token`,
    response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],
    token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],
    scopes_supported:[...scopes],client_id_metadata_document_supported:true,
    authorization_response_iss_parameter_supported:true,
  }));
  app.get("/oauth/authorize",async c=>{
    try{
      const query=new URL(c.req.url).searchParams;
      const info=await validateAuthorization(query,config,store,fetcher);
      const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>TradePilot Insight access</title><style>body{font:16px system-ui;max-width:450px;margin:10vh auto;padding:20px;background:#101827;color:#f8fafc}input,button{display:block;width:100%;box-sizing:border-box;padding:14px;margin-top:12px;border-radius:10px}button{background:#57c7af;border:0;font-weight:700}small{color:#94a3b8}</style></head><body><h1>Authorize TradePilot Insight</h1><p>${safe(info.clientName)} requests <strong>${safe(info.scope)}</strong>.</p><p>Trading 212 access is read-only. The plugin cannot place or cancel trades.</p><form method="post" action="/oauth/authorize">${[...query.entries()].map(([key,value])=>`<input type="hidden" name="${safe(key)}" value="${safe(value)}">`).join("")}<label>Owner password <input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Authorize</button></form><small>Credentials are checked only by your self-hosted server. Never enter brokerage API keys here.</small></body></html>`;
      c.header("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      c.header("Cache-Control","no-store");
      return c.html(html);
    }catch {return c.json({error:"invalid_request"},400);}
  });
  app.post("/oauth/authorize",async c=>{
    try{
      const body=await fields(c);
      const attempts=await store.increment("v3:rate:owner-password",600_000);
      if(attempts>10)return c.json({error:"temporarily_unavailable"},429);
      const info=await validateAuthorization(body,config,store,fetcher);
      if(!(await safeEqual(body.get("password")||"",config.ownerPassword)))
        return c.json({error:"access_denied"},401);
      await store.remove("v3:rate:owner-password");
      const code=random(),record:Code={clientId:info.clientId,redirectUri:info.redirectUri,challenge:info.challenge,scope:info.scope,expiresAt:Date.now()+300_000};
      await store.put(codeKey(code),record,record.expiresAt);
      const redirect=new URL(info.redirectUri);
      redirect.searchParams.set("code",code);
      redirect.searchParams.set("iss",config.publicOrigin);
      if(info.state)redirect.searchParams.set("state",info.state);
      c.header("Cache-Control","no-store");
      return c.redirect(redirect.toString(),302);
    }catch{return c.json({error:"invalid_request"},400);}
  });
  app.post("/oauth/token",async c=>{
    try{
      const b=await fields(c),grant=b.get("grant_type"),clientId=b.get("client_id")||"";
      if(grant==="authorization_code"){
        const record=await store.take<Code>(codeKey(b.get("code")||""));
        if(!record || clientId!==record.clientId || b.get("redirect_uri")!==record.redirectUri ||
           b.get("resource")!==resource(config) ||
           !(await safeEqual(await sha256Base64url(b.get("code_verifier")||""),record.challenge)))
          return c.json({error:"invalid_grant"},400);
        const access=await issue(config,"access",clientId,record.scope,random());
        const refresh=record.scope.includes("offline_access") ? await createRefresh(config,store,clientId,record.scope) : undefined;
        c.header("Cache-Control","no-store");
        return c.json({access_token:access,token_type:"Bearer",expires_in:1800,scope:record.scope,...(refresh?{refresh_token:refresh}:{})});
      }
      if(grant==="refresh_token"){
        const previous=await validateJwt(config,b.get("refresh_token")||"","refresh");
        if(previous.clientId!==clientId)return c.json({error:"invalid_grant"},400);
        const requested=b.get("scope")?parseScopes(b.get("scope")!):previous.scope;
        if(!requested.split(" ").every(x=>previous.scope.split(" ").includes(x)))
          return c.json({error:"invalid_scope"},400);
        const redeemed=await store.take<Refresh>(refreshKey(previous.jti));
        if(!redeemed || redeemed.clientId!==clientId)return c.json({error:"invalid_grant"},400);
        const refresh=await createRefresh(config,store,clientId,requested);
        const access=await issue(config,"access",clientId,requested,random());
        c.header("Cache-Control","no-store");
        return c.json({access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:1800,scope:requested});
      }
      return c.json({error:"unsupported_grant_type"},400);
    }catch{return c.json({error:"invalid_grant"},400);}
  });
}
export async function authenticateBearer(auth: string | undefined,config: Configuration): Promise<Set<string> | null> {
  const token=/^Bearer (.+)$/i.exec(auth||"")?.[1];
  if(!token)return null;
  try{
    const claim=await validateJwt(config,token,"access");
    const checked=parseScopes(claim.scope);
    return new Set(checked.split(" "));
  }catch{return null;}
}
