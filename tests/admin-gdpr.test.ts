import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setUserTag, updateOrgSettings } from "@/lib/admin/service";
import { diffObjects } from "@/lib/audit";
import { anonymizeUser, exportUserData } from "@/lib/gdpr";
import { createSession } from "@/lib/auth/sessions";
import { ForbiddenError } from "@/lib/permissions";
import { orgSettingsSchema } from "@/lib/validation/account";
import { asActor, makeEvent, makeUser, resetDb, TEST_PASSWORD } from "./helpers";

beforeEach(resetDb);

describe("admin: tag management", () => {
  it("lets an admin grant and revoke FESTIVALLEDARE, writing audit rows", async () => {
    const admin = await makeUser({ tags: ["ADMIN"] });
    const target = await makeUser();
    expect(await setUserTag(asActor(admin), target.id, "FESTIVALLEDARE", true, "7.7.7.7")).toEqual({ ok: true, changed: true });
    expect(await db.userTag.count({ where: { userId: target.id, tag: "FESTIVALLEDARE" } })).toBe(1);
    expect(await setUserTag(asActor(admin), target.id, "FESTIVALLEDARE", true)).toEqual({ ok: true, changed: false });
    expect(await setUserTag(asActor(admin), target.id, "FESTIVALLEDARE", false)).toEqual({ ok: true, changed: true });

    const logs = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["user.tag.add", "user.tag.remove"]);
    expect(logs[0]).toMatchObject({ actorId: admin.id, entityType: "User", entityId: target.id, ip: "7.7.7.7" });
    expect(logs[0]!.diff).toEqual({ tag: { from: null, to: "FESTIVALLEDARE" } });
  });

  it("refuses non-admins (even Festivalledare)", async () => {
    const fl = await makeUser({ tags: ["FESTIVALLEDARE"] });
    const target = await makeUser();
    await expect(setUserTag(asActor(fl), target.id, "ADMIN", true)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.userTag.count({ where: { tag: "ADMIN" } })).toBe(0);
  });

  it("won't remove the last ADMIN tag, including your own", async () => {
    const admin = await makeUser({ tags: ["ADMIN"] });
    expect(await setUserTag(asActor(admin), admin.id, "ADMIN", false)).toEqual({ ok: false, reason: "lastAdmin" });
    expect(await db.userTag.count({ where: { tag: "ADMIN" } })).toBe(1);
  });

  it("allows removing your own ADMIN tag when another admin exists", async () => {
    const a = await makeUser({ tags: ["ADMIN"] });
    await makeUser({ tags: ["ADMIN"] });
    expect(await setUserTag(asActor(a), a.id, "ADMIN", false)).toEqual({ ok: true, changed: true });
  });

  it("two admins removing each other concurrently can't leave zero admins", async () => {
    const a = await makeUser({ tags: ["ADMIN"] });
    const b = await makeUser({ tags: ["ADMIN"] });
    const [r1, r2] = await Promise.all([setUserTag(asActor(a), b.id, "ADMIN", false), setUserTag(asActor(b), a.id, "ADMIN", false)]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(await db.userTag.count({ where: { tag: "ADMIN" } })).toBe(1);
  });
});

describe("admin: org settings", () => {
  it("updates settings with an audit diff; non-admins are refused", async () => {
    const admin = await makeUser({ tags: ["ADMIN"] });
    const input = orgSettingsSchema.parse({ name: "CCSS", orgNumber: "802000-0000", address: "Gatan 1", contactEmail: "info@ccss.se", privacyPolicyVersion: "2" });
    await updateOrgSettings(asActor(admin), input, "8.8.8.8");
    const s = await db.orgSettings.findFirstOrThrow();
    expect(s).toMatchObject({ name: "CCSS", orgNumber: "802000-0000", privacyPolicyVersion: "2" });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "org.settings.update" } });
    expect(log.diff).toMatchObject({ orgNumber: { from: null, to: "802000-0000" }, privacyPolicyVersion: { from: "1", to: "2" } });

    const member = await makeUser();
    await expect(updateOrgSettings(asActor(member), input)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("audit diff helper", () => {
  it("reports only changed fields and redacts secrets", () => {
    expect(diffObjects({ a: 1, b: 2, passwordHash: "x" }, { a: 1, b: 3, passwordHash: "y" })).toEqual({
      b: { from: 2, to: 3 },
      passwordHash: { from: "[redacted]", to: "[redacted]" },
    });
  });
});

describe("GDPR export", () => {
  it("includes the user's data but never the password hash", async () => {
    const u = await makeUser();
    await db.consent.create({ data: { userId: u.id, kind: "PRIVACY_POLICY", version: "1" } });
    await createSession(u.id, { ip: "1.2.3.4" });
    const data = await exportUserData(u.id);
    expect(data).toMatchObject({ id: u.id, email: u.email, realName: u.realName });
    expect(data.consents).toHaveLength(1);
    expect(data.sessions).toHaveLength(1);
    const json = JSON.stringify(data);
    expect(json).not.toContain("passwordHash");
    expect(json).not.toContain("$argon2");
  });
});

describe("GDPR anonymization", () => {
  it("scrubs personal data, kills sessions, keeps orders/payments with a placeholder", async () => {
    const creator = await makeUser({ tags: ["ADMIN"] });
    const u = await makeUser();
    await db.user.update({ where: { id: u.id }, data: { allergies: "nötter", dietaryPreferences: "vegan", guardianName: "G", guardianPhone: "070" } });
    await createSession(u.id);
    await db.consent.create({ data: { userId: u.id, kind: "PRIVACY_POLICY", version: "1", ip: "1.2.3.4" } });
    await db.emailOutbox.create({ data: { to: u.email, template: "verify-email", payload: { name: u.realName } } });

    // A finished event with a paid order must survive for bookkeeping.
    const past = await makeEvent(creator.id, new Date("2020-01-01T00:00:00Z"));
    const order = await db.order.create({
      data: { number: "CCSS-2020-0001", userId: u.id, eventId: past.id, status: "PAID", subtotalOre: 10000, totalOre: 10000, expiresAt: new Date(), paidAt: new Date() },
    });
    await db.payment.create({ data: { orderId: order.id, provider: "stripe", providerRef: "pi_1", kind: "CHARGE", amountOre: 10000, status: "succeeded", raw: {} } });

    const r = await anonymizeUser(u.id, { password: TEST_PASSWORD, ip: "9.9.9.9" });
    expect(r).toEqual({ ok: true });

    const after = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.anonymizedAt).not.toBeNull();
    expect(after).toMatchObject({ realName: "Anonymiserad användare", phone: "", allergies: null, dietaryPreferences: null, guardianName: null, guardianPhone: null });
    expect(after.email).toBe(`anonymized-${u.id}@anonymized.invalid`);
    expect(after.email).not.toContain(u.email);
    expect(after.nickname).not.toBe(u.nickname);
    expect(after.birthDate.toISOString().slice(0, 4)).toBe("1900");

    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { to: u.email } })).toBe(0);
    expect((await db.consent.findFirstOrThrow({ where: { userId: u.id } })).ip).toBeNull();
    expect(await db.order.count({ where: { userId: u.id } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "user.anonymize" } });
    expect(JSON.stringify(log)).not.toContain(u.email);

    // login is impossible
    const { loginUser } = await import("@/lib/auth/service");
    expect(await loginUser(u.email, TEST_PASSWORD, {})).toEqual({ ok: false, reason: "invalid" });
    expect(await anonymizeUser(u.id, { password: TEST_PASSWORD })).toEqual({ ok: false, reason: "alreadyAnonymized" });
  });

  it("requires the right password", async () => {
    const u = await makeUser();
    expect(await anonymizeUser(u.id, { password: "wrong" })).toEqual({ ok: false, reason: "wrongPassword" });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).anonymizedAt).toBeNull();
  });

  it("refuses the last admin", async () => {
    const admin = await makeUser({ tags: ["ADMIN"] });
    expect(await anonymizeUser(admin.id, { password: TEST_PASSWORD })).toEqual({ ok: false, reason: "lastAdmin" });
  });

  it("refuses while a live ticket exists for an upcoming event", async () => {
    const creator = await makeUser({ tags: ["ADMIN"] });
    const u = await makeUser();
    const event = await makeEvent(creator.id, new Date(Date.now() + 30 * 24 * 3600_000));
    const tt = await db.ticketType.create({ data: { eventId: event.id, name: "S", priceOre: 0, quantity: 5 } });
    const o = await db.order.create({ data: { number: "T-1", userId: u.id, eventId: event.id, subtotalOre: 0, totalOre: 0, expiresAt: new Date() } });
    const t = await db.ticket.create({ data: { eventId: event.id, userId: u.id, ticketTypeId: tt.id, orderId: o.id, status: "ACTIVE", qrNonce: "n" } });
    expect(await anonymizeUser(u.id, { password: TEST_PASSWORD })).toEqual({ ok: false, reason: "activeTickets" });
    await db.ticket.update({ where: { id: t.id }, data: { status: "CANCELLED" } });
    expect(await anonymizeUser(u.id, { password: TEST_PASSWORD })).toEqual({ ok: true });
  });
});
