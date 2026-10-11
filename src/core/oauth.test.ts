import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { RuntimeConfig } from "./config.js";
import { installOAuth, type OAuthVariables, type RegisteredClient } from "./oauth.js";
import { MemoryStateStore } from "./state-store.js";
import { safeEqual, sha256Base64Url } from "./web-utils.js";

describe("OAuth PKCE", () => {
  it("computes and compares the RFC 7636 S256 challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await sha256Base64Url(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(await safeEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(await safeEqual(challenge, "wrong")).toBe(false);
  });
});

describe("OAuth endpoints", () => {
  const config = {
    publicBaseUrl: "https://example.test",
    loginPassword: "0123456789abcdef-owner",
    signingSecret: "0123456789abcdef0123456789abcdef",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
    oauthRedirectHosts: [],
  } as unknown as RuntimeConfig;
  const challenge = { verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", value: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" };

  async function setup(overrides: Partial<RuntimeConfig> = {}) {
    const app = new Hono<{ Variables: OAuthVariables }>();
    const store = new MemoryStateStore();
    installOAuth(app, { ...config, ...overrides }, store);
    const register = async (redirect = "https://client.test/cb", name?: string) => {
      const response = await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], ...(name ? { client_name: name } : {}) }) });
      return (await response.json() as { client_id: string }).client_id;
    };
    const authorizeQuery = (clientId: string, redirect = "https://client.test/cb", scope = "trade:read") =>
      new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge.value, code_challenge_method: "S256", scope });
    /** Signs in and exchanges the code; returns the token response. */
    const signIn = async (clientId: string, scope: string) => {
      const form = authorizeQuery(clientId, "https://client.test/cb", scope);
      form.set("password", config.loginPassword);
      const authorized = await app.request("/oauth/authorize", { method: "POST", body: form });
      const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
      const token = await app.request("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: challenge.verifier, client_id: clientId, redirect_uri: "https://client.test/cb" }) });
      return await token.json() as { access_token?: string; refresh_token?: string };
    };
    const refresh = async (clientId: string, token: string) =>
      app.request("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }) });
    return { app, store, register, authorizeQuery, signIn, refresh };
  }

  it("refuses to let the password page be framed", async () => {
    const { app, register, authorizeQuery } = await setup();
    const clientId = await register();
    const response = await app.request(`/oauth/authorize?${authorizeQuery(clientId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("evicts never-used registrations before a client that obtained tokens", async () => {
    const { store, register } = await setup();
    const owner = await register();
    const ownerRecord = await store.get<RegisteredClient>(`client:${owner}`);
    await store.put(`client:${owner}`, { ...ownerRecord!, last_used_at: 1 });
    for (let i = 0; i < 199; i++) {
      await store.put(`client:spam${i}`, { ...ownerRecord!, client_id: `spam${i}`, created_at: ownerRecord!.created_at + 1, last_used_at: undefined });
    }
    await store.delete("rate:register");
    await register();
    expect(await store.get(`client:${owner}`)).toBeDefined();
    expect((await store.list("client:")).length).toBe(151);
  });

  it("shows where the code goes and what it grants, and warns about unknown hosts", async () => {
    const { app, register, authorizeQuery } = await setup();
    const clientId = await register("https://evil.example/cb", "ChatGPT");
    const page = await (await app.request(`/oauth/authorize?${authorizeQuery(clientId, "https://evil.example/cb", "trade:read trade:write offline_access")}`)).text();
    expect(page).toContain("evil.example");
    expect(page).toContain("Prepare orders");
    expect(page).toContain("is not ChatGPT or Claude");

    const known = await register("https://chatgpt.com/connector_platform_oauth_redirect");
    const knownPage = await (await app.request(`/oauth/authorize?${authorizeQuery(known, "https://chatgpt.com/connector_platform_oauth_redirect")}`)).text();
    expect(knownPage).not.toContain("is not ChatGPT or Claude");
  });

  it("limits redirect hosts when OAUTH_REDIRECT_HOSTS is set, and accepts IPv6 loopback", async () => {
    const { app } = await setup({ oauthRedirectHosts: ["chatgpt.com", ".claude.ai"] });
    const status = async (redirect: string) => (await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) })).status;
    expect(await status("https://evil.example/cb")).toBe(400);
    expect(await status("https://chatgpt.com/cb")).toBe(201);
    expect(await status("https://app.claude.ai/cb")).toBe(201);
    expect(await status("http://[::1]:33418/callback")).toBe(201);
  });

  it("rotates refresh tokens and ends the session when an old one is reused", async () => {
    const { register, signIn, refresh } = await setup();
    const clientId = await register();
    const first = await signIn(clientId, "trade:read offline_access");
    const rotated = await refresh(clientId, first.refresh_token!);
    expect(rotated.status).toBe(200);
    const second = await rotated.json() as { refresh_token: string };
    expect((await refresh(clientId, first.refresh_token!)).status).toBe(400);
    // After reuse, even the newest token stops working until the owner signs in again.
    expect((await refresh(clientId, second.refresh_token)).status).toBe(400);
  });
});
