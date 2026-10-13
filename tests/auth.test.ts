import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { rateLimit } from "@/lib/auth/rate-limit";
import { createSession, validateSessionToken } from "@/lib/auth/sessions";
import { loginUser, registerUser, requestPasswordReset, resendVerification, resetPassword, verifyEmailToken } from "@/lib/auth/service";
import { sha256Hex } from "@/lib/auth/tokens";
import { registerSchema } from "@/lib/validation/account";
import { makeUser, resetDb, TEST_PASSWORD } from "./helpers";

const base = {
  email: "New.User@Example.com",
  password: "a-long-enough-password",
  realName: "New User",
  nickname: "NewUser",
  birthDate: "1996-04-12",
  phone: "+46 70 123 45 67",
  locale: "sv",
  acceptPrivacy: "on",
};

const parse = (over: Record<string, string> = {}) => registerSchema.safeParse({ ...base, ...over });
const ctx = (ip = "1.1.1.1") => ({ ip, locale: "sv" });

/** Pull the raw token out of the queued email link. */
async function lastTokenFor(template: string) {
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { template }, orderBy: { createdAt: "desc" } });
  const url = (mail.payload as { url: string }).url;
  return new URL(url).searchParams.get("token")!;
}

beforeEach(resetDb);

describe("registration", () => {
  it("creates the user (lowercased email), consent, verification token and queued email", async () => {
    const input = parse();
    expect(input.success).toBe(true);
    const r = await registerUser(input.data!, ctx());
    expect(r.ok).toBe(true);

    const user = await db.user.findUniqueOrThrow({ where: { email: "new.user@example.com" }, include: { consents: true } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(user.consents).toHaveLength(1);
    expect(user.consents[0]).toMatchObject({ kind: "PRIVACY_POLICY", version: "1", ip: "1.1.1.1" });

    const mail = await db.emailOutbox.findFirstOrThrow();
    expect(mail).toMatchObject({ to: "new.user@example.com", template: "verify-email", status: "PENDING" });
  });

  it("requires privacy consent", () => {
    const r = parse({ acceptPrivacy: "" });
    expect(r.success).toBe(false);
  });

  it("rejects duplicate email and case-insensitive duplicate nickname", async () => {
    await registerUser(parse().data!, ctx());
    const dup = await registerUser(parse({ email: "NEW.USER@example.com", nickname: "newuser" }).data!, ctx());
    expect(dup).toMatchObject({ ok: false, errors: { email: "validation.emailTaken", nickname: "validation.nicknameTaken" } });
  });

  it("requires guardian details for users under 18 and accepts them when given", () => {
    const year = new Date().getFullYear() - 15;
    const minor = parse({ birthDate: `${year}-01-01` });
    expect(minor.success).toBe(false);
    expect(minor.error!.issues.map((i) => i.path[0])).toEqual(expect.arrayContaining(["guardianName", "guardianPhone"]));
    expect(parse({ birthDate: `${year}-01-01`, guardianName: "G Guardian", guardianPhone: "+46 70 999 99 99" }).success).toBe(true);
  });

  it("rejects short passwords and impossible dates", () => {
    expect(parse({ password: "short" }).success).toBe(false);
    expect(parse({ birthDate: "2020-02-30" }).success).toBe(false);
    expect(parse({ birthDate: "2999-01-01" }).success).toBe(false);
  });

  it("is rate limited per IP", async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await registerUser(parse({ email: `rl${i}@example.com`, nickname: `rl${i}` }).data!, ctx("9.9.9.9"));
    }
    expect(last).toMatchObject({ ok: false, errors: { _: "messages.rateLimited" } });
  });
});

describe("email verification", () => {
  it("verifies once, then the token is dead", async () => {
    await registerUser(parse().data!, ctx());
    const token = await lastTokenFor("verify-email");
    expect(await verifyEmailToken(token)).toBe(true);
    expect((await db.user.findFirstOrThrow()).emailVerifiedAt).not.toBeNull();
    expect(await verifyEmailToken(token)).toBe(false);
  });

  it("rejects unknown and expired tokens", async () => {
    expect(await verifyEmailToken("nope-nope-nope-nope")).toBe(false);
    await registerUser(parse().data!, ctx());
    const token = await lastTokenFor("verify-email");
    await db.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await verifyEmailToken(token)).toBe(false);
  });

  it("only one of two concurrent verifications wins", async () => {
    await registerUser(parse().data!, ctx());
    const token = await lastTokenFor("verify-email");
    const results = await Promise.all([verifyEmailToken(token), verifyEmailToken(token), verifyEmailToken(token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("resend invalidates the older token, and is rate limited", async () => {
    const user = await makeUser({ verified: false });
    expect(await resendVerification(user.id, ctx("2.2.2.2"))).toBe("sent");
    const first = await lastTokenFor("verify-email");
    expect(await resendVerification(user.id, ctx("2.2.2.2"))).toBe("sent");
    expect(await verifyEmailToken(first)).toBe(false);
    expect(await resendVerification(user.id, ctx("2.2.2.2"))).toBe("sent");
    expect(await resendVerification(user.id, ctx("2.2.2.2"))).toBe("rateLimited"); // 4th within the hour
  });

  it("tells already-verified users so", async () => {
    const user = await makeUser();
    expect(await resendVerification(user.id, ctx())).toBe("alreadyVerified");
  });
});

describe("login and sessions", () => {
  it("logs in with correct credentials; session stores only a hash of the token", async () => {
    const u = await makeUser({ email: "login@example.test" });
    const r = await loginUser("login@example.test", TEST_PASSWORD, { ip: "3.3.3.3", userAgent: "vitest" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await db.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(sha256Hex(r.token));
    expect(rows[0]!.id).not.toBe(r.token);
    expect((await validateSessionToken(r.token))?.id).toBe(u.id);
    expect(await validateSessionToken("garbage")).toBeNull();
  });

  it("rejects wrong password and unknown email with the same result", async () => {
    await makeUser({ email: "login@example.test" });
    expect(await loginUser("login@example.test", "wrong", {})).toEqual({ ok: false, reason: "invalid" });
    expect(await loginUser("nobody@example.test", "wrong", {})).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects expired sessions", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSessionToken(token)).toBeNull();
  });

  it("locks out after too many attempts for one email", async () => {
    await makeUser({ email: "brute@example.test" });
    for (let i = 0; i < 10; i++) await loginUser("brute@example.test", "wrong", { ip: `10.0.0.${i}` });
    // even the correct password is refused now
    expect(await loginUser("brute@example.test", TEST_PASSWORD, { ip: "10.0.1.1" })).toEqual({ ok: false, reason: "rateLimited" });
  });
});

describe("password reset", () => {
  it("resets the password, revokes all sessions and burns the token", async () => {
    const u = await makeUser({ email: "reset@example.test" });
    await createSession(u.id);
    await createSession(u.id);
    expect(await requestPasswordReset("reset@example.test", ctx("4.4.4.4"))).toEqual({ rateLimited: false });
    const token = await lastTokenFor("reset-password");

    expect(await resetPassword(token, "brand-new-password-1")).toBe(true);
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
    expect(await resetPassword(token, "another-password-22")).toBe(false);

    const fresh = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword(fresh.passwordHash, "brand-new-password-1")).toBe(true);
    expect((await loginUser("reset@example.test", "brand-new-password-1", {})).ok).toBe(true);
  });

  it("silently does nothing for unknown emails (no enumeration)", async () => {
    expect(await requestPasswordReset("ghost@example.test", ctx("5.5.5.5"))).toEqual({ rateLimited: false });
    expect(await db.emailOutbox.count()).toBe(0);
  });

  it("is rate limited per email", async () => {
    await makeUser({ email: "spam@example.test" });
    for (let i = 0; i < 3; i++) await requestPasswordReset("spam@example.test", ctx(`6.6.6.${i}`));
    expect(await requestPasswordReset("spam@example.test", ctx("6.6.6.9"))).toEqual({ rateLimited: true });
    expect(await db.emailOutbox.count()).toBe(3);
  });
});

describe("rateLimit()", () => {
  it("counts atomically under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => rateLimit("k", { limit: 10, windowSeconds: 60 })));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
  });

  it("starts a fresh window later", async () => {
    const now = new Date("2027-01-01T12:00:10Z");
    for (let i = 0; i < 3; i++) await rateLimit("w", { limit: 2, windowSeconds: 60 }, now);
    expect((await rateLimit("w", { limit: 2, windowSeconds: 60 }, now)).ok).toBe(false);
    expect((await rateLimit("w", { limit: 2, windowSeconds: 60 }, new Date("2027-01-01T12:01:05Z"))).ok).toBe(true);
  });
});

describe("passwords", () => {
  it("uses argon2id and verifies", async () => {
    const h = await hashPassword("hunter2-hunter2");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, "hunter2-hunter2")).toBe(true);
    expect(await verifyPassword(h, "nope")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
