import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { now, randomToken, sha256 } from "../lib/util.ts";

export interface AuthUser { id: number; email: string; name: string; scopes: string[] | null }

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const h = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  const want = Buffer.from(hash, "hex");
  return h.length === want.length && timingSafeEqual(h, want);
}

export function registerUser(email: string, name: string, password: string): number {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Invalid email");
  if (password.length < 10) throw new Error("Password must be at least 10 characters");
  const db = getDb();
  if (db.get("SELECT id FROM users WHERE email = ?", email)) throw new Error("Email already registered");
  const id = db.insert("users", { email, name, password_hash: hashPassword(password) });
  audit({ actorType: "user", actorId: id, action: "user.registered", entityType: "user", entityId: id, summary: `User registered` });
  return id;
}

export function login(email: string, password: string): { token: string; user: AuthUser } {
  const db = getDb();
  const u = db.get<{ id: number; email: string; name: string; password_hash: string }>("SELECT * FROM users WHERE email = ?", email);
  if (!u || !verifyPassword(password, u.password_hash)) throw new Error("Invalid credentials");
  const token = randomToken();
  db.insert("sessions", { token: sha256(token), user_id: u.id, expires_at: new Date(Date.now() + 14 * 86400_000).toISOString() });
  return { token, user: { id: u.id, email: u.email, name: u.name, scopes: null } };
}

export function authenticate(token: string | null): AuthUser | null {
  if (!token) return null;
  const db = getDb();
  const h = sha256(token);
  const s = db.get<{ id: number; email: string; name: string; expires_at: string }>("SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", h);
  if (s) return s.expires_at > now() ? { id: s.id, email: s.email, name: s.name, scopes: null } : null;
  const t = db.get<{ id: number; uid: number; email: string; name: string; scopes: string }>("SELECT t.id, u.id uid, u.email, u.name, t.scopes FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?", h);
  if (!t) return null;
  db.update("api_tokens", t.id, { last_used_at: now() });
  return { id: t.uid, email: t.email, name: t.name, scopes: t.scopes.split(",") };
}

export function createApiToken(userId: number, label: string, scopes: string[]): string {
  const token = `arsenal_${randomToken(24)}`;
  getDb().insert("api_tokens", { user_id: userId, token_hash: sha256(token), label, scopes: scopes.join(",") });
  audit({ actorType: "user", actorId: userId, action: "token.created", summary: `API token "${label}" created with scopes ${scopes.join(",")}` });
  return token;
}

/** Tenant isolation: every company-scoped route must call this. */
export function membership(userId: number, companyId: number): { role: string; authorization_level: string } | undefined {
  return getDb().get("SELECT role, authorization_level FROM company_memberships WHERE user_id = ? AND company_id = ?", userId, companyId);
}
export function requireMember(userId: number, companyId: number, minRole: "VIEWER" | "MEMBER" | "ADMIN" = "VIEWER"): { role: string; authorization_level: string } {
  const m = membership(userId, companyId);
  const rank = { VIEWER: 1, MEMBER: 2, ADMIN: 3 } as Record<string, number>;
  if (!m || (rank[m.role] ?? 0) < rank[minRole]!) throw new Error("Forbidden: not authorised for this company");
  return m;
}
export const userCompanyIds = (userId: number): number[] => getDb().all<{ company_id: number }>("SELECT company_id FROM company_memberships WHERE user_id=?", userId).map((r) => r.company_id);
