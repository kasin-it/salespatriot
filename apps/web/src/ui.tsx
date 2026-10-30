import type { ReactNode } from "react";
import type { Row } from "./types.ts";

export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <path d="M8 0H32V24L24 32H0V8Z" fill="#12171A" />
    <path d="M9 23L16 9L23 23" stroke="#fff" strokeWidth="2.5" fill="none" />
    <path d="M12.5 18H19.5" stroke="#1957EA" strokeWidth="2.5" />
  </svg>
);

export const Card = ({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`ds-card min-h-0 justify-start gap-0 p-0 ${className}`}>
    {(title || actions) && (
      <header className="flex items-center justify-between gap-3 border-b border-edge py-3 pl-4 pr-8">
        <h2 className="ds-label"><span className="ds-dot" />{title}</h2>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
    )}
    <div className="p-4">{children}</div>
  </section>
);

export const PageHead = ({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="flex flex-wrap items-end justify-between gap-3">
    <div className="space-y-2"><h1 className="ds-h2">{title}</h1>{sub && <p className="ds-muted m-0 text-sm">{sub}</p>}</div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

// One accent only: tones differ by weight and outline, not hue. Red is reserved for errors.
const TONES: Record<string, string> = {
  green: "ds-tag--dark",
  amber: "ds-tag--outline",
  red: "bg-transparent text-alert shadow-[inset_0_0_0_1px_var(--ds-alert)]",
  blue: "",
  grey: "ds-tag--muted",
  violet: "ds-tag--outline border border-dashed border-faint shadow-none",
};
const STATUS_TONE: Record<string, string> = {
  VERIFIED: "green", CONNECTED: "green", SUCCEEDED: "green", COMPLETED: "green", ACCEPTED: "green", VERIFIED_MATCH: "green", VERIFIED_CAPABILITY: "green", CONFIRMED_DEMAND: "green", REAL: "green", IDENTIFIED: "blue",
  RUNNING: "blue", QUEUED: "blue", POTENTIAL_MATCH: "amber", PUBLICLY_CLAIMED_CAPABILITY: "amber", UNVERIFIED: "grey", NOT_STARTED: "grey", NOT_CONFIGURED: "grey", UNKNOWN: "grey", INSUFFICIENT_INFORMATION: "grey",
  INFERRED_CAPABILITY: "violet", INFERRED_DEMAND: "violet", UNVERIFIED_CAPABILITY: "grey", HISTORICAL_DEMAND: "grey", USER_PROVIDED_DEMAND: "blue", SANDBOX: "amber", NEEDS_REVIEW: "amber", RETRY_SCHEDULED: "amber", WAITING_APPROVAL: "amber", ACCESS_REQUIRED: "amber",
  FAILED: "red", ERROR: "red", INCOMPATIBLE: "red", REJECTED: "red", CANCELLED: "grey", EXPIRED: "grey", INACTIVE: "red", FAILED_RESEARCH: "red",
};
export const Badge = ({ value, tone }: { value: string | null | undefined; tone?: string }) => {
  const v = value ?? "UNKNOWN";
  return <span className={`ds-tag whitespace-nowrap ${TONES[tone ?? STATUS_TONE[v] ?? "grey"]}`}>{v.replace(/_/g, " ")}</span>;
};

export const Empty = ({ children }: { children: ReactNode }) => <div className="border border-dashed border-faint p-6 text-center text-sm text-muted">{children}</div>;
export const Err = ({ msg }: { msg: string | null }) => (msg ? <div className="border border-alert p-3 text-sm text-alert">{msg}</div> : null);
export const Unknown = ({ label = "Unknown" }: { label?: string }) => <span className="italic text-muted">{label}</span>;

// Inline callout. "warn" is for caveats that must stay visible (sandbox, gaps); "info" for neutral status.
export const Notice = ({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) => (
  <div className={`p-3 text-xs ${tone === "warn" ? "border-l-2 border-ink bg-fill text-ink" : "border-l-2 border-accent bg-mist text-ink"}`}>{children}</div>
);

// Small label above a block of content inside a card.
export const Cap = ({ accent, children }: { accent?: boolean; children: ReactNode }) => <div className={`ds-cap mb-1 ${accent ? "text-accent" : ""}`}>{children}</div>;

export const Btn = ({ children, onClick, disabled, tone = "default", type = "button", size = "sm" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "default" | "primary" | "danger"; type?: "button" | "submit"; size?: "sm" | "lg" }) => (
  <button type={type} disabled={disabled} onClick={onClick}
    className={`ds-btn ${size === "sm" ? "ds-btn--sm" : ""} ${tone === "danger" ? "ds-btn--danger" : tone === "default" ? "ds-btn--ghost" : ""}`}>
    {children}
  </button>
);

// Toggle in a group of mutually exclusive options.
export const Seg = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" aria-pressed={active} onClick={onClick} className={`ds-btn ds-btn--sm ${active ? "ds-btn--dark" : "ds-btn--ghost"}`}>{children}</button>
);

// Clickable suggestion or filter chip.
export const Chip = ({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className={`ds-tag cursor-pointer normal-case ${active ? "" : "ds-tag--outline hover:bg-fill"}`}>{children}</button>
);

// Square state marker; pass pulse for in-progress states.
export const Marker = ({ tone, pulse }: { tone: "ok" | "active" | "wait" | "error"; pulse?: boolean }) => (
  <span className={`inline-block h-2 w-2 shrink-0 ${tone === "ok" ? "bg-ink" : tone === "error" ? "bg-alert" : tone === "wait" ? "bg-faint" : "bg-accent"} ${pulse ? "animate-pulse" : ""}`} />
);

export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="ds-chamfer ds-chamfer--sm ds-stat bg-paper p-4">
    <div className="ds-stat__value tabular-nums">{value}</div>
    <div className="ds-stat__label">{label}</div>
    {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
  </div>
);

export function Table({ rows, cols, empty = "No records", onRow }: { rows: Row[]; cols: { h: string; r: (row: Row) => ReactNode; w?: string }[]; empty?: string; onRow?: (r: Row) => void }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead><tr className="border-b border-edge">{cols.map((c) => <th key={c.h} className="ds-cap px-2 py-2" style={{ width: c.w }}>{c.h}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} onClick={onRow ? () => onRow(row) : undefined} className={`border-b border-edge align-top ${onRow ? "cursor-pointer hover:bg-fill" : ""}`}>
              {cols.map((c) => <td key={c.h} className="px-2 py-2">{c.r(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const fmtDate = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
export const fmtTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : null);
export const ExtLink = ({ href, children }: { href: string | null | undefined; children?: ReactNode }) =>
  href && /^https?:/.test(href) ? <a className="text-accent underline-offset-2 hover:underline hover:text-accent" href={href} target="_blank" rel="noreferrer noopener">{children ?? href}</a> : <span className="text-muted">{children ?? href ?? "—"}</span>;
export const Field = ({ label, children }: { label: string; children: ReactNode }) => <div><label>{label}</label>{children}</div>;
export const parseList = (s: unknown): string[] => { try { const v = typeof s === "string" ? JSON.parse(s) : s; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
