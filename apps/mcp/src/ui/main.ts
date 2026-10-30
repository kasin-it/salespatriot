// Arsenal explorer: the MCP App behind the read tools. Every value comes from scraped sources, so text is only ever set via DOM text nodes.
import { App } from "@modelcontextprotocol/ext-apps";
import "./app.css";

type Row = Record<string, any>;
type Screen = { name: string; args: Row };
type Node_ = Node | string | null | undefined;

const root = document.getElementById("root")!;
const app = new App({ name: "Arsenal Explorer", version: "0.1.0" });

// Screens the user can go back to; the last entry is the one on display.
const history: Screen[] = [];

function h(tag: string, props: Row = {}, ...children: Node_[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "className") el.className = v;
    else if (v !== undefined) el.setAttribute(k, String(v));
  }
  el.append(...children.filter((c): c is Node | string => c != null));
  return el;
}

const fmtDate = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
const humanize = (v: string) => v.replace(/_/g, " ");
const unknown = (label = "Unknown") => h("span", { className: "x-unknown" }, label);

// Same tone map as Badge in apps/web/src/ui.tsx: one accent, red only for errors.
const DARK = ["VERIFIED", "SUCCEEDED", "COMPLETED", "VERIFIED_CAPABILITY", "VERIFIED_MATCH", "DEAL_CLOSED", "CLOSED", "ACCEPTED"];
const BLUE = ["IDENTIFIED", "RUNNING", "QUEUED", "MOCK", "READY", "NEGOTIATING", "INVESTIGATING"];
const OUTLINE = ["PUBLICLY_CLAIMED_CAPABILITY", "NEEDS_REVIEW", "RETRY_SCHEDULED", "ACCESS_REQUIRED", "INFERRED_CAPABILITY", "WAITING_REPLY", "MEETING_PLANNED", "SANDBOX"];
const ALERT = ["FAILED", "ERROR", "FAILED_RESEARCH"];
function badge(value: string | null | undefined) {
  const v = value ?? "UNKNOWN";
  const tone = DARK.includes(v) ? "ds-tag--dark" : BLUE.includes(v) ? "" : OUTLINE.includes(v) ? "ds-tag--outline" : ALERT.includes(v) ? "x-tag-alert" : "ds-tag--muted";
  return h("span", { className: `ds-tag ${tone}` }, humanize(v));
}

function extLink(url: string | null | undefined, label?: string) {
  if (!url || !/^https?:\/\//i.test(url)) return unknown("No link");
  return h("button", { type: "button", className: "x-link", onclick: () => void app.openLink({ url }) }, label ?? url);
}

function card(title: string, body: Node_[], actions?: Node_) {
  return h("section", { className: "x-card" }, h("header", {}, h("h2", { className: "ds-label" }, h("span", { className: "ds-dot" }), title), actions), ...body);
}

function table<T extends Row>(rows: T[], cols: [string, (r: T) => Node_][], open?: (r: T) => void, empty = "Nothing here yet.") {
  if (!rows.length) return h("div", { className: "x-empty" }, empty);
  const row = (r: T) => {
    const go = open && (() => open(r));
    return h("tr", go ? { tabindex: 0, onclick: go, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") go(); } } : {}, ...cols.map(([, c]) => h("td", {}, c(r))));
  };
  return h("table", { className: "x-table" }, h("thead", {}, h("tr", {}, ...cols.map(([t]) => h("th", {}, t)))), h("tbody", {}, ...rows.map(row)));
}

const stat = (label: string, value: Node_) => h("div", { className: "ds-stat ds-chamfer ds-chamfer--sm" }, h("div", { className: "ds-stat__value" }, value), h("div", { className: "ds-stat__label" }, label));

function eventsView(data: Row) {
  const rows = data.events as Row[];
  const groups: [string, string][] = [["Upcoming", "UPCOMING"], ["Ongoing", "ONGOING"], ["Historical", "HISTORICAL"], ["Dates unknown", "UNKNOWN_DATES"]];
  const cols: [string, (r: Row) => Node_][] = [
    ["Event", (r) => h("div", {}, h("div", {}, r.name), h("div", { className: "x-sub" }, [r.city, r.country].filter(Boolean).join(", ")))],
    ["Dates", (r) => (r.start_date ? h("span", { style: "white-space:nowrap" }, `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}`) : unknown("Not found on official page"))],
    ["Research", (r) => badge(r.research_status)],
    ["Exhibitors", (r) => h("span", { className: "x-num" }, String(r.exhibitors))],
    ["Identified / verified", (r) => `${r.identified_companies} / ${r.verified_companies}`],
  ];
  const cards = groups.map(([label, phase]) => [label, phase, rows.filter((r) => r.phase === phase)] as const).filter(([, , r]) => r.length)
    .map(([label, phase, r]) => {
      const section = card(`${label} (${r.length})`, [table(r, cols, (e) => go("event", { eventId: e.id }))]);
      if (phase === "ONGOING") section.classList.add("x-card--live");
      return section;
    });
  return [h("div", { className: "x-head" }, h("p", { className: "ds-label" }, h("span", { className: "ds-dot" }), "Event intelligence"), h("div", { className: "x-wordmark" }, "Arsenal AI"), h("span", { className: "x-sub" }, `${rows.length} events tracked`)), ...(cards.length ? cards : [h("div", { className: "x-empty" }, "No events yet. Ask Claude to add an event by its official URL.")])];
}

const EXHIBITOR_COLS: [string, (r: Row) => Node_][] = [
  ["Exhibitor", (r) => r.exhibitor_name],
  ["Country", (r) => r.country ?? unknown("—")],
  ["Booth", (r) => r.booth ?? unknown("—")],
  ["Identity", (r) => (r.company_id ? badge(r.identity_state) : badge(r.resolution_status))],
];

function exhibitorsCard(eventId: number, data: Row) {
  let filter = "";
  let rows = data.rows as Row[];
  let total = data.total as number;
  const body = h("div", {});
  const load = async (offset: number) => {
    const next = await fetchData("arsenal_event_exhibitors", { eventId, limit: 50, offset, ...(filter ? { query: filter } : {}) });
    rows = offset ? [...rows, ...next.rows] : next.rows;
    total = next.total;
    paint();
  };
  const paint = () => {
    heading.textContent = `Exhibitors (${total})`;
    const more = rows.length < total ? h("div", { className: "x-more" }, h("button", { type: "button", className: "ds-btn ds-btn--ghost ds-btn--sm", onclick: () => void guarded(() => load(rows.length)) }, "Load more")) : null;
    body.replaceChildren(table(rows, EXHIBITOR_COLS, (r) => { if (r.company_id) go("company", { companyId: r.company_id }); }, "No exhibitors match."), ...(more ? [more] : []));
  };
  let timer: ReturnType<typeof setTimeout>;
  const input = h("input", { className: "ds-input", placeholder: "Filter by name", "aria-label": "Filter exhibitors by name", oninput: (e: Event) => {
    clearTimeout(timer);
    filter = (e.target as HTMLInputElement).value;
    timer = setTimeout(() => void guarded(() => load(0)), 250);
  } });
  const section = card("", [body], input);
  const heading = section.querySelector("h2")!.appendChild(h("span"));
  paint();
  return section;
}

function eventView(data: Row) {
  const { event: e, stats: s, updates, sources } = data.detail as Row;
  return [
    h("div", { className: "x-head" }, h("h1", {}, e.name), extLink(e.official_url), h("div", { className: "x-row" }, badge(e.research_status), h("span", { className: "x-sub" }, e.start_date ? `${fmtDate(e.start_date)} → ${fmtDate(e.end_date)}` : "Dates not found on official page"))),
    h("div", { className: "x-stats" }, stat("Exhibitors", String(s.exhibitors)), stat("Companies", String(s.companies)), stat("With website", String(s.withWebsite)), stat("Matches", String(s.matches))),
    e.description ? h("p", { className: "ds-muted", style: "margin:0" }, e.description) : null,
    exhibitorsCard(e.id, data.exhibitors),
    updates.length ? card(`Updates (${updates.length})`, [table((updates as Row[]).slice(0, 10), [["Detected", (u) => fmtDate(u.detected_at)], ["Kind", (u) => humanize(u.kind)], ["Summary", (u) => u.summary]])]) : null,
    sources.length ? card(`Sources (${sources.length})`, [table(sources as Row[], [["Source", (x) => extLink(x.url, x.title ?? x.url)], ["Role", (x) => (x.role ? humanize(x.role) : unknown("—"))]])]) : null,
  ];
}

function companyView(data: Row) {
  const { company: c, capabilities, certifications, events, procurementAwards, conflicts } = data.detail as Row;
  return [
    h("div", { className: "x-head" }, h("h1", {}, c.canonical_name), c.website ? extLink(c.website) : unknown("Website not found"), h("div", { className: "x-row" }, badge(c.identity_state), badge(c.enrichment_status), h("span", { className: "x-sub" }, c.country ?? ""))),
    c.description ? h("p", { className: "ds-muted", style: "margin:0" }, c.description) : null,
    conflicts.length ? h("div", { className: "x-error" }, `Sources disagree on: ${(conflicts as Row[]).map((x) => humanize(x.field)).join(", ")}`) : null,
    card(`Capabilities (${capabilities.length})`, [table(capabilities as Row[], [["Capability", (r) => r.label], ["Class", (r) => badge(r.capability_class)], ["Evidence", (r) => (r.source_url ? extLink(r.source_url, r.evidence_text ?? "Source") : r.evidence_text ?? unknown("None"))]], undefined, "No capabilities recorded.")]),
    certifications.length ? card(`Certifications (${certifications.length})`, [table(certifications as Row[], [["Name", (r) => r.name], ["Status", (r) => badge(r.verification_status)], ["Source", (r) => extLink(r.source_url, "Source")]])]) : null,
    events.length ? card(`Events (${events.length})`, [table(events as Row[], [["Event", (r) => r.name], ["Date", (r) => fmtDate(r.start_date)], ["Booth", (r) => r.booth ?? unknown("—")]], (r) => go("event", { eventId: r.id }))]) : null,
    procurementAwards.length ? card(`Procurement awards (${procurementAwards.length})`, [table(procurementAwards as Row[], [["Notice", (r) => extLink(r.source_url, r.title)], ["Authority", (r) => r.contracting_authority ?? unknown("—")], ["Published", (r) => h("span", { style: "white-space:nowrap" }, fmtDate(r.publication_date))]])]) : null,
  ];
}

function searchView(data: Row) {
  const open = (r: Row) => {
    if (r.entityType === "event") go("event", { eventId: r.entityId });
    else if (r.entityType === "company") go("company", { companyId: r.entityId });
  };
  return [
    h("div", { className: "x-head" }, h("h1", {}, `Search: ${data.query}`)),
    card(`Results (${data.hits.length})`, [table(data.hits as Row[], [["Type", (r) => badge(r.entityType.toUpperCase())], ["Result", (r) => h("div", {}, h("div", {}, r.title), h("div", { className: "x-sub" }, r.snippet))]], open, "No results.")]),
  ];
}

const money = (v: unknown, currency: unknown) => (typeof v === "number" ? `${v.toLocaleString("en-GB")} ${typeof currency === "string" ? currency : ""}`.trim() : unknown("—"));
const parsed = (v: unknown): Row => { if (typeof v !== "string") return (v as Row | null) ?? {}; try { return JSON.parse(v) as Row; } catch { return {}; } };
const head = (label: string, title: string, ...rest: Node_[]) => h("div", { className: "x-head" }, h("p", { className: "ds-label" }, h("span", { className: "ds-dot" }), label), h("h1", {}, title), ...rest);
const ask = (text: string) => void guarded(async () => { await app.sendMessage({ role: "user", content: [{ type: "text", text }] }); });
const banner = (text: string, action?: [string, () => void]) => h("div", { className: "x-banner" }, h("span", {}, text), action ? h("button", { type: "button", className: "ds-btn ds-btn--light ds-btn--sm", onclick: action[1] }, action[0]) : null);
const SIMULATED = "The supplier side is a SIMULATED sandbox agent. A SANDBOX deal is a recorded acceptance, not a signed contract.";

function exhibitorsView(data: Row) {
  return [head("Event", "Exhibitors", h("button", { type: "button", className: "x-link", onclick: () => go("event", { eventId: data.eventId }) }, "Open event")), exhibitorsCard(data.eventId, data)];
}

function setupView(data: Row) {
  const checks: [string, unknown][] = [["Email (SMTP)", data.status.smtp], ["Mailbox (Mailpit)", data.status.mailpitReachable], ["Vision", data.status.vision], ["Reasoning (LLM)", data.status.llm]];
  const mandates = Object.entries((data.mandates ?? {}) as Row).filter(([, m]) => m).map(([profile, m]) => ({ profile, ...(m as Row).buyer }));
  return [
    head("Demo setup", data.company?.name ?? "Buyer not set up", h("div", { className: "x-row" }, badge(data.ready ? "READY" : "NOT_READY"), h("span", { className: "x-sub" }, data.rep ? `Salesperson: ${data.rep.name}` : "No salesperson set"))),
    h("div", { className: "x-stats" }, ...checks.map(([label, ok]) => stat(label, ok ? "On" : "Off"))),
    card(`Buyer limits (${mandates.length})`, [table(mandates, [["Profile", (m) => (m.profile === "default" ? "Thermal cameras" : humanize(m.profile))], ["Max unit price", (m) => money(m.max_unit_price, m.currency)], ["Max lead time", (m) => `${m.max_lead_time_days} days`], ["Payment", (m) => m.allowed_payment_terms]], undefined, "No mandates saved yet.")]),
    card(`Events (${data.events?.length ?? 0})`, [table((data.events ?? []) as Row[], [["Event", (r) => r.name], ["Date", (r) => fmtDate(r.start_date) || unknown("—")], ["Exhibitors", (r) => h("span", { className: "x-num" }, String(r.exhibitors))]], (r) => go("event", { eventId: r.id }), "No events yet.")]),
  ];
}

function promptsView(data: Row) {
  const list = (prompts: string[]) => table(prompts.map((text) => ({ text })), [["Prompt", (r) => r.text]], (r) => ask(r.text));
  return [head("Demo", "Ready-made prompts", h("span", { className: "x-sub" }, "Click one to send it to Claude.")), card("Source a product", [list(data.sourcing)]), card("Before the event", [list(data.preEvent)])];
}

function missionsView(data: Row) {
  const rows = data.missions as Row[];
  return [head("Agents", "Missions", h("span", { className: "x-sub" }, `${rows.length} recent`)), card(`Missions (${rows.length})`, [table(rows, [["Mission", (r) => h("div", {}, h("div", {}, r.prompt), h("div", { className: "x-sub" }, `#${r.id} · ${humanize(r.kind)}`))], ["Status", (r) => badge(r.status)], ["Started", (r) => fmtDate(r.created_at)]], (r) => go("mission", { missionId: r.id }), "No missions yet. Ask Claude to source a product.")])];
}

function missionView(data: Row) {
  const { mission: m, eventRanking, standsToVisit, steps, reasoning, salesperson, offers, deal } = data as Row;
  const id = m.id as number;
  const live = !STOPPED.includes(m.status);
  const stepRows = (steps as string[]).map((s) => { const i = s.indexOf(" · "); return { status: s.slice(0, i), title: s.slice(i + 3) }; });
  return [
    head(`Mission #${id} · ${humanize(m.kind)}`, m.prompt, h("div", { className: "x-row" }, badge(m.status), live ? h("span", { className: "x-sub" }, "Updating live") : null)),
    m.error ? h("div", { className: "x-error" }, m.error) : null,
    m.status === "WAITING_REPLY" ? banner("Waiting for the salesperson at the event.", ["Ask Claude to reply with the demo files", () => ask(`Play the salesperson for mission ${id} with the prepared demo files.`)]) : null,
    m.status === "MEETING_PLANNED" ? banner("Booth meeting agreed.", ["Ask Claude to continue at the event", () => ask(`Continue mission ${id} at the event.`)]) : null,
    deal ? banner(`DEAL CLOSED · ${typeof deal.total_value === "number" ? `${deal.total_value.toLocaleString("en-GB")} ${deal.currency ?? ""}` : "value unknown"} · human approvals: ${deal.humanApprovals ?? 0}`, ["Open deal", () => go("deal", { dealId: deal.id })]) : null,
    offers.length || deal ? h("p", { className: "x-note" }, SIMULATED) : null,
    eventRanking.length ? card(`Event ranking (${eventRanking.length})`, [table(eventRanking as Row[], [["Event", (r) => r.name], ["Date", (r) => fmtDate(r.startDate) || unknown("—")], ["Matching", (r) => h("span", { className: "x-num" }, String(r.matching ?? 0))], ["Fits deadline", (r) => (r.fitsDeadline ? "Yes" : "No")]], (r) => { if (r.eventId) go("event", { eventId: r.eventId }); })]) : null,
    standsToVisit.length ? card(`Stands to visit (${standsToVisit.length})`, [table(standsToVisit as Row[], [["Company", (r) => r.name], ["Booth", (r) => r.booth ?? unknown("—")], ["Country", (r) => r.country ?? unknown("—")], ["Why", (r) => h("span", { className: "x-sub" }, typeof r.evidence === "string" ? r.evidence : "")]], (r) => { if (r.companyId) go("company", { companyId: r.companyId }); })]) : null,
    reasoning.length ? card(`Agent reasoning (${reasoning.length})`, [table(reasoning as Row[], [["Topic", (r) => r.topic], ["Reasoning", (r) => r.text ?? unknown("—")]])]) : null,
    salesperson?.extracted?.length ? card(`Read from the salesperson's files (${salesperson.extracted.length})`, [table(salesperson.extracted as Row[], [["File", (r) => r.filename], ["Kind", (r) => (r.kind ? humanize(r.kind) : unknown("—"))], ["Status", (r) => badge(r.extraction_status)]])]) : null,
    offers.length ? card(`Offers (${offers.length})`, [table(offers as Row[], [["#", (r) => String(r.version)], ["Kind", (r) => humanize(r.kind ?? "")], ["Unit price", (r) => money(r.unitPrice, r.currency)], ["Qty", (r) => String(r.quantity ?? "—")], ["Lead time", (r) => (r.leadTimeDays ? `${r.leadTimeDays} days` : unknown("—"))], ["Status", (r) => badge(r.status)]])]) : null,
    card(`Steps (${stepRows.length})`, [table(stepRows, [["Status", (r) => badge(r.status)], ["Step", (r) => r.title]])]),
    h("div", { className: "x-row" }, h("button", { type: "button", className: "ds-btn ds-btn--ghost ds-btn--sm", onclick: () => go("emails", { missionId: id }) }, "Mission emails")),
  ];
}

function emailsView(data: Row) {
  const rows = (data.messages ?? []) as Row[];
  return [
    head(`Mission #${data.missionId}`, "Emails", h("span", { className: "x-sub" }, data.configured === false ? "Mailbox not configured" : `${rows.length} messages`)),
    data.error ? h("div", { className: "x-error" }, data.error) : null,
    card(`Emails (${rows.length})`, [table(rows, [["Subject", (r) => h("div", {}, h("div", {}, r.subject), h("div", { className: "x-sub" }, r.snippet))], ["From", (r) => r.from], ["Sent", (r) => fmtDate(r.created)]], (r) => go("email", { missionId: data.missionId, messageId: r.id }), "No emails for this mission.")]),
  ];
}

function emailView(data: Row) {
  return [
    head(`Mission #${data.missionId}`, data.subject, h("span", { className: "x-sub" }, `${data.from} → ${data.to}`)),
    h("pre", { className: "x-mail" }, data.text ?? ""),
    data.attachments?.length ? card(`Attachments (${data.attachments.length})`, [table((data.attachments as string[]).map((name) => ({ name })), [["File", (r) => r.name]])]) : null,
  ];
}

function dealView(data: Row) {
  const { deal: d, humanApprovals, offers, events } = data as Row;
  const t = parsed(d.terms);
  return [
    head("Deal", d.deal_ref ?? `Deal #${d.id}`, h("div", { className: "x-row" }, badge(d.status), badge(d.mode))),
    h("p", { className: "x-note" }, SIMULATED),
    h("div", { className: "x-stats" }, stat("Total", money(d.total_value, d.currency)), stat("Unit price", money(t.unitPrice, t.currency ?? d.currency)), stat("Quantity", String(t.quantity ?? "—")), stat("Human approvals", String(humanApprovals ?? 0))),
    card("Terms", [table(Object.entries(t).filter(([, v]) => typeof v !== "object").map(([k, v]) => ({ k: k.replace(/([A-Z])/g, " $1").toLowerCase(), v: String(v) })), [["Term", (r) => r.k], ["Value", (r) => r.v]])]),
    offers?.length ? card(`Offers (${offers.length})`, [table((offers as Row[]).map((o) => ({ ...o, ...parsed(o.terms) })), [["#", (r) => String(r.version)], ["Kind", (r) => humanize(r.kind ?? "")], ["Unit price", (r) => money(r.unitPrice, r.currency)], ["Status", (r) => badge(r.status)]])]) : null,
    events?.length ? card(`Timeline (${events.length})`, [table(events as Row[], [["When", (r) => fmtDate(r.created_at)], ["Event", (r) => r.summary]])]) : null,
  ];
}

function tendersView(data: Row) {
  const rows = data.rows as Row[];
  return [
    head("Real public tenders", data.query ? `Tenders: ${data.query}` : "Tenders", h("span", { className: "x-sub" }, `${data.total} found, showing ${rows.length}`)),
    card(`Tenders (${rows.length})`, [table(rows, [["Notice", (r) => h("div", {}, extLink(r.source_url, r.title), h("div", { className: "x-sub" }, r.contracting_authority ?? ""))], ["Country", (r) => r.country ?? unknown("—")], ["Deadline", (r) => (r.deadline ? h("span", { style: "white-space:nowrap" }, fmtDate(r.deadline)) : unknown("—"))], ["Value", (r) => money(r.estimated_value, r.currency)]], undefined, "No tenders match.")]),
  ];
}

const VIEWS: Record<string, (data: Row) => Node_[]> = { events: eventsView, event: eventView, company: companyView, search: searchView, exhibitors: exhibitorsView, setup: setupView, prompts: promptsView, missions: missionsView, mission: missionView, emails: emailsView, email: emailView, deal: dealView, tenders: tendersView };
const TOOLS: Record<string, string> = { events: "arsenal_list_events", event: "arsenal_event_detail", company: "arsenal_company", search: "arsenal_search", exhibitors: "arsenal_event_exhibitors", setup: "arsenal_demo_setup", prompts: "arsenal_demo_prompts", missions: "arsenal_list_missions", mission: "arsenal_mission", emails: "arsenal_mission_emails", email: "arsenal_mission_emails", deal: "arsenal_deal", tenders: "arsenal_find_tenders" };

// A mission stops changing on its own at these points, so the view stops polling.
const STOPPED = ["WAITING_REPLY", "MEETING_PLANNED", "DEAL_CLOSED", "FAILED"];
let poll: ReturnType<typeof setTimeout> | undefined;

// The dashboard's mark from apps/web/src/ui.tsx, inverted for the ink nav bar. Static markup, no data.
const LOGO = '<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><path d="M8 0H32V24L24 32H0V8Z" fill="#fff"/><path d="M9 23L16 9L23 23" stroke="#12171A" stroke-width="2.5" fill="none"/><path d="M12.5 18H19.5" stroke="#1957EA" stroke-width="2.5"/></svg>';

function bar() {
  // Enter handler, not a <form>: host sandboxes may omit allow-forms, which silently blocks submit events.
  const submit = (e: KeyboardEvent) => {
    const query = (e.target as HTMLInputElement).value.trim();
    if (e.key === "Enter" && query.length >= 2) go("search", { query });
  };
  const search = h("input", { className: "ds-input", placeholder: "Search events, companies, notices", "aria-label": "Search Arsenal", value: history.at(-1)?.name === "search" ? history.at(-1)!.args.query : undefined, onkeydown: submit });
  const brand = h("span", { className: "ds-brand" });
  brand.innerHTML = LOGO;
  brand.append("Arsenal AI");
  return h("div", { className: "x-bar" }, brand,
    history.length > 1 ? h("button", { type: "button", className: "ds-btn ds-btn--light ds-btn--sm", onclick: back }, "← Back") : null,
    search,
    h("button", { type: "button", className: "ds-btn ds-btn--sm", onclick: () => go("events", {}) }, "Events"),
    h("button", { type: "button", className: "ds-btn ds-btn--sm", onclick: () => go("missions", {}) }, "Missions"),
    h("button", { type: "button", className: "ds-btn ds-btn--light ds-btn--sm", onclick: () => go("setup", {}) }, "Setup"));
}

type Result = { structuredContent?: Row; isError?: boolean; content?: { type: string; text?: string }[] };

function draw(result: Result, quiet = false) {
  clearTimeout(poll);
  const text = result.content?.find((c) => c.type === "text")?.text;
  const sc = result.structuredContent;
  const body = result.isError || !sc || !VIEWS[sc.view] ? [h("div", { className: "x-error" }, text ?? "Arsenal returned no data.")] : VIEWS[sc.view]!(sc.data);
  root.replaceChildren(bar(), ...body.filter((c): c is Node | string => c != null));
  if (!quiet) window.scrollTo(0, 0);
  if (sc?.view === "mission" && !result.isError && !STOPPED.includes(sc.data.mission.status)) watch(sc.data.mission.id, JSON.stringify(sc.data));
}

// Redraws only when something changed, so reading isn't interrupted; a failed poll just tries again.
function watch(missionId: number, last: string) {
  poll = setTimeout(() => void (async () => {
    const screen = history.at(-1);
    if (screen?.name !== "mission" || screen.args.missionId !== missionId) return;
    try {
      const result = (await app.callServerTool({ name: "arsenal_mission", arguments: { missionId } })) as Result;
      const data = result.structuredContent?.data as Row | undefined;
      if (history.at(-1) !== screen) return;
      if (data && JSON.stringify(data) !== last) draw(result, true); else watch(missionId, last);
    } catch { watch(missionId, last); }
  })(), 3000);
}

async function fetchData(name: string, args: Row) {
  const result = await app.callServerTool({ name, arguments: args });
  const text = result.content?.find((c) => c.type === "text");
  if (result.isError || !result.structuredContent) throw new Error(text && "text" in text ? text.text : "Arsenal returned no data.");
  return (result.structuredContent as Row).data as Row;
}

// Failed interactions show inline so the rest of the view stays usable.
async function guarded(work: () => Promise<void>) {
  root.setAttribute("aria-busy", "true");
  try { await work(); } catch (e) { root.prepend(h("div", { className: "x-error" }, e instanceof Error ? e.message : String(e))); }
  root.removeAttribute("aria-busy");
}

const show = (screen: Screen) => guarded(async () => draw((await app.callServerTool({ name: TOOLS[screen.name]!, arguments: screen.args })) as Result));
function go(name: string, args: Row) { clearTimeout(poll); history.push({ name, args }); void show({ name, args }); }
function back() { clearTimeout(poll); history.pop(); void show(history.at(-1)!); }

// Handlers go before connect() so the first tool notifications aren't missed.
let initialArgs: Row = {};
app.ontoolinput = ({ arguments: args }) => { initialArgs = args ?? {}; };
app.ontoolresult = (result) => {
  const sc = result.structuredContent as Row | undefined;
  // arsenal_start_mission has no missionId input, so missions take it from the result.
  if (!history.length && sc?.view) history.push({ name: sc.view, args: sc.view === "mission" ? { missionId: sc.data.mission.id } : initialArgs });
  draw(result as Result);
};
root.append(h("p", { className: "ds-cap" }, "Loading Arsenal…"));
await app.connect();
