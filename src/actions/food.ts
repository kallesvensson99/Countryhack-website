"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { createMeal, createPackage, deleteMeal, deletePackage, updateMeal, updatePackage } from "@/lib/food/service";
import { createDiscountCode, deleteDiscountCode, updateDiscountCode } from "@/lib/orders/discount-codes";
import { discountCodeSchema, foodPackageSchema, mealSchema } from "@/lib/validation/commerce";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  eventCancelled: "messages.eventCancelled",
  badMeals: "messages.foodBadMeals",
  hasPurchases: "messages.foodHasPurchases",
  variantInUse: "messages.foodVariantInUse",
  quantityBelowSold: "messages.quantityBelowSold",
  duplicate: "messages.codeDuplicate",
  badTicketTypes: "messages.codeBadTicketTypes",
  inUse: "messages.codeInUse",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const id = z.string().min(1).max(60);
const strings = (fd: FormData, name: string) => fd.getAll(name).filter((v): v is string => typeof v === "string");

export async function saveMealAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "foodPackage:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = id.safeParse(raw.eventId);
  const parsed = mealSchema.safeParse(raw);
  if (!eventId.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const r = raw.id ? await updateMeal(actor, raw.id, parsed.data, ip) : await createMeal(actor, eventId.data, parsed.data, ip);
  if (!r.ok) return fail(r.reason, values);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.mealSaved", values: raw.id ? values : undefined };
}

export async function deleteMealAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "foodPackage:manage");
  const mid = id.safeParse(fd.get("id"));
  if (!mid.success) return fail("notFound");
  const r = await deleteMeal(actor, mid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.mealDeleted" };
}

export async function savePackageAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "foodPackage:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = id.safeParse(raw.eventId);
  const parsed = foodPackageSchema.safeParse(raw);
  if (!eventId.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const mealIds = strings(fd, "mealIds");
  const r = raw.id ? await updatePackage(actor, raw.id, parsed.data, mealIds, ip) : await createPackage(actor, eventId.data, parsed.data, mealIds, ip);
  if (!r.ok) return fail(r.reason, values);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.packageSaved", values: raw.id ? values : undefined };
}

export async function deletePackageAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "foodPackage:manage");
  const pid = id.safeParse(fd.get("id"));
  if (!pid.success) return fail("notFound");
  const r = await deletePackage(actor, pid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.packageDeleted" };
}

export async function saveCodeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "discountCode:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = id.safeParse(raw.eventId);
  const parsed = discountCodeSchema.safeParse(raw);
  if (!eventId.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const ticketTypeIds = strings(fd, "ticketTypeIds");
  const r = raw.id ? await updateDiscountCode(actor, raw.id, parsed.data, ticketTypeIds, ip) : await createDiscountCode(actor, eventId.data, parsed.data, ticketTypeIds, ip);
  if (!r.ok) return { ...fail(r.reason, values), errors: r.reason === "duplicate" ? { code: "validation.codeTaken" } : undefined };
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.codeSaved", values: raw.id ? values : undefined };
}

export async function deleteCodeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "discountCode:manage");
  const cid = id.safeParse(fd.get("id"));
  if (!cid.success) return fail("notFound");
  const r = await deleteDiscountCode(actor, cid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.codeDeleted" };
}
