import type { ScheduleCategory, ScheduleItem } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import type { ScheduleCategoryInput, ScheduleItemInput } from "../validation/schedule";

type Fail<R extends string> = { ok: false; reason: R };
const CAT_FIELDS = ["name", "nameEn", "color"] as const;
const ITEM_FIELDS = ["title", "titleEn", "description", "descriptionEn", "location", "categoryId", "startsAt", "endsAt"] as const;

export type ScheduleItemWithCategory = ScheduleItem & { category: ScheduleCategory | null };

/** The programme of an event: categories in their order, items by start time. Public data (it follows the event's visibility). */
export async function getSchedule(eventId: string): Promise<{ categories: ScheduleCategory[]; items: ScheduleItemWithCategory[] }> {
  const [categories, items] = await Promise.all([
    db.scheduleCategory.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.scheduleItem.findMany({ where: { eventId }, orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }], include: { category: true } }),
  ]);
  return { categories, items };
}

export function countScheduleItems(eventId: string) {
  return db.scheduleItem.count({ where: { eventId } });
}

/** Name / title / texts in the reader's language; an empty English text falls back to Swedish. */
export const pick = (sv: string, en: string, locale: string) => (locale === "en" && en) || sv;

// ───────────── categories ─────────────

export async function createCategory(actor: Actor, eventId: string, input: ScheduleCategoryInput, ip?: string | null): Promise<{ ok: true; id: string } | Fail<"notFound" | "duplicate">> {
  assertCan(actor, "schedule:manage");
  if (!(await db.event.findUnique({ where: { id: eventId }, select: { id: true } }))) return { ok: false, reason: "notFound" };
  try {
    return await db.$transaction(async (tx) => {
      const last = await tx.scheduleCategory.aggregate({ where: { eventId }, _max: { sortOrder: true } });
      const cat = await tx.scheduleCategory.create({ data: { ...input, eventId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
      await writeAudit(tx, { actorId: actor.id, action: "schedule.category.create", entityType: "ScheduleCategory", entityId: cat.id, eventId, diff: { name: { from: null, to: cat.name }, color: { from: null, to: cat.color } }, ip });
      return { ok: true as const, id: cat.id };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateCategory(actor: Actor, id: string, input: ScheduleCategoryInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "duplicate">> {
  assertCan(actor, "schedule:manage");
  try {
    return await db.$transaction(async (tx) => {
      const before = await tx.scheduleCategory.findUnique({ where: { id } });
      if (!before) return { ok: false as const, reason: "notFound" as const };
      const after = await tx.scheduleCategory.update({ where: { id }, data: input });
      await writeAudit(tx, { actorId: actor.id, action: "schedule.category.update", entityType: "ScheduleCategory", entityId: id, eventId: before.eventId, diff: diffObjects(before, after, CAT_FIELDS), ip });
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "duplicate" };
    throw e;
  }
}

/** Items in the category stay, without a category. */
export async function deleteCategory(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "schedule:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.scheduleCategory.findUnique({ where: { id }, include: { _count: { select: { items: true } } } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    await tx.scheduleCategory.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "schedule.category.delete", entityType: "ScheduleCategory", entityId: id, eventId: before.eventId, diff: { name: { from: before.name, to: null }, items: { from: before._count.items, to: 0 } }, ip });
    return { ok: true as const };
  });
}

// ───────────── items ─────────────

async function categoryBelongs(tx: Prisma.TransactionClient, categoryId: string | null, eventId: string) {
  if (!categoryId) return true;
  return (await tx.scheduleCategory.count({ where: { id: categoryId, eventId } })) > 0;
}

export async function createItem(actor: Actor, eventId: string, input: ScheduleItemInput, ip?: string | null): Promise<{ ok: true; id: string } | Fail<"notFound" | "badCategory">> {
  assertCan(actor, "schedule:manage");
  return db.$transaction(async (tx) => {
    if (!(await tx.event.findUnique({ where: { id: eventId }, select: { id: true } }))) return { ok: false as const, reason: "notFound" as const };
    if (!(await categoryBelongs(tx, input.categoryId, eventId))) return { ok: false as const, reason: "badCategory" as const };
    const item = await tx.scheduleItem.create({ data: { ...input, eventId } });
    await writeAudit(tx, { actorId: actor.id, action: "schedule.item.create", entityType: "ScheduleItem", entityId: item.id, eventId, diff: { title: { from: null, to: item.title }, startsAt: { from: null, to: item.startsAt.toISOString() } }, ip });
    return { ok: true as const, id: item.id };
  });
}

export async function updateItem(actor: Actor, id: string, input: ScheduleItemInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "badCategory">> {
  assertCan(actor, "schedule:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.scheduleItem.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    if (!(await categoryBelongs(tx, input.categoryId, before.eventId))) return { ok: false as const, reason: "badCategory" as const };
    const after = await tx.scheduleItem.update({ where: { id }, data: input });
    await writeAudit(tx, { actorId: actor.id, action: "schedule.item.update", entityType: "ScheduleItem", entityId: id, eventId: before.eventId, diff: diffObjects(before, after, ITEM_FIELDS), ip });
    return { ok: true as const };
  });
}

export async function deleteItem(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "schedule:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.scheduleItem.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    await tx.scheduleItem.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "schedule.item.delete", entityType: "ScheduleItem", entityId: id, eventId: before.eventId, diff: { title: { from: before.title, to: null } }, ip });
    return { ok: true as const };
  });
}
