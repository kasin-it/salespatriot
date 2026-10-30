// One-command demo setup against a running server: demo account, buyer company, thermal + drone mandates,
// salesperson, and the three events (exhibitor research then runs in the background, ~15–20 min).
// Run: DEMO_PASSWORD=<choose one> pnpm --filter @salespatriot/api seed:demo
// Env: ARSENAL_API_URL (default http://127.0.0.1:8787), DEMO_EMAIL (default demo@arsenal.test), DEMO_PASSWORD (required).
// Mandate values are the Setup screen's suggested defaults. The supplier mandate is a SIMULATED sandbox template.
const API = `${process.env.ARSENAL_API_URL ?? "http://127.0.0.1:8787"}/api`;
const email = process.env.DEMO_EMAIL ?? "demo@arsenal.test";
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error("Set DEMO_PASSWORD (any local test password) and rerun.");

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(API + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { ok: res.ok, data: (await res.json()) as T };
}

// Register, or log in if the account already exists.
let auth = await call<{ token?: string; error?: string }>("/auth/register", { body: { email, name: "Demo operator", password } });
if (!auth.data.token) auth = await call("/auth/login", { body: { email, password } });
const token = auth.data.token;
if (!token) throw new Error(`Could not register or log in as ${email}: ${JSON.stringify(auth.data)}`);

const PROFILES = {
  default: { // thermal cameras
    buyerMandate: { currency: "EUR", max_unit_price: 1300, opening_unit_price: 1040, max_lead_time_days: 60, allowed_payment_terms: "net30,net45" },
    supplierMandate: { currency: "EUR", min_unit_price: 1150, opening_unit_price: 1500, opening_lead_time_days: 42, opening_payment_terms: "net30", opening_delivery_terms: "DAP", opening_validity_days: 14 },
  },
  drone: {
    buyerMandate: { currency: "EUR", max_unit_price: 16000, opening_unit_price: 12800, max_lead_time_days: 90, allowed_payment_terms: "net30,net45" },
    supplierMandate: { currency: "EUR", min_unit_price: 14000, opening_unit_price: 18000, opening_lead_time_days: 70, opening_payment_terms: "net30", opening_delivery_terms: "DAP", opening_validity_days: 14 },
  },
};
for (const [profile, m] of Object.entries(PROFILES)) {
  const r = await call<{ ok?: boolean; error?: string }>("/demo/setup", { method: "PUT", token, body: { profile, buyer: { legalName: "Demo Buyer sp. z o.o.", country: "PL" }, deliveryLocation: "Warsaw, Poland", rep: { name: "Demo Salesperson", email: "rep@arsenal.test" }, ...m } });
  console.log(`setup ${profile}:`, r.ok ? "ok" : r.data);
}

for (const url of ["https://www.targikielce.pl/en/mspo", "https://www.enforcetac.com/en", "https://www.dsei.co.uk"]) {
  const r = await call<{ id?: number; error?: string }>("/events", { token, body: { url } });
  console.log(`event ${url}:`, r.ok ? `id ${r.data.id}` : r.data);
}

const s = await call<{ ready: boolean; status: Record<string, unknown> }>("/demo/setup", { token });
console.log("ready:", s.data.ready, s.data.status);
console.log(`Log in at ${API.replace(/\/api$/, "")} as ${email}. Exhibitor profiles keep loading in the background (~15–20 min).`);
