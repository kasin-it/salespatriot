import { Db, dbPath } from "./db.ts";
import { seedReferenceData } from "./reference-data.ts";

const db = new Db(dbPath());
const ran = db.migrate();
seedReferenceData(db);
console.log(ran.length ? `Applied migrations: ${ran.join(", ")}` : "Database is up to date");
db.close();
