import { jwtVerify, SignJWT } from "jose";
import type { Context, Hono } from "hono";
import type { RuntimeConfig } from "./config.js";
import { assertAuthConfigured, isLoopbackHost } from "./config.js";
import type { StateStore } from "./state-store.js";
import { randomToken, safeEqual, sha256Base64Url } from "./web-utils.js";
import { oauthPageCopy, renderOAuthMessagePage, renderOAuthPage, resolveOAuthLocale } from "./oauth-page.js";

type GrantType = "authorization_code" | "refresh_token";
type TokenUse = "access" | "refresh";

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "none";
  grant_types: GrantType[];
  response_types: ["code"];
  created_at: number;
  last_used_at?: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

export type OAuthVariables = { oauthScopes: Set<string>; oauthClientId: string };

const scopes = ["trade:read", "trade:write", "offline_access"] as const;
const grantTypes: GrantType[] = ["authorization_code", "refresh_token"];
const DEFAULT_SCOPE = "trade:read trade:write offline_access";
const MAX_BODY_BYTES = 65_536;
const MAX_CLIENTS = 200;
const EVICT_BATCH = 50;
const REGISTER_RATE_LIMIT = 30;
const LOGIN_RATE_LIMIT = 8;
const CODE_TTL_MS = 300_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const string = (source: Record<string, unknown>, key: string) => typeof source[key] === "string" ? source[key] as string : "";
const strings = (value: unknown) => Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
const splitScope = (scope: string) => scope.split(/\s+/);
const resource = (config: RuntimeConfig) => `${config.publicBaseUrl}/mcp`;
const tokenAudience = (config: RuntimeConfig, use: TokenUse) => use === "access" ? resource(config) : `${config.publicBaseUrl}/oauth/token`;
const key = (config: RuntimeConfig) => new TextEncoder().encode(config.signingSecret);
const resourceMetadataUrl = (config: RuntimeConfig) => `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;

function normalizeScope(value: string) {
  const list = [...new Set(value.split(/\s+/).filter(Boolean))];
  const supported = list.every((x) => scopes.includes(x as typeof scopes[number]));
  if (!list.length || !list.includes("trade:read") || !supported) throw new Error("Unsupported OAuth scope");
  return list.join(" ");
}

/** `allowed` holds exact hosts, or ".example.com" for any subdomain of example.com. */
function hostMatches(hostname: string, allowed: string[]) {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => entry.startsWith(".") ? host.endsWith(entry) : host === entry);
}

/** Hosts of the chat apps TradePilot is built for; any other host gets a warning on the consent page. */
const KNOWN_CLIENT_HOSTS = [".chatgpt.com", "chatgpt.com", "chat.openai.com", ".claude.ai", "claude.ai", ".claude.com", "claude.com"];

/** HTTPS redirects (limited to OAUTH_REDIRECT_HOSTS when set), plus plain HTTP to loopback for local clients. */
function validRedirect(value: string, allowedHosts: string[]) {
  try {
    const url = new URL(value);
    if (isLoopbackHost(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:" && (!allowedHosts.length || hostMatches(url.hostname, allowedHosts));
  } catch {
    return false;
  }
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function issue(config: RuntimeConfig, scope: string, clientId: string, use: TokenUse, jti: string = crypto.randomUUID()) {
  const ttl = use === "access" ? config.accessTokenTtlSeconds : config.refreshTokenTtlSeconds;
  return new SignJWT({ scope, token_use: use, client_id: clientId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(config.publicBaseUrl)
    .setAudience(tokenAudience(config, use))
    .setSubject("tradepilot-owner")
    .setIssuedAt()
    .setExpirationTime(nowSeconds() + ttl)
    .setJti(jti)
    .sign(key(config));
}

async function verify(config: RuntimeConfig, token: string, use: TokenUse) {
  const { payload } = await jwtVerify(token, key(config), {
    issuer: config.publicBaseUrl,
    audience: tokenAudience(config, use),
    algorithms: ["HS256"],
  });
  if (payload.token_use !== use) throw new Error("Invalid token type");
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  const clientId = typeof payload.client_id === "string" ? payload.client_id : "";
  if (!scope || !clientId) throw new Error("Invalid token claims");
  return { scope, clientId, jti: typeof payload.jti === "string" ? payload.jti : "" };
}

async function bodyRecord(c: Context): Promise<Record<string, unknown>> {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("Request body too large");
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) return await c.req.json<Record<string, unknown>>();
  return await c.req.parseBody() as Record<string, unknown>;
}

export function installOAuth(app: Hono<{ Variables: OAuthVariables }>, config: RuntimeConfig, store: StateStore): void {
  assertAuthConfigured(config);
  const base = config.publicBaseUrl;

  // --- Discovery ---------------------------------------------------------
  const protectedResource = {
    resource: resource(config),
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["trade:read", "trade:write"],
  };
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: grantTypes,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: scopes,
  }));

  // --- Dynamic client registration ---------------------------------------
  // Clients that never completed a token exchange are evicted first, so registration spam cannot push out the owner's connector.
  async function evictStaleClients() {
    const existing = await store.list<RegisteredClient>("client:");
    if (existing.length < MAX_CLIENTS) return;
    const oldestFirst = existing.sort((a, b) =>
      (a.value.last_used_at ?? 0) - (b.value.last_used_at ?? 0) || a.value.created_at - b.value.created_at);
    for (const old of oldestFirst.slice(0, EVICT_BATCH)) await store.delete(old.key);
  }

  async function markClientUsed(clientId: string) {
    const client = await store.get<RegisteredClient>(`client:${clientId}`);
    if (client) await store.put(`client:${clientId}`, { ...client, last_used_at: nowSeconds() });
    return client;
  }

  app.post("/oauth/register", async (c) => {
    try {
      const rate = await store.increment("rate:register", 60_000);
      if (rate.count > REGISTER_RATE_LIMIT) {
        c.header("Retry-After", String(rate.retryAfterSeconds));
        return c.json({ error: "temporarily_unavailable" }, 429);
      }
      const body = await bodyRecord(c);
      const redirectUris = strings(body.redirect_uris);
      if (!redirectUris.length || redirectUris.length > 20 || redirectUris.some((x) => !validRedirect(x, config.oauthRedirectHosts))) {
        return c.json({ error: "invalid_redirect_uri" }, 400);
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
        return c.json({ error: "invalid_client_metadata" }, 400);
      }
      const requested = strings(body.grant_types);
      if (requested.some((x) => !grantTypes.includes(x as GrantType))) {
        return c.json({ error: "invalid_client_metadata" }, 400);
      }
      const granted = [...new Set(requested.length ? requested : grantTypes)] as GrantType[];
      if (!granted.includes("authorization_code")) granted.unshift("authorization_code");

      const client: RegisteredClient = {
        client_id: `tp_${randomToken(24)}`,
        redirect_uris: [...new Set(redirectUris)],
        ...(typeof body.client_name === "string" ? { client_name: body.client_name.slice(0, 200) } : {}),
        token_endpoint_auth_method: "none",
        grant_types: granted,
        response_types: ["code"],
        created_at: nowSeconds(),
      };
      await evictStaleClients();
      await store.put(`client:${client.client_id}`, client);
      return c.json({ ...client, client_id_issued_at: client.created_at }, 201);
    } catch (error) {
      return c.json({ error: "invalid_client_metadata", error_description: errorMessage(error) }, 400);
    }
  });

  // --- Authorization -----------------------------------------------------
  /** Validates an authorization request (query on GET, form body on POST). */
  async function authorizationParams(source: Record<string, unknown>) {
    const clientId = string(source, "client_id");
    const client = await store.get<RegisteredClient>(`client:${clientId}`);
    const redirectUri = string(source, "redirect_uri");
    const codeChallenge = string(source, "code_challenge");
    const requestedResource = string(source, "resource") || resource(config);
    if (!client) throw new Error("Unknown OAuth client");
    if (!client.redirect_uris.includes(redirectUri)) throw new Error("redirect_uri is not registered");
    // Re-checked here so tightening OAUTH_REDIRECT_HOSTS also applies to clients registered earlier.
    if (!validRedirect(redirectUri, config.oauthRedirectHosts)) throw new Error("redirect_uri is not allowed");
    const pkceOk = string(source, "response_type") === "code"
      && /^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)
      && string(source, "code_challenge_method") === "S256";
    if (!pkceOk) throw new Error("PKCE S256 is required");
    if (requestedResource !== resource(config)) throw new Error("Invalid OAuth resource");
    return {
      client,
      clientId,
      redirectUri,
      codeChallenge,
      resource: requestedResource,
      state: string(source, "state"),
      scope: normalizeScope(string(source, "scope") || DEFAULT_SCOPE),
    };
  }

  // The password form must never be framed by another site (clickjacking).
  app.use("/oauth/authorize", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  });

  app.get("/oauth/authorize", async (c) => {
    try {
      const query = Object.fromEntries(new URL(c.req.url).searchParams);
      const p = await authorizationParams(query);
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
      c.header("Cache-Control", "no-store");
      const redirectHost = new URL(p.redirectUri).hostname.toLowerCase();
      return c.html(renderOAuthPage({
        locale,
        clientName: p.client.client_name?.trim() ?? "",
        redirectHost,
        knownClient: isLoopbackHost(redirectHost) || hostMatches(redirectHost, KNOWN_CLIENT_HOSTS),
        scopes: splitScope(p.scope),
        hiddenHtml: hidden,
        zhUrl: zhUrl.toString(),
        enUrl: enUrl.toString(),
      }));
    } catch (error) {
      return c.json({ error: "invalid_request", error_description: errorMessage(error) }, 400);
    }
  });

  app.post("/oauth/authorize", async (c) => {
    try {
      const body = await bodyRecord(c);
      const locale = resolveOAuthLocale(string(body, "ui_locales") || c.req.header("accept-language"));
      const copy = oauthPageCopy(locale);
      const rate = await store.increment("rate:login", 10 * 60_000);
      if (rate.count > LOGIN_RATE_LIMIT) {
        c.header("Retry-After", String(rate.retryAfterSeconds));
        return c.html(renderOAuthMessagePage(locale, copy.tooManyTitle, copy.tryLater), 429);
      }
      const p = await authorizationParams(body);
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
        expiresAt: Date.now() + CODE_TTL_MS,
      };
      await store.put("code:" + code, record, record.expiresAt);
      const redirect = new URL(p.redirectUri);
      redirect.searchParams.set("code", code);
      if (p.state) redirect.searchParams.set("state", p.state);
      return c.redirect(redirect.toString(), 302);
    } catch (error) {
      return c.json({ error: "invalid_request", error_description: errorMessage(error) }, 400);
    }
  });

  // --- Token endpoint ----------------------------------------------------
  async function exchangeCode(c: Context, body: Record<string, unknown>) {
    const record = await store.consume<AuthorizationCode>(`code:${string(body, "code")}`);
    if (!record) return c.json({ error: "invalid_grant" }, 400);
    const challenge = await sha256Base64Url(string(body, "code_verifier"));
    const clientId = string(body, "client_id");
    const matches = clientId === record.clientId
      && string(body, "redirect_uri") === record.redirectUri
      && (string(body, "resource") || record.resource) === record.resource
      && await safeEqual(challenge, record.codeChallenge);
    if (!matches) return c.json({ error: "invalid_grant" }, 400);
    await markClientUsed(clientId);
    const access = await issue(config, record.scope, clientId, "access");
    const refresh = splitScope(record.scope).includes("offline_access")
      ? await issueRefresh(record.scope, clientId)
      : undefined;
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: config.accessTokenTtlSeconds,
      scope: record.scope,
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  }

  // Refresh tokens rotate: each one works once. Presenting a used one again means it leaked, so the
  // client's session ends and the owner has to sign in again.
  const refreshKey = (clientId: string) => `refresh:${clientId}`;
  async function issueRefresh(scope: string, clientId: string) {
    const jti = crypto.randomUUID();
    await store.put(refreshKey(clientId), jti, Date.now() + config.refreshTokenTtlSeconds * 1000);
    return await issue(config, scope, clientId, "refresh", jti);
  }

  async function refreshToken(c: Context, body: Record<string, unknown>) {
    const verified = await verify(config, string(body, "refresh_token"), "refresh");
    const clientId = string(body, "client_id");
    if (clientId !== verified.clientId || !(await markClientUsed(clientId))) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const current = await store.get<string>(refreshKey(clientId));
    // Tokens from before rotation have no record yet; they are accepted once and then rotate.
    if (current !== undefined && current !== verified.jti) {
      await store.put(refreshKey(clientId), "revoked", Date.now() + config.refreshTokenTtlSeconds * 1000);
      return c.json({ error: "invalid_grant", error_description: "Refresh token reuse detected; sign in again." }, 400);
    }
    // A refresh may narrow the granted scope but never widen it.
    const next = string(body, "scope") ? normalizeScope(string(body, "scope")) : verified.scope;
    const original = new Set(splitScope(verified.scope));
    if (!splitScope(next).every((x) => original.has(x))) return c.json({ error: "invalid_scope" }, 400);
    return c.json({
      access_token: await issue(config, next, clientId, "access"),
      refresh_token: await issueRefresh(next, clientId),
      token_type: "Bearer",
      expires_in: config.accessTokenTtlSeconds,
      scope: next,
    });
  }

  app.post("/oauth/token", async (c) => {
    try {
      const body = await bodyRecord(c);
      const grant = string(body, "grant_type");
      if (grant === "authorization_code") return await exchangeCode(c, body);
      if (grant === "refresh_token") return await refreshToken(c, body);
      return c.json({ error: "unsupported_grant_type" }, 400);
    } catch {
      return c.json({ error: "invalid_grant" }, 400);
    }
  });
}

export async function bearer(c: Context<{ Variables: OAuthVariables }>, config: RuntimeConfig, next: () => Promise<void>) {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  if (!match?.[1]) {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl(config)}", scope="trade:read trade:write"`);
    return c.json({ error: "unauthorized", error_description: "Bearer token required" }, 401);
  }
  try {
    const verified = await verify(config, match[1], "access");
    const granted = new Set(splitScope(verified.scope));
    if (!granted.has("trade:read")) return c.json({ error: "insufficient_scope" }, 403);
    c.set("oauthScopes", granted);
    c.set("oauthClientId", verified.clientId);
    await next();
  } catch {
    c.header("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(config)}"`);
    return c.json({ error: "invalid_token" }, 401);
  }
}
