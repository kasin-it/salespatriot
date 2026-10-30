import { getDb } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { domainOf, normalizeUrl } from "../lib/util.ts";
import { resolveCompany } from "./companies.ts";
import { enqueueTask } from "../agents/orchestrator.ts";

export interface OnboardInput {
  userId: number;
  legalName: string;
  website?: string;
  country?: string;
  registrationNumber?: string;
  vat?: string;
  lei?: string;
  businessEmailDomain?: string;
  jobTitle?: string;
  authorizationLevel?: "SIGNATORY" | "STANDARD" | "READ_ONLY";
}

/** Register a company on behalf of a user. Identifiers are stored unverified; the identity workflow verifies them against registries. */
export function onboardCompany(i: OnboardInput): { companyId: number; taskId: number | null } {
  const db = getDb();
  const user = db.get<{ email: string }>("SELECT email FROM users WHERE id=?", i.userId)!;
  const website = normalizeUrl(i.website);
  const emailDomain = i.businessEmailDomain?.toLowerCase() ?? domainOf(website);
  const userDomain = user.email.split("@")[1]?.toLowerCase();
  const domainVerified = !!emailDomain && userDomain === emailDomain;
  const identifiers: { scheme: string; value: string }[] = [];
  if (i.registrationNumber) identifiers.push({ scheme: "REGISTRATION_NUMBER", value: i.registrationNumber.trim() });
  if (i.vat) identifiers.push({ scheme: "VAT", value: i.vat.replace(/\s/g, "").toUpperCase() });
  if (i.lei) identifiers.push({ scheme: "LEI", value: i.lei.trim().toUpperCase() });
  const r = resolveCompany({ name: i.legalName.trim(), country: i.country?.toUpperCase() ?? null, website, origin: "registration", identifiers, sourceUrl: null, sourceType: "USER_PROVIDED", factKind: "USER_PROVIDED", evidence: "Supplied by registering user" });
  db.update("companies", r.companyId, { legal_name: i.legalName.trim(), is_registered: 1 });
  const existingMembers = db.get<{ n: number }>("SELECT COUNT(*) n FROM company_memberships WHERE company_id=?", r.companyId)!.n;
  // The first member of a company becomes ADMIN. Later members must be added by an existing admin, so users cannot attach themselves to someone else's company.
  if (existingMembers > 0) throw new Error("This company already has an administrator; ask them to add you");
  db.insert("company_memberships", { user_id: i.userId, company_id: r.companyId, role: "ADMIN", job_title: i.jobTitle ?? null, authorization_level: i.authorizationLevel ?? "STANDARD", email_domain_verified: domainVerified ? 1 : 0 });
  audit({ actorType: "user", actorId: i.userId, companyId: r.companyId, action: "company.registered", entityType: "company", entityId: r.companyId, summary: `Company "${i.legalName}" registered${domainVerified ? " (business email domain matches website)" : " (email domain not matched to website)"}` });
  const taskId = enqueueTask("company_identity", "company.identity", { companyId: r.companyId, next: ["enrich", "match"] }, `user:${i.userId}`, { companyId: r.companyId, entityType: "company", entityId: r.companyId, dedupeKey: `identity:${r.companyId}`, priority: 2 });
  return { companyId: r.companyId, taskId };
}
