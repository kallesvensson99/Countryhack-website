import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { enqueueEmail, processOutbox } from "@/lib/email/outbox";
import { setEmailSender, type OutgoingEmail } from "@/lib/email/sender";
import { renderTemplate } from "@/lib/email/templates";
import { resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => setEmailSender(undefined));

describe("email outbox", () => {
  it("sends queued mail once, in both locales", async () => {
    const sent: OutgoingEmail[] = [];
    setEmailSender({ send: async (m) => void sent.push(m) });
    await enqueueEmail(db, { to: "a@x.test", template: "verify-email", locale: "sv", payload: { name: "Anna", url: "http://x/verify?token=abc" } });
    await enqueueEmail(db, { to: "b@x.test", template: "reset-password", locale: "en", payload: { name: "Bob", url: "http://x/reset?token=def" } });

    expect(await processOutbox()).toEqual({ sent: 2, failed: 0 });
    expect(sent.map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(sent[0]!.subject).toBe("Bekräfta din e-postadress");
    expect(sent[1]!.subject).toBe("Reset your password");
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(await db.emailOutbox.count({ where: { status: "SENT" } })).toBe(2);
  });

  it("retries failures and gives up after 5 attempts", async () => {
    setEmailSender({ send: async () => Promise.reject(new Error("smtp down")) });
    await enqueueEmail(db, { to: "a@x.test", template: "broadcast", locale: "sv", payload: { subject: "s", body: "b" } });
    for (let i = 0; i < 5; i++) await processOutbox();
    const row = await db.emailOutbox.findFirstOrThrow();
    expect(row).toMatchObject({ status: "FAILED", attempts: 5 });
    expect(row.error).toContain("smtp down");
  });

  it("two concurrent workers never send the same mail twice", async () => {
    const sent: string[] = [];
    setEmailSender({ send: async (m) => void sent.push(m.to) });
    for (let i = 0; i < 6; i++) await enqueueEmail(db, { to: `u${i}@x.test`, template: "broadcast", locale: "sv", payload: { subject: "s", body: "b" } });
    await Promise.all([processOutbox(), processOutbox(), processOutbox()]);
    expect(sent.sort()).toEqual(Array.from({ length: 6 }, (_, i) => `u${i}@x.test`));
  });

  it("escapes HTML in user-supplied content", () => {
    const r = renderTemplate("verify-email", "sv", { name: "<script>alert(1)</script>", url: "http://x" });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});
