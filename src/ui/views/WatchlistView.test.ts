import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WatchlistView as WatchlistData, WatchRow } from "../../shared/watchlist";
import type { NewListingsView } from "../../shared/listings";
import { createTranslator } from "../i18n";
import { sortWatchRows, watchLevelText, WatchlistView } from "./WatchlistView";

const nvda: WatchRow = {
  ticker: "NVDA_US_EQ", name: "NVIDIA", shortName: "NVDA", currencyCode: "USD", addedAt: "2026-06-12T00:00:00Z", addedPrice: 116.6,
  held: { quantity: 20, averagePrice: 98.4 }, price: 128.75, priceSource: "broker", sinceAdded: 0.104,
  changes: { "1d": -0.015, "1m": 0.04 }, high: 133.4, low: 92.1, spark: { from: "2026-07-12", closes: [120, 118, 125, 128.75] },
  levels: [{ kind: "stop", side: "sell", price: 118, distance: -0.083 }],
};
const tsla: WatchRow = {
  ticker: "TSLA_US_EQ", name: "Tesla", shortName: "TSLA", currencyCode: "USD", note: "Wait for delivery numbers", addedAt: "2026-09-21T00:00:00Z",
  price: 244.1, priceSource: "sample", changes: { "1d": 0.009, "1m": 0.12 }, high: 244.1, low: 180.58, spark: { from: "2026-07-12", closes: [200, 230, 244.1] },
  levels: [{ kind: "alert", condition: "above", price: 260, distance: 0.065 }, { kind: "limit", side: "buy", price: 215, distance: -0.119 }],
};
const late: WatchRow = { ticker: "AMZN_US_EQ", name: "Amazon", shortName: "AMZN", currencyCode: "USD", addedAt: "2026-10-02T00:00:00Z", changes: {}, levels: [], pricesMissing: "later" };
const data: WatchlistData = { kind: "watchlist", environment: "demo", credentials: { live: false, demo: true }, items: [nvda, tsla, late], timestamp: "2026-10-12T00:00:00Z" };

const noop = () => {};
const render = (view: WatchlistData, locale: "en" | "zh-CN" = "en", listings?: NewListingsView) => renderToStaticMarkup(createElement(WatchlistView, {
  data: view, locale, t: createTranslator(locale), busy: false, listings,
  onOpen: noop, onRemove: noop, onRefresh: noop, onAdd: async () => true, onNote: async () => true, onSearch: async () => [],
  onListings: async () => { throw new Error("not read in a static render"); },
  onWatchListings: async () => null,
}));
const listings: NewListingsView = {
  kind: "new_listings", environment: "demo", credentials: { live: false, demo: true }, days: 30, from: "2026-09-12T12:00:00Z", currency: "USD",
  listings: [
    { ticker: "KLAR_US_EQ", name: "Klarna Group", shortName: "KLAR", currencyCode: "USD", type: "STOCK", addedOn: "2026-10-12T09:00:00Z" },
    { ticker: "TSLA_US_EQ", name: "Tesla", shortName: "TSLA", currencyCode: "USD", type: "STOCK", addedOn: "2026-09-20T09:00:00Z" },
  ],
  total: 3, types: { STOCK: 2, ETF: 1 }, catalogue: 120, undated: 1, timestamp: "2026-10-12T12:00:00Z",
};

describe("new listings", () => {
  it("offers to read them until the host has, then lists them newest first with type choices and what was left out", () => {
    expect(render(data)).toContain("Show new listings");
    const html = render(data, "en", listings);
    expect(html).not.toContain("Show new listings");
    expect(html).toContain("Added today");
    expect(html).toContain("Added Sep 20");
    expect(html).toContain("All 3");
    expect(html).toContain("ETFs 1");
    expect(html).toContain('aria-checked="true" tabindex="0" class="active">30 days');
    expect(html).toContain("Only instruments priced in USD.");
    expect(html).toContain("Showing the newest 2 of 3.");
    expect(html).toContain("1 instrument has no listing date");
    // Tesla is on the watchlist already; Klarna is not.
    expect(html).toContain('aria-label="Add Klarna Group to the watchlist"');
    expect(html).not.toContain('aria-label="Add Tesla to the watchlist"');
  });

  it("keeps a chosen type's chip, with All, when the window has none of that type", () => {
    const html = render(data, "en", { ...listings, type: "ETF", listings: [], total: 0, types: { STOCK: 2 } });
    expect(html).toContain("All 2");
    expect(html).toContain('aria-checked="true" tabindex="0" class="active">ETFs 0');
    expect(html).toContain("Trading 212 added nothing like this in the last 30 days.");
  });

  it("offers a listing alert for what the panel shows, and says when one is on and what it covers", () => {
    expect(render(data, "en", listings)).toContain("Checks hourly for new listings: USD.");
    const on = render(data, "en", { ...listings, type: "ETF", watch: { environment: "demo", types: ["STOCK"], currencies: [], createdAt: "2026-10-01T00:00:00Z" }, webhook: false });
    expect(on).toContain("Listing alert on: Stocks");
    expect(on).toContain("set NOTIFY_WEBHOOK_URL");
    expect(on).toContain("Change to ETFs · USD");
    expect(on).toContain(">Turn off<");
  });

  it("reads in Chinese", () => {
    const html = render(data, "zh-CN", listings);
    expect(html).toContain("Trading 212 新上架");
    expect(html).toContain("今天上架");
    expect(html).toContain("只看以 USD 计价的标的。");
  });
});

describe("watchlist view", () => {
  it("shows each row's price, the day's change in words as well as colour, its range and its nearest level", () => {
    const html = render(data);
    expect(html).toContain("$128.75");
    expect(html).toContain("-1.5%");
    expect(html).toContain("3.5% below the 12-month high");
    expect(html).toContain("At its 12-month high");
    expect(html).toContain("Stop $118.00 · -8.3%");
    expect(html).toContain("Alert above $260.00 · +6.5%");
    expect(html).toContain("+1 more");
    expect(html).toContain("Wait for delivery numbers");
    expect(html).toContain('aria-label="Open NVIDIA: $128.75, -1.5% since the last close"');
  });

  it("says which rows ran out of time and offers a refresh", () => {
    const html = render(data);
    expect(html).toContain("1 instrument gets its prices on the next refresh; this read ran out of time.");
    expect(html).toContain('<span class="watchMissing">Prices on the next refresh.</span>');
    expect(html).toContain('aria-label="Open Amazon: no price"');
  });

  it("names the simulated prices on the sample account", () => {
    expect(render(data)).toContain("Simulated prices for the sample account");
    expect(render({ ...data, items: [nvda] })).toContain("Trading 212");
  });

  it("invites adding instruments when the list is empty, in both languages", () => {
    expect(render({ ...data, items: [] })).toContain("Nothing on the watchlist yet.");
    const zh = render(data, "zh-CN");
    expect(zh).toContain("比 12 个月高点低 3.5%");
    expect(zh).toContain("持有 20");
  });

  it("names the start of a range shorter than a year", () => {
    const html = render({ ...data, items: [{ ...nvda, rangeFrom: "2026-05-20" }] });
    expect(html).toContain("3.5% below its high since May 20, 2026");
    expect(html).toContain('title="Range since May 20, 2026: $92.10 to $133.40"');
    expect(render({ ...data, items: [{ ...tsla, rangeFrom: "2026-05-20" }] }, "zh-CN")).toContain("处于2026年5月20日以来高点");
  });

  it("sorts by the biggest move over the period or by the nearest level", () => {
    expect(sortWatchRows(data.items, "added", "1d").map((row) => row.shortName)).toEqual(["NVDA", "TSLA", "AMZN"]);
    expect(sortWatchRows(data.items, "move", "1d").map((row) => row.shortName)).toEqual(["NVDA", "TSLA", "AMZN"]);
    expect(sortWatchRows(data.items, "move", "1m").map((row) => row.shortName)).toEqual(["TSLA", "NVDA", "AMZN"]);
    expect(sortWatchRows(data.items, "level", "1d").map((row) => row.shortName)).toEqual(["TSLA", "NVDA", "AMZN"]);
  });

  it("names each kind of level", () => {
    const t = createTranslator("en");
    expect(watchLevelText({ kind: "limit", side: "sell", price: 300 }, "USD", "en", t)).toBe("Sell limit $300.00");
    expect(watchLevelText({ kind: "stop", side: "buy", price: 2.5, distance: 0.1 }, "GBP", "en", t)).toBe("Buy stop £2.50 · +10.0%");
  });
});
