import { describe, expect, it } from "vitest";
import { positionHistory } from "./position-history";

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
});
