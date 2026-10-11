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
  } as RuntimeConfig;

  async function setup() {
    const app = new Hono<{ Variables: OAuthVariables }>();
    const store = new MemoryStateStore();
    installOAuth(app, config, store);
    const register = async () => {
      const response = await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.test/cb"] }) });
      return (await response.json() as { client_id: string }).client_id;
    };
    return { app, store, register };
  }

  it("refuses to let the password page be framed", async () => {
    const { app, register } = await setup();
    const clientId = await register();
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: "https://client.test/cb", response_type: "code", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" });
    const response = await app.request(`/oauth/authorize?${query}`);
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
});
