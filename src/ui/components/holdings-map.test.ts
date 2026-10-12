import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Position } from "../../shared/contracts";
import type { DayMove } from "../../shared/today";
import { createTranslator } from "../i18n";
import { HoldingsMap, mapDayKnown, mapHeight, scaleEnd, strength, tileSize } from "./holdings-map";

const holding = (ticker: string, name: string, shortName: string, value: number, result: number): Position => ({
  instrument: { ticker, name, shortName, currencyCode: "USD" }, quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 1, currentPrice: 1,
  walletImpact: { currentValue: value, unrealizedProfitLoss: result },
} as Position);
const positions = [
  holding("VUSAl_EQ", "Vanguard S&P 500", "VUSA", 4330.6, 356.36),
  holding("AAPL_US_EQ", "Apple", "AAPL", 2556.31, 697.17),
  holding("KO_US_EQ", "Coca-Cola", "KO", 1407.6, -85.1),
  holding("TINY_EQ", "Tiny", "TINY", 0, 0),
];
const moves = new Map<string, DayMove>([
  ["VUSAl_EQ", { ticker: "VUSAl_EQ", quantity: 40, day: "2026-10-09", change: 0.0038, profitLoss: 16.33 }],
  ["AAPL_US_EQ", { ticker: "AAPL_US_EQ", quantity: 12, day: "2026-10-09", change: 0.0393, profitLoss: 96.6 }],
  ["KO_US_EQ", { ticker: "KO_US_EQ", quantity: 25, day: "2026-10-09", missing: "lag" }],
]);
const today = { data: { kind: "portfolio_today" as const, environment: "demo" as const, accountCurrency: "EUR", timestamp: "2026-10-12T09:00:00Z", moves: [...moves.values()] }, loading: false };
const render = (measure: "day" | "total", locale: "en" | "zh-CN" = "en", onOpen?: (ticker: string) => void) => renderToStaticMarkup(createElement(HoldingsMap, {
  positions, moves, today, measure, currency: "EUR", locale, t: createTranslator(locale), ...(onOpen ? { onOpen } : {}),
}));

describe("holdings map", () => {
  it("gives each holding with a value a tile that names its move, value and share, in the text colour, coloured by its sign", () => {
    const html = render("day", "en", () => {});
    expect(html.match(/class="mapCell"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="3 holdings, each sized by its value and coloured by its move on the day"');
    expect(html).toContain('aria-label="Apple: +3.93% on the day (+€96.60); €2,556.31, 30.8% of holdings"');
    expect(html).toMatch(/<button type="button" class="mapTile large up" title="Apple[^"]*"[^>]*><span class="mapName">AAPL<\/span><strong class="mapMove">\+3\.93%<\/strong><small class="mapAmount">\+€96\.60<\/small><\/button>/);
    // No figure: a pattern, and the legend says what it means.
    expect(html).toContain('class="mapTile large none"');
    expect(html).toContain("Coca-Cola: no figure on the day; €1,407.60, 17.0% of holdings");
    // The scale ends where the moves are: with two moves, at the step covering both, 5%.
    expect(html).toContain('<span class="mapScaleEnd" aria-hidden="true">+5%</span>');
    expect(html).toContain("--tile-strength:0.786");
    expect(html).toContain('style="left:1px;top:1px;width:373.9px;height:329px;--tile-strength:0.076"');
    expect(html).toContain('<span class="mapMissing" aria-hidden="true"><i></i>no figure</span>');
  });

  it("colours by the return since bought, with its own scale, in Chinese", () => {
    const html = render("total", "zh-CN");
    expect(html).toContain("Apple：持有以来 +37.50%（+€697.17）；市值 €2,556.31，占持仓 30.8%");
    expect(html).toContain("颜色从红色（跌 50% 及以上）经灰色（不变）到绿色（涨 50% 及以上）。");
    expect(html).toContain('class="mapTile large down"');
    // Without a way to open a holding, the tiles are not buttons.
    expect(html).not.toContain("<button");
  });

  it("sets the scale's end to what most holdings stay within, and the map's height to its width", () => {
    expect(scaleEnd([0.0038, 0.0393, -0.0194, -0.0119, -0.02], [0.01, 0.02, 0.03, 0.05, 0.1])).toBe(0.02);
    // Four in five of ten: the two largest moves do not set the scale.
    expect(scaleEnd([0.004, -0.006, 0.008, 0.01, -0.012, 0.015, 0.018, -0.019, 0.08, -0.09], [0.01, 0.02, 0.03, 0.05, 0.1])).toBe(0.02);
    expect(scaleEnd([0.4], [0.05, 0.1, 0.25, 0.5, 1])).toBe(0.5);
    expect(scaleEnd([3], [0.05, 0.1, 0.25, 0.5, 1])).toBe(1);
    expect(scaleEnd([], [0.01, 0.02])).toBe(0.01);
    expect(strength(-0.01, 0.02)).toBe(0.5);
    expect(strength(0.05, 0.02)).toBe(1);
    expect(mapHeight(390)).toBe(371);
    expect(mapHeight(720)).toBe(331);
    expect(mapHeight(1400)).toBe(440);
  });

  it("keeps tiles too small to see out of the keyboard order, and shows each tile only the lines it has room for", () => {
    const html = renderToStaticMarkup(createElement(HoldingsMap, {
      positions: [...positions, holding("TINY_US_EQ", "Tiny Corp", "TINY", 2, 0.1)], moves, today, measure: "day", currency: "EUR", locale: "en",
      t: createTranslator("en"), onOpen: () => {},
    }));
    expect(html).toMatch(/<button type="button" class="mapTile tiny[^"]*" title="Tiny Corp[^"]*" aria-label="[^"]*" tabindex="-1">/);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
    // Three lines need 80 pixels with the padding and the gap; two need 48.
    expect(tileSize(200, 79)).toBe("medium");
    expect(tileSize(200, 80)).toBe("large");
    expect(tileSize(100, 47)).toBe("small");
    expect(tileSize(100, 48)).toBe("medium");
    expect(tileSize(39, 200)).toBe("tiny");
  });

  it("offers the day while it is being read or some holding has one, not after the read failed", () => {
    expect(mapDayKnown(undefined)).toBe(false);
    expect(mapDayKnown({ loading: true })).toBe(true);
    expect(mapDayKnown({ loading: false, failed: true })).toBe(false);
    expect(mapDayKnown(today)).toBe(true);
    expect(mapDayKnown({ loading: false, data: { ...today.data, moves: [moves.get("KO_US_EQ")!] } })).toBe(false);
  });
});
