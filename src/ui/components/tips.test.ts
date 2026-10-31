import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { placeTip, TipLayer } from "./tips";

describe("the widget's own tooltips", () => {
  const frame = { width: 375, top: 0, bottom: 800 };
  const size = { width: 120, height: 30 };

  it("sits above the element, centred, and below it when there is no room above", () => {
    expect(placeTip({ top: 200, bottom: 230, left: 100, width: 60 }, size, frame)).toEqual({ top: 162, left: 70, below: false });
    expect(placeTip({ top: 20, bottom: 50, left: 100, width: 60 }, size, frame)).toEqual({ top: 58, left: 70, below: true });
  });

  it("goes below when the room above is outside the part of an inline frame the host shows", () => {
    expect(placeTip({ top: 320, bottom: 350, left: 100, width: 60 }, size, { width: 375, top: 300, bottom: 900 })).toEqual({ top: 358, left: 70, below: true });
  });

  it("stays inside the frame at either edge", () => {
    expect(placeTip({ top: 200, bottom: 230, left: 2, width: 20 }, size, frame).left).toBe(8);
    expect(placeTip({ top: 200, bottom: 230, left: 360, width: 14 }, size, frame).left).toBe(375 - 8 - 120);
    // Wider than the frame: from its left edge.
    expect(placeTip({ top: 200, bottom: 230, left: 100, width: 10 }, { width: 400, height: 30 }, frame).left).toBe(8);
  });

  it("is in the page from the start, hidden and empty, so what it describes always points at it", () => {
    expect(renderToStaticMarkup(createElement(TipLayer))).toBe('<div id="tp-tip" role="tooltip" class="tipBubble" hidden=""></div>');
  });
});
