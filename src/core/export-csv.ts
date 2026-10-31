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
  const exchangeRate = at("Exchange rate");
  const paidRows: PaidRow[] = [];
  // Orders' value both ways the exchange rate could be quoted, against their Total: which way the file quotes it.
  const quoted = { times: 0, over: 0 };
  let unreadable = 0;
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
      // A return of capital is not income, and nothing is withheld from it: it would dilute the rate.
      if (withheldColumn && priceColumn && !/return of capital|interest/i.test(name)) readPaid(row);
    }
    if (/buy|sell/i.test(name)) readQuote(row);
    add(summary.result, result, row);
    charges.forEach((column, index) => add(chargeTotals[index]!.totals, column, row));
    const when = time >= 0 ? row[time]?.trim() : undefined;
    if (when) {
      if (!summary.first || when < summary.first) summary.first = when;
      if (!summary.last || when > summary.last) summary.last = when;
    }
  }
  if (withheldColumn) {
    // An order's Total is its value at the rate, give or take its charges: the way that comes closer is the file's.
    const way = quoted.times + quoted.over === 0 ? undefined : quoted.times <= quoted.over ? 0 : 1;
    Object.assign(summary, withholdingOf(paidRows, unreadable, way));
  }
  summary.actions = [...actions.values()].sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
  summary.charges = chargeTotals.filter((charge) => Object.keys(charge.totals).length);
  function readQuote(row: string[]) {
    const quantity = Number(cell(row, shares)), perShare = Number(cell(row, priceColumn?.index ?? -1)), rate = Number(cell(row, exchangeRate));
    const value = total ? Number(cell(row, total.index)) : NaN;
    const priceCode = priceColumn ? currencyOf(priceColumn, row) : "", totalCode = total ? currencyOf(total, row) : "";
    if (!(quantity > 0) || !(perShare > 0) || !(rate > 0) || !(value > 0) || !priceCode || !totalCode || pounds(priceCode) === pounds(totalCode) || Math.abs(rate - 1) < 0.02) return;
    // A price in pence may be quoted at a rate per pound or per pence: whichever fits, each way.
    const worths = pence(priceCode) ? [quantity * perShare / 100, quantity * perShare] : [quantity * perShare];
    const inTotal = value / (pence(totalCode) ? 100 : 1);
    const off = (of: (worth: number) => number) => Math.min(...worths.map((worth) => Math.abs(of(worth) - inTotal) / inTotal));
    // Capped, so one odd row cannot outweigh the rest.
    quoted.times += Math.min(1, off((worth) => worth * rate));
    quoted.over += Math.min(1, off((worth) => worth / rate));
  }

  /** One dividend row: what the per-share figure comes to, the tax withheld as written, and the net in the paying currency. */
  function readPaid(row: string[]) {
    const quantity = Number(cell(row, shares)), perShare = Number(cell(row, priceColumn!.index));
    const withheldText = cell(row, withheldColumn!.index);
    const withheld = withheldText ? Number(withheldText) : 0;
    const priceCode = currencyOf(priceColumn!, row), withheldCode = withheldText ? currencyOf(withheldColumn!, row) : priceCode;
    // A figure missing, or the tax in another currency (or none named): left out, and counted as such.
    if (!(quantity > 0) || !(perShare > 0) || !Number.isFinite(withheld) || !priceCode || !withheldCode || pounds(priceCode) !== pounds(withheldCode)) { unreadable += 1; return; }
    const ticker = cell(row, tickerColumn);
    const totalValue = total ? Number(cell(row, total.index)) : NaN, totalCode = total ? currencyOf(total, row) : "";
    const rate = Number(cell(row, exchangeRate));
    paidRows.push({
      country: /^[A-Z]{2}/i.test(cell(row, isin)) ? cell(row, isin).slice(0, 2).toUpperCase() : "?",
      currency: pounds(priceCode), ...(ticker ? { ticker } : {}),
      paid: quantity * perShare / (pence(priceCode) ? 100 : 1),
      withheld: withheld / (pence(withheldCode) ? 100 : 1),
      // The net in the paying currency, both ways the exchange rate could be quoted (paying currency = Total ÷ rate, or ×).
      ...(Number.isFinite(totalValue) && totalValue > 0 && totalCode
        ? pounds(totalCode) === pounds(priceCode) ? { nets: [totalValue / (pence(totalCode) ? 100 : 1)] } : rate > 0 ? { nets: [totalValue / rate, totalValue * rate] } : {}
        : {}),
    });
  }
  const records = body.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]).filter(([, value]) => value !== "")));
  return { summary, records };
}

const round = (value: number) => Math.round(value * 1e8) / 1e8;
const pence = (code: string) => /^GBX$/i.test(code) || code === "GBp";
const pounds = (code: string) => (pence(code) ? "GBP" : code.toUpperCase());

interface PaidRow { country: string; currency: string; ticker?: string; paid: number; withheld: number; nets?: number[] }

/**
 * The tax withheld from dividends, by country and currency. Whether the report's per-share figure is before or after
 * withholding is not documented, and Trading 212's users have reported it after (net, to 2 decimals). So the file is
 * asked: with each row's Total and exchange rate (quoted the way the file's orders show), whichever reading comes
 * closest to the net paid is the file's. When the file cannot tell, the figure is taken as net.
 */
function withholdingOf(rows: PaidRow[], unreadable: number, way?: number): Pick<ExportSummary, "withholding" | "withholdingBasis" | "withholdingUnread"> {
  // Withholding written as negative amounts (as some files do) is counted as positive; a refund then has the other sign.
  const signs = rows.filter((row) => row.withheld !== 0);
  const sign = signs.filter((row) => row.withheld < 0).length > signs.length / 2 ? -1 : 1;
  for (const row of rows) row.withheld *= sign;
  const priced = rows.filter((row) => row.nets && row.withheld > 0);
  const paid = priced.reduce((sum, row) => sum + row.paid, 0);
  const misfit = (gross: boolean, way: number) => priced.reduce((sum, row) => {
    const net = row.nets![Math.min(way, row.nets!.length - 1)]!;
    return sum + Math.abs(row.paid - (gross ? net + row.withheld : net));
  }, 0) / paid;
  // The way the orders show; with none to go by, either way (and a rate near 1/0.85 can then fit both readings).
  const fits = (gross: boolean) => (way === undefined ? Math.min(misfit(gross, 0), misfit(gross, 1)) : misfit(gross, way));
  let basis: ExportSummary["withholdingBasis"] = "assumed";
  if (priced.length && paid > 0) {
    const asNet = fits(false), asGross = fits(true);
    // Clearly one: within 5% of the net paid, and the other at least 3 points further off.
    if (asNet < 0.05 && asGross - asNet >= 0.03) basis = "net";
    else if (asGross < 0.05 && asNet - asGross >= 0.03) basis = "gross";
  }
  const grossOf = (row: PaidRow) => (basis === "gross" ? row.paid : row.paid + row.withheld);
  const groups = new Map<string, WithholdingByCountry & { byTicker: Map<string, { gross: number; withheld: number }> }>();
  for (const row of rows) {
    const key = `${row.country}:${row.currency}`;
    const group = groups.get(key) ?? { country: row.country, currency: row.currency, payments: 0, gross: 0, withheld: 0, rate: 0, tickers: [] as string[], byTicker: new Map() };
    group.payments += 1; group.gross += grossOf(row); group.withheld += row.withheld;
    const name = row.ticker ?? "?";
    if (row.ticker && !group.tickers.includes(row.ticker)) group.tickers.push(row.ticker);
    const one = group.byTicker.get(name) ?? { gross: 0, withheld: 0 };
    one.gross += grossOf(row); one.withheld += row.withheld;
    group.byTicker.set(name, one);
    groups.set(key, group);
  }
  // Rates as shown, to a tenth of a point: a flag never sits beside a rate that reads under 25%.
  const shown = (withheld: number, gross: number) => (gross > 0 ? Math.round(withheld / gross * 1000) / 1000 : 0);
  const withholding = [...groups.values()].map(({ byTicker, ...group }) => {
    const highTickers = group.country === "US" ? [...byTicker].filter(([name, one]) => name !== "?" && shown(one.withheld, one.gross) >= 0.25).map(([name]) => name) : [];
    return { ...group, gross: round(group.gross), withheld: round(group.withheld), rate: round(shown(group.withheld, group.gross)), ...(highTickers.length ? { high: true, highTickers } : {}) };
  }).sort((a, b) => b.withheld - a.withheld || a.country.localeCompare(b.country));
  return { withholding, withholdingBasis: basis, ...(unreadable ? { withholdingUnread: unreadable } : {}) };
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
