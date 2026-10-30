import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { api, getToken, setToken, useApi } from "./api.ts";
import { Btn, Card, Err, Field } from "./ui.tsx";
import type { Row } from "./types.ts";
import { Overview } from "./pages/Overview.tsx";
import { Mission } from "./pages/Mission.tsx";
import { Events, EventDetail } from "./pages/Events.tsx";
import { Companies, CompanyDetail } from "./pages/Companies.tsx";
import { Procurement } from "./pages/Procurement.tsx";
import { Matches } from "./pages/Matches.tsx";
import { Agents } from "./pages/Agents.tsx";
import { FieldAgent } from "./pages/Field.tsx";
import { Communication } from "./pages/Communication.tsx";
import { Negotiations, NegotiationRoom } from "./pages/Negotiations.tsx";
import { Deals } from "./pages/Deals.tsx";
import { Integrations } from "./pages/Integrations.tsx";
import { Settings } from "./pages/Settings.tsx";

const NAV: [string, string][] = [
  ["/", "Mission Control"], ["/events", "Events"], ["/companies", "Companies"], ["/procurement", "Procurement"],
  ["/negotiations", "Negotiations"], ["/deals", "Deals"], ["/overview", "Overview"], ["/matches", "Matching"], ["/agents", "Agents"],
  ["/field", "Field Agent"], ["/communication", "Communication"], ["/integrations", "Integrations"], ["/settings", "Settings"],
];

function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [f, setF] = useState({ email: "", password: "", name: "" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await api<{ token: string }>(`/auth/${mode}`, { body: f });
      setToken(r.token);
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center"><div className="text-2xl font-bold tracking-wide text-accent">ARSENAL AI</div><div className="text-xs text-muted">European defence &amp; industrial event intelligence</div></div>
        <Card title={mode === "login" ? "Sign in" : "Create account"}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {mode === "register" && <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>}
            <Field label="Work email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Password (min. 10 characters)"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Err msg={err} />
            <div className="flex items-center justify-between"><Btn type="submit" tone="primary">{mode === "login" ? "Sign in" : "Register"}</Btn>
              <button type="button" className="text-xs text-muted underline" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Need an account?" : "Have an account?"}</button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => { const h = () => setAuthed(false); window.addEventListener("arsenal-logout", h); return () => window.removeEventListener("arsenal-logout", h); }, []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell onLogout={() => { setToken(null); setAuthed(false); }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const me = useApi<Row>("/me");
  const approvals = useApi<Row[]>("/approvals", 20000);
  const pending = (approvals.data ?? []).filter((a) => a.status === "PENDING").length;
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-edge bg-panel md:flex">
        <div className="px-4 py-4"><div className="text-lg font-bold tracking-wide text-accent">ARSENAL AI</div><div className="text-[11px] text-muted">Events → Opportunities → Deals</div></div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `flex items-center justify-between rounded-md px-3 py-2 text-[13px] ${isActive ? "bg-accent/15 text-accent" : "text-slate-300 hover:bg-white/5"}`}>
              {label}{to === "/negotiations" && pending > 0 && <span className="rounded bg-amber-500 px-1.5 text-[10px] font-bold text-black">{pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-edge p-3 text-xs text-muted">
          <div className="truncate text-slate-300">{me.data?.user?.email}</div>
          <div className="mb-2">{(me.data?.companies ?? []).length ? `${me.data!.companies.length} compan${me.data!.companies.length > 1 ? "ies" : "y"}` : "No company registered"}</div>
          <Btn onClick={onLogout}>Sign out</Btn>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        <nav className="mb-4 flex gap-2 overflow-x-auto md:hidden">{NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className="whitespace-nowrap rounded border border-edge px-2 py-1 text-xs">{label}</NavLink>)}</nav>
        <Routes>
          <Route path="/" element={<Mission />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/events" element={<Events />} />
          <Route path="/events/:id" element={<EventDetail />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyDetail />} />
          <Route path="/procurement" element={<Procurement />} />
          <Route path="/matches" element={<Matches />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/field" element={<FieldAgent />} />
          <Route path="/communication" element={<Communication />} />
          <Route path="/negotiations" element={<Negotiations />} />
          <Route path="/negotiations/:id" element={<NegotiationRoom />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
