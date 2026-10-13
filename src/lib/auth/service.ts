import { Prisma, type AuthTokenType } from "@prisma/client";
import type { z } from "zod";
import { env } from "../env";
import { db } from "../db";
import { enqueueEmail } from "../email/outbox";
import type { registerSchema } from "../validation/account";
import { hashPassword, verifyDummy, verifyPassword } from "./password";
import { LIMITS, rateLimit } from "./rate-limit";
import { createSession, deleteAllSessions } from "./sessions";
import { generateToken, sha256Hex } from "./tokens";

/**
 * Framework-free account logic. Server Actions are thin wrappers around this
 * so it can be tested directly against the database.
 */

export type RegisterInput = z.output<typeof registerSchema>;

interface Ctx {
  ip?: string | null;
  locale: string;
}

const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;

export function appUrl(locale: string, path: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}/${locale}${path}`;
}

async function issueToken(
  tx: Prisma.TransactionClient,
  userId: string,
  type: AuthTokenType,
  ttlMs: number,
): Promise<string> {
  // Only one live token per type: invalidate older ones.
  await tx.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  const token = generateToken();
  await tx.authToken.create({ data: { userId, type, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

async function consumeToken(type: AuthTokenType, token: string) {
  const row = await db.authToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date()) return null;
  // Atomic single-use: only one concurrent caller flips usedAt.
  const claimed = await db.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  return claimed.count === 1 ? row : null;
}

export type RegisterResult = { ok: true; userId: string } | { ok: false; errors: Record<string, string> };

export async function registerUser(input: RegisterInput, ctx: Ctx): Promise<RegisterResult> {
  const rl = await rateLimit(`register:ip:${ctx.ip ?? "unknown"}`, LIMITS.registerIp);
  if (!rl.ok) return { ok: false, errors: { _: "messages.rateLimited" } };

  const [emailTaken, nickTaken] = await Promise.all([
    db.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE lower("nickname") = lower(${input.nickname}) LIMIT 1`,
  ]);
  const errors: Record<string, string> = {};
  if (emailTaken) errors.email = "validation.emailTaken";
  if (nickTaken.length > 0) errors.nickname = "validation.nicknameTaken";
  if (Object.keys(errors).length) return { ok: false, errors };

  const passwordHash = await hashPassword(input.password);
  const settings = await getOrgSettings();

  try {
    const userId = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          realName: input.realName,
          nickname: input.nickname,
          birthDate: input.birthDate,
          phone: input.phone,
          allergies: input.allergies,
          dietaryPreferences: input.dietaryPreferences,
          guardianName: input.guardianName,
          guardianPhone: input.guardianPhone,
          locale: input.locale,
        },
      });
      await tx.consent.create({
        data: { userId: user.id, kind: "PRIVACY_POLICY", version: settings.privacyPolicyVersion, ip: ctx.ip ?? null },
      });
      const token = await issueToken(tx, user.id, "VERIFY_EMAIL", VERIFY_TTL_MS);
      await enqueueEmail(tx, {
        to: user.email,
        template: "verify-email",
        locale: user.locale,
        payload: { name: user.realName, url: appUrl(user.locale, `/verify?token=${token}`) },
      });
      return user.id;
    });
    return { ok: true, userId };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Lost a race with a concurrent registration.
      return { ok: false, errors: JSON.stringify(e.meta).toLowerCase().includes("nickname") ? { nickname: "validation.nicknameTaken" } : { email: "validation.emailTaken" } };
    }
    throw e;
  }
}

export async function verifyEmailToken(token: string): Promise<boolean> {
  const row = await consumeToken("VERIFY_EMAIL", token);
  if (!row) return false;
  await db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  return true;
}

export type ResendResult = "sent" | "alreadyVerified" | "rateLimited";

export async function resendVerification(userId: string, ctx: Ctx): Promise<ResendResult> {
  const [u, i] = await Promise.all([
    rateLimit(`verify-resend:user:${userId}`, LIMITS.verifyResendUser),
    rateLimit(`verify-resend:ip:${ctx.ip ?? "unknown"}`, LIMITS.verifyResendIp),
  ]);
  if (!u.ok || !i.ok) return "rateLimited";
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) return "alreadyVerified";
  await db.$transaction(async (tx) => {
    const token = await issueToken(tx, user.id, "VERIFY_EMAIL", VERIFY_TTL_MS);
    await enqueueEmail(tx, {
      to: user.email,
      template: "verify-email",
      locale: user.locale,
      payload: { name: user.realName, url: appUrl(user.locale, `/verify?token=${token}`) },
    });
  });
  return "sent";
}

export type LoginResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid" | "rateLimited" };

export async function loginUser(
  email: string,
  password: string,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`login:ip:${ctx.ip ?? "unknown"}`, LIMITS.loginIp),
    rateLimit(`login:email:${email}`, LIMITS.loginEmail),
  ]);
  if (!byIp.ok || !byEmail.ok) return { ok: false, reason: "rateLimited" };

  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.anonymizedAt) {
    await verifyDummy(password);
    return { ok: false, reason: "invalid" };
  }
  if (!(await verifyPassword(user.passwordHash, password))) return { ok: false, reason: "invalid" };
  const session = await createSession(user.id, ctx);
  return { ok: true, userId: user.id, ...session };
}

/** Always succeeds from the caller's point of view, so it can't be used to probe for accounts. */
export async function requestPasswordReset(email: string, ctx: Ctx): Promise<{ rateLimited: boolean }> {
  const [byIp, byEmail] = await Promise.all([
    rateLimit(`reset:ip:${ctx.ip ?? "unknown"}`, LIMITS.resetIp),
    rateLimit(`reset:email:${email}`, LIMITS.resetEmail),
  ]);
  if (!byIp.ok || !byEmail.ok) return { rateLimited: true };

  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.anonymizedAt) {
    await db.$transaction(async (tx) => {
      const token = await issueToken(tx, user.id, "RESET_PASSWORD", RESET_TTL_MS);
      await enqueueEmail(tx, {
        to: user.email,
        template: "reset-password",
        locale: user.locale,
        payload: { name: user.realName, url: appUrl(user.locale, `/reset-password?token=${token}`) },
      });
    });
  }
  return { rateLimited: false };
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const row = await consumeToken("RESET_PASSWORD", token);
  if (!row) return false;
  const passwordHash = await hashPassword(newPassword);
  await db.user.update({ where: { id: row.userId }, data: { passwordHash } });
  await deleteAllSessions(row.userId); // log out everywhere
  return true;
}

export async function getOrgSettings() {
  const existing = await db.orgSettings.findFirst();
  return existing ?? (await db.orgSettings.create({ data: {} }));
}
