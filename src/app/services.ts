import { AutomationService } from "../core/automation.js";
import type { RuntimeConfig } from "../core/config.js";
import { InsightsService } from "../core/insights-service.js";
import type { StateStore } from "../core/state-store.js";
import { TradingService, type InstrumentCache } from "../core/trading-service.js";

export interface ServiceDependencies {
  config: RuntimeConfig;
  store: StateStore;
  audit?: (event: string, details: Record<string, unknown>) => Promise<void>;
  fetcher?: typeof fetch;
  instrumentCache?: InstrumentCache;
}

export type Services = ReturnType<typeof createServices>;

/** Build the runtime-neutral services shared by the HTTP and stdio transports and the scheduler. */
export function createServices(deps: ServiceDependencies) {
  // The closures only run after all three services exist.
  const trading = new TradingService({
    ...deps,
    marketStatus: (environment, instrument) => insights.tryMarketStatus(environment, instrument),
    afterBasket: (planId, result) => automation.recordRun(planId, result),
  });
  const insights = new InsightsService({ config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), instruments: (environment) => trading.instruments(environment) });
  const automation = new AutomationService({ config: deps.config, store: deps.store, trading });
  return { trading, insights, automation };
}
