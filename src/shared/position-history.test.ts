import { describe, expect, it } from "vitest";
import type { HoldingDetail } from "./holding";
import { holdingPositionHistory, positionHistory } from "./position-history";

const closes = [
  { date: "2026-09-01", close: 100 },
  { date: "2026-09-02", close: 110 },
  { date: "2026-09-03", close: 105 },
  { date: "2026-09-04", close: 120 },
];

describe("position history", () => {
  it("gives each day's shares and value beside the start at the first close plus the trading since", () => {
    // 10 now: 4 bought on the 2nd at 108, 2 sold on the 4th at 118, so 8 at the start. 2 instrument units a euro.
    const history = positionHistory({ closes, quantity: 10, rate: 2, fills: [
      { at: "2026-09-02T15:00:00Z", quantity: 4, price: 108 },
      { at: "2026-09-04T15:00:00Z", quantity: -2, price: 118 },
    ] });
    expect(history).toEqual({
      startShares: 8,
      days: [
        { date: "2026-09-01", shares: 8, value: 400, base: 400 },
        { date: "2026-09-02", shares: 12, value: 660, base: 616 },
        { date: "2026-09-03", shares: 12, value: 630, base: 616 },
        { date: "2026-09-04", shares: 10, value: 600, base: 498 },
      ],
      // 8 × (120 − 100) + 4 × (120 − 108) − 2 × (120 − 118) = 204 units: 102 euros.
      gain: 102,
    });
  });

  it("says when the shares do not add up, and gives nothing without shares or closes", () => {
    expect(positionHistory({ closes, quantity: 1, rate: 1, fills: [{ at: "2026-09-03T10:00:00Z", quantity: 3, price: 105 }] })).toBe("quantity");
    expect(positionHistory({ closes, quantity: 0, rate: 1, fills: [] })).toBeUndefined();
    expect(positionHistory({ closes: closes.slice(0, 1), quantity: 5, rate: 1, fills: [] })).toBeUndefined();
    // Bought and sold out within the closes: shares on some days, none now.
    const roundTrip = positionHistory({ closes, quantity: 0, rate: 1, fills: [{ at: "2026-09-02T10:00:00Z", quantity: 5, price: 109 }, { at: "2026-09-03T10:00:00Z", quantity: -5, price: 106 }] });
    expect(roundTrip).toMatchObject({ startShares: 0, gain: -15 });
  });

  it("leaves out fills before the first close", () => {
    const history = positionHistory({ closes, quantity: 10, rate: 1, fills: [{ at: "2026-08-01T10:00:00Z", quantity: 10, price: 90 }] });
    expect(history).toMatchObject({ startShares: 10, gain: 200 });
  });

  it("says when the closes or the fill prices jump as across a split", () => {
    // Closes not adjusted: 1000 then 101 overnight.
    expect(positionHistory({ closes: [{ date: "2026-09-01", close: 1000 }, { date: "2026-09-02", close: 1010 }, { date: "2026-09-03", close: 101 }], quantity: 100, rate: 1, fills: [] })).toBe("split");
    // Closes adjusted, fills as traded: bought at 1000 when the adjusted close was 100.
    expect(positionHistory({ closes: [{ date: "2026-09-01", close: 100 }, { date: "2026-09-02", close: 100 }], quantity: 100, rate: 1, fills: [{ at: "2026-09-01T15:00:00Z", quantity: 10, price: 1000 }] })).toBe("split");
  });
});

describe("holding position history", () => {
  const detail = (patch: Omit<Partial<HoldingDetail>, "history"> & { history?: Partial<NonNullable<HoldingDetail["history"]>> }): HoldingDetail => ({
    kind: "holding", environment: "demo", ticker: "ACME_US_EQ", instrument: { ticker: "ACME_US_EQ", currencyCode: "USD" }, orders: [], alerts: [], journal: [], timestamp: "2026-09-05T12:00:00Z",
    accountCurrency: "EUR",
    prices: { source: "sample", points: closes },
    ...patch,
    history: { from: "2025-09-05T00:00:00Z", fills: [], dividends: [], dividendTotal: 0, dividendCount: 0, fillsTruncated: false, dividendsTruncated: false, ...patch.history },
  }) as unknown as HoldingDetail;
  const held = { quantity: 10, currentPrice: 120, walletImpact: { currentValue: 600 } };

  it("reads a sell from its side or its sign, and the older fills, at the holding's own rate", () => {
    const history = holdingPositionHistory(detail({
      position: held as never,
      history: {
        fills: [
          { filledAt: "2026-09-04T15:00:00Z", side: "SELL", quantity: 2, price: 118 },
          { filledAt: "2026-09-03T15:00:00Z", quantity: -1, price: 104 },
        ],
        olderFills: [{ filledAt: "2026-09-02T15:00:00Z", side: "BUY", quantity: 4, price: 108 }],
      },
    }));
    // 10 now, 3 sold and 4 bought after the 1st: 9 then. 1200 dollars are 600 euros: 2 a euro.
    expect(history).toMatchObject({ startShares: 9, days: [{ shares: 9 }, { shares: 13 }, { shares: 12 }, { shares: 10 }] });
    expect(history).not.toHaveProperty("fillRates");
  });

  it("takes a sold-out holding at today's rate for its currency, else at its fills' rates, and says which", () => {
    const fills = [
      { filledAt: "2026-09-02T15:00:00Z", side: "BUY", quantity: 5, price: 110, netValue: -500 },
      { filledAt: "2026-09-04T15:00:00Z", side: "SELL", quantity: 5, price: 120, netValue: 550 },
    ];
    const today = holdingPositionHistory(detail({ accountRate: 1.25, history: { fills } }));
    expect(today).toMatchObject({ gain: 40 });
    expect(today).not.toHaveProperty("fillRates");
    // 1150 dollars for 1050 euros.
    expect(holdingPositionHistory(detail({ history: { fills } }))).toMatchObject({ fillRates: true, gain: round(50 / (1150 / 1050)) });
  });

  it("starts on the oldest fill read when older ones were not, and gives nothing it cannot read", () => {
    const shortened = holdingPositionHistory(detail({ position: held as never, history: { fillsTruncated: true, fills: [{ filledAt: "2026-09-03T15:00:00Z", side: "BUY", quantity: 2, price: 104 }] } }));
    expect(shortened).toMatchObject({ shortened: true, startShares: 10, days: [{ date: "2026-09-03" }, { date: "2026-09-04" }] });
    expect(holdingPositionHistory(detail({ position: held as never, history: { fillsTruncated: true } }))).toBe("fills");
    expect(holdingPositionHistory(detail({ position: held as never, history: { fills: [{ side: "BUY", quantity: 2, price: 104 }] } }))).toBe("fills");
    expect(holdingPositionHistory(detail({ position: held as never, history: { fillsUnpriced: true } }))).toBe("fills");
    expect(holdingPositionHistory(detail({ position: held as never, history: { fillsNotTrades: true } }))).toBe("split");
  });

  it("counts the fills before a split in today's units, on closes adjusted for it or not", () => {
    // 2-for-1 on the 3rd: 5 bought at 216 on the 2nd are 10 at 108 now; the split's own fill is left out.
    const fills = [
      { filledAt: "2026-09-03T08:00:00Z", side: "BUY", quantity: 5, price: 0, fillType: "STOCK_SPLIT" },
      { filledAt: "2026-09-02T15:00:00Z", side: "BUY", quantity: 5, price: 216 },
    ];
    const splits = [{ at: "2026-09-03T08:00:00.000Z", ratio: 2 }];
    const adjusted = holdingPositionHistory(detail({ position: held as never, history: { fills, splits } }));
    expect(adjusted).toMatchObject({ startShares: 0, days: [{ shares: 0 }, { shares: 10 }, { shares: 10 }, { shares: 10 }] });
    // Closes as they were traded: those before the split halved.
    const raw = closes.map((point) => (point.date < "2026-09-03" ? { ...point, close: point.close * 2 } : point));
    expect(holdingPositionHistory(detail({ position: held as never, prices: { source: "sample", points: raw } as never, history: { fills, splits } }))).toEqual(adjusted);
  });
});

const round = (value: number) => Math.round(value * 100) / 100;
