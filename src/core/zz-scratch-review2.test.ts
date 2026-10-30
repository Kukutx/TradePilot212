import { it } from "vitest";
import { createServices } from "../app/services.js";
import { createConfig, type RuntimeEnv } from "./config.js";
import { MemoryStateStore } from "./state-store.js";
import { credentialStatus } from "./config.js";
it("m", async () => {
  const out: unknown[] = [];
  const config = createConfig({ TRADEPILOT_SAMPLE_DATA: "true" } as RuntimeEnv);
  out.push(credentialStatus(config));
  const services = createServices({ config, store: new MemoryStateStore() });
  try { out.push(await services.trading.getDashboard("live", 60000)); } catch (e: any) { out.push(["ERR", e?.constructor?.name, e?.message, e?.code]); }
  throw new Error(JSON.stringify(out));
});
