import { describe, expect, it } from "vitest";
import type { KeyboardEvent } from "react";
import { radioKeys, radioMoveKeys, radioTab, radioTabOf } from "./radio";

/** A radio group of buttons as the handler sees them: focus and click recorded, the disabled ones left out. */
function group(checked: number, disabled: number[] = [], handler = radioKeys) {
  const log: string[] = [];
  const radios = ["a", "b", "c", "d"].map((name, index) => ({
    name, disabled: disabled.includes(index),
    getAttribute: (key: string) => (key === "aria-checked" ? String(index === checked) : null),
    focus: () => log.push(`focus ${name}`),
    click: () => log.push(`click ${name}`),
  }));
  const press = (key: string, from: number, modifiers: Partial<Record<"altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => {
    let prevented = false;
    const event = {
      key, target: radios[from], ...modifiers,
      currentTarget: { querySelectorAll: () => radios.filter((radio) => !radio.disabled) },
      preventDefault: () => { prevented = true; },
    } as unknown as KeyboardEvent<HTMLElement>;
    handler(event);
    return { log: log.splice(0), prevented };
  };
  return press;
}

describe("radio groups by keyboard", () => {
  it("moves with the arrow keys to the next option and chooses it, wrapping round", () => {
    const press = group(0);
    expect(press("ArrowRight", 0)).toEqual({ log: ["focus b", "click b"], prevented: true });
    expect(press("ArrowDown", 3).log).toEqual(["focus a"]);
    expect(press("ArrowLeft", 0).log).toEqual(["focus d", "click d"]);
    expect(press("End", 1).log).toEqual(["focus d", "click d"]);
    expect(press("Home", 2).log).toEqual(["focus a"]);
  });

  it("skips the options that are off, and leaves other keys alone", () => {
    expect(group(0, [1])("ArrowRight", 0).log).toEqual(["focus c", "click c"]);
    expect(group(0)("Tab", 0)).toEqual({ log: [], prevented: false });
    expect(group(0)(" ", 0).prevented).toBe(false);
  });

  it("leaves a key with a modifier to the browser (Alt+Left goes back, Ctrl+Home scrolls)", () => {
    expect(group(0)("ArrowRight", 0, { altKey: true })).toEqual({ log: [], prevented: false });
    expect(group(0)("Home", 2, { ctrlKey: true })).toEqual({ log: [], prevented: false });
    expect(group(0)("ArrowLeft", 1, { metaKey: true })).toEqual({ log: [], prevented: false });
  });

  it("only moves focus where choosing an option starts a load, so Space or Enter chooses it", () => {
    expect(group(0, [], radioMoveKeys)("ArrowRight", 0)).toEqual({ log: ["focus b"], prevented: true });
  });

  it("makes only the chosen option a Tab stop", () => {
    expect([radioTab(true), radioTab(false)]).toEqual([0, -1]);
    // With none chosen (a custom period), the first option is the stop, so the group can still be reached.
    const keys = ["1m", "3m", "all"];
    expect(keys.map((key) => radioTabOf(keys, null, key))).toEqual([0, -1, -1]);
    expect(keys.map((key) => radioTabOf(keys, "3m", key))).toEqual([-1, 0, -1]);
  });
});
