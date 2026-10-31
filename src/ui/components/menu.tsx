// A button that opens a short list of actions, drawn by the widget: the menu button of the ARIA practices. Opening it
// moves the focus to its first item (Up opens it on the last); the arrows, Home, End and typing move between items,
// Enter or Space runs one, Escape closes it back to the button, and Tab closes it and moves on.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { typedOption, visibleArea } from "./select";

export interface MenuItem {
  id: string;
  label: string;
  /** A second line under the label, such as what a file holds. */
  detail?: string;
}

export function Menu({ label, items, onChoose, disabled = false, className, children }: {
  /** The button's name, read out and shown as its tip. */
  label: string;
  items: readonly MenuItem[];
  onChoose: (id: string) => void;
  disabled?: boolean;
  className?: string;
  /** What the button shows: an icon, and text where there is room. */
  children: ReactNode;
}) {
  const own = useId();
  const menuId = `${own}-menu`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Null until measured for this opening: the list is laid out unseen until then, so it never shows where it would not fit.
  const [placement, setPlacement] = useState<{ above: boolean; shift: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const show = (index: number) => {
    setActive(index);
    setOpen(true);
    // Already open on that item (a key on the button): the focus goes back into the menu.
    if (open) list.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[index]?.focus();
  };
  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); };
  const run = (index: number) => {
    const item = items[index];
    close(true);
    if (item) onChoose(item.id);
  };

  // The focus follows the item reached, inside the menu.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[active]?.focus();
  }, [open, active]);
  // Opened below the button, or above it where the reader sees more room there; from the button's end, moved toward
  // its start as far as it needs to stay inside the frame.
  useEffect(() => {
    if (!open) { setPlacement(null); return; }
    let live = true;
    void visibleArea().then((area) => {
      if (!live || !button.current || !list.current) return;
      const rect = button.current.getBoundingClientRect();
      const below = area.bottom - rect.bottom - 8;
      const past = 8 - (rect.right - list.current.offsetWidth);
      setPlacement({ above: below < list.current.scrollHeight && rect.top - area.top > below, shift: past > 0 ? -past : 0 });
    });
    return () => { live = false; };
  }, [open]);
  // A press anywhere else closes it, leaving the focus where the press put it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const buttonKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") { event.preventDefault(); show(0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); show(items.length - 1); }
  };
  const menuKeys = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = items.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(active === last ? 0 : active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(active === 0 ? last : active - 1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(last); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(active); }
    // Escape closes the menu only, not the host's full view.
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") close(false);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = now - typed.current.at > 500 ? event.key : typed.current.text + event.key;
      typed.current = { text, at: now };
      const found = typedOption(items.map((item) => item.label), text, active);
      if (found !== undefined) { event.preventDefault(); setActive(found); }
    }
  };

  return (
    <div ref={wrap} className={`menuWrap${className ? ` ${className}` : ""}${open ? " open" : ""}`}>
      <button ref={button} type="button" className="iconAction" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={label} title={label}
        disabled={disabled} onClick={() => (open ? close(true) : show(0))} onKeyDown={buttonKeys}>
        {children}
      </button>
      <ul ref={list} id={menuId} role="menu" aria-label={label} hidden={!open} className={`menuList${placement?.above ? " above" : ""}`}
        style={!placement ? { opacity: 0 } : placement.shift ? { insetInlineEnd: placement.shift } : undefined} onKeyDown={menuKeys}>
        {items.map((item, index) => (
          <li key={item.id} role="menuitem" tabIndex={index === active ? 0 : -1} className={index === active ? "menuItem active" : "menuItem"} data-item={item.id}
            onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => run(index)}>
            <span>{item.label}</span>
            {item.detail && <span className="menuDetail">{item.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
