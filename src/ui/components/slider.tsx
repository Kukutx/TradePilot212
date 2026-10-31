// The widget's own slider: a track, the part chosen in the theme's colour and a round thumb, drawn by the widget in
// every browser (never `<input type="range">`, whose look is the system's). It is a `role="slider"` reached with Tab:
// the arrow keys move it a step, Page Up and Page Down ten, Home and End to its ends; a pointer or a finger drags it
// anywhere on the track. A vertical swipe on a touch screen still scrolls the page; a sideways one moves the thumb.

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

/** The value nearest `value` on the slider's steps, inside its ends, without the float's tail (0.1 + 0.2). */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const clamped = Math.min(max, Math.max(min, value));
  const steps = Math.round((clamped - min) / step);
  const decimals = Math.max(0, (String(step).split(".")[1] ?? "").length, (String(min).split(".")[1] ?? "").length);
  return Math.min(max, Number((min + steps * step).toFixed(decimals)));
}

/** Where `value` sits along the track, 0 to 1; a value outside the ends sits at that end. */
export function sliderShare(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** The value a key moves the slider to, or undefined for a key it does not take. */
export function sliderKey(key: string, value: number, min: number, max: number, step: number): number | undefined {
  const from = Math.min(max, Math.max(min, value));
  switch (key) {
    case "ArrowRight": case "ArrowUp": return snapToStep(from + step, min, max, step);
    case "ArrowLeft": case "ArrowDown": return snapToStep(from - step, min, max, step);
    case "PageUp": return snapToStep(from + step * 10, min, max, step);
    case "PageDown": return snapToStep(from - step * 10, min, max, step);
    case "Home": return min;
    case "End": return max;
    default: return undefined;
  }
}

export function Slider({ value, min, max, step, label, labelledBy, valueText, disabled = false, onChange }: {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Its name, when no visible label names it (`labelledBy`). */
  label?: string;
  labelledBy?: string;
  /** The value as read out, with its unit ("6.5%", "€250"). */
  valueText: string;
  disabled?: boolean;
  /** Called with each new value on its steps; while dragging, at most once a frame. */
  onChange: (value: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const share = sliderShare(value, min, max);
  const now = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

  const send = (next: number) => { if (next !== now) change.current(next); };
  const fromPointer = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    pending.current = snapToStep(min + ((clientX - box.left) / box.width) * (max - min), min, max, step);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current !== null) change.current(pending.current);
      pending.current = null;
    });
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    fromPointer(event.clientX);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!disabled && event.currentTarget.hasPointerCapture?.(event.pointerId)) fromPointer(event.clientX);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = sliderKey(event.key, now, min, max, step);
    if (next === undefined) return;
    event.preventDefault();
    send(next);
  };

  return (
    <div className={`slider${disabled ? " disabled" : ""}`} role="slider" tabIndex={disabled ? -1 : 0}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={now} aria-valuetext={valueText} aria-orientation="horizontal"
      {...(labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": label })} {...(disabled ? { "aria-disabled": true } : {})}
      onPointerDown={down} onPointerMove={move} onKeyDown={key}>
      <div className="sliderTrack" ref={track}>
        <span className="sliderFill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
        <span className="sliderThumb" style={{ left: `${(share * 100).toFixed(2)}%` }} />
      </div>
    </div>
  );
}
