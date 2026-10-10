import type { StateStore } from "./state-store.js";

function key(jti: string): string {
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(jti)) throw new Error("Invalid refresh token identifier");
  return `oauth:refresh:${jti}`;
}

/** A refresh token is valid only if its signed JTI is registered server-side. */
export async function registerRefreshGrant(
  store: StateStore, jti: string, clientId: string, expiresAtMs: number,
): Promise<void> {
  if (!clientId || expiresAtMs <= Date.now()) throw new Error("Invalid refresh token grant");
  await store.put(key(jti), clientId, expiresAtMs);
}

/**
 * Atomically consumes the JTI before rotation. Two concurrent refresh requests
 * cannot both succeed, even with a valid signed JWT. If persistence fails,
 * the caller must reauthenticate instead of reviving the old token.
 */
export async function redeemRefreshGrant(
  store: StateStore, jti: string, clientId: string,
): Promise<boolean> {
  return (await store.consume<string>(key(jti))) === clientId;
}
