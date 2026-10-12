// A squarified treemap (Bruls, Huizing and van Wijk): tiles whose areas follow the values, laid out in rows along the
// shorter side so each tile stays as close to a square as it can, largest first.

export interface TreemapItem<T> { value: number; item: T }
export interface TreemapTile<T> { item: T; x: number; y: number; width: number; height: number }

/** The worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(row: number[], side: number): number {
  const sum = row.reduce((total, area) => total + area, 0);
  const max = Math.max(...row), min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Tiles for the items with a positive value, largest first, filling a `width` by `height` rectangle. */
export function treemap<T>(items: Array<TreemapItem<T>>, width: number, height: number): Array<TreemapTile<T>> {
  const sorted = items.filter((entry) => entry.value > 0 && Number.isFinite(entry.value)).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, entry) => sum + entry.value, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const areas = sorted.map((entry) => entry.value * scale);
  const tiles: Array<TreemapTile<T>> = [];
  let x = 0, y = 0, w = width, h = height, start = 0;
  while (start < areas.length) {
    const side = Math.min(w, h);
    let end = start + 1;
    while (end < areas.length && worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)) end += 1;
    const row = areas.slice(start, end);
    const sum = row.reduce((total, area) => total + area, 0);
    // The row runs along the shorter side and takes its share of the longer one.
    const thickness = sum / side;
    let offset = 0;
    row.forEach((area, index) => {
      const length = area / thickness;
      const entry = sorted[start + index]!;
      if (w >= h) tiles.push({ item: entry.item, x, y: y + offset, width: thickness, height: length });
      else tiles.push({ item: entry.item, x: x + offset, y, width: length, height: thickness });
      offset += length;
    });
    if (w >= h) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
    start = end;
  }
  return tiles;
}
