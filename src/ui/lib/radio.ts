// Keyboard use of the widget's radio groups (period switches, table or map, and the like), as native radios work:
// one Tab stop on the chosen option, and the arrow keys, Home and End move to another option and choose it. A group
// whose choice reads data (a period, a history view) only moves with the keys; Space or Enter chooses.

import type { KeyboardEvent } from "react";

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * On a `role="radiogroup"`: moves to the next or previous enabled option (wrapping round), or the first or last, and
 * chooses it unless `follow` is false. Keys with Alt, Ctrl or Meta are the browser's (back, forward) and left alone.
 */
export function radioKeys(event: KeyboardEvent<HTMLElement>, follow = true): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const step = STEPS[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')];
  const at = radios.indexOf(event.target as HTMLElement);
  if (at < 0 || !radios.length) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 : (at + step! + radios.length) % radios.length;
  event.preventDefault();
  const target = radios[next]!;
  target.focus();
  if (follow && target.getAttribute("aria-checked") !== "true") target.click();
}

/** radioKeys for a group whose choice reads data: the keys move between options, Space or Enter chooses one. */
export const radioMoveKeys = (event: KeyboardEvent<HTMLElement>): void => radioKeys(event, false);

/**
 * An option's place in the Tab order: only the chosen one is a stop, the rest are reached with the arrow keys. When
 * none is chosen (a custom period, a tax year of its own), `first` makes the first option the stop, so the group can
 * still be reached.
 */
export const radioTab = (checked: boolean, first = false): 0 | -1 => (checked || first ? 0 : -1);

/** radioTab for `key` among `keys` when `value` may be none of them. */
export const radioTabOf = <T,>(keys: readonly T[], value: T | null | undefined, key: T): 0 | -1 =>
  radioTab(value === key, key === keys[0] && !keys.includes(value as T));
