import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { api, getToken, setToken, useApi } from "./api.ts";
import { Btn, Card, Err, Field, Logo } from "./ui.tsx";
import type { Row } from "./types.ts";
import { Overview } from "./pages/Overview.tsx";
import { Mission } from "./pages/Mission.tsx";
import { Command } from "./pages/Command.tsx";
import { Events, EventDetail } from "./pages/Events.tsx";
import { Companies, CompanyDetail } from "./pages/Companies.tsx";
import { Procurement } from "./pages/Procurement.tsx";
import { Matches } from "./pages/Matches.tsx";
import { Agents } from "./pages/Agents.tsx";
import { FieldAgent } from "./pages/Field.tsx";
import { Communication } from "./pages/Communication.tsx";
import { Negotiations, NegotiationRoom } from "./pages/Negotiations.tsx";
import { Bidding } from "./pages/Bidding.tsx";
import { Deals } from "./pages/Deals.tsx";
import { Integrations } from "./pages/Integrations.tsx";
import { Settings } from "./pages/Settings.tsx";

const NAV: [string, string][] = [
  ["/", "Command Center"], ["/missions", "Missions"], ["/events", "Events"], ["/companies", "Companies"], ["/procurement", "Procurement"],
  ["/negotiations", "Negotiations"], ["/bidding", "Agent Bidding"], ["/deals", "Deals"], ["/overview", "Overview"], ["/matches", "Matching"], ["/agents", "Agents"],
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
    <div className="grid h-full place-items-center bg-mist p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center gap-2 text-center"><span className="ds-brand"><Logo />Arsenal AI</span><div className="ds-cap">European defence &amp; industrial event intelligence</div></div>
        <Card title={mode === "login" ? "Sign in" : "Create account"}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {mode === "register" && <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>}
            <Field label="Work email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Password (min. 10 characters)"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Err msg={err} />
            <div className="flex items-center justify-between"><Btn type="submit" tone="primary" size="lg">{mode === "login" ? "Sign in" : "Register"}</Btn>
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
      <aside className="hidden w-60 shrink-0 flex-col border-r border-edge bg-paper md:flex">
        <div className="space-y-2 px-4 py-4"><span className="ds-brand"><Logo />Arsenal AI</span><div className="ds-cap">Events → Opportunities → Deals</div></div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `flex items-center justify-between px-3 py-2 font-mono text-[13px] font-medium no-underline ${isActive ? "bg-fill text-ink" : "text-muted hover:bg-fill hover:text-ink"}`}>
              {label}{to === "/negotiations" && pending > 0 && <span className="ds-tag">{pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-edge p-3 text-xs text-muted">
          <div className="truncate text-ink">{me.data?.user?.email}</div>
          <div className="mb-2">{(me.data?.companies ?? []).length ? `${me.data!.companies.length} compan${me.data!.companies.length > 1 ? "ies" : "y"}` : "No company registered"}</div>
          <Btn onClick={onLogout}>Sign out</Btn>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto bg-mist p-4 md:p-8">
        <nav className="mb-4 flex gap-2 overflow-x-auto md:hidden">{NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `ds-tag whitespace-nowrap no-underline ${isActive ? "ds-tag--dark" : "ds-tag--outline"}`}>{label}</NavLink>)}</nav>
        <Routes>
          <Route path="/" element={<Command />} />
          <Route path="/missions" element={<Mission />} />
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
          <Route path="/bidding" element={<Bidding />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
