import { Db, setDb } from "../src/db/db.ts";
import { seedReferenceData } from "../src/db/reference-data.ts";

/** Each test gets an isolated in-memory database. Nothing here ever touches production data. */
export function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  seedReferenceData(db);
  setDb(db);
  return db;
}

// All values below are TEST FIXTURES for exercising logic. They are never inserted into a real database.
export function fixtureUser(db: Db, email: string): number {
  return db.insert("users", { email, name: email, password_hash: "x" });
}
export function fixtureCompany(db: Db, name: string, opts: { registered?: boolean; state?: string; userId?: number; level?: string } = {}): number {
  const id = db.insert("companies", { canonical_name: name, normalized_name: name.toLowerCase(), country: "PL", identity_state: opts.state ?? "IDENTIFIED", is_registered: opts.registered ? 1 : 0, origin: "TEST_FIXTURE" });
  if (opts.userId) db.insert("company_memberships", { user_id: opts.userId, company_id: id, role: "ADMIN", authorization_level: opts.level ?? "SIGNATORY" });
  return id;
}
