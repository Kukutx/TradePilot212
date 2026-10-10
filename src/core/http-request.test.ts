import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { createApp } from "../app/create-app.js";
import { createConfig } from "./config.js";
import { boundedMcpRequest, RequestTooLargeError } from "./http-request.js";
import { MemoryStateStore } from "./state-store.js";

describe("MCP request-body limits", () => {
  it("accepts requests below the cap and keeps their MIME type", async () => {
    const request = new Request("https://example.test/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ hello: "world" }),
    });
    const received = await boundedMcpRequest(request, 256);
    expect(received.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(await received.json()).toEqual({ hello: "world" });
  });

  it("rejects streamed bodies without relying on Content-Length", async () => {
    const request = new Request("https://example.test/mcp", {
      method: "POST", body: "a".repeat(1025),
    });
    expect(request.headers.has("content-length")).toBe(false);
    await expect(boundedMcpRequest(request, 1024)).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("rejects dishonest or invalid Content-Length", async () => {
    const request = new Request("https://example.test/mcp", {
      method: "POST", headers: { "Content-Length": "9999999" }, body: "{}",
    });
    await expect(boundedMcpRequest(request, 1024)).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("exposes no brokerage credential-status details on unauthenticated health", async () => {
    const config = createConfig({
      PUBLIC_BASE_URL: "https://tradepilot.test",
      APP_LOGIN_PASSWORD: "0123456789abcdef",
      AUTH_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
      T212_DEMO_API_KEY: "broker-key",
      T212_DEMO_API_SECRET: "broker-secret",
    });
    const app = createApp({ config, store: new MemoryStateStore(), widgetHtml: async () => "<html></html>" });
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    const response = await health.json() as Record<string, unknown>;
    expect(response.ok).toBe(true);
    expect(response.credentials).toBeUndefined();
  });

  it("returns 413 for authenticated MCP uploads exceeding the streaming cap", async () => {
    const config = createConfig({
      PUBLIC_BASE_URL: "https://tradepilot.test",
      APP_LOGIN_PASSWORD: "0123456789abcdef",
      AUTH_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
    });
    const app = createApp({ config, store: new MemoryStateStore(), widgetHtml: async () => "<html></html>" });
    const token = await new SignJWT({ token_use: "access", client_id: "tp_client", scope: "trade:read" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.publicBaseUrl)
      .setAudience(`${config.publicBaseUrl}/mcp`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("token-test-identifier-123456789")
      .sign(new TextEncoder().encode(config.signingSecret));
    const result = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "a".repeat(1_048_577),
    });
    expect(result.status).toBe(413);
    expect((await result.json() as Record<string, unknown>).error).toBe("request_too_large");
  });
});
