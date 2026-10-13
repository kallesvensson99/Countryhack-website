import type { UserTagKind } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import { getOrgSettings } from "../auth/service";
import type { orgSettingsSchema } from "../validation/account";
import type { z } from "zod";

export type TagResult = { ok: true; changed: boolean } | { ok: false; reason: "lastAdmin" | "notFound" | "anonymized" };

/** Add or remove a tag. An admin can't remove the last ADMIN tag (including their own). */
export async function setUserTag(
  actor: Actor,
  targetUserId: string,
  tag: UserTagKind,
  enabled: boolean,
  ip?: string | null,
): Promise<TagResult> {
  assertCan(actor, "userTag:manage");
  return db.$transaction(async (tx) => {
    // Advisory lock so two admins can't both remove "the other" last admin concurrently.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(42001)`;
    const target = await tx.user.findUnique({ where: { id: targetUserId }, include: { tags: true } });
    if (!target) return { ok: false as const, reason: "notFound" as const };
    if (target.anonymizedAt) return { ok: false as const, reason: "anonymized" as const };
    const has = target.tags.some((t) => t.tag === tag);
    if (has === enabled) return { ok: true as const, changed: false };

    if (!enabled && tag === "ADMIN") {
      const admins = await tx.userTag.count({ where: { tag: "ADMIN" } });
      if (admins <= 1) return { ok: false as const, reason: "lastAdmin" as const };
    }
    if (enabled) {
      await tx.userTag.create({ data: { userId: targetUserId, tag, grantedById: actor.id } });
    } else {
      await tx.userTag.deleteMany({ where: { userId: targetUserId, tag } });
    }
    await writeAudit(tx, {
      actorId: actor.id,
      action: enabled ? "user.tag.add" : "user.tag.remove",
      entityType: "User",
      entityId: targetUserId,
      diff: { tag: { from: enabled ? null : tag, to: enabled ? tag : null } },
      ip,
    });
    return { ok: true as const, changed: true };
  });
}

export async function updateOrgSettings(
  actor: Actor,
  input: z.output<typeof orgSettingsSchema>,
  ip?: string | null,
): Promise<void> {
  assertCan(actor, "orgSettings:edit");
  const before = await getOrgSettings();
  await db.$transaction(async (tx) => {
    const after = await tx.orgSettings.update({
      where: { id: before.id },
      data: {
        name: input.name,
        orgNumber: input.orgNumber ?? null,
        address: input.address ?? null,
        contactEmail: input.contactEmail ?? null,
        privacyPolicyVersion: input.privacyPolicyVersion,
      },
    });
    await writeAudit(tx, {
      actorId: actor.id,
      action: "org.settings.update",
      entityType: "OrgSettings",
      entityId: after.id,
      diff: diffObjects(before, after, ["name", "orgNumber", "address", "contactEmail", "privacyPolicyVersion"]),
      ip,
    });
  });
}

export async function listUsers(actor: Actor, opts: { q?: string; page?: number; pageSize?: number }) {
  assertCan(actor, "user:manage");
  const pageSize = opts.pageSize ?? 25;
  const page = Math.max(1, opts.page ?? 1);
  const q = opts.q?.trim();
  const where = q
    ? {
        OR: [
          { email: { contains: q.toLowerCase() } },
          { nickname: { contains: q, mode: "insensitive" as const } },
          { realName: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const [users, total] = await Promise.all([
    db.user.findMany({ where, include: { tags: true }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db.user.count({ where }),
  ]);
  return { users, total, page, pageSize };
}
