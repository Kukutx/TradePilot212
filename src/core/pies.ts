// Trading 212 pies: read them with derived analytics, and create, update, duplicate or delete them
// behind the same review-then-confirm flow as orders. A pie change moves no cash by itself, but
// Trading 212 may rebalance or release holdings when slices change, so it is still confirmed.
//
// The pie endpoints are rate limited hard (list 1 per 30 s, detail 1 per 5 s), so reads are cached.

import type { TradingEnvironment } from "../shared/contracts.js";
import type {
  PieChangeDraft,
  PieChangePreview,
  PieChangeResult,
  PieDetail,
  PieOverview,
  PieRequest,
  PiesPayload,
  PieSummary,
} from "../shared/pies.js";
import { credentialStatus, requireCredentials, type RuntimeConfig } from "./config.js";
import { asStructuredError, fail } from "./errors.js";
import type { StateStore } from "./state-store.js";
import { resolveInstrumentFromList, type TradingService } from "./trading-service.js";
import { ExecutionStatusUnknownError, Trading212ApiError, Trading212Client } from "./trading212-client.js";
import { randomToken } from "./web-utils.js";

export interface PiesDeps {
  config: RuntimeConfig;
  store: StateStore;
  trading: TradingService;
  fetcher?: typeof fetch;
}

interface PendingPieChange {
  environment: TradingEnvironment;
  action: PieChangeDraft["action"];
  pieId?: number;
  request?: PieRequest;
  duplicate?: { name?: string; icon?: string };
}

export const MAX_PIE_INSTRUMENTS = 50;
export const DEFAULT_PIE_DETAILS = 10;
const LIST_CACHE_MS = 30_000;
const DETAIL_CACHE_MS = 60_000;
const SHARE_DIGITS = 4;

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Scale shares so they sum to exactly 1 at four decimals. The largest slice absorbs the rounding
 * remainder, which keeps every other slice at the share the user asked for.
 */
export function normaliseShares(shares: Record<string, number>): Record<string, number> {
  const entries = Object.entries(shares);
  if (!entries.length || entries.length > MAX_PIE_INSTRUMENTS) fail("INVALID_INPUT", `A pie needs 1 to ${MAX_PIE_INSTRUMENTS} instruments`, { field: "instrumentShares" });
  for (const [ticker, share] of entries)
    if (!Number.isFinite(share) || share <= 0) fail("INVALID_INPUT", `The share for ${ticker} must be a positive number`, { field: "instrumentShares" });
  const total = entries.reduce((sum, [, share]) => sum + share, 0);
  const scaled = entries.map(([ticker, share]) => [ticker, round(share / total, SHARE_DIGITS)] as const);
  const remainder = round(1 - scaled.reduce((sum, [, share]) => sum + share, 0), SHARE_DIGITS);
  const largest = scaled.reduce((best, entry, index) => (entry[1] > scaled[best]![1] ? index : best), 0);
  const result = Object.fromEntries(scaled);
  result[scaled[largest]![0]] = round(scaled[largest]![1] + remainder, SHARE_DIGITS);
  for (const [ticker, share] of Object.entries(result))
    if (share <= 0) fail("INVALID_INPUT", `${ticker} rounds to a 0% share; give it at least 0.01%`, { field: "instrumentShares" });
  return result;
}

/** Combine the list row and the detail call into one overview with drift from the target shares. */
export function pieOverview(summary: PieSummary | undefined, detail: PieDetail | undefined, id: number): PieOverview {
  const result = summary?.result ?? {};
  const invested = num(result.priceAvgInvestedValue);
  const value = num(result.priceAvgValue);
  const instruments = detail?.instruments?.map((item) => {
    const targetShare = num(item.expectedShare);
    const currentShare = num(item.currentShare);
    return {
      ticker: item.ticker,
      targetShare,
      currentShare,
      driftShare: round(currentShare - targetShare, 4),
      ownedQuantity: num(item.ownedQuantity),
      ...(item.result?.priceAvgValue === undefined ? {} : { value: item.result.priceAvgValue }),
      ...(item.result?.priceAvgResult === undefined ? {} : { result: item.result.priceAvgResult }),
      issues: item.issues ?? [],
    };
  });
  const settings = detail?.settings;
  return {
    id,
    name: settings?.name || `Pie ${id}`,
    status: summary?.status ?? null,
    cash: num(summary?.cash),
    invested,
    value,
    result: num(result.priceAvgResult) || round(value - invested),
    resultPercent: typeof result.priceAvgResultCoef === "number" ? round(result.priceAvgResultCoef * 100) : invested > 0 ? round(((value - invested) / invested) * 100) : null,
    progress: typeof summary?.progress === "number" ? summary.progress : null,
    ...(settings?.goal ? { goal: settings.goal } : {}),
    dividends: { gained: num(summary?.dividendDetails?.gained), reinvested: num(summary?.dividendDetails?.reinvested), inCash: num(summary?.dividendDetails?.inCash) },
    ...(instruments ? { instruments, drift: round(instruments.reduce((sum, item) => sum + Math.abs(item.driftShare), 0) / 2, 4) } : {}),
    ...(settings ? { settings } : {}),
  };
}

export class PiesService {
  constructor(private readonly deps: PiesDeps) {}

  private client(environment: TradingEnvironment) {
    return new Trading212Client(environment, this.deps.config, this.deps.fetcher);
  }

  private assertCredentials(environment: TradingEnvironment) {
    requireCredentials(this.deps.config, environment);
  }

  private async summaries(environment: TradingEnvironment, fresh = false): Promise<PieSummary[]> {
    const key = `pies-cache:${environment}`;
    if (!fresh) {
      const cached = await this.deps.store.get<PieSummary[]>(key);
      if (cached) return cached;
    }
    const pies = await this.client(environment).getPies();
    await this.deps.store.put(key, pies, Date.now() + LIST_CACHE_MS);
    return pies;
  }

  private async detail(environment: TradingEnvironment, id: number, fresh = false): Promise<PieDetail> {
    const key = `pie-cache:${environment}:${id}`;
    if (!fresh) {
      const cached = await this.deps.store.get<PieDetail>(key);
      if (cached) return cached;
    }
    try {
      const pie = await this.client(environment).getPie(id);
      await this.deps.store.put(key, pie, Date.now() + DETAIL_CACHE_MS);
      return pie;
    } catch (error) {
      if (error instanceof Trading212ApiError && error.status === 404) fail("PIE_NOT_FOUND", `Pie ${id} was not found`, { pieId: id });
      throw error;
    }
  }

  private async forget(environment: TradingEnvironment, id?: number) {
    await this.deps.store.delete(`pies-cache:${environment}`);
    if (id !== undefined) await this.deps.store.delete(`pie-cache:${environment}:${id}`);
  }

  /** All pies with totals. Details (names, slices) are read for up to `details` pies, newest first. */
  async listPies(environment: TradingEnvironment, options: { details?: number; fresh?: boolean } = {}): Promise<PiesPayload> {
    const credentials = credentialStatus(this.deps.config);
    const base = { kind: "pies" as const, environment, credentials, timestamp: new Date().toISOString() };
    if (!credentials[environment]) return { ...base, pies: [], totals: { value: 0, invested: 0, result: 0, cash: 0 }, notes: [`${environment.toUpperCase()} credentials are not configured.`] };
    const summaries = await this.summaries(environment, options.fresh);
    const limit = Math.max(0, Math.min(options.details ?? DEFAULT_PIE_DETAILS, summaries.length));
    const ordered = [...summaries].sort((a, b) => b.id - a.id);
    const pies: PieOverview[] = [];
    const notes: string[] = [];
    for (const [index, summary] of ordered.entries()) {
      let detail: PieDetail | undefined;
      if (index < limit) {
        try {
          detail = await this.detail(environment, summary.id, options.fresh);
        } catch (error) {
          notes.push(`Pie ${summary.id}: details unavailable (${asStructuredError(error).message}).`);
        }
      }
      pies.push(pieOverview(summary, detail, summary.id));
    }
    if (limit < summaries.length) notes.push(`Slices were read for ${limit} of ${summaries.length} pies; Trading 212 allows one pie detail read every 5 seconds.`);
    const totals = pies.reduce((sum, pie) => ({ value: sum.value + pie.value, invested: sum.invested + pie.invested, result: sum.result + pie.result, cash: sum.cash + pie.cash }), { value: 0, invested: 0, result: 0, cash: 0 });
    const currency = await this.deps.trading.accountCurrency(environment);
    return {
      ...base,
      pies: currency ? pies.map((pie) => ({ ...pie, currency })) : pies,
      totals: { value: round(totals.value), invested: round(totals.invested), result: round(totals.result), cash: round(totals.cash) },
      ...(currency ? { currency } : {}),
      notes,
    };
  }

  /** One pie; its amounts carry the account currency, so a single-pie view never shows bare numbers. */
  async getPie(environment: TradingEnvironment, id: number): Promise<PieOverview> {
    this.assertCredentials(environment);
    const [summaries, detail] = [await this.summaries(environment), await this.detail(environment, id)];
    const pie = pieOverview(summaries.find((item) => item.id === id), detail, id);
    const currency = await this.deps.trading.accountCurrency(environment);
    return currency ? { ...pie, currency } : pie;
  }

  /** Resolve tickers, normalise shares and fill unchanged settings so the broker gets a full body. */
  private async buildRequest(draft: PieChangeDraft, current?: PieOverview): Promise<PieRequest> {
    const instruments = await this.deps.trading.instruments(draft.environment);
    const sharesInput = draft.instrumentShares
      ?? Object.fromEntries((current?.instruments ?? []).map((item) => [item.ticker, item.targetShare]));
    const resolved: Record<string, number> = {};
    for (const [query, share] of Object.entries(sharesInput)) {
      const ticker = resolveInstrumentFromList(instruments, query).ticker;
      resolved[ticker] = (resolved[ticker] ?? 0) + share;
    }
    const name = (draft.name ?? current?.settings?.name ?? "").trim();
    if (!name || name.length > 100) fail("INVALID_INPUT", "A pie needs a name of 1 to 100 characters", { field: "name" });
    if (draft.goal !== undefined && (!Number.isFinite(draft.goal) || draft.goal <= 0)) fail("INVALID_INPUT", "goal must be a positive amount", { field: "goal" });
    if (draft.endDate !== undefined && !(Date.parse(draft.endDate) > Date.now())) fail("INVALID_INPUT", "endDate must be a future date", { field: "endDate" });
    const goal = draft.goal ?? current?.settings?.goal;
    const endDate = draft.endDate ?? current?.settings?.endDate;
    const icon = draft.icon ?? current?.settings?.icon;
    return {
      name,
      instrumentShares: normaliseShares(resolved),
      dividendCashAction: draft.dividendCashAction ?? current?.settings?.dividendCashAction ?? "REINVEST",
      ...(icon ? { icon } : {}),
      ...(goal ? { goal } : {}),
      ...(endDate ? { endDate } : {}),
    };
  }

  async preparePieChange(draft: PieChangeDraft): Promise<PieChangePreview> {
    this.assertCredentials(draft.environment);
    if (draft.action !== "create" && (draft.pieId === undefined || !Number.isInteger(draft.pieId) || draft.pieId <= 0))
      fail("INVALID_INPUT", `pieId is required to ${draft.action} a pie`, { field: "pieId" });
    const current = draft.action === "create" ? undefined : await this.getPie(draft.environment, draft.pieId!);
    const notices = ["Trading 212 marks the pies API as deprecated. It still works, but it may change or stop."];
    if (draft.environment === "live") notices.push("LIVE: this changes a pie in your real-money account.");
    let request: PieRequest | undefined;
    let duplicate: PendingPieChange["duplicate"];
    let changes: PieChangePreview["changes"] = [];

    if (draft.action === "create" || draft.action === "update") {
      if (draft.action === "create" && !draft.instrumentShares) fail("INVALID_INPUT", "instrumentShares is required to create a pie", { field: "instrumentShares" });
      request = await this.buildRequest(draft, current);
      const before = new Map((current?.instruments ?? []).map((item) => [item.ticker, item.targetShare]));
      const tickers = new Set([...before.keys(), ...Object.keys(request.instrumentShares)]);
      changes = [...tickers]
        .map((ticker) => ({ ticker, from: before.get(ticker) ?? 0, to: request!.instrumentShares[ticker] ?? 0 }))
        .filter((change) => Math.abs(change.from - change.to) >= 1e-6)
        .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
      const removed = changes.filter((change) => change.to === 0 && (current?.instruments?.find((item) => item.ticker === change.ticker)?.ownedQuantity ?? 0) > 0);
      if (removed.length) notices.push(`Removing ${removed.map((item) => item.ticker).join(", ")} takes those holdings out of the pie. Check in Trading 212 whether they are kept as shares or sold.`);
      if (draft.action === "update" && changes.length) notices.push("New target shares apply to future investments. Trading 212 does not rebalance existing holdings unless you ask it to in the app.");
      if (draft.action === "create") notices.push("Creating a pie invests nothing. Add money to it in Trading 212, or with an order basket.");
    } else if (draft.action === "duplicate") {
      duplicate = { ...(draft.name ? { name: draft.name.trim().slice(0, 100) } : {}), ...(draft.icon ? { icon: draft.icon } : {}) };
      notices.push("The copy has the same slices and settings and starts empty.");
    } else {
      const value = current?.value ?? 0;
      notices.push(value > 0
        ? `This pie holds about ${value} in value. Deleting it takes the holdings out of the pie; Trading 212 decides whether they stay as shares or are sold, so check the app first.`
        : "This pie holds nothing, so deleting it moves no money.");
    }

    const pending: PendingPieChange = {
      environment: draft.environment,
      action: draft.action,
      ...(draft.pieId === undefined || draft.action === "create" ? {} : { pieId: draft.pieId }),
      ...(request ? { request } : {}),
      ...(duplicate ? { duplicate } : {}),
    };
    const token = randomToken();
    const expiresAt = Date.now() + this.deps.config.confirmationTtlSeconds * 1000;
    await this.deps.store.put(`pie-confirm:${token}`, pending, expiresAt);
    await this.deps.trading.recordActivity("pie_prepared", draft.environment, { outcome: draft.action, ...(pending.pieId ? { pieId: pending.pieId } : {}) });
    return {
      kind: "pie_change_preview",
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      environment: draft.environment,
      action: draft.action,
      ...(pending.pieId ? { pieId: pending.pieId } : {}),
      ...(request ? { request } : {}),
      ...(current ? { current } : {}),
      changes,
      notices,
    };
  }

  /** Send a confirmed pie change once. Live changes need the second confirmation, as orders do. */
  async executePieChange(token: string, options: { liveAcknowledged?: boolean } = {}): Promise<PieChangeResult> {
    const key = `pie-confirm:${token}`;
    const peeked = await this.deps.store.get<PendingPieChange>(key);
    if (!peeked) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");
    if (peeked.environment === "live" && !options.liveAcknowledged) fail("LIVE_ACK_REQUIRED", "Live pie changes need the second confirmation that a real-money account will change");
    const pending = await this.deps.store.consume<PendingPieChange>(key);
    if (!pending) fail("CONFIRMATION_EXPIRED", "Confirmation token is invalid or expired");

    const client = this.client(pending.environment);
    const base = { kind: "pie_change_result" as const, environment: pending.environment, action: pending.action };
    try {
      let pie: PieDetail | undefined;
      if (pending.action === "create") pie = await client.createPie(pending.request!);
      else if (pending.action === "update") pie = await client.updatePie(pending.pieId!, pending.request!);
      else if (pending.action === "duplicate") pie = await client.duplicatePie(pending.pieId!, pending.duplicate ?? {});
      else await client.deletePie(pending.pieId!);
      const pieId = pie?.settings?.id ?? pending.pieId;
      await this.forget(pending.environment, pending.pieId);
      await this.deps.trading.recordActivity("pie_submitted", pending.environment, { outcome: pending.action, ...(pieId ? { pieId } : {}) });
      return { ...base, ok: true, status: "submitted", ...(pieId ? { pieId } : {}), ...(pie ? { pie } : {}), message: `${pending.environment.toUpperCase()} pie ${pending.action} sent to Trading 212.` };
    } catch (error) {
      await this.forget(pending.environment, pending.pieId);
      const unknown = error instanceof ExecutionStatusUnknownError;
      await this.deps.trading.recordActivity(unknown ? "pie_status_unknown" : "pie_rejected", pending.environment, { outcome: pending.action, ...(pending.pieId ? { pieId: pending.pieId } : {}) });
      const message = unknown
        ? "Trading 212 did not clearly confirm the pie change. Refresh your pies before trying again."
        : error instanceof Trading212ApiError && error.status === 403
          ? "Trading 212 refused the pie change (403). The API key needs the pies write permission."
          : asStructuredError(error).message;
      return { ...base, ok: false, status: unknown ? "unknown" : "rejected", ...(pending.pieId ? { pieId: pending.pieId } : {}), message };
    }
  }
}
