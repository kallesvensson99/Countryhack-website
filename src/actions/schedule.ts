"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { createCategory, createItem, deleteCategory, deleteItem, updateCategory, updateItem } from "@/lib/schedule/service";
import { assertCan } from "@/lib/permissions";
import { scheduleCategorySchema, scheduleItemSchema } from "@/lib/validation/schedule";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  duplicate: "messages.scheduleCategoryDuplicate",
  badCategory: "messages.scheduleBadCategory",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

/** Create (no `id` field) or update a category of the event in `eventId`. */
export async function saveScheduleCategoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "schedule:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = id.safeParse(raw.eventId);
  const parsed = scheduleCategorySchema.safeParse(raw);
  if (!eventId.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const r = raw.id ? await updateCategory(actor, raw.id, parsed.data, ip) : await createCategory(actor, eventId.data, parsed.data, ip);
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.scheduleCategorySaved", values: raw.id ? values : undefined };
}

export async function deleteScheduleCategoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "schedule:manage");
  const cid = id.safeParse(fd.get("id"));
  if (!cid.success) return fail("notFound");
  const r = await deleteCategory(actor, cid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.scheduleCategoryDeleted" };
}

/** Create (no `id` field) or update a block of the event in `eventId`. */
export async function saveScheduleItemAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "schedule:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = id.safeParse(raw.eventId);
  const parsed = scheduleItemSchema.safeParse(raw);
  if (!eventId.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const r = raw.id ? await updateItem(actor, raw.id, parsed.data, ip) : await createItem(actor, eventId.data, parsed.data, ip);
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.scheduleItemSaved", values: raw.id ? values : undefined };
}

export async function deleteScheduleItemAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "schedule:manage");
  const iid = id.safeParse(fd.get("id"));
  if (!iid.success) return fail("notFound");
  const r = await deleteItem(actor, iid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.scheduleItemDeleted" };
}
