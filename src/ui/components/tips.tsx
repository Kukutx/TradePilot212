// The widget's own tooltips. A `title` shows the browser's tooltip: late, in the system's look whatever the theme,
// never for the keyboard, and never on a touch screen, where much of the widget is used. This layer shows the same
// text as a bubble in the theme instead: after a moment's hover, at once for a control reached with the keyboard, and
// on a long press. While the bubble shows, the element's `title` is set aside (so the browser's does not show over
// it) and the bubble describes the element instead; both are put back when it goes.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const HOVER_MS = 350;
const PRESS_MS = 450;
const TOUCH_SHOW_MS = 3000;
const GAP = 8;

/** Where a bubble of `size` goes for an element at `rect`: above it, or below when there is no room above, and
 * moved sideways to stay inside the frame. */
export function placeTip(rect: { top: number; bottom: number; left: number; width: number }, size: { width: number; height: number }, frame: { width: number; height: number }) {
  const above = rect.top - GAP - size.height;
  const top = above >= GAP || rect.bottom + GAP + size.height > frame.height ? Math.max(GAP, above) : rect.bottom + GAP;
  const centre = rect.left + rect.width / 2 - size.width / 2;
  const left = Math.min(Math.max(GAP, centre), Math.max(GAP, frame.width - GAP - size.width));
  return { top: Math.round(top), left: Math.round(left), below: top > rect.top };
}

export function TipLayer({ id = "tp-tip" }: { id?: string }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let owner: HTMLElement | null = null;
    let described: string | null = null;
    let wait = 0;
    let pressed: { x: number; y: number } | null = null;
    let eatClick = false;

    // The title goes aside as soon as the pointer or focus arrives, before the browser's own tooltip would show.
    const take = (element: HTMLElement) => {
      if (owner === element) return;
      give();
      const text = element.getAttribute("title");
      if (!text?.trim()) return;
      owner = element;
      element.dataset.tipTitle = text;
      element.removeAttribute("title");
      described = element.getAttribute("aria-describedby");
      element.setAttribute("aria-describedby", described ? `${described} ${id}` : id);
    };
    const give = () => {
      window.clearTimeout(wait);
      if (owner) {
        const text = owner.dataset.tipTitle;
        delete owner.dataset.tipTitle;
        if (text !== undefined && !owner.hasAttribute("title")) owner.setAttribute("title", text);
        if (described) owner.setAttribute("aria-describedby", described); else owner.removeAttribute("aria-describedby");
      }
      owner = null;
      described = null;
      setTip(null);
    };
    const show = () => { if (owner?.isConnected && owner.dataset.tipTitle) setTip({ text: owner.dataset.tipTitle, rect: owner.getBoundingClientRect() }); };
    const titled = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[title], [data-tip-title]") : null);

    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const element = titled(event.target);
      if (!element) return;
      if (element !== owner) { take(element); window.clearTimeout(wait); wait = window.setTimeout(show, HOVER_MS); }
    };
    const out = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !owner) return;
      if (!(event.relatedTarget instanceof Node && owner.contains(event.relatedTarget))) give();
    };
    const focus = (event: FocusEvent) => {
      const element = event.target instanceof HTMLElement && event.target.hasAttribute("title") ? event.target : null;
      if (!element || !element.matches(":focus-visible")) return;
      take(element);
      show();
    };
    const blur = (event: FocusEvent) => { if (event.target === owner) give(); };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") { if (owner && !owner.contains(event.target as Node)) give(); return; }
      // A long press whose lift brought no click must not swallow this tap's.
      eatClick = false;
      give();
      const element = titled(event.target);
      if (!element) return;
      pressed = { x: event.clientX, y: event.clientY };
      wait = window.setTimeout(() => {
        take(element);
        show();
        eatClick = true;
        // Nothing hovers on a touch screen to take it away: it goes by itself after a while.
        wait = window.setTimeout(give, TOUCH_SHOW_MS);
      }, PRESS_MS);
    };
    const move = (event: PointerEvent) => {
      if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 10) { pressed = null; window.clearTimeout(wait); }
    };
    const up = () => { pressed = null; if (!eatClick) window.clearTimeout(wait); };
    // A long press shows the bubble; it does not also press the button under it.
    const click = (event: MouseEvent) => { if (eatClick) { eatClick = false; event.preventDefault(); event.stopPropagation(); } };
    const menu = (event: Event) => { if (eatClick) event.preventDefault(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && owner) give(); };
    const away = () => give();

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("click", click, true);
    document.addEventListener("contextmenu", menu, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", away, true);
    window.addEventListener("blur", away);
    return () => {
      give();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("click", click, true);
      document.removeEventListener("contextmenu", menu, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("blur", away);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!tip || !bubble.current) { setPlace(null); return; }
    setPlace(placeTip(tip.rect, { width: bubble.current.offsetWidth, height: bubble.current.offsetHeight }, { width: document.documentElement.clientWidth, height: window.innerHeight }));
  }, [tip]);

  // Always in the page, so the element it describes points at something; empty and hidden when there is no tip.
  return (
    <div ref={bubble} id={id} role="tooltip" className={`tipBubble${tip && place ? " shown" : ""}${place?.below ? " below" : ""}`}
      style={place ? { top: place.top, left: place.left } : undefined} hidden={!tip}>
      {tip?.text}
    </div>
  );
}
