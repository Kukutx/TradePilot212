import { describe, expect, it } from "vitest";
import { treemap } from "./treemap";

describe("treemap layout", () => {
  const values = [4330, 2556, 2369, 2367, 1407, 300, 120];
  const tiles = treemap(values.map((value, index) => ({ value, item: index })), 700, 320);

  it("gives each item an area in proportion to its value, inside the rectangle, without overlaps", () => {
    const total = values.reduce((sum, value) => sum + value, 0);
    for (const tile of tiles) {
      expect(tile.width * tile.height).toBeCloseTo((values[tile.item]! / total) * 700 * 320, 6);
      expect(tile.x).toBeGreaterThanOrEqual(-1e-9);
      expect(tile.y).toBeGreaterThanOrEqual(-1e-9);
      expect(tile.x + tile.width).toBeLessThanOrEqual(700 + 1e-6);
      expect(tile.y + tile.height).toBeLessThanOrEqual(320 + 1e-6);
    }
    for (const a of tiles) for (const b of tiles) {
      if (a === b) continue;
      const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(overlap).toBeLessThan(1e-6);
    }
  });

  it("lays out the largest first and keeps the tiles near square", () => {
    expect(tiles.map((tile) => tile.item)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Squarified rows keep the large tiles' sides within a few times of each other.
    for (const tile of tiles.slice(0, 4)) expect(Math.max(tile.width / tile.height, tile.height / tile.width)).toBeLessThan(3);
  });

  it("leaves out items without a positive value, and lays out nothing in no room", () => {
    expect(treemap([{ value: 0, item: "a" }, { value: -5, item: "b" }, { value: Number.NaN, item: "c" }, { value: 1, item: "d" }], 100, 100))
      .toEqual([{ item: "d", x: 0, y: 0, width: 100, height: 100 }]);
    expect(treemap([{ value: 1, item: "a" }], 0, 100)).toEqual([]);
    expect(treemap([], 100, 100)).toEqual([]);
  });
});
