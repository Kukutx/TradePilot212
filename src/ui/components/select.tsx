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
  // Until the room around the box is known, the open list is laid out but not seen.
  const [placement, setPlacement] = useState<{ above: boolean; shift: number; height: number } | null>(null);
  const box = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const value_ = useRef<HTMLSpanElement>(null);
  const typed = useRef({ text: "", at: 0 });
  // The list scrolls to the option reached with the keys; one under the pointer is already in view.
  const byKeys = useRef(false);

  const show = (index: number) => { byKeys.current = true; setActive(Math.min(Math.max(index, 0), options.length - 1)); setOpen(true); };
  const move = (index: number) => { byKeys.current = true; setActive(Math.min(Math.max(index, 0), options.length - 1)); };
  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value && !disabled) onChange(option.value);
  };
  // What was typed in the last half second.
  const match = (key: string, from: number) => {
    const now = Date.now();
    const text = now - typed.current.at > 500 ? key : typed.current.text + key;
    typed.current = { text, at: now };
    return typedOption(options.map((option) => option.label), text, from);
  };

  // Opened below the box, or above it when there is more room there, in the part of the frame the reader can see: an
  // inline widget's frame is as tall as the widget, mostly scrolled out of the host's view. Moved left as far as it
  // needs to keep inside the frame, never past its left edge (the list is never wider than the frame).
  useEffect(() => {
    if (!open) { setPlacement(null); return; }
    let live = true;
    void visibleArea().then((area) => {
      if (!live || !box.current || !list.current) return;
      const rect = box.current.getBoundingClientRect();
      const below = area.bottom - rect.bottom - 8;
      const above = rect.top - area.top - 8;
      const wanted = Math.min(list.current.scrollHeight, 280);
      const up = below < wanted && above > below;
      const overflow = rect.left + list.current.offsetWidth - (document.documentElement.clientWidth - 8);
      setPlacement({ above: up, shift: overflow > 0 ? -Math.min(overflow, rect.left - 8) : 0, height: Math.max(120, Math.min(280, up ? above : below)) });
    });
    return () => { live = false; };
  }, [open]);
  // The option reached with the keys is scrolled into the list's view, the list alone: scrollIntoView would scroll the
  // host's page too.
  useEffect(() => {
    if (!open || !placement || !byKeys.current || !list.current) return;
    byKeys.current = false;
    const item = list.current.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`);
    if (!item) return;
    const { scrollTop, clientHeight } = list.current;
    if (item.offsetTop < scrollTop) list.current.scrollTop = item.offsetTop - 4;
    else if (item.offsetTop + item.offsetHeight > scrollTop + clientHeight) list.current.scrollTop = item.offsetTop + item.offsetHeight - clientHeight + 4;
  }, [open, active, placement]);
  useEffect(() => { if (!open) setActive(chosen); }, [open, chosen]);
  // A press anywhere else closes it. Blur alone is not enough: Safari does not focus a button that is clicked.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  // A box that turns busy while open closes its list: what it would choose could not be read now.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  // The choice carries a title only when the box cuts it short.
  useLayoutEffect(() => {
    const span = value_.current;
    if (!span) return;
    if (span.scrollWidth > span.clientWidth + 1) span.title = options[chosen]?.label ?? "";
    else span.removeAttribute("title");
  });

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
    // A space typed mid-word is part of what is typed ("Day's move"), not a choice.
    const typing = event.key === " " && Date.now() - typed.current.at <= 500;
    if (event.key === "ArrowUp" && event.altKey) { event.preventDefault(); choose(active); }
    else if (step[event.key] !== undefined) { event.preventDefault(); move(active + step[event.key]!); }
    else if (event.key === "Home") { event.preventDefault(); move(0); }
    else if (event.key === "End") { event.preventDefault(); move(last); }
    else if (event.key === "Enter" || (event.key === " " && !typing)) { event.preventDefault(); choose(active); }
    else if (event.key === "Tab") choose(active);
    // Escape closes the list only, not the host's full view or a panel around it.
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const found = match(event.key, active);
      if (found !== undefined) { event.preventDefault(); move(found); }
    }
  };

  return (
    <div ref={wrap} className={`selectWrap${className ? ` ${className}` : ""}${open ? " open" : ""}`}>
      <button ref={box} type="button" id={boxId} className="selectBox" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        {...(open ? { "aria-activedescendant": optionId(active) } : {})} {...(label ? { "aria-label": label } : {})} {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
        {...(describedBy ? { "aria-describedby": describedBy } : {})} {...(invalid ? { "aria-invalid": true } : {})} disabled={disabled}
        onClick={() => { box.current?.focus(); if (open) setOpen(false); else show(chosen); }} onKeyDown={keys} onBlur={() => setOpen(false)}>
        <span ref={value_} className="selectValue">{options[chosen]?.label ?? ""}</span>
      </button>
      <ul ref={list} id={listId} role="listbox" tabIndex={-1} hidden={!open} {...(label ? { "aria-label": label } : {})} {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
        className={`selectList${placement?.above ? " above" : ""}${open && !placement ? " measuring" : ""}`} style={placement ? { maxHeight: placement.height, insetInlineStart: placement.shift } : undefined}
        // The box keeps the focus while the list is used with the mouse or a finger, its scrollbar included.
        onMouseDown={(event) => event.preventDefault()}>
        {options.map((option, index) => (
          // As the ARIA practices' select-only combobox: the option reached is the selected one; the tick marks the choice.
          <li key={option.value} id={optionId(index)} role="option" aria-selected={index === active} data-value={option.value} data-chosen={index === chosen || undefined}
            className={index === active ? "selectOption active" : "selectOption"}
            onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => choose(index)}>
            <span>{option.label}</span>{index === chosen && <Icon name="check" className="selectCheck" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The part of this frame the reader can see, in its own coordinates. An inline widget's frame is as tall as the widget
 * and the host scrolls it, so the window's height says nothing; the root element's intersection with the top-level
 * viewport does, across origins too. Falls back to the whole window where that is not known.
 */
function visibleArea(): Promise<{ top: number; bottom: number }> {
  const whole = { top: 0, bottom: window.innerHeight };
  if (typeof IntersectionObserver === "undefined") return Promise.resolve(whole);
  return new Promise((resolve) => {
    const done = (area: { top: number; bottom: number }) => { observer.disconnect(); window.clearTimeout(late); resolve(area); };
    const observer = new IntersectionObserver(([entry]) => {
      const seen = entry?.intersectionRect;
      done(seen && seen.height > 0 ? { top: Math.max(0, seen.top), bottom: Math.min(window.innerHeight, seen.bottom) } : whole);
    });
    const late = window.setTimeout(() => done(whole), 150);
    observer.observe(document.documentElement);
  });
}

/** The props a Field hands its control, as a Select takes them. */
export const fieldSelect = (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ({
  id: props.id,
  // The list is named by the Field's label too, as the box is.
  labelledBy: `${props.id}-label`,
  ...(props["aria-describedby"] ? { describedBy: props["aria-describedby"] } : {}),
  ...(props["aria-invalid"] ? { invalid: true } : {}),
});
