// The widget's own tooltips. A `title` shows the browser's tooltip: late, in the system's look whatever the theme,
// never for the keyboard, and never on a touch screen, where much of the widget is used. This layer shows the same
// text as a bubble in the theme instead: after a moment's hover, at once for a control reached with the keyboard, and
// on a long press. While the bubble shows, the element's `title` is set aside (so the browser's does not show over
// it) and the bubble describes the element instead; both are put back when it goes. React may change either while
// they are aside: a new title is taken up by the bubble, a new description kept, and both are what is put back.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { visibleArea } from "./select";

const HOVER_MS = 350;
const PRESS_MS = 450;
const TOUCH_SHOW_MS = 3000;
const GAP = 8;

/** Where a bubble of `size` goes for an element at `rect`: above it, or below when there is no room above in the part
 * of the frame the reader sees (`frame.top` to `frame.bottom`), and moved sideways to stay inside the frame. */
export function placeTip(rect: { top: number; bottom: number; left: number; width: number }, size: { width: number; height: number }, frame: { width: number; top: number; bottom: number }) {
  const above = rect.top - GAP - size.height;
  const top = above >= frame.top + GAP || rect.bottom + GAP + size.height > frame.bottom ? Math.max(frame.top + GAP, above) : rect.bottom + GAP;
  const centre = rect.left + rect.width / 2 - size.width / 2;
  const left = Math.min(Math.max(GAP, centre), Math.max(GAP, frame.width - GAP - size.width));
  return { top: Math.round(top), left: Math.round(left), below: top > rect.top };
}

export function TipLayer({ id = "tp-tip" }: { id?: string }) {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect; area: { top: number; bottom: number } } | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let owner: HTMLElement | null = null;
    let described: string | null = null;
    let shown = false;
    // The hover or press about to show the bubble, and, after a long press, the bubble's own end.
    let wait = 0;
    let hide = 0;
    let pressed: { x: number; y: number; element: HTMLElement } | null = null;
    // After a long press, the click its lift brings on that element (and no other) shows nothing more.
    let eat: HTMLElement | null = null;
    let eatEnd = 0;
    const describes = (value: string | null) => Boolean(value?.split(/\s+/).includes(id));

    // React writes the attributes it owns whenever it renders: a title written again is the bubble's new text, a
    // description written again is the element's own, to keep and put back.
    const watch = new MutationObserver(() => {
      if (!owner) return;
      if (!owner.isConnected) { give(); return; }
      if (owner.hasAttribute("title")) {
        const text = owner.getAttribute("title") ?? "";
        owner.removeAttribute("title");
        if (!text.trim()) { delete owner.dataset.tipTitle; give(); return; }
        owner.dataset.tipTitle = text;
        if (shown) show();
      }
      const now = owner.getAttribute("aria-describedby");
      if (!describes(now)) { described = now; owner.setAttribute("aria-describedby", now ? `${now} ${id}` : id); }
    });
    // An element taken away while its bubble shows takes the bubble with it.
    const gone = new MutationObserver(() => { if (owner && !owner.isConnected) give(); });

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
      watch.observe(element, { attributes: true, attributeFilter: ["title", "aria-describedby"] });
      gone.observe(document.body, { childList: true, subtree: true });
    };
    const give = () => {
      window.clearTimeout(wait);
      window.clearTimeout(hide);
      watch.disconnect();
      gone.disconnect();
      if (owner) {
        const text = owner.dataset.tipTitle;
        delete owner.dataset.tipTitle;
        if (text !== undefined && !owner.hasAttribute("title")) owner.setAttribute("title", text);
        if (described) owner.setAttribute("aria-describedby", described); else owner.removeAttribute("aria-describedby");
      }
      owner = null;
      described = null;
      shown = false;
      setTip(null);
    };
    const show = () => {
      const element = owner;
      if (!element?.isConnected || !element.dataset.tipTitle) return;
      shown = true;
      void visibleArea().then((area) => {
        if (owner === element && shown && element.dataset.tipTitle) setTip({ text: element.dataset.tipTitle, rect: element.getBoundingClientRect(), area });
      });
    };
    const titled = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[title], [data-tip-title]") : null);
    const inside = (node: EventTarget | null, ...boxes: (Element | null)[]) => node instanceof Node && boxes.some((box) => box?.contains(node));

    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch" || inside(event.target, bubble.current)) return;
      const element = titled(event.target);
      if (!element) return;
      if (element !== owner) { take(element); window.clearTimeout(wait); wait = window.setTimeout(show, HOVER_MS); }
    };
    // Leaving the element, or the bubble the pointer moved onto to read it, takes the bubble away; the pointer
    // leaving anything else does not (a bubble shown for the keyboard stays while the mouse moves).
    const out = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !owner) return;
      if (!inside(event.target, owner, bubble.current)) return;
      if (!inside(event.relatedTarget, owner, bubble.current)) give();
    };
    const focus = (event: FocusEvent) => {
      const element = event.target instanceof HTMLElement && event.target.hasAttribute("title") ? event.target : null;
      if (!element || !element.matches(":focus-visible")) return;
      take(element);
      show();
    };
    const blur = (event: FocusEvent) => { if (event.target === owner) give(); };
    const press = (element: HTMLElement) => {
      pressed = null;
      take(element);
      show();
      eat = element;
      // Nothing hovers on a touch screen to take it away: it goes by itself after a while.
      hide = window.setTimeout(give, TOUCH_SHOW_MS);
    };
    const down = (event: PointerEvent) => {
      // Whatever a long press left to swallow is not this press's.
      eat = null;
      window.clearTimeout(eatEnd);
      if (event.pointerType !== "touch") { if (owner && !inside(event.target, owner, bubble.current)) give(); return; }
      give();
      const element = titled(event.target);
      if (!element) return;
      pressed = { x: event.clientX, y: event.clientY, element };
      wait = window.setTimeout(() => press(element), PRESS_MS);
    };
    const move = (event: PointerEvent) => {
      if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 10) { pressed = null; window.clearTimeout(wait); }
    };
    // The click a lift brings comes at once; one later is a new press of its own.
    // Only a finger's: a mouse pressed before its hover shows leaves the hover to show.
    const up = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      pressed = null;
      window.clearTimeout(wait);
      if (eat) eatEnd = window.setTimeout(() => { eat = null; }, 400);
    };
    const cancel = (event: PointerEvent) => { if (event.pointerType !== "touch") return; pressed = null; window.clearTimeout(wait); eat = null; };
    // A long press shows the bubble; it does not also press the button under it.
    const click = (event: MouseEvent) => {
      if (eat && inside(event.target, eat)) { event.preventDefault(); event.stopPropagation(); }
      eat = null;
    };
    // A phone takes a long press for the menu (Android, at about 400 ms) or the start of a selection: on a titled
    // element it shows the bubble instead.
    const menu = (event: Event) => {
      if (pressed) { event.preventDefault(); window.clearTimeout(wait); press(pressed.element); }
      else if (eat) event.preventDefault();
    };
    // Escape takes a showing bubble away, and only that: not the panel or full view around it too.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !owner) return;
      const was = shown;
      give();
      if (was) { event.preventDefault(); event.stopPropagation(); }
    };
    const away = () => give();

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("click", click, true);
    document.addEventListener("contextmenu", menu, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("blur", away);
    return () => {
      give();
      window.clearTimeout(eatEnd);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("click", click, true);
      document.removeEventListener("contextmenu", menu, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("blur", away);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!tip || !bubble.current) { setPlace(null); return; }
    setPlace(placeTip(tip.rect, { width: bubble.current.offsetWidth, height: bubble.current.offsetHeight }, { width: document.documentElement.clientWidth, ...tip.area }));
  }, [tip]);

  // Always in the page, so the element it describes points at something; empty and hidden when there is no tip.
  return (
    <div ref={bubble} id={id} role="tooltip" className={`tipBubble${tip && place ? " shown" : ""}${place?.below ? " below" : ""}`}
      style={place ? { top: place.top, left: place.left } : undefined} hidden={!tip}>
      {tip?.text}
    </div>
  );
}
