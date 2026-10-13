import type { UserTagKind } from "@prisma/client";
import { db } from "../db";
import { generateToken, sha256Hex } from "./tokens";

export const SESSION_COOKIE = "ccss_session";
export const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  realName: string;
  nickname: string;
  locale: string;
  emailVerifiedAt: Date | null;
  anonymizedAt: Date | null;
  tags: UserTagKind[];
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.session.create({
    data: { id: sha256Hex(token), userId, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null },
  });
  return { token, expiresAt };
}

export async function validateSessionToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { id: sha256Hex(token) },
    include: { user: { include: { tags: true } } },
  });
  if (!session) return null;
  if (session.expiresAt <= new Date() || session.user.anonymizedAt) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  const u = session.user;
  return {
    id: u.id,
    email: u.email,
    realName: u.realName,
    nickname: u.nickname,
    locale: u.locale,
    emailVerifiedAt: u.emailVerifiedAt,
    anonymizedAt: u.anonymizedAt,
    tags: u.tags.map((t) => t.tag),
  };
}

export async function deleteSessionByToken(token: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sha256Hex(token) } });
}

export async function deleteAllSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

export async function deleteExpiredSessions(): Promise<number> {
  const r = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return r.count;
}
