import type { Configuration } from "../infra/config.js";
import type { StateStore } from "../infra/state.js";

export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
}
export function permittedClient(id: string, config: Configuration): boolean {
  try {
    const url = new URL(id);
    return url.protocol === "https:" &&
      config.trustedClientOrigins.includes(url.origin) &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/[a-zA-Z0-9/_-]+\.json$/.test(url.pathname);
  } catch { return false; }
}
export function validateClientDocument(id: string, input: unknown): ClientMetadata {
  if (!input || typeof input !== "object") throw new Error("Invalid OAuth CIMD document");
  const value = input as Record<string, unknown>;
  if (value.client_id !== id || !Array.isArray(value.redirect_uris) ||
      value.redirect_uris.length < 1 || value.redirect_uris.length > 20)
    throw new Error("OAuth CIMD identity or redirects invalid");
  for (const redirect of value.redirect_uris) {
    if (typeof redirect !== "string") throw new Error("Invalid OAuth redirect URI");
    const url = new URL(redirect);
    if (url.hash || url.username || url.password ||
        !(url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))))
      throw new Error("Invalid OAuth redirect URI");
  }
  const supported = value.token_endpoint_auth_methods_supported;
  if (supported !== undefined) {
    if (!Array.isArray(supported) || !supported.includes("none"))
      throw new Error("OAuth public PKCE method unavailable");
  } else if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== "none")
    throw new Error("OAuth public PKCE method unavailable");
  if (value.response_types !== undefined && (!Array.isArray(value.response_types) || !value.response_types.includes("code")))
    throw new Error("Client does not support authorization code response");
  if (value.grant_types !== undefined && (!Array.isArray(value.grant_types) || !value.grant_types.includes("authorization_code")))
    throw new Error("Client does not support authorization code grant");
  return {
    client_id: id,
    redirect_uris: value.redirect_uris as string[],
    ...(typeof value.client_name === "string" ? { client_name: value.client_name.slice(0, 120) } : {}),
  };
}
export async function lookupClient(
  id: string, config: Configuration, store: StateStore, fetcher: typeof fetch,
): Promise<ClientMetadata> {
  if (!permittedClient(id, config)) throw new Error("Untrusted OAuth client ID");
  const cached = await store.get<ClientMetadata>(`v3:client:${id}`);
  if (cached) return cached;
  const response = await fetcher(id, {
    redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("OAuth client metadata unavailable");
  if (Number(response.headers.get("content-length") || 0) > 16_384) throw new Error("OAuth metadata too large");
  if (!response.body) throw new Error("OAuth metadata empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) throw new Error("OAuth metadata too large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const client = validateClientDocument(id, JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  await store.put(`v3:client:${id}`, client, Date.now() + 30 * 60_000);
  return client;
}
