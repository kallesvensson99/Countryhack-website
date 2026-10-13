import { Prisma, type EventStatus } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import { copyChart } from "../seating/copy";
import { getStorage, MAX_IMAGE_BYTES, sniffImage } from "../storage";
import type { EventInput } from "../validation/events";

type Tx = Prisma.TransactionClient;

export const STATUS_FLOW: Record<EventStatus, EventStatus[]> = {
  DRAFT: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["CLOSED", "CANCELLED"],
  CLOSED: ["CANCELLED"],
  CANCELLED: [],
};

const AUDITED_FIELDS = [
  "name", "description", "venueName", "address", "startsAt", "endsAt", "registrationOpensAt",
  "registrationClosesAt", "minAge", "seatChangeDeadline", "showNicknamesOnMap", "status", "imagePath",
] as const;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "event";
}

/** "name", "name-2", "name-3" … first free slug. */
async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set((await tx.event.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((e) => e.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export type EventResult<T = { id: string }> = { ok: true; value: T } | { ok: false; reason: "notFound" | "cancelled" | "badTransition" | "badImage" | "tooLarge" };

export async function createEvent(actor: Actor, input: EventInput, opts: { templateId?: string; ip?: string | null } = {}) {
  assertCan(actor, "event:manage");
  // Retry on the (rare) slug race with a concurrent create.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const event = await tx.event.create({
          data: { ...input, seatChangeDeadline: input.seatChangeDeadline ?? null, slug: await uniqueSlug(tx, input.name), createdById: actor.id },
        });
        if (opts.templateId) {
          const tpl = await tx.seatingChart.findFirst({ where: { id: opts.templateId, isTemplate: true } });
          if (tpl) await copyChart(tx, tpl.id, { name: tpl.name, eventId: event.id, isTemplate: false });
        }
        await writeAudit(tx, { actorId: actor.id, action: "event.create", entityType: "Event", entityId: event.id, eventId: event.id, diff: { name: event.name, slug: event.slug, fromTemplate: opts.templateId ?? null }, ip: opts.ip });
        return event;
      });
    } catch (e) {
      if (attempt < 3 && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
}

export async function updateEvent(actor: Actor, eventId: string, input: EventInput, ip?: string | null): Promise<EventResult> {
  assertCan(actor, "event:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.event.findUnique({ where: { id: eventId } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    if (before.status === "CANCELLED") return { ok: false as const, reason: "cancelled" as const };
    const after = await tx.event.update({ where: { id: eventId }, data: { ...input, seatChangeDeadline: input.seatChangeDeadline ?? null } });
    const diff = diffObjects(before, after, AUDITED_FIELDS);
    if (Object.keys(diff).length) {
      await writeAudit(tx, { actorId: actor.id, action: "event.update", entityType: "Event", entityId: eventId, eventId, diff, ip });
    }
    return { ok: true as const, value: { id: eventId } };
  });
}

export async function setEventStatus(actor: Actor, eventId: string, to: EventStatus, ip?: string | null): Promise<EventResult<{ status: EventStatus }>> {
  assertCan(actor, "event:manage");
  return db.$transaction(async (tx) => {
    // Lock the row so two concurrent transitions can't both pass the check.
    await tx.$queryRaw`SELECT 1 FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
    const ev = await tx.event.findUnique({ where: { id: eventId } });
    if (!ev) return { ok: false as const, reason: "notFound" as const };
    if (!STATUS_FLOW[ev.status].includes(to)) return { ok: false as const, reason: "badTransition" as const };
    await tx.event.update({ where: { id: eventId }, data: { status: to } });
    await writeAudit(tx, { actorId: actor.id, action: "event.status", entityType: "Event", entityId: eventId, eventId, diff: { status: { from: ev.status, to } }, ip });
    return { ok: true as const, value: { status: to } };
  });
}

/**
 * Copies an event as a new DRAFT: chart (zones/seats/objects), ticket types (+zone links),
 * meals, food packages and variants. Never copies orders, tickets, seat claims or discount usage.
 */
export async function duplicateEvent(actor: Actor, eventId: string, ip?: string | null): Promise<EventResult<{ id: string; slug: string }>> {
  assertCan(actor, "event:manage");
  return db.$transaction(async (tx) => {
    const src = await tx.event.findUnique({
      where: { id: eventId },
      include: {
        chart: true,
        ticketTypes: { include: { zones: true } },
        meals: true,
        foodPackages: { include: { meals: true, variants: true } },
      },
    });
    if (!src) return { ok: false as const, reason: "notFound" as const };

    const copy = await tx.event.create({
      data: {
        slug: await uniqueSlug(tx, `${src.name} kopia`),
        name: `${src.name} (kopia)`,
        description: src.description,
        imagePath: src.imagePath,
        venueName: src.venueName,
        address: src.address,
        startsAt: src.startsAt,
        endsAt: src.endsAt,
        registrationOpensAt: src.registrationOpensAt,
        registrationClosesAt: src.registrationClosesAt,
        minAge: src.minAge,
        seatChangeDeadline: src.seatChangeDeadline,
        showNicknamesOnMap: src.showNicknamesOnMap,
        status: "DRAFT",
        createdById: actor.id,
      },
    });

    let zoneMap = new Map<string, string>();
    if (src.chart) zoneMap = (await copyChart(tx, src.chart.id, { name: src.chart.name, eventId: copy.id, isTemplate: false })).zoneMap;

    for (const tt of src.ticketTypes) {
      await tx.ticketType.create({
        data: {
          eventId: copy.id, name: tt.name, description: tt.description, priceOre: tt.priceOre, quantity: tt.quantity,
          salesStartsAt: tt.salesStartsAt, salesEndsAt: tt.salesEndsAt, includesSeat: tt.includesSeat,
          requiresDiscountCode: tt.requiresDiscountCode, hidden: tt.hidden, sortOrder: tt.sortOrder,
          zones: { create: tt.zones.filter((z) => zoneMap.has(z.zoneId)).map((z) => ({ zoneId: zoneMap.get(z.zoneId)! })) },
        },
      });
    }

    const mealMap = new Map<string, string>();
    for (const m of src.meals) {
      mealMap.set(m.id, (await tx.meal.create({ data: { eventId: copy.id, name: m.name, servedAt: m.servedAt } })).id);
    }
    for (const p of src.foodPackages) {
      await tx.foodPackage.create({
        data: {
          eventId: copy.id, name: p.name, description: p.description, priceOre: p.priceOre, quantity: p.quantity,
          salesEndsAt: p.salesEndsAt, sortOrder: p.sortOrder,
          meals: { create: p.meals.map((m) => ({ mealId: mealMap.get(m.mealId)! })) },
          variants: { create: p.variants.map((v) => ({ name: v.name, sortOrder: v.sortOrder })) },
        },
      });
    }

    await writeAudit(tx, { actorId: actor.id, action: "event.duplicate", entityType: "Event", entityId: copy.id, eventId: copy.id, diff: { copiedFrom: src.id }, ip });
    return { ok: true as const, value: { id: copy.id, slug: copy.slug } };
  });
}

/** Does any *other* event still reference this image file? (Duplicates share the file.) */
async function imageStillUsed(path: string, exceptEventId: string): Promise<boolean> {
  return (await db.event.count({ where: { imagePath: path, id: { not: exceptEventId } } })) > 0;
}

export const imageUrl = (key: string) => `/uploads/${key}`;

export async function setEventImage(actor: Actor, eventId: string, data: Buffer, ip?: string | null): Promise<EventResult<{ imagePath: string }>> {
  assertCan(actor, "event:manage");
  if (data.length > MAX_IMAGE_BYTES) return { ok: false, reason: "tooLarge" };
  const kind = sniffImage(data);
  if (!kind) return { ok: false, reason: "badImage" };
  const ev = await db.event.findUnique({ where: { id: eventId } });
  if (!ev) return { ok: false, reason: "notFound" };
  if (ev.status === "CANCELLED") return { ok: false, reason: "cancelled" };

  const key = await getStorage().save("events", kind.ext, data);
  const imagePath = imageUrl(key);
  await db.$transaction(async (tx) => {
    await tx.event.update({ where: { id: eventId }, data: { imagePath } });
    await writeAudit(tx, { actorId: actor.id, action: "event.image", entityType: "Event", entityId: eventId, eventId, diff: { imagePath: { from: ev.imagePath, to: imagePath } }, ip });
  });
  if (ev.imagePath && !(await imageStillUsed(ev.imagePath, eventId))) await getStorage().delete(ev.imagePath.replace(/^\/uploads\//, ""));
  return { ok: true, value: { imagePath } };
}

export async function removeEventImage(actor: Actor, eventId: string, ip?: string | null): Promise<EventResult> {
  assertCan(actor, "event:manage");
  const ev = await db.event.findUnique({ where: { id: eventId } });
  if (!ev) return { ok: false, reason: "notFound" };
  if (!ev.imagePath) return { ok: true, value: { id: eventId } };
  await db.$transaction(async (tx) => {
    await tx.event.update({ where: { id: eventId }, data: { imagePath: null } });
    await writeAudit(tx, { actorId: actor.id, action: "event.image", entityType: "Event", entityId: eventId, eventId, diff: { imagePath: { from: ev.imagePath, to: null } }, ip });
  });
  if (!(await imageStillUsed(ev.imagePath, eventId))) await getStorage().delete(ev.imagePath.replace(/^\/uploads\//, ""));
  return { ok: true, value: { id: eventId } };
}
