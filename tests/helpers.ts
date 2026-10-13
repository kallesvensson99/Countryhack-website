import type { UserTagKind } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

let counter = 0;

/** Wipe all data (keeps the schema and the order-number sequence). */
export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await db.orgSettings.create({ data: {} });
}

export const TEST_PASSWORD = "correct-horse-battery";
let cachedHash: string | undefined;

export async function makeUser(opts: { tags?: UserTagKind[]; verified?: boolean; birthDate?: string; email?: string; nickname?: string } = {}) {
  const n = ++counter;
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  return db.user.create({
    data: {
      email: opts.email ?? `user${n}@example.test`,
      passwordHash: cachedHash,
      realName: `Test User ${n}`,
      nickname: opts.nickname ?? `tester${n}`,
      birthDate: new Date(`${opts.birthDate ?? "1995-06-15"}T00:00:00.000Z`),
      phone: "+46 70 000 00 00",
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      tags: { create: (opts.tags ?? []).map((tag) => ({ tag })) },
    },
    include: { tags: true },
  });
}

export function asActor(u: { id: string; emailVerifiedAt: Date | null; tags: { tag: UserTagKind }[] }) {
  return { id: u.id, emailVerifiedAt: u.emailVerifiedAt, tags: u.tags.map((t) => t.tag) };
}

/** Build a minimal event so ticket / order rows can be inserted. */
export async function makeEvent(creatorId: string, startsAt = new Date("2027-03-12T16:00:00Z")) {
  const n = ++counter;
  return db.event.create({
    data: {
      slug: `event-${n}`,
      name: `Event ${n}`,
      description: "test",
      venueName: "Hall",
      address: "Street 1",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 48 * 3600_000),
      registrationOpensAt: new Date("2026-01-01T00:00:00Z"),
      registrationClosesAt: startsAt,
      status: "PUBLISHED",
      createdById: creatorId,
    },
  });
}
