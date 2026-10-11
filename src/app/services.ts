import { PriceAlerts } from "../core/alerts.js";
import { AutomationService } from "../core/automation.js";
import { credentialStatus, type RuntimeConfig } from "../core/config.js";
import type { AutomationOverview } from "../shared/automation.js";
import type { Instrument, TradingEnvironment } from "../shared/contracts.js";
import { InsightsService } from "../core/insights-service.js";
import { DailyDigest } from "../core/digest.js";
import { createNotifier } from "../core/notify.js";
import { PiesService } from "../core/pies.js";
import { createQuoteProvider } from "../core/quotes.js";
import { createSampleBroker } from "../core/sample-broker.js";
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
// One simulated account per process, so the HTTP handlers and the scheduler see the same sample data.
let processSampleBroker: typeof fetch | undefined;

export function createServices(input: ServiceDependencies) {
  // Sample mode answers Trading 212 requests from the simulated account; other requests pass through.
  const sampleFetcher = () => (input.fetcher ? createSampleBroker(input.fetcher) : (processSampleBroker ??= createSampleBroker()));
  const deps = input.config.sampleData ? { ...input, fetcher: sampleFetcher() } : input;
  // The closures only run after all three services exist.
  const notify = createNotifier(deps.config, deps.fetcher);
  const quotes = createQuoteProvider(deps.config, deps.fetcher);
  const trading = new TradingService({
    ...deps,
    ...(notify ? { notify } : {}),
    ...(quotes ? { quotes } : {}),
    marketStatus: (environment, instrument) => insights.tryMarketStatus(environment, instrument),
    afterBasket: (planId, result) => automation.recordRun(planId, result),
  });
  const insights = new InsightsService({ config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), instruments: (environment) => trading.instruments(environment) });
  const automation = new AutomationService({ config: deps.config, store: deps.store, trading });
  const links = new ProtectiveLinks({ config: deps.config, store: deps.store, trading });
  const alerts = new PriceAlerts({ config: deps.config, store: deps.store, trading });
  const pies = new PiesService({ config: deps.config, store: deps.store, trading, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
  const digest = new DailyDigest({ config: deps.config, store: deps.store, trading, ...(notify ? { notify } : {}) });
  /** One scheduler tick: settle protective pairs first, then due plans, price alerts and the daily digest. */
  // Each stage runs even when an earlier one fails, so one broken read cannot stop the others.
  const stage = async <T>(name: string, run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch (error) {
      console.error(JSON.stringify({ message: `TradePilot scheduler stage failed: ${name}`, error: error instanceof Error ? error.message : String(error) }));
      return [];
    }
  };
  const tick = async () => ({
    links: await stage("protective links", () => links.reconcile()),
    plans: await stage("plans", () => automation.runDuePlans()),
    alerts: await stage("alerts", () => alerts.check()),
    digest: await stage("digest", () => digest.run()),
  });
  // A tick that outlasts the interval (slow broker, rate-limit waits) is joined, not overlapped.
  let running: ReturnType<typeof tick> | undefined;
  const runScheduled = () => (running ??= tick().finally(() => { running = undefined; }));
  // The instruments the automation page names, so it can show their names and price alerts in their currency.
  const namedInstruments = async (environment: TradingEnvironment, tickers: string[]): Promise<NonNullable<AutomationOverview["instruments"]>> => {
    const wanted = new Set(tickers);
    if (!wanted.size) return [];
    const all = await trading.instruments(environment).catch(() => [] as Instrument[]);
    return all.filter((instrument) => wanted.has(instrument.ticker))
      .map(({ ticker, name, shortName, currencyCode, type }) => ({ ticker, ...(name ? { name } : {}), ...(shortName ? { shortName } : {}), ...(currencyCode ? { currencyCode } : {}), ...(type ? { type } : {}) }));
  };
  /** Plans, alerts, linked pairs, today's usage and the automation settings for one environment. */
  const automationOverview = async (environment: TradingEnvironment): Promise<AutomationOverview> => {
    const plans = await automation.listPlans(environment);
    const priceAlerts = await alerts.list(environment);
    const pairs = (await links.list()).filter((link) => link.environment === environment);
    const instruments = await namedInstruments(environment, [...plans.flatMap((plan) => plan.legs.map((leg) => leg.ticker)), ...priceAlerts.map((alert) => alert.ticker), ...pairs.map((link) => link.ticker)]);
    return {
      kind: "automation",
      environment,
      credentials: credentialStatus(deps.config),
      plans,
      alerts: priceAlerts,
      links: pairs,
      ...(instruments.length ? { instruments } : {}),
      usageToday: await trading.usageToday(environment),
      ...await trading.accountCurrency(environment).then((currency) => (currency ? { currency } : {})),
      policy: deps.config.policy[environment],
      settings: {
        demoAutomation: deps.config.demoAutomationEnabled,
        protectiveLinking: deps.config.protectiveLinking,
        webhook: !!deps.config.notifyWebhookUrl,
        digestHourUtc: deps.config.digestHourUtc ?? null,
        quoteProvider: deps.config.quoteProvider,
      },
      timestamp: new Date().toISOString(),
    };
  };
  return { trading, insights, automation, links, alerts, pies, digest, runScheduled, automationOverview };
}
