import { randomBytes } from "node:crypto";
import { db } from "../db";
import { writeAudit } from "../audit";
import { verifyPassword } from "../auth/password";

/** Everything we store about a user, as a plain JSON-serialisable object (GDPR art. 15/20). */
export async function exportUserData(userId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      tags: true,
      consents: true,
      sessions: { select: { createdAt: true, expiresAt: true, userAgent: true, ip: true } },
      tickets: {
        include: {
          ticketType: { select: { name: true } },
          event: { select: { name: true, startsAt: true } },
          seatClaim: { include: { seat: { select: { label: true } } } },
          foodPurchases: { include: { package: { select: { name: true } }, variant: { select: { name: true } } } },
        },
      },
      orders: { include: { items: true, payments: { select: { provider: true, kind: true, amountOre: true, status: true, createdAt: true } } } },
      reservedSeats: { select: { label: true } },
      crewApplications: { include: { job: { select: { title: true } } } },
    },
  });
  const { passwordHash: _passwordHash, ...profile } = user;
  void _passwordHash;
  return {
    exportedAt: new Date().toISOString(),
    note: "Data stored about you by Cable connectors spelsällskap (CCSS). Password hash is intentionally excluded.",
    ...profile,
  };
}

export type AnonymizeResult = { ok: true } | { ok: false; reason: "wrongPassword" | "lastAdmin" | "activeTickets" | "alreadyAnonymized" };

/**
 * GDPR deletion = anonymization. Bookkeeping law requires keeping orders and payments for
 * 7 years, so those stay, attached to a placeholder user with all personal data scrubbed.
 */
export async function anonymizeUser(
  userId: string,
  opts: { password: string; ip?: string | null },
): Promise<AnonymizeResult> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { tags: true } });
  if (user.anonymizedAt) return { ok: false, reason: "alreadyAnonymized" };
  if (!(await verifyPassword(user.passwordHash, opts.password))) return { ok: false, reason: "wrongPassword" };

  return db.$transaction(async (tx) => {
    // Serialize concurrent admin-affecting changes (also used by tag management).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(42001)`;

    if (user.tags.some((t) => t.tag === "ADMIN")) {
      const admins = await tx.userTag.count({ where: { tag: "ADMIN" } });
      if (admins <= 1) return { ok: false as const, reason: "lastAdmin" as const };
    }
    // Refunds are done by Festivalledare, so a member with a live ticket must ask them first.
    const live = await tx.ticket.count({
      where: { userId, status: { not: "CANCELLED" }, event: { status: { in: ["DRAFT", "PUBLISHED"] }, endsAt: { gt: new Date() } } },
    });
    if (live > 0) return { ok: false as const, reason: "activeTickets" as const };

    const placeholder = `anonymized-${userId}`;
    await tx.user.update({
      where: { id: userId },
      data: {
        realName: "Anonymiserad användare",
        nickname: `anon-${userId.slice(-8)}`,
        email: `${placeholder}@anonymized.invalid`,
        passwordHash: `!${randomBytes(16).toString("hex")}`, // not a valid argon2 hash: login impossible
        phone: "",
        birthDate: new Date("1900-01-01T00:00:00.000Z"),
        allergies: null,
        dietaryPreferences: null,
        guardianName: null,
        guardianPhone: null,
        emailVerifiedAt: null,
        anonymizedAt: new Date(),
      },
    });
    await tx.session.deleteMany({ where: { userId } });
    await tx.authToken.deleteMany({ where: { userId } });
    await tx.userTag.deleteMany({ where: { userId } });
    await tx.crewApplication.deleteMany({ where: { userId } }); // free-text motivation is personal data
    await tx.consent.updateMany({ where: { userId }, data: { ip: null } });
    await tx.seat.updateMany({ where: { reservedForUserId: userId }, data: { reservedForUserId: null } });
    await tx.foodPurchase.updateMany({ where: { ticket: { userId } }, data: { allergiesSnapshot: null } });
    await tx.emailOutbox.deleteMany({ where: { to: user.email } });
    await writeAudit(tx, {
      actorId: userId,
      action: "user.anonymize",
      entityType: "User",
      entityId: userId,
      diff: { anonymized: true }, // deliberately no personal data in the audit log
      ip: opts.ip,
    });
    return { ok: true as const };
  });
}
