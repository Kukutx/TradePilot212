import { describe, expect, it, vi } from "vitest";
import { MemoryStateStore } from "./state-store.js";
import { isSupportedClientId, parseClientDocument, resolveClientDocument } from "./oauth-client-metadata.js";

const id = "https://chatgpt.com/oauth/client.json";
const doc = { client_id: id, client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  token_endpoint_auth_method: "none" };

describe("OAuth Client ID Metadata Documents", () => {
  it("only accepts known ChatGPT-owned client-id URL forms", () => {
    expect(isSupportedClientId(id)).toBe(true);
    expect(isSupportedClientId("https://chatgpt.com/oauth/callback_7/client.json")).toBe(true);
    for (const unsafe of ["http://169.254.169.254/latest/meta-data", "https://evil.test/oauth/client.json",
      "https://chatgpt.com.evil.test/oauth/client.json",
      "https://chatgpt.com/oauth/client.json?x=1"]) expect(isSupportedClientId(unsafe)).toBe(false);
  });
  it("rejects untrusted client identity and non-HTTPS redirects", () => {
    expect(parseClientDocument(id, doc).client_id).toBe(id);
    expect(() => parseClientDocument(id, { ...doc, client_id: "https://evil.test" })).toThrow();
    expect(() => parseClientDocument(id, { ...doc, redirect_uris: ["javascript:alert(1)"] })).toThrow();
    expect(() => parseClientDocument(id, { ...doc, token_endpoint_auth_method: "client_secret_basic" })).toThrow();
  });
  it("caches validated client metadata and does not fetch arbitrary URLs", async () => {
    const store = new MemoryStateStore();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 }));
    expect((await resolveClientDocument(id, store, fetcher as typeof fetch))?.client_name).toBe("ChatGPT");
    await resolveClientDocument(id, store, fetcher as typeof fetch);
    await resolveClientDocument("https://example.test/client.json", store, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
