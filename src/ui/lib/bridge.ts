// What the widget hands its chat host, each only where the host says it takes it: a file to save (the page's rows as
// CSV, or its data as JSON), a question to ask in the chat, and a short account of what the reader is looking at, so
// the model knows the page without being told.

import { describePayload } from "../../core/text-summary";
import type { PortfolioSnapshot, TradingEnvironment } from "../../shared/contracts";
import type { CashHistory, TaxYearSummary, TradeHistory } from "../../shared/history";
import { walletNumber } from "./format";

export type ExportFormat = "csv" | "json";

export interface ExportFile {
  name: string;
  mimeType: string;
  text: string;
  /** Rows written, and how many the read holds when that is more: a list read up to a limit. */
  rows: number;
  of?: number;
  /** The page's own caution the file carries too: a history cut short, or a tax year's figures not final. */
  partial?: ExportCaveat[];
}

export type ExportCaveat = "historyCut" | "matchingIncomplete" | "matchingProvisional";

/** Each caveat as a note row of the tax year's CSV, in English like its header. */
const CAVEAT_NOTES: Record<ExportCaveat, string> = {
  historyCut: "The history read was cut short at its limit: figures can be low.",
  matchingIncomplete: "Not every sale could be matched and valued by the UK rules: an estimate, check before filing.",
  matchingProvisional: "The year's last sales can still be matched with buys in the next 30 days: the UK figures can change.",
};

type Cell = string | number | boolean | undefined | null;

/**
 * One CSV field. Numbers are written plainly (no grouping, a dot for decimals) for any spreadsheet to read; text that
 * a spreadsheet would run as a formula (=, +, -, @ first) is led by an apostrophe, as OWASP advises.
 */
function field(value: Cell): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, "\"\"")}"` : safe;
}

/** CSV with a byte-order mark, so Excel reads it as UTF-8 (a Chinese name stays readable), and CRLF line ends. */
export function csvText(header: string[], rows: Cell[][]): string {
  return `﻿${[header, ...rows].map((row) => row.map(field).join(",")).join("\r\n")}\r\n`;
}

type Exportable = PortfolioSnapshot | TradeHistory | CashHistory | TaxYearSummary;
const EXPORTABLE = new Set(["portfolio", "trade_history", "cash_history", "tax_year"]);

export function canExport(payload: { kind?: unknown } | null | undefined): payload is Exportable {
  return !!payload && typeof payload.kind === "string" && EXPORTABLE.has(payload.kind);
}

const STEMS: Record<Exportable["kind"], string> = { portfolio: "holdings", trade_history: "trades", cash_history: "cash", tax_year: "tax-year" };

function stem(payload: Exportable): string {
  const day = payload.timestamp.slice(0, 10);
  const what = payload.kind === "tax_year" ? `${STEMS.tax_year}-${payload.firstDay}` : STEMS[payload.kind];
  return `tradepilot-${payload.environment}-${what}-${day}`;
}

function caveats(payload: Exportable): ExportCaveat[] {
  const found: ExportCaveat[] = [];
  if (payload.kind !== "portfolio" && payload.truncated) found.push("historyCut");
  if (payload.kind === "tax_year" && payload.ukMatching) {
    if (!payload.ukMatching.complete) found.push("matchingIncomplete");
    if (payload.ukMatching.provisional) found.push("matchingProvisional");
  }
  return found;
}

/** The rows of a page, header first. */
function table(payload: Exportable): { header: string[]; rows: Cell[][]; of?: number; notes?: string[] } {
  switch (payload.kind) {
    case "portfolio": {
      const currency = payload.account?.currency;
      return {
        header: ["Ticker", "Name", "ISIN", "Quantity", "In pies", "Average price", "Price", "Price currency", "Value", "Cost", "Unrealized P/L", "Account currency"],
        rows: payload.positions.map((position) => [
          position.instrument.ticker, position.instrument.name, position.instrument.isin, position.quantity, position.quantityInPies, position.averagePricePaid,
          position.currentPrice, position.instrument.currencyCode, walletNumber(position, "currentValue"), walletNumber(position, "totalCost"),
          walletNumber(position, "unrealizedProfitLoss"), currency,
        ]),
      };
    }
    case "trade_history":
      return {
        header: ["Filled at", "Ticker", "Name", "Side", "Order type", "Quantity", "Price", "Price currency", "Net value", "Realized P/L", "Costs", "FX rate", "Account currency", "Order id"],
        rows: payload.fills.map((fill) => [
          fill.filledAt, fill.ticker, fill.name, fill.side, fill.type, fill.quantity, fill.price, fill.priceCurrency, fill.netValue, fill.realisedProfitLoss,
          fill.costs, fill.fxRate, fill.accountCurrency ?? payload.totals.currency, fill.orderId,
        ]),
        ...(payload.count > payload.fills.length ? { of: payload.count } : {}),
      };
    case "cash_history":
      return {
        header: ["Date", "Type", "Amount", "Currency", "Ticker", "Name", "Shares", "Gross per share", "Per-share currency", "Dividend type", "Reference"],
        rows: payload.items.map((item) => [item.date, item.type, item.amount, item.currency, item.ticker, item.name, item.quantity, item.grossPerShare, item.perShareCurrency, item.subtype, item.reference]),
        ...(payload.count > payload.items.length ? { of: payload.count } : {}),
      };
    case "tax_year": {
      // Trading 212's realised figures by instrument, and beside them the UK matching where the year has it.
      const uk = new Map((payload.ukMatching?.byTicker ?? []).map((row) => [row.ticker, row]));
      const ukColumns = payload.ukMatching ? ["UK shares sold", "UK proceeds", "UK cost", "UK gain", "Same day", "30 days", "Section 104 pool", "Unmatched"] : [];
      // An instrument the matching names under another ticker (one ISIN, two tickers) gets a row of its own.
      const listed = new Set(payload.byTicker.map((row) => row.ticker));
      const extra = [...uk.values()].filter((row) => !listed.has(row.ticker)).map((row) => ({ ticker: row.ticker, disposals: row.disposals, proceeds: undefined, realizedProfitLoss: undefined }));
      const rows: Cell[][] = [...payload.byTicker, ...extra].map((row) => {
        const matched = uk.get(row.ticker);
        const ukCells: Cell[] = !payload.ukMatching ? [] : matched
          ? [matched.quantity, matched.proceeds, matched.cost, matched.unvalued ? undefined : matched.gain, matched.sameDay, matched.thirtyDay, matched.pool, matched.unmatched]
          : ukColumns.map(() => undefined);
        return [row.ticker, row.disposals, row.proceeds, row.realizedProfitLoss, ...ukCells, payload.accountCurrency];
      });
      // What the page warns of goes in the file too, below the rows: a file kept for a tax return is read without the page.
      const notes = [...caveats(payload).map((caveat) => CAVEAT_NOTES[caveat]), ...payload.notes, ...(payload.ukMatching?.notes ?? [])];
      return { header: ["Ticker", "Disposals", "Proceeds", "Realized P/L", ...ukColumns, "Account currency"], rows, ...(notes.length ? { notes } : {}) };
    }
  }
}

/**
 * The page's data as JSON: only what the page is about, so a file named for the holdings carries no account number,
 * pending orders, activity log or settings, and one of trades carries no journal notes.
 */
function jsonData(payload: Exportable): Record<string, unknown> {
  const common = { kind: payload.kind, environment: payload.environment, timestamp: payload.timestamp };
  switch (payload.kind) {
    case "portfolio": {
      const { id: _id, ...account } = payload.account ?? {};
      return { ...common, account: payload.account ? account : null, positions: payload.positions };
    }
    case "trade_history":
      return { ...common, period: payload.period, count: payload.count, limit: payload.limit, truncated: payload.truncated, filter: payload.filter, totals: payload.totals, fills: payload.fills };
    case "cash_history":
      return { ...common, period: payload.period, count: payload.count, truncated: payload.truncated, filter: payload.filter, currency: payload.currency, totals: payload.totals, items: payload.items };
    case "tax_year": {
      const { credentials: _credentials, preferences: _preferences, ...year } = payload as TaxYearSummary & { credentials?: unknown };
      return year as unknown as Record<string, unknown>;
    }
  }
}

/** The file for a page: its rows as CSV, or the data it was drawn from as JSON. */
export function exportFile(payload: Exportable, format: ExportFormat): ExportFile {
  const { header, rows, of, notes } = table(payload);
  const partial = caveats(payload);
  const counts = { rows: rows.length, ...(of ? { of } : {}), ...(partial.length ? { partial } : {}) };
  if (format === "json") return { name: `${stem(payload)}.json`, mimeType: "application/json", text: `${JSON.stringify(jsonData(payload), null, 2)}\n`, ...counts };
  // Notes follow a blank row, one to a row, in the first column.
  const text = csvText(header, notes ? [...rows, [], ...notes.map((note) => [`Note: ${note}`])] : rows);
  return { name: `${stem(payload)}.csv`, mimeType: "text/csv", text, ...counts };
}

/** What a model is told the reader sees: the page, the account, and the page's own summary, kept short. */
export const CONTEXT_LIMIT = 4000;

export function viewContext(view: { page: string; environment: TradingEnvironment; sample: boolean; note?: string }, payload: unknown): string {
  const account = view.environment === "live" ? "Live (real money)" : view.sample ? "sample (simulated)" : "Demo";
  const lead = `The user is looking at TradePilot's ${view.page} page in the widget, for the ${account} account.${view.note ? ` ${view.note}` : ""}`;
  const head = payload ? `${lead} What the page shows:` : lead;
  let summary = "";
  try {
    summary = payload ? describePayload(payload) : "";
  } catch {
    summary = "";
  }
  const room = CONTEXT_LIMIT - head.length - 2;
  const body = summary.length > room ? `${summary.slice(0, room - 1)}…` : summary;
  return body ? `${head}\n${body}` : head;
}
