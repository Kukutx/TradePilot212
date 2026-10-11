import type { Position } from "../../shared/contracts";

export type IconName = "refresh" | "expand" | "collapse" | "globe" | "close" | "arrow";

export function Icon({ name }: { name: IconName }) {
  const paths = {
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6"/></>,
    collapse: <><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    close: <path d="M6 6l12 12M18 6L6 18"/>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6"/>,
  } as const;
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="icon" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function DetailSection({ title, text }: { title: string; text: string }) {
  return <section><h3>{title}</h3><p>{text}</p></section>;
}

export function DetailList({ title, items }: { title: string; items: string[] }) {
  return <section><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>;
}

export function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return <div className={`metric ${compact ? "compact" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

export function SectionHeader({ title, count }: { title: string; count: number }) {
  return <div className="sectionHeader"><h2>{title}</h2><span>{count}</span></div>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

export function AssetIdentity({ position }: { position: Position }) {
  const name = position.instrument.shortName || position.instrument.name || position.instrument.ticker;
  return <div className="assetIdentity"><span className="assetAvatar">{name.slice(0, 2).toUpperCase()}</span><div><strong>{name}</strong><small>{position.instrument.ticker}</small></div></div>;
}
