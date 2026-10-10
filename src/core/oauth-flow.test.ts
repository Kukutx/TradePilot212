import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createConfig } from "./config.js";
import { installOAuth, type OAuthVariables } from "./oauth.js";
import { MemoryStateStore } from "./state-store.js";
import { sha256Base64Url } from "./web-utils.js";

function harness() {
  const config = createConfig({
    PUBLIC_BASE_URL: "https://tradepilot.example.test",
    APP_LOGIN_PASSWORD: "0123456789abcdef",
    AUTH_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
    EXECUTION_APPROVAL_SECRET: "different-independent-approval",
  });
  const store = new MemoryStateStore();
  const app = new Hono<{ Variables: OAuthVariables }>();
  installOAuth(app, config, store);
  return { app, config };
}

describe("OAuth integration", () => {
  it("issues RFC 9207 issuer and rotates refresh grants with replay rejection", async () => {
    const { app, config } = harness();
    const redirectUri = "https://client.example.test/cb";
    const register = await app.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    expect(register.status).toBe(201);
    const { client_id: clientId } = await register.json() as { client_id: string };
    const verifier = "x".repeat(43);
    const challenge = await sha256Base64Url(verifier);
    const fields = {
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256",
      resource: `${config.publicBaseUrl}/mcp`, scope: "trade:read offline_access",
      state: "original-state", password: "0123456789abcdef",
    };
    const authorize = await app.request("/oauth/authorize", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("location")!);
    expect(callback.searchParams.get("iss")).toBe(config.publicBaseUrl);
    expect(callback.searchParams.get("state")).toBe(fields.state);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const exchange = async (data: Record<string, string>) => {
      const response = await app.request("/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, ...data }).toString(),
      });
      return { status: response.status, body: await response.json() as Record<string, string> };
    };
    const original = await exchange({
      grant_type: "authorization_code", code: code!,
      redirect_uri: redirectUri, code_verifier: verifier,
      resource: fields.resource,
    });
    expect(original.status).toBe(200);
    expect(original.body.refresh_token).toBeTruthy();

    const next = await exchange({ grant_type: "refresh_token", refresh_token: original.body.refresh_token! });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(original.body.refresh_token);
    const replay = await exchange({ grant_type: "refresh_token", refresh_token: original.body.refresh_token! });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    const rotated = await exchange({ grant_type: "refresh_token", refresh_token: next.body.refresh_token! });
    expect(rotated.status).toBe(200);
  });
});
