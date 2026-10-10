import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "./state-store.js";
import { redeemRefreshGrant, registerRefreshGrant } from "./refresh-store.js";

describe("refresh grant replay prevention", () => {
  it("allows exactly one concurrent redemption for the registered client", async () => {
    const store = new MemoryStateStore();
    const jti = "a".repeat(36);
    await registerRefreshGrant(store, jti, "client-a", Date.now() + 60_000);
    const results = await Promise.all(Array.from({ length: 6 },
      () => redeemRefreshGrant(store, jti, "client-a")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects a different client, expired records and missing identifiers", async () => {
    const store = new MemoryStateStore();
    const jti = "b".repeat(36);
    await registerRefreshGrant(store, jti, "client-a", Date.now() + 60_000);
    expect(await redeemRefreshGrant(store, jti, "client-b")).toBe(false);
    expect(await redeemRefreshGrant(store, jti, "client-a")).toBe(false);
    await expect(registerRefreshGrant(store, "short", "client-a", Date.now() + 30_000)).rejects.toThrow();
    await expect(registerRefreshGrant(store, "c".repeat(36), "client-a", Date.now() - 1)).rejects.toThrow();
  });
});
