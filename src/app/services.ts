import { PriceAlerts } from "../core/alerts.js";
import { AccountAlerts } from "../core/account-alerts.js";
import { AutomationService } from "../core/automation.js";
import { credentialStatus, type RuntimeConfig } from "../core/config.js";
import type { AutomationOverview } from "../shared/automation.js";
import type { Instrument, TradingEnvironment } from "../shared/contracts.js";
import type { PricePoint } from "../shared/prices.js";
import { InsightsService } from "../core/insights-service.js";
import { TradeJournal } from "../core/journal.js";
import { DailyDigest } from "../core/digest.js";
import { createNotifications } from "../core/notify.js";
import { OrderWatch } from "../core/order-watch.js";
import { PiesService } from "../core/pies.js";
import { createPriceHistory, settleWithin } from "../core/price-history.js";
import { createQuoteProvider } from "../core/quotes.js";
import { createSampleBroker, createSampleQuotes } from "../core/sample-broker.js";
import { ProtectiveLinks } from "../core/protective-links.js";
import { DAY_ORDER_PAGES, dayCloseOf, daySessionOf, portfolioToday } from "../core/today.js";
import { TargetAllocations } from "../core/targets.js";
import { ValueHistory } from "../core/value-history.js";
import { Watchlist } from "../core/watchlist.js";
import type { StateStore } from "../core/state-store.js";
import { HistoryLedgers } from "../core/history-ledger.js";
import { TradingService, type InstrumentCache } from "../core/trading-service.js";

export interface ServiceDependencies {
  config: RuntimeConfig;
  store: StateStore;
  /**
   * Where the history ledger is kept, when not in `store`: a local state file is rewritten whole on every write, so
   * the ledger's few MB go in a file of their own rather than in every other write.
   */
  ledgerStore?: StateStore;
  audit?: (event: string, details: Record<string, unknown>) => Promise<void>;
  fetcher?: typeof fetch;
  instrumentCache?: InstrumentCache;
}

export type Services = ReturnType<typeof createServices>;

/** The automation page takes an account summary read in the last minute, and waits a few seconds at most for a new one. */
const OVERVIEW_SUMMARY_MS = 60_000;
const OVERVIEW_WAIT_MS = 3_000;

/** Build the runtime-neutral services shared by the HTTP and stdio transports and the scheduler. */
// One simulated account per process, so the HTTP handlers and the scheduler see the same sample data.
let processSampleBroker: typeof fetch | undefined;

export function createServices(input: ServiceDependencies) {
  // Sample mode answers Trading 212 requests from the simulated account; other requests pass through.
  const sampleFetcher = () => (input.fetcher ? createSampleBroker(input.fetcher) : (processSampleBroker ??= createSampleBroker()));
  const deps = input.config.sampleData ? { ...input, fetcher: sampleFetcher() } : input;
  // The closures only run after the services they call exist.
  const notifications = createNotifications(deps.config, deps.store, deps.fetcher);
  const notify = notifications?.send;
  // The sample account prices what it does not hold from its own list, offline.
  const quotes = deps.config.sampleData ? createSampleQuotes() : createQuoteProvider(deps.config, deps.fetcher);
  const trading = new TradingService({
    ...deps,
    ...(notify ? { notify } : {}),
    ...(quotes ? { quotes } : {}),
    marketStatus: (environment, instrument) => insights.tryMarketStatus(environment, instrument),
    afterBasket: (planId, result) => automation.recordRun(planId, result),
    afterOrder: (draft, outcome) => journal.recordOrder(draft, outcome),
    afterVerification: (entryId, orderId) => journal.confirmOrder(entryId, orderId),
    afterWrite: (environment) => insights.forgetHistory(environment),
  });
  const insights = new InsightsService({ config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), instruments: (environment) => trading.instruments(environment),
    // The sample account's history is drawn relative to today: kept, it would go stale.
    ...(deps.config.sampleData ? {} : { ledgers: new HistoryLedgers(deps.ledgerStore ?? deps.store) }) });
  const automation = new AutomationService({ config: deps.config, store: deps.store, trading, targets: (environment) => targets.get(environment) });
  const links = new ProtectiveLinks({ config: deps.config, store: deps.store, trading });
  const orders = new OrderWatch({ config: deps.config, store: deps.store, trading });
  const values = new ValueHistory({ config: deps.config, store: deps.store, trading });
  const alerts = new PriceAlerts({
    config: deps.config, store: deps.store, trading,
    // A day's-move alert sets the price against its previous close as the dashboard's day does.
    dayClose: (environment, instrument, price, quoted, now) => dayCloseOf({ priceHistory, closes, quotedCloses, schedules }, environment, instrument, price, quoted, now),
    tradingDay: async (environment, instrument, quoted, now) => (await daySessionOf({ schedules }, environment, instrument, quoted, now))?.day,
  });
  const journal = new TradeJournal({ config: deps.config, store: deps.store, trading });
  const pies = new PiesService({ config: deps.config, store: deps.store, trading, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
  const targets = new TargetAllocations({ config: deps.config, store: deps.store, trading, allocation: (environment) => insights.allocation(environment) });
  const watchlist = new Watchlist({ config: deps.config, store: deps.store, trading });
  const priceHistory = createPriceHistory({
    sampleData: deps.config.sampleData,
    ...(quotes ? { quotes } : {}),
    // The holding page's fills (the same read), so the watchlist draws the path its chart does.
    ...(deps.config.sampleData ? {
      sampleAnchors: async (instrument: Instrument, from: Date) => (await insights.tradeHistory("demo", { from, to: new Date() }, instrument.ticker, 200, 2)).fills
        .flatMap((fill) => (fill.filledAt && fill.price ? [{ at: fill.filledAt, price: fill.price }] : [])),
    } : {}),
  });
  /** Trading 212's exchange schedules: the trading day a price is from. */
  const schedules = (environment: TradingEnvironment) => insights.schedules(environment);
  /** Previous closes that will not change today, kept across the day's reads. */
  const closes = new Map<string, PricePoint & { source: string }>();
  /** The same for alerts priced by a quote, whose closes are checked against the quote rather than Trading 212's price. */
  const quotedCloses = new Map<string, PricePoint & { source: string }>();
  /** Each holding's move since its previous close, with the day's fills counted from their price. */
  const today = (environment: TradingEnvironment, now?: Date) => portfolioToday({
    trading,
    priceHistory,
    schedules,
    closes,
    fills: (env, from) => insights.tradeHistory(env, { from, to: new Date() }, undefined, 200, DAY_ORDER_PAGES),
  }, environment, now);
  /** Alerts on the account's value, cash and day's move; the day's move is the one get_portfolio_today adds up. */
  const accountAlerts = new AccountAlerts({ config: deps.config, store: deps.store, trading, today: (environment, now) => today(environment, now) });
  const digest = new DailyDigest({
    config: deps.config, store: deps.store, trading, targets: (environment) => targets.get(environment), today,
    // A year of dividends is a page or two of Trading 212's history; at most as many pages as the Income tab reads.
    dividends: (environment, from, now) => insights.collect(environment, "dividends", { from, to: now }),
    ...(notify ? { notify } : {}),
  });
  /** One scheduler tick: settle protective pairs first, then how open orders ended, the daily value record, due plans, price and account alerts, target drift and the daily digest. */
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
    orders: await stage("order watch", () => orders.check()),
    values: await stage("value history", () => values.snapshot()),
    plans: await stage("plans", () => automation.runDuePlans()),
    alerts: await stage("alerts", () => alerts.check()),
    accountAlerts: await stage("account alerts", () => accountAlerts.check()),
    targets: await stage("targets", () => targets.check()),
    digest: await stage("digest", () => digest.run()),
    notifications: await stage("notifications", () => notifications?.flush() ?? Promise.resolve([])),
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
    const onAccount = await accountAlerts.list(environment);
    const pairs = (await links.list()).filter((link) => link.environment === environment);
    const saved = await targets.get(environment);
    const instruments = await namedInstruments(environment, [
      ...plans.flatMap((plan) => plan.legs.map((leg) => leg.ticker)), ...priceAlerts.map((alert) => alert.ticker), ...pairs.map((link) => link.ticker),
      ...(saved?.targets.map((target) => target.ticker) ?? []),
    ]);
    return {
      kind: "automation",
      environment,
      credentials: credentialStatus(deps.config),
      plans,
      alerts: priceAlerts,
      ...(onAccount.length ? { accountAlerts: onAccount } : {}),
      links: pairs,
      ...(saved ? { targets: saved } : {}),
      ...(instruments.length ? { instruments } : {}),
      usageToday: await trading.usageToday(environment),
      // The currency and the starting amounts of an account alert, from a summary read in the last minute or a new
      // one, for at most a few seconds; else the currency alone, from that same read once it is in.
      ...await settleWithin(trading.accountSummary(environment, OVERVIEW_SUMMARY_MS).catch(() => undefined), OVERVIEW_WAIT_MS).then(
        (summary) => (summary
          ? { ...(summary.currency ? { currency: summary.currency } : {}), account: { ...(summary.totalValue !== undefined ? { value: summary.totalValue } : {}), ...(summary.cash?.availableToTrade !== undefined ? { cash: summary.cash.availableToTrade } : {}) } }
          : trading.accountCurrency(environment).then((currency) => (currency ? { currency } : {}), () => ({})))),
      policy: deps.config.policy[environment],
      orderLimits: { notional: deps.config.maxOrderNotional, quantity: deps.config.maxOrderQuantity },
      settings: {
        demoAutomation: deps.config.demoAutomationEnabled,
        protectiveLinking: deps.config.protectiveLinking,
        orderWatch: deps.config.orderWatch,
        webhook: deps.config.notifyTargets.length > 0,
        ...(deps.config.notifyTargets.length ? {
          notifications: {
            formats: deps.config.notifyTargets.map((target) => target.format),
            locale: deps.config.notifyLocale,
            ...(deps.config.notifyQuietHours ? { quietHours: deps.config.notifyQuietHours } : {}),
          },
        } : {}),
        digestHour: deps.config.digest?.hour ?? null,
        ...(deps.config.digest ? { digestTimeZone: deps.config.digest.timeZone } : {}),
        ...(deps.config.timeZone ? { timeZone: deps.config.timeZone } : {}),
        taxYearStart: deps.config.taxYearStart,
        quoteProvider: deps.config.sampleData ? "sample" : deps.config.quoteProvider,
      },
      timestamp: new Date().toISOString(),
    };
  };
  return { trading, insights, automation, links, orders, values, alerts, accountAlerts, journal, targets, pies, digest, notifications, priceHistory, watchlist, schedules, today, closes, runScheduled, automationOverview };
}
