import { z } from "zod";
import type { Account, Environment, Holding, PortfolioSnapshot } from "../domain/types.js";
import type { Configuration } from "./config.js";

const accountSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalValue: z.number().finite().nonnegative(),
  cash: z.object({ availableToTrade: z.number().finite().nonnegative() }),
  investments: z.object({
    currentValue: z.number().finite().nonnegative(),
    unrealizedProfitLoss: z.number().finite().optional(),
    realizedProfitLoss: z.number().finite().optional(),
    totalCost: z.number().finite().nonnegative().optional(),
  }),
});
const holdingSchema = z.object({
  instrument: z.object({
    ticker: z.string().min(1),
    name: z.string().optional(),
    shortName: z.string().optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  }),
  quantity: z.number().finite().nonnegative(),
  quantityAvailableForTrading: z.number().finite().nonnegative(),
  currentPrice: z.number().finite().nonnegative().optional(),
  averagePricePaid: z.number().finite().nonnegative().optional(),
  walletImpact: z.record(z.string(), z.unknown()).optional(),
});
const listSchema = z.union([z.array(holdingSchema), z.object({ items: z.array(holdingSchema) })]);
const HISTORY_PREFIX = "/api/v0/equity/history/orders";
const HISTORY_PAGE = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  nextPagePath: z.string().nullable().optional(),
});

export interface BrokerReader {
  getPortfolio(environment: Environment): Promise<PortfolioSnapshot>;
  getRecentOrders(environment: Environment, cursor?: string): Promise<{ items: unknown[]; nextCursor: string | null }>;
}
function encodeBasic(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let str = "";
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str);
}
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("Trading 212 response too large");
  if (!response.body) throw new Error("Trading 212 returned no JSON body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) throw new Error("Trading 212 response too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export class Trading212Reader implements BrokerReader {
  constructor(private readonly config: Configuration, private readonly fetcher: typeof fetch = fetch) {}
  private async get(environment: Environment, path: string): Promise<unknown> {
    if (!path.startsWith("/api/v0/equity/") || path.includes(".."))
      throw new Error("Blocked untrusted Trading 212 request path");
    // Explicit allowlist, no generic method dispatch: no broker writes in this project.
    const approved = ["/api/v0/equity/account/summary", "/api/v0/equity/positions"];
    if (!approved.includes(path) && !(path === HISTORY_PREFIX || path.startsWith(HISTORY_PREFIX + "?")))
      throw new Error("Blocked non-read-only Trading 212 endpoint");
    const creds = this.config.broker[environment];
    if (!creds.key || !creds.secret) throw new Error(`Missing ${environment} Trading 212 read credentials`);
    const auth = encodeBasic(`${creds.key}:${creds.secret}`);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await this.fetcher(`${creds.origin}${path}`, {
        method: "GET", redirect: "error",
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return boundedJson(response, 8 * 1024 * 1024);
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000) : 300 * attempt;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new Error(`Trading 212 read request failed (HTTP ${response?.status ?? "unknown"}). No sample data substitution.`);
  }
  async getPortfolio(environment: Environment): Promise<PortfolioSnapshot> {
    const [rawAccount, rawPositions] = await Promise.all([
      this.get(environment, "/api/v0/equity/account/summary"),
      this.get(environment, "/api/v0/equity/positions"),
    ]);
    const raw = accountSchema.parse(rawAccount), positionList = listSchema.parse(rawPositions);
    const positions = Array.isArray(positionList) ? positionList : positionList.items;
    const account: Account = {
      currency: raw.currency, totalValue: raw.totalValue,
      availableCash: raw.cash.availableToTrade, investmentValue: raw.investments.currentValue,
      unrealizedProfitLoss: raw.investments.unrealizedProfitLoss ?? null,
      realizedProfitLoss: raw.investments.realizedProfitLoss ?? null,
      totalCost: raw.investments.totalCost ?? null,
    };
    const notes: string[] = [];
    const holdings: Holding[] = positions.map(row => {
      const currency = row.instrument.currencyCode;
      const price = row.currentPrice ?? null;
      const averagePricePaid = row.averagePricePaid ?? null;
      const rawBrokerValue = row.walletImpact?.currentValue;
      const declaredValueCurrency = row.walletImpact?.currency;
      // Broker wallets can be in a different currency from the primary account.
      // Never trust walletImpact.currentValue without matching ISO currency evidence.
      const brokerValue = declaredValueCurrency === raw.currency &&
        typeof rawBrokerValue === "number" && Number.isFinite(rawBrokerValue) && rawBrokerValue >= 0
        ? rawBrokerValue : null;
      const verifiedSameCurrency = currency === raw.currency && price !== null;
      const rawPnl = row.walletImpact?.unrealizedProfitLoss;
      const pnlInAccountCurrency = declaredValueCurrency === raw.currency &&
        typeof rawPnl === "number" && Number.isFinite(rawPnl) ? rawPnl : null;
      const value = brokerValue ?? (verifiedSameCurrency ? row.quantity * price : null);
      const provenance: Holding["valueProvenance"] = brokerValue !== null ? "broker_account_value"
        : verifiedSameCurrency ? "same_currency_quote" : "unknown";
      if (value === null) notes.push(`Missing account-currency value for ${row.instrument.ticker}; FX conversion was not guessed.`);
      return {
        ticker: row.instrument.ticker, name: row.instrument.name || row.instrument.shortName || row.instrument.ticker,
        currency, quantity: row.quantity, tradableQuantity: row.quantityAvailableForTrading,
        price, averagePricePaid, unrealizedProfitLossInAccountCurrency: pnlInAccountCurrency,
        valueInAccountCurrency: value, valueProvenance: provenance,
      };
    });
    return { kind: "portfolio", source: "trading212", environment, asOf: new Date().toISOString(), account, holdings, notes };
  }
  async getRecentOrders(environment: Environment, cursor?: string) {
    if (cursor && !/^\d{1,20}$/.test(cursor)) throw new Error("Invalid order-history cursor");
    const path = `${HISTORY_PREFIX}?limit=20${cursor ? `&cursor=${cursor}` : ""}`;
    const page = HISTORY_PAGE.parse(await this.get(environment, path));
    const nextPage = page.nextPagePath;
    if (nextPage && !nextPage.startsWith(HISTORY_PREFIX + "?"))
      throw new Error("Trading 212 returned an invalid history pagination path");
    const nextCursor = nextPage ? new URL(nextPage, "https://example.test").searchParams.get("cursor") : null;
    if (nextCursor && !/^\d{1,20}$/.test(nextCursor)) throw new Error("Invalid broker cursor");
    return { items: page.items, nextCursor };
  }
}
