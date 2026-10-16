import type { Sponsor, SponsorTier } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import { getStorage, MAX_IMAGE_BYTES, sniffImage } from "../storage";
import type { SponsorInput } from "../validation/crew";

export const TIER_ORDER: SponsorTier[] = ["MAIN", "LARGE", "REGULAR"];

type Fail<R extends string> = { ok: false; reason: R };
const SPONSOR_FIELDS = ["name", "tier", "url", "sortOrder", "isActive", "logoPath"] as const;

const keyOf = (logoPath: string) => logoPath.replace(/^\/uploads\//, "");

/** Sponsors by tier (huvudsponsor first), in their chosen order. `onlyActive` for the public page. */
export async function listSponsors(opts: { onlyActive?: boolean } = {}): Promise<Sponsor[]> {
  const rows = await db.sponsor.findMany({ where: opts.onlyActive ? { isActive: true } : {}, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}

export function groupByTier(sponsors: Sponsor[]) {
  return TIER_ORDER.map((tier) => ({ tier, sponsors: sponsors.filter((s) => s.tier === tier) })).filter((g) => g.sponsors.length > 0);
}

async function storeLogo(data: Buffer): Promise<{ ok: true; path: string } | Fail<"badImage" | "tooLarge">> {
  if (data.length > MAX_IMAGE_BYTES) return { ok: false, reason: "tooLarge" };
  const kind = sniffImage(data);
  if (!kind) return { ok: false, reason: "badImage" };
  return { ok: true, path: `/uploads/${await getStorage().save("sponsors", kind.ext, data)}` };
}

/** A logo is required when a sponsor is created. */
export async function createSponsor(actor: Actor, input: SponsorInput, logo: Buffer, ip?: string | null): Promise<{ ok: true; id: string } | Fail<"badImage" | "tooLarge">> {
  assertCan(actor, "sponsor:manage");
  const stored = await storeLogo(logo);
  if (!stored.ok) return stored;
  const sponsor = await db.$transaction(async (tx) => {
    const created = await tx.sponsor.create({ data: { ...input, logoPath: stored.path } });
    await writeAudit(tx, { actorId: actor.id, action: "sponsor.create", entityType: "Sponsor", entityId: created.id, diff: { name: { from: null, to: created.name }, tier: { from: null, to: created.tier } }, ip });
    return created;
  });
  return { ok: true, id: sponsor.id };
}

/** `logo` replaces the current one when given. */
export async function updateSponsor(actor: Actor, id: string, input: SponsorInput, logo?: Buffer, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "badImage" | "tooLarge">> {
  assertCan(actor, "sponsor:manage");
  const before = await db.sponsor.findUnique({ where: { id } });
  if (!before) return { ok: false, reason: "notFound" };
  let logoPath = before.logoPath;
  if (logo) {
    const stored = await storeLogo(logo);
    if (!stored.ok) return stored;
    logoPath = stored.path;
  }
  await db.$transaction(async (tx) => {
    const after = await tx.sponsor.update({ where: { id }, data: { ...input, logoPath } });
    await writeAudit(tx, { actorId: actor.id, action: "sponsor.update", entityType: "Sponsor", entityId: id, diff: diffObjects(before, after, SPONSOR_FIELDS), ip });
  });
  if (logoPath !== before.logoPath) await getStorage().delete(keyOf(before.logoPath));
  return { ok: true };
}

export async function deleteSponsor(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "sponsor:manage");
  const before = await db.sponsor.findUnique({ where: { id } });
  if (!before) return { ok: false, reason: "notFound" };
  await db.$transaction(async (tx) => {
    await tx.sponsor.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "sponsor.delete", entityType: "Sponsor", entityId: id, diff: { name: { from: before.name, to: null } }, ip });
  });
  await getStorage().delete(keyOf(before.logoPath));
  return { ok: true };
}
