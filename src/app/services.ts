import { PriceAlerts } from "../core/alerts.js";
import { AutomationService } from "../core/automation.js";
import type { RuntimeConfig } from "../core/config.js";
import { InsightsService } from "../core/insights-service.js";
import { createNotifier } from "../core/notify.js";
import { PiesService } from "../core/pies.js";
import { ProtectiveLinks } from "../core/protective-links.js";
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
  const notify = createNotifier(deps.config, deps.fetcher);
  const trading = new TradingService({
    ...deps,
    ...(notify ? { notify } : {}),
    marketStatus: (environment, instrument) => insights.tryMarketStatus(environment, instrument),
    afterBasket: (planId, result) => automation.recordRun(planId, result),
  });
  const insights = new InsightsService({ config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), instruments: (environment) => trading.instruments(environment) });
  const automation = new AutomationService({ config: deps.config, store: deps.store, trading });
  const links = new ProtectiveLinks({ config: deps.config, store: deps.store, trading });
  const alerts = new PriceAlerts({ config: deps.config, store: deps.store, trading });
  const pies = new PiesService({ config: deps.config, store: deps.store, trading, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
  /** One scheduler tick: settle protective pairs first, then due plans, then price alerts. */
  const runScheduled = async () => ({ links: await links.reconcile(), plans: await automation.runDuePlans(), alerts: await alerts.check() });
  return { trading, insights, automation, links, alerts, pies, runScheduled };
}
