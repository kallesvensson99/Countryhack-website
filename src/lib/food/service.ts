import { db } from "../db";
import { writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import type { FoodPackageInput, MealInput } from "../validation/commerce";

export type FoodError = "notFound" | "eventCancelled" | "badMeals" | "hasPurchases" | "variantInUse" | "quantityBelowSold";
export type FoodResult<T = { id: string }> = { ok: true; value: T } | { ok: false; reason: FoodError };

const fail = (reason: FoodError): { ok: false; reason: FoodError } => ({ ok: false, reason });

async function openEvent(eventId: string) {
  const ev = await db.event.findUnique({ where: { id: eventId } });
  if (!ev) return fail("notFound");
  if (ev.status === "CANCELLED") return fail("eventCancelled");
  return { ok: true as const, ev };
}

// ───────────── meals ─────────────

export async function createMeal(actor: Actor, eventId: string, input: MealInput, ip?: string | null): Promise<FoodResult> {
  assertCan(actor, "foodPackage:manage");
  const ev = await openEvent(eventId);
  if (!ev.ok) return ev;
  return db.$transaction(async (tx) => {
    const m = await tx.meal.create({ data: { eventId, name: input.name, servedAt: input.servedAt } });
    await writeAudit(tx, { actorId: actor.id, action: "meal.create", entityType: "Meal", entityId: m.id, eventId, diff: { name: m.name, servedAt: m.servedAt.toISOString() }, ip });
    return { ok: true as const, value: { id: m.id } };
  });
}

export async function updateMeal(actor: Actor, mealId: string, input: MealInput, ip?: string | null): Promise<FoodResult> {
  assertCan(actor, "foodPackage:manage");
  const before = await db.meal.findUnique({ where: { id: mealId } });
  if (!before) return fail("notFound");
  const ev = await openEvent(before.eventId);
  if (!ev.ok) return ev;
  await db.$transaction(async (tx) => {
    await tx.meal.update({ where: { id: mealId }, data: { name: input.name, servedAt: input.servedAt } });
    await writeAudit(tx, { actorId: actor.id, action: "meal.update", entityType: "Meal", entityId: mealId, eventId: before.eventId, diff: { name: { from: before.name, to: input.name }, servedAt: { from: before.servedAt.toISOString(), to: input.servedAt.toISOString() } }, ip });
  });
  return { ok: true, value: { id: mealId } };
}

export async function deleteMeal(actor: Actor, mealId: string, ip?: string | null): Promise<FoodResult> {
  assertCan(actor, "foodPackage:manage");
  const meal = await db.meal.findUnique({ where: { id: mealId } });
  if (!meal) return fail("notFound");
  const used = await db.foodPurchase.count({ where: { package: { meals: { some: { mealId } } } } });
  if (used > 0) return fail("hasPurchases");
  await db.$transaction(async (tx) => {
    await tx.meal.delete({ where: { id: mealId } });
    await writeAudit(tx, { actorId: actor.id, action: "meal.delete", entityType: "Meal", entityId: mealId, eventId: meal.eventId, diff: { name: meal.name }, ip });
  });
  return { ok: true, value: { id: mealId } };
}

// ───────────── packages ─────────────

async function mealsBelong(eventId: string, mealIds: string[]): Promise<boolean> {
  if (mealIds.length === 0) return true;
  return (await db.meal.count({ where: { id: { in: mealIds }, eventId } })) === new Set(mealIds).size;
}

export async function createPackage(actor: Actor, eventId: string, input: FoodPackageInput, mealIds: string[], ip?: string | null): Promise<FoodResult> {
  assertCan(actor, "foodPackage:manage");
  const ev = await openEvent(eventId);
  if (!ev.ok) return ev;
  if (!(await mealsBelong(eventId, mealIds))) return fail("badMeals");
  return db.$transaction(async (tx) => {
    const p = await tx.foodPackage.create({
      data: {
        eventId, name: input.name, description: input.description, priceOre: input.price, quantity: input.quantity ?? null, salesEndsAt: input.salesEndsAt, sortOrder: input.sortOrder,
        meals: { create: [...new Set(mealIds)].map((mealId) => ({ mealId })) },
        variants: { create: input.variants.map((name, i) => ({ name, sortOrder: i })) },
      },
    });
    await writeAudit(tx, { actorId: actor.id, action: "foodPackage.create", entityType: "FoodPackage", entityId: p.id, eventId, diff: { name: p.name, priceOre: p.priceOre, variants: input.variants }, ip });
    return { ok: true as const, value: { id: p.id } };
  });
}

export async function updatePackage(actor: Actor, packageId: string, input: FoodPackageInput, mealIds: string[], ip?: string | null): Promise<FoodResult> {
  assertCan(actor, "foodPackage:manage");
  const before = await db.foodPackage.findUnique({ where: { id: packageId }, include: { variants: true, meals: true } });
  if (!before) return fail("notFound");
  const ev = await openEvent(before.eventId);
  if (!ev.ok) return ev;
  if (!(await mealsBelong(before.eventId, mealIds))) return fail("badMeals");

  const purchases = await db.foodPurchase.groupBy({ by: ["variantId"], where: { packageId, status: { not: "CANCELLED" } }, _count: { _all: true } });
  const sold = purchases.reduce((s, p) => s + p._count._all, 0);
  if (input.quantity !== undefined && input.quantity < sold) return fail("quantityBelowSold");
  const everUsed = new Set((await db.foodPurchase.findMany({ where: { packageId }, select: { variantId: true }, distinct: ["variantId"] })).map((p) => p.variantId));

  // Variants are matched by name (case-insensitive): keep, rename-free add, remove only when never purchased.
  const wanted = new Map(input.variants.map((n, i) => [n.toLowerCase(), { name: n, sortOrder: i }]));
  const existing = new Map(before.variants.map((v) => [v.name.toLowerCase(), v]));
  const removed = before.variants.filter((v) => !wanted.has(v.name.toLowerCase()));
  if (removed.some((v) => everUsed.has(v.id))) return fail("variantInUse");

  return db.$transaction(async (tx) => {
    await tx.foodPackage.update({ where: { id: packageId }, data: { name: input.name, description: input.description, priceOre: input.price, quantity: input.quantity ?? null, salesEndsAt: input.salesEndsAt, sortOrder: input.sortOrder } });
    if (removed.length) await tx.foodVariant.deleteMany({ where: { id: { in: removed.map((v) => v.id) } } });
    for (const [key, w] of wanted) {
      const cur = existing.get(key);
      if (cur) {
        if (cur.name !== w.name || cur.sortOrder !== w.sortOrder) await tx.foodVariant.update({ where: { id: cur.id }, data: { name: w.name, sortOrder: w.sortOrder } });
      } else await tx.foodVariant.create({ data: { packageId, name: w.name, sortOrder: w.sortOrder } });
    }
    await tx.foodPackageMeal.deleteMany({ where: { packageId } });
    await tx.foodPackageMeal.createMany({ data: [...new Set(mealIds)].map((mealId) => ({ packageId, mealId })) });
    await writeAudit(tx, {
      actorId: actor.id, action: "foodPackage.update", entityType: "FoodPackage", entityId: packageId, eventId: before.eventId,
      diff: { name: { from: before.name, to: input.name }, priceOre: { from: before.priceOre, to: input.price }, quantity: { from: before.quantity, to: input.quantity ?? null }, variants: input.variants, meals: mealIds.length }, ip,
    });
    return { ok: true as const, value: { id: packageId } };
  });
}

export async function deletePackage(actor: Actor, packageId: string, ip?: string | null): Promise<FoodResult> {
  assertCan(actor, "foodPackage:manage");
  const p = await db.foodPackage.findUnique({ where: { id: packageId } });
  if (!p) return fail("notFound");
  if ((await db.foodPurchase.count({ where: { packageId } })) + (await db.orderItem.count({ where: { foodPackageId: packageId } })) > 0) return fail("hasPurchases");
  await db.$transaction(async (tx) => {
    await tx.foodPackage.delete({ where: { id: packageId } });
    await writeAudit(tx, { actorId: actor.id, action: "foodPackage.delete", entityType: "FoodPackage", entityId: packageId, eventId: p.eventId, diff: { name: p.name }, ip });
  });
  return { ok: true, value: { id: packageId } };
}

/** Packages as shown to buyers: with meals, variants and what's left. */
export async function listPackagesForSale(eventId: string, now = new Date()) {
  const packages = await db.foodPackage.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }],
    include: { variants: { orderBy: { sortOrder: "asc" } }, meals: { include: { meal: true } } },
  });
  const sold = await db.foodPurchase.groupBy({ by: ["packageId"], where: { package: { eventId }, status: { not: "CANCELLED" } }, _count: { _all: true } });
  const soldBy = new Map(sold.map((s) => [s.packageId, s._count._all]));
  return packages.map((p) => {
    const taken = soldBy.get(p.id) ?? 0;
    const left = p.quantity === null ? null : Math.max(0, p.quantity - taken);
    const state = now >= p.salesEndsAt ? "ended" : left === 0 ? "soldOut" : "open";
    return { ...p, meals: p.meals.map((m) => m.meal).sort((a, b) => a.servedAt.getTime() - b.servedAt.getTime()), left, state } as const;
  });
}
