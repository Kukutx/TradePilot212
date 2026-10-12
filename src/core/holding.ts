// The detail of one instrument in one account, gathered from the services that already read each part.

import type { TradingEnvironment } from "../shared/contracts.js";
import type { HoldingDetail } from "../shared/holding.js";
import type { PriceAlerts } from "./alerts.js";
import { asStructuredError } from "./errors.js";
import type { InsightsService } from "./insights-service.js";
import type { TradeJournal } from "./journal.js";
import type { TargetAllocations } from "./targets.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";

const DAY_MS = 86_400_000;
/** Fills and dividends listed; the dividend total covers the whole window. */
const MAX_FILLS = 20;
const MAX_DIVIDENDS = 12;
/** The newest journal notes listed, plus any on a listed fill. */
const MAX_NOTES = 20;
/** Two pages of each history is at most four requests, well inside Trading 212's limits even with a few views open. */
const HISTORY_PAGES = 2;

export interface HoldingDeps {
  trading: TradingService;
  insights: InsightsService;
  alerts: PriceAlerts;
  journal: TradeJournal;
  targets: TargetAllocations;
}

/**
 * One instrument: the position (if held), its share of the account and saved target, open orders,
 * price alerts, journal notes, market session, and the last 12 months of fills and dividends. A failed history read
 * leaves the rest in place and says why.
 */
export async function holdingDetail(deps: HoldingDeps, environment: TradingEnvironment, query: string, now = new Date()): Promise<HoldingDetail> {
  const dashboard = await deps.trading.getDashboard(environment);
  if (!dashboard.credentials[environment]) throw new Error(dashboard.warning ?? `${environment.toUpperCase()} credentials are not configured`);
  const wanted = query.trim().toUpperCase();
  // A held ticker needs no instrument list; anything else resolves like an order does.
  const held = dashboard.positions.find((position) => position.instrument.ticker.toUpperCase() === wanted);
  const listed = held ? undefined : resolveInstrumentFromList(await deps.trading.instruments(environment), query);
  const ticker = held?.instrument.ticker ?? listed!.ticker;
  const position = held ?? dashboard.positions.find((item) => item.instrument.ticker === ticker);
  const source = { ...(position?.instrument ?? {}), ...(listed ?? {}) };
  const instrument = {
    ticker,
    ...(source.name ? { name: source.name } : {}),
    ...(source.shortName ? { shortName: source.shortName } : {}),
    ...(source.currencyCode ? { currencyCode: source.currencyCode } : {}),
    ...(source.type ? { type: source.type } : {}),
    ...(source.isin ? { isin: source.isin } : {}),
  };
  const total = dashboard.account?.totalValue;
  const value = (position?.walletImpact as { currentValue?: unknown } | undefined)?.currentValue;
  const window = { from: new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - 365 * DAY_MS), to: now };
  const [targets, alerts, notes, market, history] = await Promise.all([
    deps.targets.get(environment),
    deps.alerts.list(environment),
    deps.journal.list(environment, { ticker }),
    deps.insights.tryMarketStatus(environment, listed ?? position!.instrument, now),
    Promise.all([
      deps.insights.tradeHistory(environment, window, ticker, MAX_FILLS, HISTORY_PAGES),
      deps.insights.cashHistory(environment, window, { ticker, types: ["DIVIDEND"], limit: MAX_DIVIDENDS, maxPages: HISTORY_PAGES }),
    ]).catch((error: unknown) => asStructuredError(error)),
  ]);
  const target = targets?.targets.find((item) => item.ticker === ticker)?.weight;
  const filled = new Set(Array.isArray(history) ? history[0].fills.flatMap((fill) => (fill.orderId ? [fill.orderId] : [])) : []);
  const journal = notes.filter((note, index) => index < MAX_NOTES || (note.orderId !== undefined && filled.has(note.orderId)));
  return {
    kind: "holding",
    environment,
    credentials: dashboard.credentials,
    ticker,
    instrument,
    ...(dashboard.account?.currency ? { accountCurrency: dashboard.account.currency } : {}),
    ...(position ? { position } : {}),
    ...(typeof value === "number" && typeof total === "number" && total > 0 ? { weight: value / total } : {}),
    ...(target === undefined ? {} : { targetWeight: target }),
    orders: dashboard.orders.filter((order) => order.ticker === ticker),
    alerts: alerts.filter((alert) => alert.ticker === ticker),
    journal,
    ...(notes.length > journal.length ? { journalTotal: notes.length } : {}),
    ...(market ? { market } : {}),
    ...(Array.isArray(history)
      ? {
          history: {
            from: window.from.toISOString(),
            fills: history[0].fills.map((fill) => ({
              ...(fill.orderId ? { orderId: fill.orderId } : {}),
              ...(fill.filledAt ? { filledAt: fill.filledAt } : {}),
              ...(fill.side ? { side: fill.side } : {}),
              ...(fill.type ? { type: fill.type } : {}),
              ...(fill.quantity === undefined ? {} : { quantity: fill.quantity }),
              ...(fill.price === undefined ? {} : { price: fill.price }),
              ...(fill.priceCurrency ? { priceCurrency: fill.priceCurrency } : {}),
              ...(fill.netValue === undefined ? {} : { netValue: fill.netValue }),
              ...(fill.accountCurrency ? { accountCurrency: fill.accountCurrency } : {}),
              ...(fill.realisedProfitLoss === undefined ? {} : { realisedProfitLoss: fill.realisedProfitLoss }),
            })),
            dividends: history[1].items.map((item) => ({
              date: item.date,
              amount: item.amount,
              currency: item.currency,
              ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
              ...(item.grossPerShare === undefined ? {} : { grossPerShare: item.grossPerShare, perShareCurrency: item.perShareCurrency ?? "" }),
            })),
            dividendTotal: history[1].totals.DIVIDEND ?? 0,
            dividendCount: history[1].count,
            fillsTruncated: history[0].truncated,
            dividendsTruncated: history[1].truncated,
          },
        }
      : { historyProblem: history.message }),
    timestamp: new Date().toISOString(),
  };
}
