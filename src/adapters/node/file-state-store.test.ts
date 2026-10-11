import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStateStore } from "./file-state-store.js";

describe("file state shared between processes", () => {
  it("sees and keeps the other instance's writes, and shares counters and tokens", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tp-state-"));
    const file = path.join(dir, "state.json");
    const a = await FileStateStore.open(file);
    const b = await FileStateStore.open(file);

    await a.put("plan:1", { label: "A" });
    await b.put("alert:1", { ticker: "B" });
    await a.put("plan:2", { label: "A2" });
    expect((await b.list("plan:")).map((entry) => entry.key).sort()).toEqual(["plan:1", "plan:2"]);
    expect(await a.get("alert:1")).toEqual({ ticker: "B" });

    // A run lock taken by one process holds for the other.
    const [first, second] = await Promise.all([a.increment("plan-lock:1", 60_000), b.increment("plan-lock:1", 60_000)]);
    expect([first.count, second.count].sort()).toEqual([1, 2]);

    // A confirmation token is consumed once across both.
    await a.put("confirm:t", { kind: "order" });
    const consumed = await Promise.all([a.consume("confirm:t"), b.consume("confirm:t")]);
    expect(consumed.filter(Boolean)).toHaveLength(1);

    const reopened = await FileStateStore.open(file);
    expect((await reopened.list("")).map((entry) => entry.key).sort()).toEqual(["alert:1", "plan-lock:1", "plan:1", "plan:2"]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
