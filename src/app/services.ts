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

/** Build the runtime-neutral services shared by the HTTP and stdio transports. */
export function createServices(deps: ServiceDependencies) {
  // Insights reuse the trading service's instrument cache; the closure only runs after both exist.
  const trading = new TradingService({ ...deps, marketStatus: (environment, instrument) => insights.tryMarketStatus(environment, instrument) });
  const insights = new InsightsService({ config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), instruments: (environment) => trading.instruments(environment) });
  return { trading, insights };
}
