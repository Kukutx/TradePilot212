import { describe, expect, it } from "vitest";
import type { AllocationAnalysis, AllocationDrift, HoldingCovariance } from "./history.js";
import { equalRiskTargets, holdingRiskOf, marketScenarios, MATRIX_SIZE, MAX_PARITY_TARGETS, MIN_WEEKS, parityOf, riskAtWeights, targetRiskOf, withTargetVolatility, type HoldingRiskInput } from "./holding-risk.js";
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
      { ticker: "A", weight: 0.75, volatility: risk.volatility, risk: 0.75, correlation: 1, parity: 0.5 },
      { ticker: "B", weight: 0.25, volatility: risk.volatility, risk: 0.25, correlation: 1, parity: 0.5 },
    ]);
    // Moving as one, they bring the same risk at the same weight, which moves the same.
    expect(risk.parityVolatility).toBe(risk.volatility);
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

/** The share of x'Σx each holding brings: x_i(Σx)_i over the whole. */
const shares = (covariance: number[][], x: number[]) => {
  const each = x.map((value, i) => value * covariance[i]!.reduce((sum, cell, j) => sum + cell * x[j]!, 0));
  const total = each.reduce((sum, value) => sum + value, 0);
  return each.map((value) => value / total);
};

describe("equal-risk weights", () => {
  it("weighs two unrelated holdings by their inverse volatilities, and the risk at those weights", () => {
    const risk = holdingRiskOf([holding("A", 3000, pattern([1, -1, 1, -1])), holding("B", 1000, pattern([1, 1, -1, -1], 0.04))], TODAY)!;
    const [a, b] = ["A", "B"].map((ticker) => risk.rows.find((row) => row.ticker === ticker)!);
    // B moves twice as much: half A's weight brings as much risk.
    expect(a!.parity).toBeCloseTo(2 / 3, 5);
    expect(b!.parity).toBeCloseTo(1 / 3, 5);
    // Unrelated: the variance is the sum of each one's, (2/3 σ)² + (1/3 · 2σ)².
    expect(risk.parityVolatility).toBeCloseTo(Math.sqrt(2 * (2 / 3 * a!.volatility) ** 2), 5);
  });

  it("gives each holding the same share of the risk, whatever moves with what", () => {
    const covariance = [[0.04, 0.03, -0.004], [0.03, 0.09, 0.006], [-0.004, 0.006, 0.0225]];
    const parity = parityOf(covariance, [0.5, 0.3, 0.2], covariance.map((row, i) => Math.sqrt(row[i]!)))!;
    expect(parity.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    for (const share of shares(covariance, parity)) expect(share).toBeCloseTo(1 / 3, 8);
    // The one that offsets the others takes the most.
    expect(Math.max(...parity)).toBe(parity[2]);
  });

  it("keeps the weight of a holding that barely moves, and the others share the rest at equal risk", () => {
    const covariance = [[0.0001, 0, 0], [0, 0.04, 0], [0, 0, 0.16]];
    const parity = parityOf(covariance, [0.2, 0.5, 0.3], [0.01, 0.2, 0.4])!;
    expect(parity[0]).toBe(0.2);
    expect(parity[1]).toBeCloseTo(0.8 * 2 / 3, 10);
    expect(parity[2]).toBeCloseTo(0.8 / 3, 10);
    // One that moves is no spread at all.
    expect(parityOf(covariance, [0.2, 0.5, 0.3], [0.01, 0.01, 0.4])).toBeUndefined();
  });

  it("finds none for a perfect hedge, at whose weights there is no risk to share", () => {
    const moves = pattern([1, -1, 2, -2]);
    const risk = holdingRiskOf([holding("A", 3000, moves), holding("H", 1000, moves.map((move) => -move))], TODAY)!;
    expect(risk.parityVolatility).toBeUndefined();
    expect(risk.rows.every((row) => row.parity === undefined)).toBe(true);
  });

  it("does not chase the noise of many holdings over few weeks", () => {
    // 40 unrelated holdings moving alike, over 52 weeks: the answer is about equal weights, whatever the sample's noise.
    let seed = 11;
    const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const inputs = Array.from({ length: 40 }, (_, index) => holding(`N${index}`, 1000, Array.from({ length: 52 }, () => noise() * 0.06)));
    const risk = holdingRiskOf(inputs, TODAY)!;
    for (const row of risk.rows) expect(Math.abs(row.parity! * 40 - 1)).toBeLessThan(0.35);
    // A holding whose price never moved keeps its weight, and does not stop the others being shrunk.
    const still = holdingRiskOf([...inputs, holding("FLAT", 1000, Array.from({ length: 52 }, () => 0))], TODAY)!;
    expect(still.rows.find((row) => row.ticker === "FLAT")!.parity).toBeCloseTo(1 / 41, 6);
    for (const row of still.rows.filter((item) => item.ticker !== "FLAT")) expect(Math.abs(row.parity! * 41 - 1)).toBeLessThan(0.35);
  });
});

describe("the targets that plan the move to equal risk", () => {
  const analysis = (rows: Array<{ ticker: string; weight: number; parity?: number }>, values: Record<string, number>, extra: Partial<AllocationAnalysis> = {}) => ({
    totalValue: 2000, cash: 500, availableCash: 450,
    holdings: Object.entries(values).map(([ticker, value]) => ({ ticker, name: ticker, currency: "EUR", value, weight: value / 2000 })),
    risk: { rows: rows.map((row) => ({ volatility: 0.2, risk: row.weight, correlation: 0.5, ...row })) } as AllocationAnalysis["risk"],
    ...extra,
  });

  it("keeps the value of the holdings measured, and leaves the others and the free cash as they are", () => {
    const plan = equalRiskTargets(analysis([{ ticker: "A", weight: 0.6, parity: 0.4 }, { ticker: "B", weight: 0.4, parity: 0.6 }], { A: 600, B: 400, C: 500 }))!;
    // The 1,000 measured, of 2,000: A 400, B 600; C is not measured and is not a target.
    expect(plan.targets).toEqual([{ ticker: "A", weight: 0.2 }, { ticker: "B", weight: 0.3 }]);
    expect(plan.cashWeight).toBe(0.225);
    // A sells 200 of the 1,000 measured, which B buys.
    expect(plan.sold).toBe(0.2);
    expect(plan.partial).toBeUndefined();
    // Without free cash, as the planner counts none, none is kept.
    expect(equalRiskTargets(analysis([{ ticker: "A", weight: 0.6, parity: 0.4 }, { ticker: "B", weight: 0.4, parity: 0.6 }], { A: 600, B: 400 }, { availableCash: undefined }))!.cashWeight).toBe(0);
    // A holding measured but not among the holdings would be bought from nothing.
    expect(equalRiskTargets(analysis([{ ticker: "A", weight: 0.6, parity: 0.4 }, { ticker: "B", weight: 0.4, parity: 0.6 }], { A: 600 }))).toBeUndefined();
  });

  it("never asks the planner for more than the account, however the values were rounded", () => {
    // Fully invested, every holding measured: the rounded weights and values can come to a little more than 1.
    let seed = 5;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const six = (value: number) => Math.round(value * 1e6) / 1e6;
    for (let trial = 0; trial < 2000; trial += 1) {
      const raw = Array.from({ length: 19 }, () => 50 + random() * 5000);
      const total = raw.reduce((sum, value) => sum + value, 0);
      const values = raw.map((value) => Math.round(value * 100) / 100);
      const measured = values.reduce((sum, value) => sum + value, 0);
      const spread = raw.map(() => random() + 0.2);
      const rows = values.map((value, index) => ({ ticker: `T${index}`, weight: six(value / measured), parity: six(spread[index]! / spread.reduce((sum, item) => sum + item, 0)) }));
      const plan = equalRiskTargets(analysis(rows, Object.fromEntries(values.map((value, index) => [`T${index}`, value])), { totalValue: Math.round(total * 100) / 100, cash: 0, availableCash: 0 }))!;
      // The planner refuses more than 1 + 1e-9.
      expect(plan.targets.reduce((sum, target) => sum + target.weight, 0) + plan.cashWeight).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("moves the furthest from equal risk when a basket cannot take them all, keeping their value together", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({ ticker: `T${index}`, weight: 0.04, parity: 0.04 + (index % 2 ? 1 : -1) * index / 10_000 }));
    const plan = equalRiskTargets(analysis(rows, Object.fromEntries(rows.map((row) => [row.ticker, 40]))))!;
    expect(plan.partial).toBe(true);
    expect(plan.targets).toHaveLength(MAX_PARITY_TARGETS);
    // The 20 furthest are T5 to T24.
    expect(plan.targets.map((target) => target.ticker).sort()).toEqual(rows.slice(5).map((row) => row.ticker).sort());
    // Together they keep their 800 of the 2,000: 0.4 of the account.
    expect(plan.targets.reduce((sum, target) => sum + target.weight, 0)).toBeCloseTo(0.4, 4);
    expect(plan.targets.reduce((sum, target) => sum + target.weight, 0) + plan.cashWeight).toBeLessThanOrEqual(1);
  });

  it("has none without equal-risk weights or an account value", () => {
    expect(equalRiskTargets(analysis([{ ticker: "A", weight: 0.6 }, { ticker: "B", weight: 0.4 }], { A: 600, B: 400 }))).toBeUndefined();
    expect(equalRiskTargets(analysis([{ ticker: "A", weight: 0.6, parity: 0.4 }, { ticker: "B", weight: 0.4, parity: 0.6 }], { A: 600, B: 400 }, { totalValue: 0 }))).toBeUndefined();
  });
});

describe("the risk at target weights", () => {
  // A 20% and a 40% volatility, unrelated, and C, which moves with A.
  const covariance: HoldingCovariance = { tickers: ["A", "B", "C"], matrix: [[0.04, 0, 0.03], [0, 0.16, 0], [0.03, 0, 0.0225]] };

  it("hands over the covariance it reads the risk from, which gives today's volatility again", () => {
    let found: HoldingCovariance | undefined;
    const risk = holdingRiskOf([holding("A", 3000, pattern([1, -1, 1, -1])), holding("B", 1000, pattern([1, 1, -1, -1], 0.04))], TODAY, undefined, (given) => { found = given; })!;
    expect(found!.tickers).toEqual(["A", "B"]);
    const today = riskAtWeights(found!, new Map([["A", 0.3], ["B", 0.1]]))!;
    expect(today.volatility).toBeCloseTo(risk.volatility, 6);
    for (const row of risk.rows) expect(today.shares.get(row.ticker)).toBeCloseTo(row.risk, 6);
    // Shares of an account 40% in these two: its volatility is theirs times 0.4.
    expect(today.scaled).toBeCloseTo(risk.volatility * 0.4, 6);
    // No covariance is handed over when there is no risk to read.
    let none: HoldingCovariance | undefined;
    expect(holdingRiskOf([holding("A", 3000, pattern([1, -1]))], TODAY, undefined, (given) => { none = given; })).toBeUndefined();
    expect(none).toBeUndefined();
  });

  it("measures instruments not held over the holdings' weeks, for the covariance alone", () => {
    const a = holding("A", 3000, pattern([1, -1, 1, -1]));
    const b = holding("B", 1000, pattern([1, 1, -1, -1], 0.04));
    let alone: HoldingCovariance | undefined;
    const risk = holdingRiskOf([a, b], TODAY, undefined, (given) => { alone = given; })!;
    let found: HoldingCovariance | undefined;
    // N moves as A does at twice the size; S misses the first ten weeks; J's closes jump as across pounds and pence.
    const jumped = fridays(pattern([1, -1, 1, -1])).map((point, index) => (index > 30 ? { ...point, close: point.close * 100 } : point));
    const beside = holdingRiskOf([a, b], TODAY, undefined, (given) => { found = given; }, [
      { ticker: "N", points: fridays(pattern([1, -1, 1, -1], 0.04)) },
      { ticker: "S", points: fridays(pattern([1, 1, -1, -1])).slice(10) },
      { ticker: "J", points: jumped },
      // A holding asked for again is the holding, not an instrument beside it.
      { ticker: "A", points: fridays(pattern([1, 1, -1, -1])) },
    ])!;
    // The holdings' risk does not change.
    expect(beside).toEqual(risk);
    expect(found!.tickers).toEqual(["A", "B", "N"]);
    expect(found!.unmeasured).toEqual([{ ticker: "S", reason: "short" }, { ticker: "J", reason: "jumps" }]);
    // The holdings' block is the covariance without them, and N's is A's at twice the size.
    found!.matrix.slice(0, 2).forEach((row, i) => row.slice(0, 2).forEach((cell, j) => expect(cell).toBeCloseTo(alone!.matrix[i]![j]!, 12)));
    expect(found!.matrix[2]![2]).toBeCloseTo(4 * found!.matrix[0]![0]!, 12);
    expect(found!.matrix[2]![0]).toBeCloseTo(2 * found!.matrix[0]![0]!, 12);
    expect(found!.matrix[0]![2]).toBe(found!.matrix[2]![0]);
    // Half in A and half in N, which moves as A does at twice the size: one and a half times A's volatility.
    const mixed = targetRiskOf(found!, [{ ticker: "A", weight: 0.3 }, { ticker: "B", weight: 0.1 }], new Map([["A", 0.2], ["N", 0.2]]), true)!;
    expect(mixed.leftOut).toEqual([]);
    expect(mixed.atTargets.volatility).toBeCloseTo(1.5 * Math.sqrt(found!.matrix[0]![0]!), 10);
    expect(mixed.now.shares.get("N")).toBe(0);
    expect(mixed.account).toBeDefined();
  });

  it("weighs the holdings measured among themselves, and counts any other ticker as nothing", () => {
    const half = riskAtWeights(covariance, new Map([["A", 0.25], ["B", 0.25], ["X", 0.5]]))!;
    // Half each of A and B, unrelated: √(0.25 × 0.04 + 0.25 × 0.16).
    expect(half.volatility).toBeCloseTo(Math.sqrt(0.05), 10);
    expect(half.scaled).toBeCloseTo(Math.sqrt(0.05) / 2, 10);
    expect(half.shares.get("A")).toBeCloseTo(0.2, 10);
    expect(half.shares.get("B")).toBeCloseTo(0.8, 10);
    expect(half.shares.get("C")).toBe(0);
    expect(riskAtWeights(covariance, new Map([["X", 1]]))).toBeUndefined();
    expect(riskAtWeights(covariance, new Map())).toBeUndefined();
  });

  it("keeps a holding without a target at today's weight, or sells it, and adds the targets not held", () => {
    const holdings = [{ ticker: "A", weight: 0.4 }, { ticker: "B", weight: 0.2 }, { ticker: "C", weight: 0.2 }];
    const kept = targetRiskOf(covariance, holdings, new Map([["A", 0.2]]), false)!;
    // A at its 0.2 target, B and C kept at their 0.2: a third each, weighing 0.6 of the account.
    const third = riskAtWeights(covariance, new Map([["A", 1], ["B", 1], ["C", 1]]))!;
    expect(kept.atTargets.volatility).toBeCloseTo(third.volatility, 10);
    expect(kept.account!.atTargets).toBeCloseTo(third.volatility * 0.6, 10);
    expect(kept.account!.now).toBeCloseTo(riskAtWeights(covariance, new Map(holdings.map((item) => [item.ticker, item.weight])))!.scaled, 10);
    expect(kept.leftOut).toEqual([]);
    // Sold: only A's 0.2 is left, at A's own volatility.
    const sold = targetRiskOf(covariance, holdings, new Map([["A", 0.2]]), true)!;
    expect(sold.atTargets.volatility).toBeCloseTo(0.2, 10);
    expect(sold.account!.atTargets).toBeCloseTo(0.04, 10);
    // A target not held cannot be measured: the holdings' figures leave it out, and there is no account figure.
    const away = targetRiskOf(covariance, holdings, new Map([["A", 0.2], ["EIMI", 0.3]]), false)!;
    expect(away.leftOut).toEqual(["EIMI"]);
    expect(away.account).toBeUndefined();
    // Nor is there one when a holding today was not measured.
    expect(targetRiskOf(covariance, [...holdings, { ticker: "Z", weight: 0.1 }], new Map([["A", 0.2]]), true)!.leftOut).toEqual(["Z"]);
    // Kept beside targets that already take the account, the holdings come to more than it: no account figure.
    const over = targetRiskOf(covariance, holdings, new Map([["A", 0.5], ["B", 0.4]]), false)!;
    expect(over.atTargets.weight).toBeCloseTo(1.1, 10);
    expect(over.account).toBeUndefined();
    expect(over.leftOut).toEqual([]);
    expect(targetRiskOf(covariance, holdings, new Map([["A", 0.5], ["B", 0.3]]), false)!.account).toBeDefined();
    // So is the cash target: 0.5 + 0.3 + C's 0.2 kept leave none for 10% in cash.
    expect(targetRiskOf(covariance, holdings, new Map([["A", 0.5], ["B", 0.3]]), false, 0.1)!.account).toBeUndefined();
    expect(targetRiskOf(covariance, holdings, new Map([["A", 0.4], ["B", 0.3]]), false, 0.1)!.account).toBeDefined();
    // Nothing measured at the targets: nothing to say.
    expect(targetRiskOf(covariance, holdings, new Map([["EIMI", 0.5]]), true)).toBeUndefined();
  });

  it("puts the volatility at the saved targets on the drift, rounded, when both are there", () => {
    const drift = { rows: [{ ticker: "A", target: 0.3, current: 0.4, drift: 0.1 }], cash: { target: 0.2, current: 0.2, drift: 0 }, sellUntargeted: false } as unknown as AllocationDrift;
    const holdings = [{ ticker: "A", weight: 0.4 }, { ticker: "B", weight: 0.2 }, { ticker: "C", weight: 0.2 }] as AllocationAnalysis["holdings"];
    const saved = withTargetVolatility({ holdings, drift }, covariance);
    const expected = targetRiskOf(covariance, holdings, new Map([["A", 0.3]]), false, 0.2)!;
    expect(saved.drift!.volatility).toEqual({
      now: Math.round(expected.now.volatility * 1e6) / 1e6,
      atTargets: Math.round(expected.atTargets.volatility * 1e6) / 1e6,
      account: { now: Math.round(expected.account!.now * 1e6) / 1e6, atTargets: Math.round(expected.account!.atTargets * 1e6) / 1e6 },
    });
    expect(withTargetVolatility({ holdings, drift }, undefined)).toEqual({ holdings, drift });
    expect(withTargetVolatility({ holdings }, covariance)).toEqual({ holdings });
  });
});

describe("against the market", () => {
  const market = pattern([1, -1, 2, -2, 1, 1, -1, -2]);
  it("reads each holding's beta and the holdings' together, and the market's worst week", () => {
    // A moves half as much again as the market; B does not follow it at all (+,-,+,- against its pattern's sign).
    const a = market.map((move) => 1.5 * move);
    const b = pattern([1, -1, -1, 1, -1, 1, 1, -1], 0.01);
    const risk = holdingRiskOf([holding("A", 3000, a), holding("B", 1000, b)], TODAY, undefined, undefined, [], { ticker: "M", points: fridays(market) })!;
    const sensitivity = risk.market!;
    expect(sensitivity).toMatchObject({ ticker: "M", weeks: 52, from: "2025-10-10", to: "2026-10-09" });
    const byTicker = new Map(sensitivity.rows.map((row) => [row.ticker, row]));
    expect(byTicker.get("A")).toMatchObject({ beta: 1.5, correlation: 1, weight: 0.75 });
    expect(sensitivity.rows[0]!.ticker).toBe("A");
    // Together: their weights times their betas.
    expect(sensitivity.beta).toBeCloseTo(0.75 * 1.5 + 0.25 * byTicker.get("B")!.beta, 4);
    expect(sensitivity.correlation).toBeGreaterThan(0.9);
    // The market's worst single week is a −4% log move; the mix's simple return that week at today's weights.
    expect(sensitivity.worstWeek!.market).toBeCloseTo(Math.exp(-0.04) - 1, 6);
    expect(sensitivity.worstWeek!.mix).toBeLessThan(sensitivity.worstWeek!.market);
  });

  it("reads only the weeks the market has a close in, and nothing from a market that does not move", () => {
    const a = market.map((move) => 1.5 * move);
    const holdings = [holding("A", 3000, a), holding("B", 1000, market)];
    // The market's closes stop after 20 weeks: too few to read a beta from.
    expect(holdingRiskOf(holdings, TODAY, undefined, undefined, [], { ticker: "M", points: fridays(market).slice(0, 21) })!.market).toBeUndefined();
    expect(holdingRiskOf(holdings, TODAY, undefined, undefined, [], { ticker: "M", points: fridays(market.map(() => 0)) })!.market).toBeUndefined();
    // A gap of a few weeks in the market's closes leaves the rest read.
    const gapped = fridays(market).filter((_, index) => index < 10 || index > 13);
    expect(holdingRiskOf(holdings, TODAY, undefined, undefined, [], { ticker: "M", points: gapped })!.market).toMatchObject({ weeks: 48 });
  });

  it("turns the beta into what a 5%, 10% and 20% fall would take, of the holdings and of the account", () => {
    expect(marketScenarios(1.2, 10_000, 12_500)).toEqual([
      { market: -0.05, move: -0.06, amount: -600, account: -0.048 },
      { market: -0.1, move: -0.12, amount: -1200, account: -0.096 },
      { market: -0.2, move: -0.24, amount: -2400, account: -0.192 },
    ]);
    expect(marketScenarios(0.5, 1000)[0]).toEqual({ market: -0.05, move: -0.025, amount: -25 });
  });
});
