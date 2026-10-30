import { parseHTML } from "linkedom";
import { cleanText, excerpt } from "../lib/util.ts";

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const monthIdx = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export interface DateRange {
  start: string;
  end: string;
  evidence: string;
}

const M = "(January|February|March|April|May|June|July|August|September|October|November|December)";

/** Extract explicit date ranges ("8-11 September 2026", "31 August to 3 September 2027", "Sept 7-10, 2027") from page text. */
export function findDateRanges(text: string): DateRange[] {
  const out: DateRange[] = [];
  const push = (start: string, end: string, idx: number, len: number) => out.push({ start, end, evidence: excerpt(text, idx + Math.floor(len / 2), 90) });
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s*(?:[-–—]|to)\\s*(\\d{1,2})\\s+${M}\\s+(20\\d\\d)`, "gi")))
    push(iso(+m[4]!, monthIdx(m[3]!), +m[1]!), iso(+m[4]!, monthIdx(m[3]!), +m[2]!), m.index!, m[0].length);
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+${M}\\s*(?:[-–—]|to)\\s*(\\d{1,2})\\s+${M}\\s+(20\\d\\d)`, "gi")))
    push(iso(+m[5]!, monthIdx(m[2]!), +m[1]!), iso(+m[5]!, monthIdx(m[4]!), +m[3]!), m.index!, m[0].length);
  for (const m of text.matchAll(/(\d{1,2})\.(\d{1,2})\s*[-–—]\s*(\d{1,2})\.(\d{1,2})\.(20\d\d)/g))
    push(iso(+m[5]!, +m[2]! - 1, +m[1]!), iso(+m[5]!, +m[4]! - 1, +m[3]!), m.index!, m[0].length);
  for (const m of text.matchAll(new RegExp(`${M}\\s+(\\d{1,2})\\s*(?:[-–—]|to)\\s*(\\d{1,2}),?\\s+(20\\d\\d)`, "gi")))
    push(iso(+m[4]!, monthIdx(m[1]!), +m[2]!), iso(+m[4]!, monthIdx(m[1]!), +m[3]!), m.index!, m[0].length);
  return out.filter((r) => r.start <= r.end);
}

export interface EventPageInfo {
  title: string | null;
  siteName: string | null;
  description: string | null;
  organizer: string | null;
  dateRanges: DateRange[];
  links: { href: string; text: string }[];
  text: string;
}

export function parseEventPage(html: string, baseUrl: string): EventPageInfo {
  const { document } = parseHTML(html);
  const meta = (sel: string) => cleanText(document.querySelector(sel)?.getAttribute("content") ?? null);
  const links = [...document.querySelectorAll("a[href]")].flatMap((a) => {
    try {
      return [{ href: new URL(a.getAttribute("href")!, baseUrl).toString(), text: cleanText(a.textContent) ?? "" }];
    } catch {
      return [];
    }
  });
  document.querySelectorAll("script,style,noscript").forEach((n: { remove(): void }) => n.remove());
  const text = cleanText(document.body?.textContent ?? "") ?? "";
  const org = /organi[sz]ed by\s+([A-Z][^.|<\n]{2,80}?)(?:[.|,]|\s{2}|$)/.exec(text);
  return {
    title: cleanText(document.querySelector("title")?.textContent ?? null),
    siteName: meta('meta[property="og:site_name"]'),
    description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    organizer: org?.[1]?.trim() ?? null,
    dateRanges: findDateRanges(text),
    links,
    text,
  };
}

const DIRECTORY_HINT = /(exhibitor|aussteller|exposant|exhibiting[- ]compan|participants|company-list|catalogue|catalog)/i;
const DOC_HINT = /\.(pdf|xlsx?|csv)(\?|$)/i;

export function findDirectoryLinks(info: EventPageInfo): { href: string; text: string }[] {
  return info.links.filter((l) => DIRECTORY_HINT.test(l.href) || DIRECTORY_HINT.test(l.text)).slice(0, 15);
}
export function findDocumentLinks(info: EventPageInfo): { href: string; text: string }[] {
  return info.links.filter((l) => DOC_HINT.test(l.href)).slice(0, 25);
}
