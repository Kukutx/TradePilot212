import { describe, expect, it } from "vitest";
import { holdingRiskOf, MATRIX_SIZE, MIN_WEEKS, type HoldingRiskInput } from "./holding-risk.js";
import type { PricePoint } from "./prices.js";

const DAY_MS = 86_400_000;
const FIRST_FRIDAY = Date.UTC(2025, 9, 10);
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
// A Saturday after 52 weeks: the last week is over.
const TODAY = date(FIRST_FRIDAY + 52 * 7 * DAY_MS + DAY_MS);

/** Friday closes, one a week from 10 October 2025, from 100 by the weekly log returns given. */
function fridays(moves: number[], start = 100): PricePoint[] {
  const points: PricePoint[] = [{ date: date(FIRST_FRIDAY), close: start }];
  let log = Math.log(start);
  moves.forEach((move, index) => { log += move; points.push({ date: date(FIRST_FRIDAY + (index + 1) * 7 * DAY_MS), close: Math.exp(log) }); });
  return points;
}
/** 52 weekly moves repeating a pattern. */
const pattern = (cycle: number[], size = 0.02) => Array.from({ length: 52 }, (_, index) => cycle[index % cycle.length]! * size);
const holding = (ticker: string, value: number, moves: number[]): HoldingRiskInput => ({ ticker, value, points: fridays(moves) });

describe("risk by holding", () => {
  it("shares the risk of holdings that move as one by their weights, with no diversification", () => {
    const moves = pattern([1, -1, 2, -2]);
    const risk = holdingRiskOf([holding("A", 3000, moves), holding("B", 1000, moves)], TODAY)!;
    expect(risk).toMatchObject({ weeks: 52, covered: 1, diversification: 1, from: "2025-10-10", to: "2026-10-09" });
    expect(risk.rows).toEqual([
      { ticker: "A", weight: 0.75, volatility: risk.volatility, risk: 0.75, correlation: 1 },
      { ticker: "B", weight: 0.25, volatility: risk.volatility, risk: 0.25, correlation: 1 },
    ]);
    // The weekly moves' spread a year: √(mean square × 52 / 51 × 52).
    const mean = moves.reduce((sum, move) => sum + move, 0) / 52;
    const variance = moves.reduce((sum, move) => sum + (move - mean) ** 2, 0) / 51 * 52;
    expect(risk.volatility).toBeCloseTo(Math.sqrt(variance), 6);
    expect(risk.correlations).toEqual({ tickers: ["A", "B"], matrix: [[1, 1], [1, 1]] });
  });

  it("halves the shares of two unrelated holdings and reads the diversification", () => {
    // +,-,+,- against +,+,-,-: no covariance at all.
    const risk = holdingRiskOf([holding("A", 1000, pattern([1, -1, 1, -1])), holding("B", 1000, pattern([1, 1, -1, -1]))], TODAY)!;
    expect(risk.rows.map((row) => row.risk)).toEqual([0.5, 0.5]);
    expect(risk.rows[0]!.correlation).toBeCloseTo(Math.SQRT1_2, 5);
    expect(risk.diversification).toBeCloseTo(Math.SQRT2, 3);
    expect(risk.correlations.matrix[0]![1]).toBeCloseTo(0, 6);
  });

  it("gives a holding that offsets the rest a share below zero", () => {
    const moves = pattern([1, -1, 2, -2]);
    const risk = holdingRiskOf([holding("A", 3000, moves), holding("H", 1000, moves.map((move) => -move))], TODAY)!;
    expect(risk.rows).toMatchObject([{ ticker: "A", risk: 1.5, correlation: 1 }, { ticker: "H", risk: -0.5, correlation: -1 }]);
    expect(risk.diversification).toBe(2);
    expect(risk.correlations.matrix).toEqual([[1, -1], [-1, 1]]);
  });

  it("takes each week's last close and leaves out the week still on", () => {
    const daily: PricePoint[] = [];
    // Weekday closes from the Monday after the first Friday into the week after the last one.
    let close = 100;
    for (let day = FIRST_FRIDAY + 3 * DAY_MS; day <= FIRST_FRIDAY + 52 * 7 * DAY_MS + 5 * DAY_MS; day += DAY_MS) {
      const weekday = new Date(day).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      close *= Math.exp(0.01 * Math.sin(day));
      daily.push({ date: date(day), close });
    }
    const other = holding("B", 1000, pattern([1, -1, 1, -1]));
    // A Wednesday: the week it is in is not over, so its Monday to Wednesday closes are left out.
    const wednesday = date(FIRST_FRIDAY + 52 * 7 * DAY_MS + 5 * DAY_MS);
    const fromDaily = holdingRiskOf([{ ticker: "A", value: 1000, points: daily }, other], wednesday)!;
    const lastOfWeek = daily.filter((point) => new Date(`${point.date}T00:00:00Z`).getUTCDay() === 5 && point.date <= "2026-10-09");
    expect(fromDaily).toEqual(holdingRiskOf([{ ticker: "A", value: 1000, points: lastOfWeek }, other], wednesday));
    // B's first Friday has no week of A's before it.
    expect(fromDaily).toMatchObject({ from: "2025-10-17", to: "2026-10-09", weeks: 51 });
  });

  it("counts a week with no close (a market shut) as two weeks of variance", () => {
    const moves = pattern([1, -1, 2, -2]);
    const shut = fridays(moves).filter((_, index) => index !== 20);
    const risk = holdingRiskOf([{ ticker: "A", value: 1000, points: shut }, { ticker: "B", value: 1000, points: shut }], TODAY)!;
    expect(risk.weeks).toBe(51);
    const returns = moves.map((move, index) => (index === 19 ? (move + moves[20]!) / Math.SQRT2 : move)).filter((_, index) => index !== 20);
    const mean = returns.reduce((sum, move) => sum + move, 0) / 51;
    expect(risk.volatility).toBeCloseTo(Math.sqrt(returns.reduce((sum, move) => sum + (move - mean) ** 2, 0) / 50 * 52), 6);
  });

  it("leaves out a holding with too few weeks, and has nothing to say with one holding, too few weeks or no moves", () => {
    const moves = pattern([1, -1, 2, -2]);
    const young = { ticker: "NEW", value: 5000, points: fridays(moves).slice(-MIN_WEEKS) };
    const risk = holdingRiskOf([holding("A", 1000, moves), holding("B", 1000, pattern([1, 1, -1, -1])), young], TODAY, 8000)!;
    expect(risk.short).toEqual(["NEW"]);
    expect(risk.rows.map((row) => row.ticker).sort()).toEqual(["A", "B"]);
    expect(risk.covered).toBe(0.25);
    expect(holdingRiskOf([holding("A", 1000, moves), young], TODAY)).toBeUndefined();
    // Each has 29 weeks, but only 6 of them together.
    expect(holdingRiskOf([{ ticker: "A", value: 1000, points: fridays(moves).slice(0, 30) }, { ticker: "B", value: 1000, points: fridays(moves).slice(-30) }], TODAY)).toBeUndefined();
    expect(holdingRiskOf([holding("A", 1000, pattern([0])), holding("B", 1000, pattern([0]))], TODAY)).toBeUndefined();
  });

  it("leaves out a holding bought late rather than cut the weeks the rest are read over", () => {
    const full = (ticker: string, cycle: number[]) => holding(ticker, 1000, pattern(cycle));
    // 31 closes, from the year's second half: under three quarters of the 53 the others have.
    const late = { ticker: "LATE", value: 1000, points: fridays(pattern([1, -1])).slice(-31) };
    const risk = holdingRiskOf([full("A", [1, -1, 2, -2]), full("B", [1, 1, -1, -1]), full("C", [2, -1, -1]), late], TODAY)!;
    expect(risk).toMatchObject({ weeks: 52, short: ["LATE"], covered: 0.75 });
  });

  it("leaves out the holding whose weeks line up least with the rest's when too few are shared", () => {
    const moves = pattern([1, -1, 2, -2]);
    // B's closes stop after week 39 and C's start at week 13: the three share 27 closes, 26 weeks, too few.
    const b = { ticker: "B", value: 1000, points: fridays(pattern([1, 1, -1, -1])).slice(0, 40) };
    const c = { ticker: "C", value: 1000, points: fridays(pattern([2, -1, -1])).slice(13) };
    const risk = holdingRiskOf([holding("A", 1000, moves), b, c], TODAY)!;
    expect(risk).toMatchObject({ weeks: 39, short: ["B"], from: "2026-01-09", to: "2026-10-09" });
    expect(risk.rows.map((row) => row.ticker).sort()).toEqual(["A", "C"]);
  });

  it("leaves out a holding whose closes jump as across a change of unit", () => {
    const moves = pattern([1, -1, 2, -2]);
    // Pounds, then pence from week 20.
    const pence = { ticker: "GBX", value: 1000, points: fridays(pattern([1, 1, -1, -1])).map((point, index) => (index >= 20 ? { ...point, close: point.close * 100 } : point)) };
    const risk = holdingRiskOf([holding("A", 1000, moves), holding("B", 1000, pattern([2, -1, -1])), pence], TODAY)!;
    expect(risk.jumps).toEqual(["GBX"]);
    expect(risk.rows.map((row) => row.ticker).sort()).toEqual(["A", "B"]);
    expect(risk.short).toBeUndefined();
  });

  it("follows today's mix at today's weights over the weeks read, with its bad weeks and deepest fall", () => {
    const moves = pattern([1, -1, 2, -2]);
    const { mix } = holdingRiskOf([holding("A", 3000, moves), holding("B", 1000, moves)], TODAY)!;
    expect(mix.value).toBe(4000);
    expect(mix.series).toHaveLength(53);
    expect(mix.series[0]).toEqual({ date: "2025-10-10", return: 0 });
    // Up 2%, back, up 4%, back: each cycle of four weeks ends where it began.
    expect(mix.series[2]!.return).toBeCloseTo(0, 6);
    expect(mix.series[3]!.return).toBeCloseTo(Math.exp(0.04) - 1, 6);
    expect(mix.return).toBeCloseTo(0, 6);
    const fall = Math.exp(-0.04) - 1;
    // 52 weeks: one in 20 is the third worst, and the 13 falls of 4% are all as bad.
    expect(mix.badWeek).toBeCloseTo(fall, 6);
    expect(mix.badWeeks).toBeCloseTo(fall, 6);
    expect(mix.worst).toEqual({ date: "2025-11-07", return: expect.closeTo(fall, 6) });
    expect(mix.best).toEqual({ date: "2025-10-31", return: expect.closeTo(Math.exp(0.04) - 1, 6) });
    expect(mix.up).toBe(26);
    expect(mix.counted).toBe(52);
    expect(mix.drawdown).toMatchObject({ max: expect.closeTo(fall, 6), peak: "2025-10-31", trough: "2025-11-07" });
  });

  it("takes the third worst of 52 weeks as the bad week one in 20, and the average of the three", () => {
    // Small moves, then falls of 5%, 4%, 3% and 2% in four weeks of their own.
    const moves = pattern([0.1, -0.1]).map((move, index) => (index === 10 ? -0.05 : index === 20 ? -0.04 : index === 30 ? -0.03 : index === 40 ? -0.02 : move * 0.01));
    const { mix } = holdingRiskOf([holding("A", 1000, moves), holding("B", 1000, moves.map((move, index) => (index % 2 ? move : move * 1.5)))], TODAY)!;
    const week = (index: number) => 0.5 * (Math.exp(moves[index]!) - 1) + 0.5 * (Math.exp(index % 2 ? moves[index]! : moves[index]! * 1.5) - 1);
    expect(mix.worst.return).toBeCloseTo(week(10), 6);
    expect(mix.badWeek).toBeCloseTo(week(30), 6);
    expect(mix.badWeeks).toBeCloseTo((week(10) + week(20) + week(30)) / 3, 6);
  });

  it("draws a stretch over a week some holding has no close in, but counts it as no week", () => {
    const moves = pattern([1, -1, 2, -2]);
    // B has no close in weeks 20 and 21: the three weeks from 19 to 22 are one stretch.
    const gap = fridays(pattern([1, 1, -1, -1])).filter((_, index) => index !== 20 && index !== 21);
    const { mix, weeks } = holdingRiskOf([holding("A", 1000, moves), { ticker: "B", value: 1000, points: gap }], TODAY)!;
    expect(weeks).toBe(50);
    expect(mix.series).toHaveLength(51);
    expect(mix.counted).toBe(49);
    const other = pattern([1, 1, -1, -1]);
    // Into week k: the moves k - 1 of each, half and half.
    const into = (k: number) => 0.5 * (Math.exp(moves[k - 1]!) - 1) + 0.5 * (Math.exp(other[k - 1]!) - 1);
    const single = [...Array.from({ length: 19 }, (_, index) => index + 1), ...Array.from({ length: 30 }, (_, index) => index + 23)].map(into);
    // The stretch is in the line: week 22 stands where weeks 19 to 22 took it.
    const stretch = 0.5 * (Math.exp(moves[19]! + moves[20]! + moves[21]!) - 1) + 0.5 * (Math.exp(other[19]! + other[20]! + other[21]!) - 1);
    expect((1 + mix.series[20]!.return) / (1 + mix.series[19]!.return) - 1).toBeCloseTo(stretch, 5);
    expect(mix.up).toBe(single.filter((value) => value > 0).length);
    expect(mix.worst.return).toBeCloseTo(Math.min(...single), 6);
    expect(mix.best.return).toBeCloseTo(Math.max(...single), 6);
  });

  it("weighs each holding's weekly change by today's weight, so a hedge softens the bad weeks", () => {
    const moves = pattern([1, -1, 2, -2]);
    const { mix } = holdingRiskOf([holding("A", 3000, moves), holding("H", 1000, moves.map((move) => -move))], TODAY)!;
    const worst = 0.75 * (Math.exp(-0.04) - 1) + 0.25 * (Math.exp(0.04) - 1);
    expect(mix.worst.return).toBeCloseTo(worst, 6);
    expect(mix.badWeek).toBeCloseTo(worst, 6);
    // The tail is the three worst of the 52.
    const weekly = moves.map((move) => 0.75 * (Math.exp(move) - 1) + 0.25 * (Math.exp(-move) - 1)).sort((a, b) => a - b);
    expect(mix.badWeeks).toBeCloseTo((weekly[0]! + weekly[1]! + weekly[2]!) / 3, 6);
  });

  it("shows the correlations between the largest holdings only", () => {
    const inputs = Array.from({ length: MATRIX_SIZE + 2 }, (_, index) => holding(`T${index}`, 100 + index, pattern([1, -1, index % 2 ? 2 : -2, 1])));
    const risk = holdingRiskOf(inputs, TODAY)!;
    expect(risk.rows).toHaveLength(MATRIX_SIZE + 2);
    expect(risk.correlations.tickers).toEqual(Array.from({ length: MATRIX_SIZE }, (_, index) => `T${MATRIX_SIZE + 1 - index}`));
    expect(risk.correlations.matrix.every((row, i) => row.length === MATRIX_SIZE && row[i] === 1)).toBe(true);
    expect(risk.rows.reduce((sum, row) => sum + row.risk, 0)).toBeCloseTo(1, 4);
  });
});
