// Trading 212's CSV history export: one row per order, dividend, interest payment, deposit, conversion and so on,
// with the charges the API's history leaves out or gives only per fill (currency conversion fees, stamp duty,
// French transaction tax, withholding tax). Its columns depend on what the period holds, and amounts are paired with
// a "Currency (…)" column (older files put the currency in the header, "Currency conversion fee (EUR)"), so the
// file is read by its header.

import type { ExportSummary, ExportTotals as Totals, WithholdingByCountry } from "../shared/history.js";
export type { ExportSummary, Totals };

/** The rows of a CSV file, as text: quoted fields, doubled quotes, CRLF and a byte-order mark are handled. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

/** A column of money and where its currency is: its "Currency (…)" column, or a code in its header. */
interface Money { name: string; index: number; currency?: number; code?: string }

/** Charges: fees, taxes, duties and levies, but not an amount ("Charge amount" is a card payment) or a rate. */
const CHARGE = /fee|tax|duty|levy/i;
const NOT_CHARGE = /amount|rate/i;

export function summarizeExport(text: string): { summary: ExportSummary; records: Array<Record<string, string>> } {
  const [header = [], ...body] = parseCsv(text);
  const columns = header.map((name) => name.trim());
  const at = (name: string) => columns.findIndex((column) => column.toLowerCase() === name.toLowerCase());
  const money = (name: string): Money | undefined => {
    const index = at(name);
    if (index >= 0) {
      const currency = at(`Currency (${name})`);
      return { name, index, ...(currency >= 0 ? { currency } : {}) };
    }
    // "Total (EUR)": the currency in the header.
    const coded = columns.findIndex((column) => new RegExp(`^${escape(name)} \\(([A-Z]{3})\\)$`, "i").test(column));
    return coded >= 0 ? { name, index: coded, code: columns[coded]!.slice(-4, -1).toUpperCase() } : undefined;
  };
  const chargeNames = [...new Set(columns
    .filter((column) => CHARGE.test(column) && !NOT_CHARGE.test(column) && !/^currency \(/i.test(column))
    .map((column) => column.replace(/ \([A-Z]{3}\)$/i, "")))];
  const charges = chargeNames.map(money).filter((item): item is Money => item !== undefined);
  const total = money("Total");
  const result = money("Result");
  const action = at("Action");
  const time = at("Time");
  const withheldColumn = money("Withholding tax");
  const priceColumn = money("Price / share");
  const shares = at("No. of shares");
  const isin = at("ISIN");
  const tickerColumn = at("Ticker");
  const withholding = new Map<string, WithholdingByCountry>();
  const cell = (row: string[], index: number) => (index >= 0 ? (row[index] ?? "").trim() : "");
  const currencyOf = (column: Money, row: string[]) => column.code ?? (column.currency !== undefined ? cell(row, column.currency) : "");

  const add = (totals: Totals, column: Money | undefined, row: string[]) => {
    if (!column) return;
    const value = Number((row[column.index] ?? "").replace(/[\s"]/g, ""));
    if (!(row[column.index] ?? "").trim() || !Number.isFinite(value)) return;
    const currency = column.code ?? (column.currency !== undefined ? row[column.currency]?.trim() : undefined) ?? "";
    const key = currency || "?";
    totals[key] = round((totals[key] ?? 0) + value);
  };
  const actions = new Map<string, { action: string; count: number; totals: Totals }>();
  const chargeTotals = charges.map((column) => ({ name: column.name, totals: {} as Totals }));
  const summary: ExportSummary = { rows: body.length, actions: [], charges: [], interest: {}, dividends: {}, result: {}, columns };
  for (const row of body) {
    const name = action >= 0 ? (row[action] ?? "").trim() || "?" : "?";
    const entry = actions.get(name) ?? { action: name, count: 0, totals: {} };
    entry.count += 1;
    add(entry.totals, total, row);
    actions.set(name, entry);
    if (/interest/i.test(name)) add(summary.interest, total, row);
    if (/^dividend/i.test(name)) {
      add(summary.dividends, total, row);
      if (withheldColumn && priceColumn) addWithholding(row);
    }
    add(summary.result, result, row);
    charges.forEach((column, index) => add(chargeTotals[index]!.totals, column, row));
    const when = time >= 0 ? row[time]?.trim() : undefined;
    if (when) {
      if (!summary.first || when < summary.first) summary.first = when;
      if (!summary.last || when > summary.last) summary.last = when;
    }
  }
  if (withheldColumn) {
    summary.withholding = [...withholding.values()]
      .map((entry) => ({ ...entry, gross: round(entry.gross), withheld: round(entry.withheld), rate: entry.gross > 0 ? round(entry.withheld / entry.gross) : 0,
        ...(entry.country === "US" && entry.gross > 0 && entry.withheld / entry.gross >= 0.25 ? { high: true } : {}) }))
      .sort((a, b) => b.withheld - a.withheld || a.country.localeCompare(b.country));
  }
  summary.actions = [...actions.values()].sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
  summary.charges = chargeTotals.filter((charge) => Object.keys(charge.totals).length);
  /** One dividend row's gross and withholding, both in its paying currency (pence counted as pounds). */
  function addWithholding(row: string[]) {
    const quantity = Number(cell(row, shares)), perShare = Number(cell(row, priceColumn!.index));
    const withheldText = cell(row, withheldColumn!.index);
    const withheld = withheldText ? Number(withheldText) : 0;
    if (!(quantity > 0) || !(perShare > 0) || !Number.isFinite(withheld)) return;
    const pence = (code: string) => /^GBX$/i.test(code) || code === "GBp";
    const pounds = (code: string) => (pence(code) ? "GBP" : code.toUpperCase());
    const grossCode = currencyOf(priceColumn!, row), withheldCode = withheldText ? currencyOf(withheldColumn!, row) : grossCode;
    if (!grossCode || pounds(grossCode) !== pounds(withheldCode || grossCode)) return;
    const currency = pounds(grossCode);
    const gross = quantity * perShare / (pence(grossCode) ? 100 : 1);
    const tax = Math.abs(withheld) / (pence(withheldCode || grossCode) ? 100 : 1);
    const country = /^[A-Z]{2}/.test(cell(row, isin).toUpperCase()) ? cell(row, isin).slice(0, 2).toUpperCase() : "?";
    const key = `${country}:${currency}`;
    const entry = withholding.get(key) ?? { country, currency, payments: 0, gross: 0, withheld: 0, rate: 0, tickers: [] };
    entry.payments += 1; entry.gross += gross; entry.withheld += tax;
    const ticker = cell(row, tickerColumn);
    if (ticker && !entry.tickers.includes(ticker)) entry.tickers.push(ticker);
    withholding.set(key, entry);
  }
  const records = body.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]).filter(([, value]) => value !== "")));
  return { summary, records };
}

const round = (value: number) => Math.round(value * 1e8) / 1e8;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
