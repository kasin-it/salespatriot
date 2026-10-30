import type { ReactNode } from "react";
import type { Row } from "./types.ts";

export const Card = ({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`rounded-lg border border-edge bg-panel ${className}`}>
    {(title || actions) && (
      <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h2>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
    )}
    <div className="p-4">{children}</div>
  </section>
);

const TONES: Record<string, string> = {
  green: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  red: "bg-red-500/15 text-red-300 border-red-500/30",
  blue: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  grey: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  violet: "bg-violet-500/15 text-violet-300 border-violet-500/30",
};
const STATUS_TONE: Record<string, string> = {
  VERIFIED: "green", CONNECTED: "green", SUCCEEDED: "green", COMPLETED: "green", ACCEPTED: "green", VERIFIED_MATCH: "green", VERIFIED_CAPABILITY: "green", CONFIRMED_DEMAND: "green", REAL: "green", IDENTIFIED: "blue",
  RUNNING: "blue", QUEUED: "blue", POTENTIAL_MATCH: "amber", PUBLICLY_CLAIMED_CAPABILITY: "amber", UNVERIFIED: "grey", NOT_STARTED: "grey", NOT_CONFIGURED: "grey", UNKNOWN: "grey", INSUFFICIENT_INFORMATION: "grey",
  INFERRED_CAPABILITY: "violet", INFERRED_DEMAND: "violet", UNVERIFIED_CAPABILITY: "grey", HISTORICAL_DEMAND: "grey", USER_PROVIDED_DEMAND: "blue", SANDBOX: "amber", NEEDS_REVIEW: "amber", RETRY_SCHEDULED: "amber", WAITING_APPROVAL: "amber", ACCESS_REQUIRED: "amber",
  FAILED: "red", ERROR: "red", INCOMPATIBLE: "red", REJECTED: "red", CANCELLED: "grey", EXPIRED: "grey", INACTIVE: "red", FAILED_RESEARCH: "red",
};
export const Badge = ({ value, tone }: { value: string | null | undefined; tone?: string }) => {
  const v = value ?? "UNKNOWN";
  return <span className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone ?? STATUS_TONE[v] ?? "grey"]}`}>{v.replace(/_/g, " ")}</span>;
};

export const Empty = ({ children }: { children: ReactNode }) => <div className="rounded-md border border-dashed border-edge p-6 text-center text-sm text-muted">{children}</div>;
export const Err = ({ msg }: { msg: string | null }) => (msg ? <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{msg}</div> : null);
export const Unknown = ({ label = "Unknown" }: { label?: string }) => <span className="italic text-muted">{label}</span>;

export const Btn = ({ children, onClick, disabled, tone = "default", type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "default" | "primary" | "danger"; type?: "button" | "submit" }) => (
  <button type={type} disabled={disabled} onClick={onClick}
    className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${tone === "primary" ? "border-accent bg-accent text-black hover:brightness-110" : tone === "danger" ? "border-red-500/50 text-red-300 hover:bg-red-500/10" : "border-edge bg-ink text-slate-200 hover:border-slate-500"}`}>
    {children}
  </button>
);

export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="rounded-lg border border-edge bg-panel p-4">
    <div className="text-2xl font-bold tabular-nums text-slate-100">{value}</div>
    <div className="mt-0.5 text-xs uppercase tracking-wider text-muted">{label}</div>
    {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
  </div>
);

export function Table({ rows, cols, empty = "No records", onRow }: { rows: Row[]; cols: { h: string; r: (row: Row) => ReactNode; w?: string }[]; empty?: string; onRow?: (r: Row) => void }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead><tr className="border-b border-edge text-[11px] uppercase tracking-wider text-muted">{cols.map((c) => <th key={c.h} className="px-2 py-2 font-medium" style={{ width: c.w }}>{c.h}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} onClick={onRow ? () => onRow(row) : undefined} className={`border-b border-edge/50 align-top ${onRow ? "cursor-pointer hover:bg-white/5" : ""}`}>
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
  href && /^https?:/.test(href) ? <a className="text-sky-300 underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer noopener">{children ?? href}</a> : <span className="text-muted">{children ?? href ?? "—"}</span>;
export const Field = ({ label, children }: { label: string; children: ReactNode }) => <div><label>{label}</label>{children}</div>;
export const parseList = (s: unknown): string[] => { try { const v = typeof s === "string" ? JSON.parse(s) : s; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
