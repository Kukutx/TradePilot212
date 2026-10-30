// Keyboard use of the widget's radio groups (period switches, table or map, and the like), as native radios work:
// one Tab stop on the chosen option, and the arrow keys, Home and End move to another option and choose it.

import type { KeyboardEvent } from "react";

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** On a `role="radiogroup"`: moves to the next or previous enabled option (wrapping round), or the first or last. */
export function radioKeys(event: KeyboardEvent<HTMLElement>): void {
  const step = STEPS[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')];
  const at = radios.indexOf(event.target as HTMLElement);
  if (at < 0 || !radios.length) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 : (at + step! + radios.length) % radios.length;
  event.preventDefault();
  const target = radios[next]!;
  target.focus();
  if (target.getAttribute("aria-checked") !== "true") target.click();
}

/** An option's place in the Tab order: only the chosen one is a stop, the rest are reached with the arrow keys. */
export const radioTab = (checked: boolean): 0 | -1 => (checked ? 0 : -1);
