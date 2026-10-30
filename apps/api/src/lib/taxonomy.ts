// Classification vocabulary used to label evidence. It never creates facts by itself:
// a category is attached to a company or notice only when one of its terms occurs in a real source text,
// and that passage is stored as evidence.

export interface Category {
  key: string;
  label: string;
  /** CPV code prefixes that belong to this category. */
  cpv: string[];
  /** Lowercase terms (EN/PL/DE/FR). Matched on word boundaries. */
  terms: string[];
}

export const CATEGORIES: Category[] = [
  { key: "ammunition", label: "Ammunition & ordnance", cpv: ["3533", "35321", "35322", "35323", "35331", "35332", "35333"], terms: ["ammunition", "munitions", "amunicja", "amunicji", "munition", "ordnance", "projectile", "pociski", "pocisk", "cartridge", "naboje", "naboi", "artillery shell", "mortar round", "explosives", "materiały wybuchowe"] },
  { key: "small_arms", label: "Small arms & weapons", cpv: ["35321", "3532"], terms: ["small arms", "firearms", "rifle", "rifles", "pistol", "pistols", "karabin*", "karabinki", "broń strzelecka", "weapon systems", "machine gun", "waffen", "gewehr", "armes"] },
  { key: "optics_sights", label: "Optics, sights & night vision", cpv: ["38636", "386", "3863"], terms: ["optics", "optical sight", "holographic", "riflescope", "night vision", "night-vision", "nvg", "nvgs", "night vision goggles", "thermal imaging", "thermal imager", "thermal imagers", "thermal camera", "thermal cameras", "thermal sight", "thermal sights", "thermal scope", "thermal scopes", "thermal weapon sight", "thermal binoculars", "infrared camera", "infrared cameras", "ir camera", "ir cameras", "celownik*", "celowniki", "noktowizor", "noktowizyjne", "termowizyjn*", "lunet*", "optronic", "electro-optic", "electro-optical", "optronics", "nachtsicht", "wärmebild"] },
  { key: "uav_drones", label: "UAV, drones & counter-UAS", cpv: ["35613"], terms: ["uav", "uavs", "uas", "drone", "drones", "military drone", "military drones", "combat drone", "combat drones", "reconnaissance drone", "reconnaissance drones", "unmanned aerial", "unmanned aircraft", "unmanned air", "quadcopter", "quadcopters", "multicopter", "multicopters", "multirotor", "multirotors", "fixed-wing uav", "vtol", "bezzałogow*", "dron", "drony", "dronów", "bsp", "multikopter*", "bezpilot*", "counter-uas", "c-uas", "counter-drone", "loitering munition", "amunicja krążąca", "drohne", "drohnen", "unbemannt*"] },
  { key: "radar_sensors", label: "Radar, surveillance & sensors", cpv: ["38115", "35125", "3812", "38112"], terms: ["radar", "radars", "surveillance system", "sensor", "sensors", "radiolokac*", "rozpoznani*", "detection system", "perimeter security", "sonar"] },
  { key: "communications", label: "Military communications & C4ISR", cpv: ["32", "3251", "3252", "3253", "32344", "35711", "35712"], terms: ["radios", "communications", "tactical communication", "c4isr", "c4i", "command and control", "satcom", "łączność", "radiostacj*", "datalink", "data link", "mesh network", "kommunikation"] },
  { key: "electronic_warfare", label: "Electronic warfare", cpv: ["35722", "3572"], terms: ["electronic warfare", "jamming", "jammer", "zakłóce*", "walka elektroniczna*", "sigint", "elint"] },
  { key: "electronics_components", label: "Electronics & components", cpv: ["315", "316", "317", "3171", "3172", "3173", "3174", "3176", "3123", "3155"], terms: ["electronic components", "electronics", "pcb", "printed circuit", "semiconductor", "semiconductors", "microelectronics", "cable harness", "elektronik*", "podzespoły elektroniczne*", "fpga", "embedded systems"] },
  { key: "armoured_vehicles", label: "Military & armoured vehicles", cpv: ["35400", "3541", "3542", "34144", "3411"], terms: ["armoured vehicle", "armored vehicle", "armoured vehicles", "armored vehicles", "military vehicle", "military vehicles", "pojazd*", "pojazdy", "wozy bojowe*", "transporter opancerzony", "fahrzeug", "fahrzeuge"] },
  { key: "aerospace", label: "Aircraft, helicopters & aerospace", cpv: ["3500", "35600", "3461", "34711", "34712", "50211", "50212"], terms: ["aircraft", "aerospace", "helicopter", "helicopters", "aviation", "airframe", "avionics", "śmigłow*", "samolot*", "lotnicz*", "luftfahrt", "hubschrauber", "aéronautique", "mro"] },
  { key: "naval", label: "Naval & maritime systems", cpv: ["35500", "3451", "3452", "35513"], terms: ["naval", "warship", "warships", "submarine", "submarines", "maritime", "okręt*", "okrętow", "morsk*", "shipyard", "stocznia"] },
  { key: "protective_equipment", label: "Protective equipment & body armour", cpv: ["35811", "35812", "35113", "18143", "18830", "3581", "35815"], terms: ["body armour", "body armor", "ballistic protection", "ballistic vest", "helmet", "helmets", "kamizelk*", "hełm*", "ochrona balistyczna", "protective equipment", "ppe", "cbrn", "chemical protection", "gas mask", "mundur*", "umundurowan*", "schutzausrüstung"] },
  { key: "cybersecurity", label: "Cybersecurity & secure IT", cpv: ["48730", "72212730", "48732", "72"], terms: ["cybersecurity", "cyber security", "cyber defence", "cyber defense", "cyberbezpiecze*", "encryption", "kryptograf*", "secure communications", "siem", "penetration testing", "it security", "informationssicherheit"] },
  { key: "space", label: "Space systems & satellites", cpv: ["35613", "38111", "3511", "64228"], terms: ["satellite", "satellites", "spacecraft", "satelit*", "kosmiczn*", "earth observation", "launcher", "raumfahrt"] },
  { key: "simulation_training", label: "Simulation & training", cpv: ["3515", "80330", "80600", "806"], terms: ["simulator", "simulators", "simulation", "training system", "symulator", "szkolen*", "trenażer*", "live fire training", "ausbildung"] },
  { key: "logistics_support", label: "Logistics, maintenance & support", cpv: ["50", "5060", "63", "60"], terms: ["logistics", "overhaul", "remont*", "serwis*", "obsługa techniczna", "spare parts", "części zamienne", "wartung", "instandhaltung"] },
  { key: "manufacturing_machining", label: "Manufacturing & precision machining", cpv: ["42", "4263", "4264", "45", "2853", "4500"], terms: ["cnc", "machining", "precision machining", "metalworking", "fabrication", "welding", "casting", "forging", "obróbka", "spawanie", "odlewn*", "additive manufacturing", "3d printing", "fertigung", "zerspanung"] },
  { key: "robotics_automation", label: "Robotics & autonomous systems", cpv: ["42997", "4299", "38551"], terms: ["robots", "robotics", "robotic", "ugv", "unmanned ground", "autonomous systems", "autonomy", "robotyk*", "bezzałogowe pojazdy lądowe", "robotik"] },
  { key: "medical_tactical", label: "Tactical medical equipment", cpv: ["33", "331", "3314", "3319"], terms: ["tactical medical", "tourniquet", "medical kit", "combat medical", "medyczn*", "apteczk*", "sanitätsmaterial"] },
  { key: "police_security", label: "Police & internal security equipment", cpv: ["35100", "3512", "35121", "35122", "35123", "35124", "3511"], terms: ["law enforcement", "policja", "policji", "tactical equipment", "riot control", "less lethal", "less-lethal", "access control", "border security", "straż graniczna", "polizei", "sicherheitstechnik", "security equipment", "sprzęt bezpieczeństwa"] },
  { key: "energy_power", label: "Power, energy & batteries", cpv: ["31", "311", "3115", "3141", "3143", "31158", "09"], terms: ["power system", "energy storage", "akumulator*", "agregat*", "zasilani*", "fuel cell", "energieversorgung"] },
  { key: "textiles_field_gear", label: "Textiles, field gear & shelters", cpv: ["18", "39522", "1840", "1820", "39522530"], terms: ["tents", "shelters", "camouflage", "kamuflaż", "namiot*", "namioty", "backpack", "load carrying", "field equipment", "oporządzenie", "tarnung"] },
];

export const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const compiled = CATEGORIES.map((c) => ({
  cat: c,
  // Prefix-style terms (Polish stems) match at a word start; others need full-word boundaries.
  re: new RegExp(
    `(?<![\\p{L}\\p{N}])(${c.terms.map((t) => (t.endsWith("*") ? `${escapeRe(t.slice(0, -1))}` : `${escapeRe(t)}(?![\\p{L}\\p{N}])`)).join("|")})`,
    "giu",
  ),
}));

export interface CategoryHit {
  key: string;
  label: string;
  term: string;
  index: number;
}

/** Find categories whose terms occur in `text`; returns one hit (first occurrence) per category. */
export function classifyText(text: string): CategoryHit[] {
  const hits: CategoryHit[] = [];
  for (const { cat, re } of compiled) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) hits.push({ key: cat.key, label: cat.label, term: m[1] ?? m[0], index: m.index });
  }
  return hits;
}

/** Categories implied by CPV codes. A CPV code is official classification, so these are not inferences about the buyer. */
export function categoriesForCpv(codes: string[]): string[] {
  const out = new Set<string>();
  for (const raw of codes) {
    const code = raw.replace(/[^0-9]/g, "");
    if (!code) continue;
    for (const c of CATEGORIES) {
      if (c.cpv.some((p) => code.startsWith(p) && p.length >= 3)) out.add(c.key);
    }
  }
  return [...out];
}

export const CERTIFICATION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ISO 9001", re: /\bISO\s*9001(?::\s*20\d\d)?\b/i },
  { name: "AQAP 2110", re: /\bAQAP[\s-]*2110\b/i },
  { name: "AQAP 2210", re: /\bAQAP[\s-]*2210\b/i },
  { name: "AQAP 2310", re: /\bAQAP[\s-]*2310\b/i },
  { name: "EN 9100 / AS9100", re: /\b(?:EN|AS)\s*9100\b/i },
  { name: "ISO 14001", re: /\bISO\s*14001\b/i },
  { name: "ISO 27001", re: /\bISO(?:\/IEC)?\s*27001\b/i },
  { name: "ISO 45001", re: /\bISO\s*45001\b/i },
  { name: "NADCAP", re: /\bNADCAP\b/i },
  { name: "EN 1090", re: /\bEN\s*1090\b/i },
  { name: "ISO 3834", re: /\bISO\s*3834\b/i },
  { name: "PART-145", re: /\bPart[\s-]*145\b/i },
  { name: "PART-21", re: /\bPart[\s-]*21[GJ]?\b/i },
  { name: "Industrial security clearance (declared)", re: /\b(facility security clearance|świadectwo bezpieczeństwa przemysłowego)\b/i },
  { name: "WSK export-control ICP (declared)", re: /\b(WSK|wewnętrzny system kontroli)\b/ },
];
