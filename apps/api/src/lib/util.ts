import { createHash, randomBytes } from "node:crypto";

export const now = (): string => new Date().toISOString();

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("hex");

const LEGAL_SUFFIXES =
  /\b(spolka akcyjna|spolka z ograniczona odpowiedzialnoscia|spolka komandytowa|spolka jawna|sp z o o|sp zoo|sp k|sp j|s a|sa|gmbh co kg|gmbh|ag|kg|se|ltd|limited|plc|llc|inc|corp|corporation|bv|b v|nv|n v|srl|s r l|spa|s p a|sas|s a s|sarl|oy|ab|as|a s|aps|kft|zrt|s r o|sro|a s|d o o|doo|ehf|oü|ou|uab|sia|company|co)\b/g;

/** Lowercase, strip diacritics, punctuation and legal-form suffixes. Used for candidate lookup only, never for merging alone. */
export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/["'“”„`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanText(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function excerpt(text: string, index: number, radius = 160): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message + (e.cause instanceof Error ? ` (${e.cause.message})` : "");
  return String(e);
}

/** ISO-3166 alpha-3 -> alpha-2 for the countries TED reports most. Unknown codes pass through. */
const A3: Record<string, string> = {
  POL: "PL", DEU: "DE", FRA: "FR", ITA: "IT", ESP: "ES", NLD: "NL", BEL: "BE", AUT: "AT", CZE: "CZ", SVK: "SK",
  HUN: "HU", ROU: "RO", BGR: "BG", GRC: "GR", PRT: "PT", SWE: "SE", FIN: "FI", DNK: "DK", EST: "EE", LVA: "LV",
  LTU: "LT", IRL: "IE", LUX: "LU", SVN: "SI", HRV: "HR", CYP: "CY", MLT: "MT", NOR: "NO", GBR: "GB", CHE: "CH",
  USA: "US", ISL: "IS", UKR: "UA", TUR: "TR",
};
export const iso2 = (code: string | null | undefined): string | null => (code ? (A3[code] ?? code) : null);

const COUNTRY_NAMES: Record<string, string> = {
  poland: "PL", polska: "PL", germany: "DE", deutschland: "DE", france: "FR", italy: "IT", spain: "ES",
  netherlands: "NL", "the netherlands": "NL", belgium: "BE", austria: "AT", "czech republic": "CZ", czechia: "CZ",
  slovakia: "SK", hungary: "HU", romania: "RO", bulgaria: "BG", greece: "GR", portugal: "PT", sweden: "SE",
  finland: "FI", denmark: "DK", estonia: "EE", latvia: "LV", lithuania: "LT", ireland: "IE", luxembourg: "LU",
  slovenia: "SI", croatia: "HR", cyprus: "CY", malta: "MT", norway: "NO", "united kingdom": "GB", uk: "GB",
  "great britain": "GB", switzerland: "CH", "united states": "US", usa: "US", "united states of america": "US",
  ukraine: "UA", turkey: "TR", türkiye: "TR", turkiye: "TR", israel: "IL", "south korea": "KR",
  "korea, republic of": "KR", "republic of korea": "KR", japan: "JP", canada: "CA", australia: "AU", india: "IN",
  pakistan: "PK", china: "CN", taiwan: "TW", singapore: "SG", "united arab emirates": "AE", brazil: "BR",
  serbia: "RS", "bosnia and herzegovina": "BA", "north macedonia": "MK", albania: "AL", montenegro: "ME",
  moldova: "MD", georgia: "GE", "south africa": "ZA",
};
export function countryFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const t = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(t)) return t.toUpperCase();
  return COUNTRY_NAMES[t] ?? null;
}
