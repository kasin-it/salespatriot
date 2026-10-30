// Demo-only fictional events. Pass --remove to delete them. Everything is labelled [MOCK], uses reserved .example domains
// and never links to a real company, so the rule that real data comes from official sources still holds.
import { Db, dbPath } from "./db.ts";

const VIA = "mock_seed";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const EVENTS = [
  { name: "Northern Shield Expo", slug: "northern-shield", city: "Gdansk", country: "Poland", start: 45, end: 48, description: "Fictional land and maritime defence exhibition.", exhibitors: [["Baltic Optronics Mock", "PL", "A12"], ["Kestrel Drone Works Mock", "EE", "A20"], ["Ironwake Marine Mock", "FI", "B03"], ["Polaris Radar Mock", "SE", "B11"], ["Vanguard Logistics Mock", "DE", "C07"], ["Sentinel Comms Mock", "NO", "C15"]] },
  { name: "Aegis Air & Space Forum", slug: "aegis-air-space", city: "Toulouse", country: "France", start: 120, end: 122, description: "Fictional aerospace and space systems forum.", exhibitors: [["Stratos Avionics Mock", "FR", "H1-04"], ["Orbitline Systems Mock", "IT", "H1-18"], ["Skyforge Composites Mock", "ES", "H2-02"], ["Helion Propulsion Mock", "FR", "H2-09"]] },
  { name: "Bastion Land Systems Week", slug: "bastion-land", city: "Prague", country: "Czechia", start: -1, end: 2, description: "Fictional armoured vehicles and land systems show.", exhibitors: [["Rampart Armour Mock", "CZ", "12"], ["Trailhead Vehicles Mock", "SK", "27"], ["Ferrous Munitions Mock", "AT", "31"], ["Lodestar Navigation Mock", "HU", "44"], ["Granite Power Mock", "RO", "52"]] },
  { name: "Harbour Defence Summit", slug: "harbour-defence", city: "Rotterdam", country: "Netherlands", start: -200, end: -198, description: "Fictional naval and coastal security summit.", exhibitors: [["Tidewatch Sensors Mock", "NL", "D2"], ["Keelhaul Robotics Mock", "BE", "D9"], ["Saltline Security Mock", "DK", "E4"]] },
] as const;

const db = new Db(dbPath());
const removed = db.all<{ id: number }>("SELECT id FROM events WHERE discovered_via=?", VIA);
for (const { id } of removed) {
  db.run("DELETE FROM search_index WHERE entity_type='event' AND entity_id=?", id);
  db.run("DELETE FROM events WHERE id=?", id); // Exhibitors, updates and source links cascade.
}
db.run("DELETE FROM sources WHERE url LIKE 'https://%.example/%'");

if (process.argv.includes("--remove")) {
  console.log(`Removed ${removed.length} mock events`);
} else {
  for (const e of EVENTS) {
    const url = `https://${e.slug}.example/`;
    const name = `[MOCK] ${e.name}`;
    const id = db.insert("events", { name, official_url: url, city: e.city, country: e.country, start_date: day(e.start), end_date: day(e.end), description: e.description, discovered_via: VIA });
    const source = db.insert("sources", { url, domain: `${e.slug}.example`, source_type: "mock", title: `${name} (fictional)` });
    db.insert("event_sources", { event_id: id, source_id: source, role: "MOCK" });
    db.insert("event_updates", { event_id: id, kind: "MOCK_UPDATE", summary: "Fictional update for demos." });
    db.run("INSERT INTO search_index (entity_type, entity_id, title, body) VALUES ('event', ?, ?, ?)", id, name, [e.description, e.city, e.country].join(" "));
    for (const [exhibitor, country, booth] of e.exhibitors) {
      db.insert("event_exhibitors", { event_id: id, exhibitor_name: exhibitor, normalized_name: exhibitor.toLowerCase(), country, booth, source_url: url, resolution_status: "MOCK" });
    }
  }
  console.log(`Seeded ${EVENTS.length} mock events`);
}
db.close();
