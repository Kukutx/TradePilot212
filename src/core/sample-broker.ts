// A simulated Trading 212 account for trying TradePilot without an API key (TRADEPILOT_SAMPLE_DATA).
// It answers the same endpoints as the real API from in-memory data: a EUR account with a few US
// stocks, a UK ETF, two pies and a year of history. Market orders fill at once at the sample price;
// other orders stay pending until cancelled. Nothing leaves the process and no real account is used.

import type { QuoteProvider } from "./quotes.js";

export const SAMPLE_BASE_URL = "https://sample.tradepilot.invalid/api/v0";

type Json = Record<string, unknown>;
interface SampleInstrument {
  ticker: string;
  name: string;
  shortName: string;
  currencyCode: string;
  isin: string;
  type: string;
  price: number;
  extendedHours?: boolean;
  workingScheduleId: number;
}
interface Holding { ticker: string; quantity: number; average: number; inPies: number; createdAt: string }

const INSTRUMENTS: SampleInstrument[] = [
  { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD", isin: "US0378331005", type: "STOCK", price: 231.55, extendedHours: true, workingScheduleId: 1 },
  { ticker: "MSFT_US_EQ", name: "Microsoft", shortName: "MSFT", currencyCode: "USD", isin: "US5949181045", type: "STOCK", price: 428.9, extendedHours: true, workingScheduleId: 1 },
  { ticker: "NVDA_US_EQ", name: "NVIDIA", shortName: "NVDA", currencyCode: "USD", isin: "US67066G1040", type: "STOCK", price: 128.75, extendedHours: true, workingScheduleId: 1 },
  { ticker: "KO_US_EQ", name: "Coca-Cola", shortName: "KO", currencyCode: "USD", isin: "US1912161007", type: "STOCK", price: 61.2, workingScheduleId: 1 },
  { ticker: "TSLA_US_EQ", name: "Tesla", shortName: "TSLA", currencyCode: "USD", isin: "US88160R1014", type: "STOCK", price: 244.1, extendedHours: true, workingScheduleId: 1 },
  { ticker: "VUSAl_EQ", name: "Vanguard S&P 500 UCITS ETF (Dist)", shortName: "VUSA", currencyCode: "GBX", isin: "IE00B3XXRP09", type: "ETF", price: 9175, workingScheduleId: 2 },
  { ticker: "EUNLd_EQ", name: "iShares Core MSCI World UCITS ETF (Acc)", shortName: "EUNL", currencyCode: "EUR", isin: "IE00B4L5Y983", type: "ETF", price: 98.42, workingScheduleId: 3 },
  // Not held and never traded: something to watch.
  { ticker: "AMZN_US_EQ", name: "Amazon", shortName: "AMZN", currencyCode: "USD", isin: "US0231351067", type: "STOCK", price: 186.4, extendedHours: true, workingScheduleId: 1 },
  { ticker: "ASMLa_EQ", name: "ASML Holding", shortName: "ASML", currencyCode: "EUR", isin: "NL0010273215", type: "STOCK", price: 642.3, workingScheduleId: 3 },
];
/** Account (EUR) value of one unit of each quote currency. */
const EUR_PER_UNIT: Record<string, number> = { EUR: 1, USD: 0.92, GBX: 0.0118 };

/**
 * Prices for the sample account's quote provider: each sample instrument at its sample price, and rates between the
 * sample currencies, so the instruments it does not hold have a price too. Nothing leaves the process.
 */
export function createSampleQuotes(): QuoteProvider {
  const byTicker = new Map(INSTRUMENTS.map((item) => [item.ticker.toUpperCase(), item]));
  return {
    name: "sample",
    hasFxRates: true,
    symbolFor: (instrument) => byTicker.get(instrument.ticker.toUpperCase())?.shortName,
    async quote(instrument) {
      const item = byTicker.get(instrument.ticker.toUpperCase());
      return item ? { ticker: item.ticker, symbol: item.shortName, price: item.price, asOf: new Date().toISOString(), source: "sample" } : undefined;
    },
    async fxRate(from, to) {
      const source = from.toUpperCase();
      const target = to.toUpperCase();
      const fromEur = EUR_PER_UNIT[source];
      const toEur = EUR_PER_UNIT[target];
      if (!fromEur || !toEur || source === target) return undefined;
      return { from: source, to: target, rate: fromEur / toEur, asOf: new Date().toISOString(), source: "sample" };
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function weekdaySchedule(openHour: number, closeHour: number, now: Date) {
  const events: Array<{ date: string; type: string }> = [];
  for (let offset = -3; offset < 10; offset++) {
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset);
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    events.push({ date: new Date(day + openHour * 3_600_000).toISOString(), type: "OPEN" }, { date: new Date(day + closeHour * 3_600_000).toISOString(), type: "CLOSE" });
  }
  return events;
}

/**
 * A fetch that serves the sample account for requests to SAMPLE_BASE_URL and passes every other
 * request (webhooks, quote providers) to `passthrough`.
 */
export function createSampleBroker(passthrough: typeof fetch = (input, init) => globalThis.fetch(input, init)): typeof fetch {
  const started = Date.now();
  const daysAgo = (days: number) => new Date(started - days * 86_400_000).toISOString();
  const byTicker = new Map(INSTRUMENTS.map((item) => [item.ticker, item]));
  const instrumentOf = (ticker: string) => byTicker.get(ticker);
  const eur = (ticker: string, amount: number) => amount * (EUR_PER_UNIT[instrumentOf(ticker)?.currencyCode ?? "EUR"] ?? 1);

  let cash = 3962.1;
  const realized = 412.6;
  const holdings: Holding[] = [
    { ticker: "AAPL_US_EQ", quantity: 12, average: 168.4, inPies: 1.6, createdAt: daysAgo(400) },
    { ticker: "MSFT_US_EQ", quantity: 6, average: 352.1, inPies: 1.4, createdAt: daysAgo(380) },
    { ticker: "NVDA_US_EQ", quantity: 20, average: 96.3, inPies: 4, createdAt: daysAgo(300) },
    { ticker: "VUSAl_EQ", quantity: 40, average: 8420, inPies: 3, createdAt: daysAgo(350) },
    { ticker: "KO_US_EQ", quantity: 25, average: 64.9, inPies: 7, createdAt: daysAgo(330) },
  ];
  let nextId = 90_000;
  const pending: Json[] = [
    { id: 81234, ticker: "TSLA_US_EQ", quantity: 3, filledQuantity: 0, status: "NEW", type: "LIMIT", limitPrice: 215, timeValidity: "GOOD_TILL_CANCEL", strategy: "QUANTITY", createdAt: daysAgo(1) },
    // A stop-loss on a holding, so the widget can show how far the trigger is from the last price.
    { id: 81235, ticker: "NVDA_US_EQ", quantity: -5, filledQuantity: 0, status: "NEW", type: "STOP", stopPrice: 118, timeValidity: "GOOD_TILL_CANCEL", strategy: "QUANTITY", createdAt: daysAgo(3) },
  ];
  /** Shares held back by pending sells, as Trading 212 does; released when the order is cancelled. */
  const reservedShares = (ticker: string) => pending.reduce((sum, order) => sum + (order.ticker === ticker && Number(order.quantity) < 0 ? -Number(order.quantity) : 0), 0);
  const sellable = (holding: Holding) => round(holding.quantity - holding.inPies - reservedShares(holding.ticker), 6);
  /** Cash held back for a pending buy, in EUR; released when the order is cancelled. */
  const reservation = (order: Json) => (Number(order.quantity) > 0 ? eur(String(order.ticker), Number(order.quantity) * Number(order.limitPrice ?? order.stopPrice ?? instrumentOf(String(order.ticker))?.price ?? 0)) : 0);
  const history: Json[] = [];
  const addHistory = (ticker: string, quantity: number, price: number, at: string, realisedProfitLoss = 0, id: number = nextId++) => {
    history.unshift({
      order: { id, ticker, side: quantity < 0 ? "SELL" : "BUY", type: "MARKET", status: "FILLED", quantity, filledQuantity: quantity, currency: instrumentOf(ticker)?.currencyCode, createdAt: at, instrument: { ticker, name: instrumentOf(ticker)?.name } },
      fill: { id, filledAt: at, price, quantity, type: "TRADE", walletImpact: { currency: "EUR", fxRate: EUR_PER_UNIT[instrumentOf(ticker)?.currencyCode ?? "EUR"], netValue: round(eur(ticker, Math.abs(quantity) * price)), realisedProfitLoss, taxes: quantity > 0 && instrumentOf(ticker)?.currencyCode === "USD" ? [] : [{ name: "FINRA_FEE", quantity: 0.02, currency: "EUR" }] } },
    });
  };
  // A fill every 24 days over the last year, at prices that climb towards today's, as a rising market's would. Only
  // instruments held now are traded, so today's shares less the buys plus the sells leave what was held before.
  const traded = ["AAPL_US_EQ", "MSFT_US_EQ", "NVDA_US_EQ", "KO_US_EQ", "VUSAl_EQ"].map((ticker) => instrumentOf(ticker)!);
  for (let index = 13; index >= 0; index--) {
    const instrument = traded[index % traded.length]!;
    const sell = index % 4 === 3;
    addHistory(instrument.ticker, sell ? -2 : 3, round(instrument.price * (0.95 - index * 0.013)), daysAgo(20 + index * 24), sell ? 30 + index * 2 : 0);
  }
  const dividends: Json[] = [];
  for (const [ticker, perShare, quantity, firstDay] of [["AAPL_US_EQ", 0.25, 12, 30], ["KO_US_EQ", 0.485, 25, 45], ["MSFT_US_EQ", 0.83, 6, 60], ["VUSAl_EQ", 27, 40, 80]] as const) {
    for (let quarter = 0; quarter < 4; quarter++) {
      const paidOn = daysAgo(firstDay + quarter * 91);
      dividends.push({ reference: `${ticker}-${quarter}`, ticker, type: "ORDINARY", amount: round(eur(ticker, perShare * quantity) * 0.85), currency: "EUR", tickerCurrency: instrumentOf(ticker)?.currencyCode, grossAmountPerShare: perShare, quantity, paidOn });
    }
  }
  dividends.sort((a, b) => String(b.paidOn).localeCompare(String(a.paidOn)));
  const transactions: Json[] = [
    { reference: "sample-deposit-1", type: "DEPOSIT", amount: 10_000, currency: "EUR", dateTime: daysAgo(420) },
    { reference: "sample-deposit-2", type: "DEPOSIT", amount: 4_000, currency: "EUR", dateTime: daysAgo(200) },
    { reference: "sample-withdraw-1", type: "WITHDRAW", amount: -500, currency: "EUR", dateTime: daysAgo(90) },
    { reference: "sample-interest-1", type: "INTEREST", amount: 6.4, currency: "EUR", dateTime: daysAgo(31) },
  ];
  let nextPieId = 4103;
  const pies = new Map<number, { name: string; icon: string; goal?: number; dividendCashAction: string; shares: Record<string, number>; cash: number; createdAt: string }>([
    [4101, { name: "Core tech", icon: "Rocket", goal: 5000, dividendCashAction: "REINVEST", shares: { NVDA_US_EQ: 0.5, MSFT_US_EQ: 0.3, AAPL_US_EQ: 0.2 }, cash: 23.3, createdAt: daysAgo(300) }],
    [4102, { name: "Dividend income", icon: "Coins", dividendCashAction: "TO_ACCOUNT_CASH", shares: { KO_US_EQ: 0.6, VUSAl_EQ: 0.4 }, cash: 100, createdAt: daysAgo(120) }],
  ]);
  const exports: Json[] = [{ reportId: 11, status: "Finished", downloadLink: "https://sample.tradepilot.invalid/report-11.csv", timeFrom: daysAgo(365), timeTo: daysAgo(0), dataIncluded: { includeOrders: true, includeDividends: true, includeTransactions: true, includeInterest: true } }];

  const position = (holding: Holding) => {
    const instrument = instrumentOf(holding.ticker)!;
    const currentValue = round(eur(holding.ticker, holding.quantity * instrument.price));
    const totalCost = round(eur(holding.ticker, holding.quantity * holding.average));
    const { price, ...meta } = instrument;
    return {
      instrument: meta,
      quantity: holding.quantity,
      quantityAvailableForTrading: sellable(holding),
      quantityInPies: holding.inPies,
      averagePricePaid: holding.average,
      currentPrice: price,
      createdAt: holding.createdAt,
      walletImpact: { currency: "EUR", totalCost, currentValue, unrealizedProfitLoss: round(currentValue - totalCost), fxImpact: 0 },
    };
  };
  const pieSummary = (id: number) => {
    const pie = pies.get(id)!;
    const invested = id === 4101 ? 1950 : id === 4102 ? 800 : 0;
    const value = id === 4101 ? 2210.4 : id === 4102 ? 764.2 : 0;
    return {
      id,
      cash: pie.cash,
      dividendDetails: { gained: id === 4101 ? 18.4 : 6.1, inCash: pie.dividendCashAction === "REINVEST" ? 0 : 6.1, reinvested: pie.dividendCashAction === "REINVEST" ? 18.4 : 0 },
      progress: pie.goal ? round(value / pie.goal, 4) : null,
      status: id === 4102 ? "BEHIND" : "ON_TRACK",
      result: { priceAvgInvestedValue: invested, priceAvgValue: value, priceAvgResult: round(value - invested), priceAvgResultCoef: invested ? round((value - invested) / invested, 4) : 0 },
    };
  };
  const drift = (id: number, ticker: string, target: number) => (id === 4101 ? ({ NVDA_US_EQ: 0.08, MSFT_US_EQ: -0.04, AAPL_US_EQ: -0.04 } as Record<string, number>)[ticker] ?? 0 : id === 4102 ? ({ KO_US_EQ: -0.05, VUSAl_EQ: 0.05 } as Record<string, number>)[ticker] ?? 0 : 0) + target;
  const pieDetail = (id: number) => {
    const pie = pies.get(id)!;
    return {
      settings: { id, name: pie.name, icon: pie.icon, ...(pie.goal ? { goal: pie.goal } : {}), instrumentShares: pie.shares, dividendCashAction: pie.dividendCashAction, creationDate: pie.createdAt, publicUrl: null },
      instruments: Object.entries(pie.shares).map(([ticker, share]) => ({
        ticker,
        expectedShare: share,
        currentShare: round(drift(id, ticker, share), 4),
        ownedQuantity: holdings.find((item) => item.ticker === ticker)?.inPies ?? 0,
        issues: [],
      })),
    };
  };

  const fill = (ticker: string, quantity: number, orderId?: number): Json => {
    const instrument = instrumentOf(ticker)!;
    const value = eur(ticker, Math.abs(quantity) * instrument.price);
    let holding = holdings.find((item) => item.ticker === ticker);
    if (quantity > 0) {
      if (value > cash) return { error: json({ code: "InsufficientFreeForStocksException", clarification: "Not enough free cash" }, 400) };
      cash -= value;
      if (!holding) holdings.push(holding = { ticker, quantity: 0, average: instrument.price, inPies: 0, createdAt: new Date().toISOString() });
      holding.average = (holding.average * holding.quantity + instrument.price * quantity) / (holding.quantity + quantity);
      holding.quantity = round(holding.quantity + quantity, 6);
    } else {
      if (!holding || sellable(holding) < -quantity - 1e-9) return { error: json({ code: "SellingEquityNotOwned", clarification: "Not enough shares to sell" }, 400) };
      cash += value;
      holding.quantity = round(holding.quantity + quantity, 6);
      if (holding.quantity <= 0) holdings.splice(holdings.indexOf(holding), 1);
    }
    addHistory(ticker, quantity, instrument.price, new Date().toISOString(), 0, orderId);
    return {};
  };

  const handle = async (method: string, path: string, query: URLSearchParams, body: Json): Promise<Response> => {
    if (method === "GET" && path === "/equity/account/summary") {
      const invested = holdings.reduce((sum, item) => sum + position(item).walletImpact.currentValue, 0);
      const cost = holdings.reduce((sum, item) => sum + position(item).walletImpact.totalCost, 0);
      const pieCash = [...pies.values()].reduce((sum, pie) => sum + pie.cash, 0);
      const reserved = pending.reduce((sum, order) => sum + reservation(order), 0);
      return json({ id: 21_200_000, currency: "EUR", totalValue: round(invested + cash + pieCash + reserved), cash: { availableToTrade: round(cash), inPies: round(pieCash), reservedForOrders: round(reserved) }, investments: { currentValue: round(invested), totalCost: round(cost), unrealizedProfitLoss: round(invested - cost), realizedProfitLoss: realized } });
    }
    if (method === "GET" && path === "/equity/positions") return json(holdings.map(position));
    if (method === "GET" && path === "/equity/orders") return json(pending);
    if (method === "GET" && path.startsWith("/equity/orders/")) {
      const order = pending.find((item) => String(item.id) === path.split("/").pop());
      return order ? json(order) : json({ code: "OrderNotFound" }, 404);
    }
    if (method === "GET" && path === "/equity/metadata/instruments") return json(INSTRUMENTS.map(({ price, ...meta }) => ({ ...meta, maxOpenQuantity: 10_000, addedOn: "2019-01-01T00:00:00.000Z" })));
    if (method === "GET" && path === "/equity/metadata/exchanges") {
      const now = new Date();
      return json([
        { id: 1, name: "NASDAQ", workingSchedules: [{ id: 1, timeEvents: weekdaySchedule(13.5, 20, now) }] },
        { id: 2, name: "London Stock Exchange", workingSchedules: [{ id: 2, timeEvents: weekdaySchedule(8, 16.5, now) }] },
        { id: 3, name: "Xetra", workingSchedules: [{ id: 3, timeEvents: weekdaySchedule(8, 16.5, now) }] },
      ]);
    }
    if (method === "GET" && path.startsWith("/equity/history/") && path !== "/equity/history/exports") {
      const kind = path.split("/").pop();
      const items = kind === "orders" ? history : kind === "dividends" ? dividends : kind === "transactions" ? transactions : undefined;
      if (!items) return json({ code: "NotFound" }, 404);
      const ticker = query.get("ticker");
      return json({ items: ticker ? items.filter((item) => (item.ticker ?? (item.order as Json | undefined)?.ticker) === ticker) : items, nextPagePath: null });
    }
    if (method === "GET" && path === "/equity/history/exports") return json(exports);
    if (method === "POST" && path === "/equity/history/exports") {
      const reportId = nextId++;
      exports.unshift({ reportId, status: "Finished", downloadLink: `https://sample.tradepilot.invalid/report-${reportId}.csv`, timeFrom: body.timeFrom, timeTo: body.timeTo, dataIncluded: body.dataIncluded });
      return json({ reportId });
    }
    if (method === "POST" && path.startsWith("/equity/orders/")) {
      const type = path.split("/").pop()!.toUpperCase();
      const ticker = String(body.ticker ?? "");
      const quantity = Number(body.quantity);
      if (!instrumentOf(ticker)) return json({ code: "InstrumentNotFound" }, 404);
      if (!Number.isFinite(quantity) || quantity === 0) return json({ code: "InvalidQuantity" }, 400);
      const order: Json = { id: nextId++, ticker, quantity, filledQuantity: 0, type, status: "NEW", strategy: "QUANTITY", createdAt: new Date().toISOString(), ...(body.limitPrice ? { limitPrice: body.limitPrice } : {}), ...(body.stopPrice ? { stopPrice: body.stopPrice } : {}), ...(body.timeValidity ? { timeValidity: body.timeValidity } : {}) };
      if (type === "MARKET") {
        const result = fill(ticker, quantity, Number(order.id));
        if (result.error) return result.error as Response;
        return json({ ...order, status: "FILLED", filledQuantity: quantity, filledValue: round(quantity * instrumentOf(ticker)!.price) });
      }
      const holding = holdings.find((item) => item.ticker === ticker);
      if (quantity < 0 && (!holding || sellable(holding) < -quantity - 1e-9)) return json({ code: "SellingEquityNotOwned", clarification: "Not enough shares to sell" }, 400);
      const held = reservation(order);
      if (held > cash) return json({ code: "InsufficientFreeForStocksException", clarification: "Not enough free cash" }, 400);
      cash -= held;
      pending.push(order);
      return json(order);
    }
    if (method === "DELETE" && path.startsWith("/equity/orders/")) {
      const index = pending.findIndex((item) => String(item.id) === path.split("/").pop());
      if (index < 0) return json({ code: "OrderNotFound" }, 404);
      const order = pending[index]!;
      cash += reservation(order);
      pending.splice(index, 1);
      // A cancelled order stays in the history without a fill, as on Trading 212.
      history.unshift({ order: { ...order, side: Number(order.quantity) < 0 ? "SELL" : "BUY", status: "CANCELLED", currency: instrumentOf(String(order.ticker))?.currencyCode, instrument: { ticker: order.ticker, name: instrumentOf(String(order.ticker))?.name } } });
      return new Response(null, { status: 200 });
    }
    if (method === "GET" && path === "/equity/pies") return json([...pies.keys()].map(pieSummary));
    const pieMatch = /^\/equity\/pies\/(\d+)(\/duplicate)?$/.exec(path);
    if (method === "POST" && path === "/equity/pies") {
      const id = nextPieId++;
      pies.set(id, { name: String(body.name ?? "New pie"), icon: String(body.icon ?? "Home"), ...(typeof body.goal === "number" ? { goal: body.goal } : {}), dividendCashAction: String(body.dividendCashAction ?? "REINVEST"), shares: (body.instrumentShares as Record<string, number>) ?? {}, cash: 0, createdAt: new Date().toISOString() });
      return json(pieDetail(id));
    }
    if (pieMatch) {
      const id = Number(pieMatch[1]);
      const pie = pies.get(id);
      if (!pie) return json({ code: "PieNotFound" }, 404);
      if (method === "GET" && !pieMatch[2]) return json(pieDetail(id));
      if (method === "DELETE" && !pieMatch[2]) { pies.delete(id); return new Response(null, { status: 200 }); }
      if (method === "POST" && pieMatch[2]) {
        const copy = nextPieId++;
        pies.set(copy, { ...pie, shares: { ...pie.shares }, name: String(body.name ?? `${pie.name} copy`), cash: 0, createdAt: new Date().toISOString() });
        return json(pieDetail(copy));
      }
      if (method === "POST") {
        pies.set(id, { ...pie, name: String(body.name ?? pie.name), ...(body.icon ? { icon: String(body.icon) } : {}), ...(typeof body.goal === "number" ? { goal: body.goal } : {}), dividendCashAction: String(body.dividendCashAction ?? pie.dividendCashAction), shares: (body.instrumentShares as Record<string, number>) ?? pie.shares });
        return json(pieDetail(id));
      }
    }
    return json({ code: "NotFound", path }, 404);
  };

  /** A report as Trading 212 writes it: the period's fills, dividends and cash movements, oldest first. */
  const report = (from: string, to: string) => {
    const header = "Action,Time,ISIN,Ticker,Name,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)";
    const time = (iso: string) => iso.replace("T", " ").slice(0, 19);
    const quote = (text: unknown) => (/[",]/.test(String(text)) ? `"${String(text).replace(/"/g, "\"\"")}"` : String(text ?? ""));
    const rows: Array<[string, string]> = [];
    for (const item of history) {
      const order = item.order as Json, fill = item.fill as Json, impact = fill.walletImpact as Json;
      const ticker = String(order.ticker), currency = instrumentOf(ticker)?.currencyCode ?? "EUR", quantity = Number(fill.quantity);
      const fee = currency === "EUR" ? "" : round(Number(impact.netValue) * 0.0015);
      rows.push([String(fill.filledAt), [quantity < 0 ? "Market sell" : "Market buy", time(String(fill.filledAt)), "", ticker.split("_")[0], quote(instrumentOf(ticker)?.name), `EOF${fill.id}`, Math.abs(quantity), fill.price, currency, impact.fxRate, quantity < 0 ? impact.realisedProfitLoss : "", quantity < 0 ? "EUR" : "", impact.netValue, "EUR", "", "", fee, fee === "" ? "" : "EUR"].join(",")]);
    }
    for (const item of dividends) {
      const ticker = String(item.ticker), gross = Number(item.grossAmountPerShare) * Number(item.quantity);
      rows.push([String(item.paidOn), ["Dividend (Ordinary)", time(String(item.paidOn)), "", ticker.split("_")[0], quote(instrumentOf(ticker)?.name), "", item.quantity, item.grossAmountPerShare, item.tickerCurrency, "", "", "", item.amount, "EUR", round(gross * 0.15), item.tickerCurrency, "", ""].join(",")]);
    }
    for (const item of transactions) {
      const action = item.type === "DEPOSIT" ? "Deposit" : item.type === "WITHDRAW" ? "Withdrawal" : item.type === "INTEREST" ? "Interest on cash" : String(item.type);
      rows.push([String(item.dateTime), [action, time(String(item.dateTime)), "", "", "", String(item.reference), "", "", "", "", "", "", item.amount, "EUR", "", "", "", ""].join(",")]);
    }
    const inside = rows.filter(([at]) => at >= from && at <= to).sort(([a], [b]) => a.localeCompare(b));
    return [header, ...inside.map(([, row]) => row)].join("\n") + "\n";
  };

  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const base = new URL(SAMPLE_BASE_URL);
    if (url.host === base.host && /^\/report-\d+\.csv$/.test(url.pathname)) {
      const listed = exports.find((item) => item.downloadLink === url.href);
      return listed ? new Response(report(String(listed.timeFrom), String(listed.timeTo)), { headers: { "content-type": "text/csv" } }) : new Response("Not found", { status: 404 });
    }
    if (url.host !== base.host) return passthrough(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    return handle(method, url.pathname.replace(/^\/api\/v0/, ""), url.searchParams, body);
  };
}
