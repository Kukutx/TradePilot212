import { jwtVerify, SignJWT } from "jose";
import type { Context, Hono } from "hono";
import type { RuntimeConfig } from "./config.js";
import { assertAuthConfigured } from "./config.js";
import type { StateStore } from "./state-store.js";
import { randomToken, safeEqual, sha256Base64Url } from "./web-utils.js";
import { oauthPageCopy, renderOAuthMessagePage, renderOAuthPage, resolveOAuthLocale } from "./oauth-page.js";

export interface RegisteredClient { client_id: string; redirect_uris: string[]; client_name?: string; token_endpoint_auth_method: "none"; grant_types: Array<"authorization_code" | "refresh_token">; response_types: ["code"]; created_at: number }
interface AuthorizationCode { clientId: string; redirectUri: string; codeChallenge: string; resource: string; scope: string; expiresAt: number }
export type OAuthVariables = { oauthScopes: Set<string>; oauthClientId: string };
const scopes = ["trade:read", "trade:write", "offline_access"] as const;
const string = (source: Record<string, unknown>, key: string) => typeof source[key] === "string" ? source[key] as string : "";
const resource = (config: RuntimeConfig) => `${config.publicBaseUrl}/mcp`;
const key = (config: RuntimeConfig) => new TextEncoder().encode(config.signingSecret);
function normalizeScope(value: string) { const normalized = [...new Set(value.split(/\s+/).filter(Boolean))].join(" "); const list = normalized.split(" ").filter(Boolean); if (!list.length || !list.includes("trade:read") || !list.every((x) => scopes.includes(x as typeof scopes[number]))) throw new Error("Unsupported OAuth scope"); return normalized; }
function validRedirect(value: string) { try { const u = new URL(value); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(u.hostname)); } catch { return false; } }
function escape(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
async function issue(config: RuntimeConfig, scope: string, clientId: string, use: "access" | "refresh") { return new SignJWT({ scope, token_use: use, client_id: clientId }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(config.publicBaseUrl).setAudience(use === "access" ? resource(config) : `${config.publicBaseUrl}/oauth/token`).setSubject("tradepilot-owner").setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + (use === "access" ? config.accessTokenTtlSeconds : config.refreshTokenTtlSeconds)).setJti(crypto.randomUUID()).sign(key(config)); }
async function verify(config: RuntimeConfig, token: string, use: "access" | "refresh") { const result = await jwtVerify(token, key(config), { issuer: config.publicBaseUrl, audience: use === "access" ? resource(config) : `${config.publicBaseUrl}/oauth/token`, algorithms: ["HS256"] }); if (result.payload.token_use !== use) throw new Error("Invalid token type"); const scope = typeof result.payload.scope === "string" ? result.payload.scope : "", clientId = typeof result.payload.client_id === "string" ? result.payload.client_id : ""; if (!scope || !clientId) throw new Error("Invalid token claims"); return { scope, clientId }; }
async function bodyRecord(c: Context): Promise<Record<string, unknown>> { const length = Number(c.req.header("content-length") ?? 0); if (length > 65_536) throw new Error("Request body too large"); const type = c.req.header("content-type") ?? ""; if (type.includes("application/json")) return await c.req.json<Record<string, unknown>>(); const parsed = await c.req.parseBody(); return parsed as Record<string, unknown>; }

export function installOAuth(app: Hono<{ Variables: OAuthVariables }>, config: RuntimeConfig, store: StateStore): void {
  assertAuthConfigured(config);
  const metadata = { resource: resource(config), authorization_servers: [config.publicBaseUrl], bearer_methods_supported: ["header"], scopes_supported: ["trade:read", "trade:write"] };
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata)); app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(metadata));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json({ issuer: config.publicBaseUrl, authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`, token_endpoint: `${config.publicBaseUrl}/oauth/token`, registration_endpoint: `${config.publicBaseUrl}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: scopes }));
  app.post("/oauth/register", async (c) => { try { const rate = await store.increment("rate:register", 60_000); if (rate.count > 30) { c.header("Retry-After", String(rate.retryAfterSeconds)); return c.json({ error: "temporarily_unavailable" }, 429); } const body = await bodyRecord(c), redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((x): x is string => typeof x === "string") : []; if (!redirectUris.length || redirectUris.length > 20 || redirectUris.some((x) => !validRedirect(x))) return c.json({ error: "invalid_redirect_uri" }, 400); if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") return c.json({ error: "invalid_client_metadata" }, 400); const requested = Array.isArray(body.grant_types) ? body.grant_types.filter((x): x is string => typeof x === "string") : []; if (requested.some((x) => !["authorization_code", "refresh_token"].includes(x))) return c.json({ error: "invalid_client_metadata" }, 400); const grantTypes = [...new Set(requested.length ? requested : ["authorization_code", "refresh_token"])] as Array<"authorization_code" | "refresh_token">; if (!grantTypes.includes("authorization_code")) grantTypes.unshift("authorization_code"); const client: RegisteredClient = { client_id: `tp_${randomToken(24)}`, redirect_uris: [...new Set(redirectUris)], ...(typeof body.client_name === "string" ? { client_name: body.client_name.slice(0, 200) } : {}), token_endpoint_auth_method: "none", grant_types: grantTypes, response_types: ["code"], created_at: Math.floor(Date.now() / 1000) }; const existing = await store.list<RegisteredClient>("client:"); if (existing.length >= 200) for (const old of existing.sort((a,b) => a.value.created_at - b.value.created_at).slice(0, 50)) await store.delete(old.key); await store.put(`client:${client.client_id}`, client); return c.json({ ...client, client_id_issued_at: client.created_at }, 201); } catch (error) { return c.json({ error: "invalid_client_metadata", error_description: error instanceof Error ? error.message : String(error) }, 400); } });
  async function params(source: Record<string, unknown>) { const clientId = string(source, "client_id"), client = await store.get<RegisteredClient>(`client:${clientId}`), redirectUri = string(source, "redirect_uri"), codeChallenge = string(source, "code_challenge"), requestedResource = string(source, "resource") || resource(config); if (!client) throw new Error("Unknown OAuth client"); if (!client.redirect_uris.includes(redirectUri)) throw new Error("redirect_uri is not registered"); if (string(source, "response_type") !== "code" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || string(source, "code_challenge_method") !== "S256") throw new Error("PKCE S256 is required"); if (requestedResource !== resource(config)) throw new Error("Invalid OAuth resource"); return { client, clientId, redirectUri, codeChallenge, resource: requestedResource, state: string(source, "state"), scope: normalizeScope(string(source, "scope") || "trade:read trade:write offline_access") }; }
  app.get("/oauth/authorize", async (c) => {
    try {
      const query = Object.fromEntries(new URL(c.req.url).searchParams);
      const p = await params(query);
      const locale = resolveOAuthLocale(string(query, "ui_locales") || c.req.header("accept-language"));
      const hidden = [
        "client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method",
        "state", "resource", "scope", "ui_locales",
      ]
        .map((name) => string(query, name) ? '<input type="hidden" name="' + name + '" value="' + escape(string(query, name)) + '">' : "")
        .join("");
      const zhUrl = new URL(c.req.url);
      zhUrl.searchParams.set("ui_locales", "zh-CN");
      const enUrl = new URL(c.req.url);
      enUrl.searchParams.set("ui_locales", "en");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'");
      c.header("Cache-Control", "no-store");
      return c.html(renderOAuthPage({
        locale,
        clientName: p.client.client_name ?? "ChatGPT",
        hiddenHtml: hidden,
        zhUrl: zhUrl.toString(),
        enUrl: enUrl.toString(),
      }));
    } catch (error) {
      return c.json({ error: "invalid_request", error_description: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post("/oauth/authorize", async (c) => {
    try {
      const body = await bodyRecord(c);
      const locale = resolveOAuthLocale(string(body, "ui_locales") || c.req.header("accept-language"));
      const copy = oauthPageCopy(locale);
      const rate = await store.increment("rate:login", 10 * 60_000);
      if (rate.count > 8) {
        c.header("Retry-After", String(rate.retryAfterSeconds));
        return c.html(renderOAuthMessagePage(locale, copy.tooManyTitle, copy.tryLater), 429);
      }
      const p = await params(body);
      if (!(await safeEqual(string(body, "password"), config.loginPassword))) {
        return c.html(renderOAuthMessagePage(locale, copy.deniedTitle, copy.invalidCredential), 401);
      }
      await store.delete("rate:login");
      const code = randomToken();
      const record: AuthorizationCode = {
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        codeChallenge: p.codeChallenge,
        resource: p.resource,
        scope: p.scope,
        expiresAt: Date.now() + 300_000,
      };
      await store.put("code:" + code, record, record.expiresAt);
      const redirect = new URL(p.redirectUri);
      redirect.searchParams.set("code", code);
      if (p.state) redirect.searchParams.set("state", p.state);
      return c.redirect(redirect.toString(), 302);
    } catch (error) {
      return c.json({ error: "invalid_request", error_description: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.post("/oauth/token", async (c) => { try { const body = await bodyRecord(c), grant = string(body,"grant_type"); if (grant === "authorization_code") { const record = await store.consume<AuthorizationCode>(`code:${string(body,"code")}`); if (!record) return c.json({ error: "invalid_grant" }, 400); const challenge = await sha256Base64Url(string(body,"code_verifier")), clientId = string(body,"client_id"); if (clientId !== record.clientId || string(body,"redirect_uri") !== record.redirectUri || (string(body,"resource") || record.resource) !== record.resource || !(await safeEqual(challenge,record.codeChallenge))) return c.json({ error: "invalid_grant" }, 400); const access = await issue(config,record.scope,clientId,"access"), refresh = record.scope.split(/\s+/).includes("offline_access") ? await issue(config,record.scope,clientId,"refresh") : undefined; return c.json({ access_token: access, token_type: "Bearer", expires_in: config.accessTokenTtlSeconds, scope: record.scope, ...(refresh ? { refresh_token: refresh } : {}) }); } if (grant === "refresh_token") { const v = await verify(config,string(body,"refresh_token"),"refresh"), clientId = string(body,"client_id"); if (clientId !== v.clientId || !(await store.get(`client:${clientId}`))) return c.json({ error: "invalid_grant" },400); const next = string(body,"scope") ? normalizeScope(string(body,"scope")) : v.scope, original = new Set(v.scope.split(/\s+/)); if (!next.split(/\s+/).every((x) => original.has(x))) return c.json({ error: "invalid_scope" },400); return c.json({ access_token: await issue(config,next,clientId,"access"), refresh_token: await issue(config,next,clientId,"refresh"), token_type: "Bearer", expires_in: config.accessTokenTtlSeconds, scope: next }); } return c.json({ error: "unsupported_grant_type" },400); } catch { return c.json({ error: "invalid_grant" },400); } });
}

export async function bearer(c: Context<{ Variables: OAuthVariables }>, config: RuntimeConfig, next: () => Promise<void>) { const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? ""); if (!match?.[1]) { c.header("WWW-Authenticate", `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="trade:read trade:write"`); return c.json({ error: "unauthorized", error_description: "Bearer token required" },401); } try { const v = await verify(config,match[1],"access"), set = new Set(v.scope.split(/\s+/)); if (!set.has("trade:read")) return c.json({ error: "insufficient_scope" },403); c.set("oauthScopes",set); c.set("oauthClientId",v.clientId); await next(); } catch { c.header("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`); return c.json({ error: "invalid_token" },401); } }
