import { test } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { freshDb, fixtureCompany, fixtureUser } from "../helpers.ts";
import { addFieldRep, pollInbox, sendFieldRequest } from "../../src/services/field.ts";

const live = process.env.LIVE === "1";

// TEST FIXTURE: minimal single-page PDF standing in for a spec sheet a person at the event would photograph or forward.
function fixturePdf(lines: string[]): Buffer {
  const stream = `BT /F1 11 Tf 40 780 Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out);
}

test("LIVE Mailpit: agent asks the person at the event; reply with photo + spec PDF is received and parsed; gaps are explicit", { skip: !live, timeout: 60_000 }, async () => {
  const base = process.env.MAILPIT_URL ?? "http://localhost:8026"; // dedicated Mailpit; this test clears it
  await fetch(`${base}/api/v1/messages`, { method: "DELETE" });
  Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_FROM: "agent@arsenal.test", MAILPIT_URL: base });
  const db = freshDb();
  const u = fixtureUser(db, "u@t.example");
  const ours = fixtureCompany(db, "Our Buyer Co", { registered: true, userId: u });
  const target = fixtureCompany(db, "Public Thermal Vendor (public record)");
  const repId = addFieldRep(ours, "Marek", "marek@field.test", u);
  const reqId = await sendFieldRequest({ companyId: ours, repId, targetCompanyId: target, standHint: "hala 2, stoisko A12", userId: u });
  const row = db.get<{ status: string; token: string }>("SELECT * FROM field_requests WHERE id=?", reqId)!;
  assert.equal(row.status, "REQUESTED");

  const sent = (await (await fetch(`${base}/api/v1/messages`)).json()) as { messages: { Subject: string; To: { Address: string }[] }[] };
  assert.equal(sent.messages.length, 1);
  assert.match(sent.messages[0]!.Subject, /Jesteś na evencie\? Sprawdź stoisko/);
  assert.equal(sent.messages[0]!.To[0]!.Address, "marek@field.test");

  // The human's reply: photo + spec PDF. Subject keeps the token, as the request asks.
  const t = nodemailer.createTransport({ host: "127.0.0.1", port: 1026, secure: false });
  await t.sendMail({ from: "marek@field.test", to: "agent@arsenal.test", subject: `Re: ${row.token}`, text: "Jestem przy stoisku. Zdjęcie i spec w załączniku.",
    attachments: [{ filename: "flyer.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), contentType: "image/jpeg" }, { filename: "spec.pdf", content: fixturePdf(["Thermal imaging camera TI-640 night vision", "Unit price: 1200 EUR", "Lead time: 6 weeks", "Quality: ISO 9001"]), contentType: "application/pdf" }] });
  await new Promise((r) => setTimeout(r, 500));

  const r = await pollInbox();
  assert.equal(r.replies, 1);
  assert.equal((await pollInbox()).replies, 0, "polling is idempotent");
  const done = db.get<{ status: string; summary: string }>("SELECT * FROM field_requests WHERE id=?", reqId)!;
  assert.equal(done.status, "REPLIED");
  const s = JSON.parse(done.summary);
  assert.equal(s.photoCount, 1);
  assert.equal(s.terms.unitPrice, 1200); assert.equal(s.terms.currency, "EUR"); assert.equal(s.terms.leadTimeDays, 42);
  assert.ok(s.categories.some((c: { key: string }) => c.key === "optics_sights"));
  assert.ok(s.certifications.some((c: { name: string }) => c.name === "ISO 9001"));
  assert.ok(s.gaps.includes("Payment terms not stated"), "missing data is reported as a gap, not guessed");
  const atts = db.all<{ filename: string; extraction_status: string }>("SELECT filename, extraction_status FROM email_attachments ORDER BY filename");
  assert.deepEqual(atts.map((a) => [a.filename, a.extraction_status]), [["flyer.jpg", "NEEDS_VISION_NOT_CONFIGURED"], ["spec.pdf", "EXTRACTED_TEXT"]]);
  assert.ok(db.get("SELECT 1 FROM company_capabilities WHERE company_id=? AND source_url LIKE 'field-request:%'", target));
});
