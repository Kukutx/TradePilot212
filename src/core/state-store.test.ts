import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "./state-store.js";

describe("StateStore", () => {
  it("expires values", async () => {
    const store = new MemoryStateStore();
    await store.put("short", { ok: true }, Date.now() - 1);
    expect(await store.get("short")).toBeUndefined();
  });
  it("consumes a token exactly once under concurrency", async () => {
    const store = new MemoryStateStore(); await store.put("token", "payload", Date.now() + 1000);
    const values = await Promise.all([store.consume("token"), store.consume("token"), store.consume("token")]);
    expect(values.filter((value) => value === "payload")).toHaveLength(1);
    expect(values.filter((value) => value === undefined)).toHaveLength(2);
  });
});
