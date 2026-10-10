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
  if (doc.client_id !== id) throw new Error("Invalid OAuth client identity");
  // The modern CIMD plural field is authoritative for supported methods.
  // ChatGPT may prefer private_key_jwt in the legacy singular field while
  // still offering "none"; this self-hosted server supports "none" + PKCE.
  const supported = doc.token_endpoint_auth_methods_supported;
  if (supported !== undefined) {
    if (!Array.isArray(supported) || !supported.includes("none") ||
        !supported.every((method) => typeof method === "string"))
      throw new Error("OAuth client does not support public PKCE authentication");
  } else if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    throw new Error("OAuth client does not support public PKCE authentication");
  }
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
  // Enforce a streaming byte cap. response.text() only checks size after
  // loading the entire body and would allow an unbounded response in memory.
  if (!res.body) throw new Error("OAuth client metadata is empty");
  const reader = res.body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > 16_384) throw new Error("OAuth client metadata too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const payload = new Uint8Array(received);
  let offset = 0;
  for (const part of chunks) { payload.set(part, offset); offset += part.byteLength; }
  const result = parseClientDocument(clientId, JSON.parse(new TextDecoder().decode(payload)) as unknown);
  await store.put(key, result, Date.now() + VALID_FOR_MS);
  return result;
}
