import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select, typedOption } from "./select";

const options = [{ value: "added", label: "Date added" }, { value: "move", label: "Day's move" }, { value: "level", label: "Distance to level" }] as const;

describe("the widget's own select", () => {
  it("is a closed combobox showing the choice, its list in the page but hidden", () => {
    const html = renderToStaticMarkup(createElement(Select<"added" | "move" | "level">, { value: "move", options, label: "Sort", onChange: () => {} }));
    expect(html).toMatch(/<button type="button" id="[^"]+" class="selectBox" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="([^"]+)" aria-label="Sort">/);
    expect(html).toContain('<span class="selectValue" title="Day&#x27;s move">Day&#x27;s move</span>');
    expect(html).toMatch(/<ul id="[^"]+" role="listbox" tabindex="-1" hidden="" aria-label="Sort" class="selectList">/);
    // Each option carries its value, and the chosen one is marked, with a tick.
    expect([...html.matchAll(/aria-selected="(true|false)" data-value="([a-z]+)"/g)].map((match) => `${match[2]} ${match[1]}`)).toEqual(["added false", "move true", "level false"]);
    expect(html.match(/selectCheck/g)).toHaveLength(1);
    // The list is controlled by the box: the ids match.
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<ul id="${controls}"`);
  });

  it("takes a Field's id, hint and error", () => {
    const html = renderToStaticMarkup(createElement(Select<"a" | "b">, { value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], id: "x", describedBy: "x-hint", invalid: true, disabled: true, onChange: () => {} }));
    expect(html).toContain('id="x" class="selectBox"');
    expect(html).toContain('aria-describedby="x-hint" aria-invalid="true" disabled=""');
  });

  it("moves to the option typed, a repeated letter cycling through those starting with it", () => {
    const labels = ["Apple", "Amazon", "Broadcom", "Alphabet"];
    expect(typedOption(labels, "a", 0)).toBe(1);
    expect(typedOption(labels, "aa", 1)).toBe(3);
    expect(typedOption(labels, "aaa", 3)).toBe(0);
    // Several letters find the first label starting with them, the active one included.
    expect(typedOption(labels, "al", 0)).toBe(3);
    expect(typedOption(labels, "am", 1)).toBe(1);
    expect(typedOption(labels, "b", 3)).toBe(2);
    expect(typedOption(labels, "z", 0)).toBeUndefined();
    expect(typedOption([], "a", 0)).toBeUndefined();
    // Case and other scripts: letters are compared as lower case.
    expect(typedOption(["按成本", "按市值"], "按市", 0)).toBe(1);
  });
});
