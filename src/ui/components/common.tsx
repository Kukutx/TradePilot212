import { useEffect, useId, useRef, type CSSProperties, type InputHTMLAttributes, type ReactNode, type Ref, type RefObject } from "react";
import type { Position } from "../../shared/contracts";
import { instrumentLabel, type InstrumentBook } from "../lib/instruments";

export type IconName = "refresh" | "expand" | "collapse" | "globe" | "close" | "arrow" | "alert" | "calendar" | "check";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const paths = {
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6"/></>,
    collapse: <><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    close: <path d="M6 6l12 12M18 6L6 18"/>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6"/>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></>,
    calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></>,
    check: <path d="M5 12.5l4.5 4.5L19 7.5"/>,
  } as const;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={`icon${className ? ` ${className}` : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function DetailSection({ title, text }: { title: string; text: string }) {
  return <section><h3>{title}</h3><p>{text}</p></section>;
}

export function DetailList({ title, items }: { title: string; items: string[] }) {
  return <section><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>;
}

export function Metric({ label, value, compact = false, tone }: { label: string; value: ReactNode; compact?: boolean; tone?: string }) {
  return <div className={`metric ${compact ? "compact" : ""}`}><span>{label}</span><strong className={tone} title={typeof value === "string" ? value : undefined}>{value}</strong></div>;
}

export function SectionHeader({ title, count }: { title: string; count: number }) {
  return <div className="sectionHeader"><h2>{title}</h2><span>{count}</span></div>;
}

/**
 * A labelled form control. The hint and the error are tied to the control with aria-describedby, the
 * error sets aria-invalid, and a unit (a currency code) sits inside the input's right edge.
 */
export function Field({ label, children, hint, error, unit, group }: {
  label: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  hint?: string;
  error?: string;
  unit?: string;
  /** The control is a group of controls (a radio group) named by the label through `${id}-label`, not a form field. */
  group?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${error ? " invalid" : ""}`}>
      {group ? <span className="fieldLabel" id={`${id}-label`}>{label}</span> : <label htmlFor={id} id={`${id}-label`}>{label}</label>}
      <div className={unit ? "fieldControl withUnit" : "fieldControl"}>
        {children({ id, ...(describedBy ? { "aria-describedby": describedBy } : {}), ...(error ? { "aria-invalid": true } : {}) })}
        {unit && <span className="fieldUnit" aria-hidden="true">{unit}</span>}
      </div>
      {error && <span className="fieldError" id={errorId}><Icon name="alert" />{error}</span>}
      {hint && <span className="fieldHint" id={hintId}>{hint}</span>}
    </div>
  );
}

export function DetailRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

/** Name first, symbol second; the exact Trading 212 ticker is the tooltip. */
export function InstrumentName({ ticker, book, instrument, className }: { ticker: string; book?: InstrumentBook; instrument?: { name?: string; shortName?: string }; className?: string }) {
  const label = instrumentLabel(ticker, book, instrument);
  return (
    <span className={`instrumentName${className ? ` ${className}` : ""}`} title={label.ticker}>
      <strong>{label.name}</strong>
      {label.detail && <small>{label.detail}</small>}
    </span>
  );
}

/** A stable hue for a ticker, so the same instrument wears the same tint in every view. */
export function avatarHue(ticker: string): number {
  let hash = 0;
  for (const char of ticker) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** Two letters on the instrument's own tint. */
export function AssetAvatar({ ticker, label }: { ticker: string; label: { name: string; detail?: string } }) {
  return <span className="assetAvatar" aria-hidden="true" style={{ "--tp-hue": avatarHue(ticker) } as CSSProperties}>{(label.detail || label.name).slice(0, 2).toUpperCase()}</span>;
}

export function AssetIdentity({ position, book }: { position: Position; book?: InstrumentBook }) {
  const label = instrumentLabel(position.instrument.ticker, book, position.instrument);
  return <div className="assetIdentity" title={label.ticker}><AssetAvatar ticker={position.instrument.ticker} label={label} /><div><strong>{label.name}</strong>{label.detail && <small>{label.detail}</small>}</div></div>;
}

/**
 * A search box with its own clear button, and Escape to clear it, the same in every browser: Firefox draws no clear
 * button and Chrome and Safari draw their own, which is hidden. Escape on an empty box is left to whatever it closes.
 */
export function SearchField({ value, onValue, clearLabel, inputRef, onKeyDown, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string; onValue: (next: string) => void; clearLabel: string; inputRef?: Ref<HTMLInputElement> | undefined;
}) {
  return (
    <span className={`searchField${value ? " filled" : ""}`}>
      <input {...input} ref={inputRef} type="search" value={value} onChange={(event) => onValue(event.target.value)}
        onKeyDown={(event) => {
          // Escape that cancels a composition (a Chinese input method) leaves what is typed alone.
          if (event.key === "Escape" && value && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onValue(""); return; }
          onKeyDown?.(event);
        }} />
      {value && (
        <button type="button" className="searchClear" aria-label={clearLabel} title={clearLabel}
          onClick={(event) => { onValue(""); (event.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus(); }}><Icon name="close" /></button>
      )}
    </span>
  );
}

/**
 * A next step offered where there is nothing to show. It takes the empty state away, so the focus moves first to
 * `focus` (a selector within the view: the control the step changed) or else to the panel's heading.
 */
export interface EmptyAction { label: string; onClick: () => void; disabled?: boolean; focus?: string }

function runEmptyAction(action: EmptyAction, button: HTMLElement): void {
  if (action.disabled) return;
  const scope = button.closest("main") ?? document;
  const heading = button.closest("section")?.querySelector<HTMLElement>("h2, h3");
  const next = (action.focus ? scope.querySelector<HTMLElement>(action.focus) : null) ?? heading;
  if (next === heading && heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  action.onClick();
  next?.focus();
}

/**
 * Nothing to show: what is missing, in a sentence, and the next step as a button where there is one (show a longer
 * period, clear a filter). A panel that would have had a title keeps it, so an empty panel still says what it is.
 */
export function EmptyState({ text, title, action }: { text: string; title?: string; action?: EmptyAction | undefined }) {
  const body = (
    <div className={`emptyState compact${action ? " withAction" : ""}`}>
      <span>{text}</span>
      {/* Unavailable while a load runs, but still focusable (aria-disabled), as the period switch is. */}
      {action && <button type="button" className="linkButton" aria-disabled={action.disabled || undefined} onClick={(event) => runEmptyAction(action, event.currentTarget)}>{action.label}</button>}
    </div>
  );
  // Titled as the chart it stands in for (a caption, not a heading), so the page's outline is the same either way.
  return title ? <><span className="emptyPanelTitle">{title}</span>{body}</> : body;
}

/** Grey blocks in the shape of the view that is loading. */
export function SkeletonView({ label }: { label: string }) {
  return (
    <main className="contentStack skeletonView" aria-busy="true" aria-label={label}>
      <span className="visuallyHidden" role="status">{label}</span>
      <section className="overviewPanel" aria-hidden="true">
        <div className="overviewLead"><span className="skeleton line short" /><span className="skeleton hero" /><span className="skeleton line" /></div>
        <div className="metricGrid">{[0, 1, 2, 3].map((index) => <div className="metric" key={index}><span className="skeleton line short" /><span className="skeleton line" /></div>)}</div>
      </section>
      <section className="dataPanel" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => <div className="skeletonRow" key={index}><span className="skeleton line" /><span className="skeleton bar" /></div>)}
      </section>
    </main>
  );
}

/** An error in place of the content it stopped, with a way to try again. */
export function ErrorCard({ title, message, retryLabel, onRetry, busy }: { title: string; message: string; retryLabel: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <section className="stateCard errorCard" role="alert">
      <Icon name="alert" />
      <div className="stateCopy">
        <h2>{title}</h2>
        <p>{message}</p>
      </div>
      {onRetry && <button type="button" className="secondaryButton" disabled={busy} onClick={onRetry}>{retryLabel}</button>}
    </section>
  );
}

// The control that last received focus, and when. Captured before React re-renders, so a dialog can
// still find the button that opened it after that button was replaced.
const OPENER_WINDOW_MS = 30_000;
let lastFocus: { element: HTMLElement; at: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) lastFocus = { element: event.target, at: Date.now() };
  }, true);
}

// Options a radio group reaches with the arrow keys (tabindex -1) are not Tab stops, so not the trap's first or last.
const FOCUSABLE = "a[href], button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1']), select:not([disabled]):not([tabindex='-1']), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/**
 * Dialog behaviour for the in-flow confirmation panels: focus moves to the heading on open, Tab and
 * Shift+Tab stay inside the panel, and on close focus returns to the control that opened it. When that
 * control was re-rendered meanwhile, its replacement is found by its data-focus-id.
 */
export function useDialogFocus(panel: RefObject<HTMLElement | null>, heading: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // The review button that opens a dialog is usually unmounted in the same render, so focus has already
    // fallen back to the body here. A review button focused shortly before (it carries a data-focus-id)
    // stands in for it; the wait covers the broker check that runs between the click and the dialog.
    const recent = lastFocus && Date.now() - lastFocus.at < OPENER_WINDOW_MS && lastFocus.element.hasAttribute("data-focus-id") ? lastFocus.element : null;
    const opener = active ?? recent;
    const openerId = opener?.getAttribute("data-focus-id") ?? null;
    heading.current?.focus({ preventScroll: false });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (!items.length) { event.preventDefault(); heading.current?.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.current.contains(active);
      if (event.shiftKey && (active === first || active === heading.current || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Let the next view render before looking for the opener or its replacement.
      requestAnimationFrame(() => {
        if (opener?.isConnected) { opener.focus(); return; }
        if (!openerId) return;
        const replacement = [...document.querySelectorAll<HTMLElement>("[data-focus-id]")].find((element) => element.getAttribute("data-focus-id") === openerId);
        replacement?.focus();
      });
    };
  }, [panel, heading]);
}

/** Props for a panel that behaves as a modal dialog while it is open. */
export function dialogProps(headingId: string) {
  return { role: "dialog" as const, "aria-modal": true as const, "aria-labelledby": headingId };
}

export function useDialog() {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useDialogFocus(panel, heading);
  return { panel, heading, headingId, props: dialogProps(headingId) };
}
