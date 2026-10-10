import type { RegisteredClient } from "./oauth.js";
import type { StateStore } from "./state-store.js";

const CLIENT_ID = /^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[\w-]+\/client\.json)$/;
const VALID_FOR_MS = 15 * 60_000;
export function isSupportedClientId(id: string): boolean {
  return CLIENT_ID.test(id);
}
function validRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)));
  } catch { return false; }
}
export function parseClientDocument(id: string, json: unknown): RegisteredClient {
  if (!isSupportedClientId(id) || !json || typeof json !== "object") throw new Error("Unsupported OAuth client");
  const doc = json as Record<string, unknown>;
  if (doc.client_id !== id || (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none"))
    throw new Error("Invalid OAuth client metadata");
  const redirects = doc.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 20 ||
      !redirects.every((uri) => typeof uri === "string" && validRedirect(uri)))
    throw new Error("Invalid OAuth client redirect URIs");
  if (doc.response_types !== undefined && (!Array.isArray(doc.response_types) || !doc.response_types.includes("code")))
    throw new Error("Invalid OAuth response type");
  if (doc.grant_types !== undefined && (!Array.isArray(doc.grant_types) || !doc.grant_types.includes("authorization_code")))
    throw new Error("Invalid OAuth grant type");
  return { client_id: id, redirect_uris: redirects, token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    created_at: Math.floor(Date.now()/1000),
    client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 200) : "ChatGPT" };
}

/** Fetch only ChatGPT-owned public OAuth identities; never fetch arbitrary client-id URLs. */
export async function resolveClientDocument(
  clientId: string, store: StateStore, fetcher: typeof fetch = fetch,
): Promise<RegisteredClient | undefined> {
  if (!isSupportedClientId(clientId)) return undefined;
  const key = "cimd:" + clientId;
  const cached = await store.get<RegisteredClient>(key);
  if (cached) return cached;
  const res = await fetcher(clientId, { redirect: "error",
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 16_384)
    throw new Error("OAuth client metadata unavailable");
  const text = await res.text();
  if (text.length > 16_384) throw new Error("OAuth client metadata too large");
  const result = parseClientDocument(clientId, JSON.parse(text) as unknown);
  await store.put(key, result, Date.now() + VALID_FOR_MS);
  return result;
}
