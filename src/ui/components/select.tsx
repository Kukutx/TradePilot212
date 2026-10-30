// A choice from a list, drawn by the widget: the closed box looks like the other fields, and the open list follows the
// theme and the widget's type instead of the system's menu (or a phone's wheel). It is the select-only combobox of
// the ARIA practices: focus stays on the box, the list's options are announced through aria-activedescendant.
//
// Closed: Down, Up, Enter, Space or Alt+Down opens it on the chosen option; Home and End open it on the first or
// last; typing opens it on the first option starting with what was typed. Open: the arrows, Home, End, Page Up and
// Page Down move, typing jumps, Enter or Space chooses, Tab chooses and moves on, Escape closes without choosing.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./common";

/**
 * The option typing `text` moves to from option `from`: the first label starting with it, from `from` on. A single
 * letter, or one letter typed again and again, moves on to the next label starting with it, so repeating a letter
 * cycles through those labels.
 */
export function typedOption(labels: readonly string[], text: string, from: number): number | undefined {
  if (!text || !labels.length) return undefined;
  const repeat = [...text].every((letter) => letter === text[0]);
  const search = (repeat ? text[0]! : text).toLocaleLowerCase();
  const start = (from + (repeat ? 1 : 0)) % labels.length;
  return labels.map((_, index) => (start + index) % labels.length).find((index) => labels[index]!.toLocaleLowerCase().startsWith(search));
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({ value, options, onChange, disabled = false, className, id, label, labelledBy, describedBy, invalid }: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Placed on the wrapper, so each place keeps its own size. */
  className?: string;
  /** From Field, whose <label htmlFor> names the box. */
  id?: string;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const own = useId();
  const boxId = id ?? `${own}-box`;
  const listId = `${own}-list`;
  const optionId = (index: number) => `${own}-option-${index}`;
  const chosen = Math.max(0, options.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(chosen);
  const [placement, setPlacement] = useState({ above: false, shift: 0, height: 280 });
  const box = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const show = (index: number) => { setActive(Math.min(Math.max(index, 0), options.length - 1)); setOpen(true); };
  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  };
  // What was typed in the last half second.
  const match = (key: string, from: number) => {
    const now = Date.now();
    const text = now - typed.current.at > 500 ? key : typed.current.text + key;
    typed.current = { text, at: now };
    return typedOption(options.map((option) => option.label), text, from);
  };

  // Opened below the box, or above it when the frame has more room there; moved left as far as it needs to keep inside
  // the frame, never past its left edge (the list is never wider than the frame).
  useLayoutEffect(() => {
    if (!open || !box.current || !list.current) return;
    const rect = box.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const wanted = Math.min(list.current.scrollHeight, 280);
    const up = below < wanted && above > below;
    const overflow = rect.left + list.current.offsetWidth - (document.documentElement.clientWidth - 8);
    setPlacement({ above: up, shift: overflow > 0 ? -Math.min(overflow, rect.left - 8) : 0, height: Math.max(120, Math.min(280, up ? above : below)) });
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);
  useEffect(() => { if (!open) setActive(chosen); }, [open, chosen]);

  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(chosen); }
      else if (event.key === "Home") { event.preventDefault(); show(0); }
      else if (event.key === "End") { event.preventDefault(); show(last); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const found = match(event.key, chosen);
        if (found !== undefined) { event.preventDefault(); show(found); }
      }
      return;
    }
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
    if (event.key === "ArrowUp" && event.altKey) { event.preventDefault(); choose(active); }
    else if (step[event.key] !== undefined) { event.preventDefault(); setActive(Math.min(Math.max(active + step[event.key]!, 0), last)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(last); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); }
    else if (event.key === "Tab") choose(active);
    // Escape closes the list only, not the host's full view or a panel around it.
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const found = match(event.key, active);
      if (found !== undefined) { event.preventDefault(); setActive(found); }
    }
  };

  return (
    <div className={`selectWrap${className ? ` ${className}` : ""}${open ? " open" : ""}`}>
      <button ref={box} type="button" id={boxId} className="selectBox" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        {...(open ? { "aria-activedescendant": optionId(active) } : {})} {...(label ? { "aria-label": label } : {})} {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
        {...(describedBy ? { "aria-describedby": describedBy } : {})} {...(invalid ? { "aria-invalid": true } : {})} disabled={disabled}
        onClick={() => (open ? setOpen(false) : show(chosen))} onKeyDown={keys} onBlur={() => setOpen(false)}>
        <span className="selectValue" title={options[chosen]?.label}>{options[chosen]?.label ?? ""}</span>
      </button>
      <ul ref={list} id={listId} role="listbox" tabIndex={-1} hidden={!open} {...(label ? { "aria-label": label } : {})} {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
        className={`selectList${placement.above ? " above" : ""}`} style={open ? { maxHeight: placement.height, insetInlineStart: placement.shift } : undefined}
        // The box keeps the focus while the list is used with the mouse or a finger, its scrollbar included.
        onMouseDown={(event) => event.preventDefault()}>
        {options.map((option, index) => (
          <li key={option.value} id={optionId(index)} role="option" aria-selected={index === chosen} data-value={option.value} className={index === active ? "selectOption active" : "selectOption"}
            onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => choose(index)}>
            <span>{option.label}</span>{index === chosen && <Icon name="check" className="selectCheck" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The props a Field hands its control, as a Select takes them. */
export const fieldSelect = (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ({
  id: props.id,
  ...(props["aria-describedby"] ? { describedBy: props["aria-describedby"] } : {}),
  ...(props["aria-invalid"] ? { invalid: true } : {}),
});
