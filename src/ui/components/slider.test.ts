import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Slider, sliderKey, sliderShare, snapToStep } from "./slider";

describe("the widget's own slider", () => {
  it("lands on its steps, inside its ends, without a float's tail", () => {
    expect(snapToStep(6.26, -5, 15, 0.5)).toBe(6.5);
    expect(snapToStep(0.30000000000000004, 0, 10, 0.1)).toBe(0.3);
    expect(snapToStep(99, 0, 40, 0.5)).toBe(40);
    expect(snapToStep(-9, -5, 15, 0.5)).toBe(-5);
    expect(snapToStep(Number.NaN, 0, 40, 0.5)).toBe(0);
    expect(snapToStep(1234, 0, 3000, 10)).toBe(1230);
  });

  it("moves a step with the arrows, ten with the page keys, and to its ends with Home and End", () => {
    expect(sliderKey("ArrowRight", 6, -5, 15, 0.5)).toBe(6.5);
    expect(sliderKey("ArrowDown", 6, -5, 15, 0.5)).toBe(5.5);
    expect(sliderKey("PageUp", 6, -5, 15, 0.5)).toBe(11);
    expect(sliderKey("PageDown", -1, -5, 15, 0.5)).toBe(-5);
    expect(sliderKey("Home", 6, -5, 15, 0.5)).toBe(-5);
    expect(sliderKey("End", 6, -5, 15, 0.5)).toBe(15);
    // A value typed outside its ends moves from that end.
    expect(sliderKey("ArrowLeft", 30, -5, 15, 0.5)).toBe(14.5);
    expect(sliderKey("Enter", 6, -5, 15, 0.5)).toBeUndefined();
  });

  it("is a named slider with its value in words, drawn by the widget, never the browser's range input", () => {
    expect(sliderShare(5, 0, 20)).toBe(0.25);
    expect(sliderShare(50, 0, 20)).toBe(1);
    const html = renderToStaticMarkup(createElement(Slider, { value: 5, min: 0, max: 20, step: 0.5, labelledBy: "goal-label", valueText: "5%", onChange: () => {} }));
    expect(html).toContain('role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="20" aria-valuenow="5" aria-valuetext="5%" aria-orientation="horizontal" aria-labelledby="goal-label"');
    expect(html).toContain('<span class="sliderFill" style="width:25.00%"></span><span class="sliderThumb" style="left:25.00%"></span>');
    expect(html).not.toContain("<input");
    const off = renderToStaticMarkup(createElement(Slider, { value: 5, min: 0, max: 20, step: 1, label: "Volatility", valueText: "5%", disabled: true, onChange: () => {} }));
    expect(off).toContain('class="slider disabled" role="slider" tabindex="-1"');
    expect(off).toContain('aria-label="Volatility" aria-disabled="true"');
  });
});
