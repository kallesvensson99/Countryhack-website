"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { createEvent, duplicateEvent, removeEventImage, setEventImage, setEventStatus, updateEvent } from "@/lib/events/service";
import { createTicketType, deleteTicketType, updateTicketType } from "@/lib/events/ticket-types";
import { createEventSchema, eventSchema, ticketTypeSchema } from "@/lib/validation/events";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  cancelled: "messages.eventCancelled",
  eventCancelled: "messages.eventCancelled",
  badTransition: "messages.badTransition",
  badImage: "messages.badImage",
  tooLarge: "messages.imageTooLarge",
  badZones: "messages.badZones",
  hasSales: "messages.ticketHasSales",
  quantityBelowSold: "messages.quantityBelowSold",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });

const idSchema = z.string().min(1).max(60);

export async function createEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "event:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = createEventSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { templateId, ...input } = parsed.data;
  const event = await createEvent(actor, input, { templateId: templateId || undefined, ip: await getClientIp() });
  redirect({ href: `/manage/events/${event.id}`, locale: await getLocale() });
  return {};
}

export async function updateEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "event:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const id = idSchema.safeParse(raw.id);
  const parsed = eventSchema.safeParse(raw);
  if (!id.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const r = await updateEvent(actor, id.data, parsed.data, await getClientIp());
  if (!r.ok) return fail(r.reason, values);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.eventSaved", values };
}

export async function setStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "event:manage");
  const p = z.object({ id: idSchema, status: z.enum(["PUBLISHED", "CLOSED", "CANCELLED"]) }).safeParse(formToObject(fd));
  if (!p.success) return fail("invalid");
  const r = await setEventStatus(actor, p.data.id, p.data.status, await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.statusChanged" };
}

export async function duplicateEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "event:manage");
  const id = idSchema.safeParse(fd.get("id"));
  if (!id.success) return fail("notFound");
  const r = await duplicateEvent(actor, id.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  redirect({ href: `/manage/events/${r.value.id}`, locale: await getLocale() });
  return {};
}

export async function uploadImageAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "event:manage");
  const id = idSchema.safeParse(fd.get("id"));
  const file = fd.get("image");
  if (!id.success) return fail("notFound");
  if (!(file instanceof File) || file.size === 0) return fail("badImage");
  const r = await setEventImage(actor, id.data, Buffer.from(await file.arrayBuffer()), await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.imageSaved" };
}

export async function removeImageAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "event:manage");
  const id = idSchema.safeParse(fd.get("id"));
  if (!id.success) return fail("notFound");
  const r = await removeEventImage(actor, id.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.imageRemoved" };
}

// ───────── Ticket types ─────────

export async function saveTicketTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "ticketType:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = idSchema.safeParse(raw.eventId);
  const parsed = ticketTypeSchema.safeParse(raw);
  if (!eventId.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const zoneIds = fd.getAll("zoneIds").filter((z): z is string => typeof z === "string");
  const ip = await getClientIp();
  const id = raw.id;
  const r = id ? await updateTicketType(actor, id, parsed.data, zoneIds, ip) : await createTicketType(actor, eventId.data, parsed.data, zoneIds, ip);
  if (!r.ok) return fail(r.reason, values);
  revalidatePath("/", "layout");
  // A newly created type resets the "new" form; an edited one keeps what was typed.
  return { ok: true, message: "messages.ticketSaved", values: id ? values : undefined };
}

export async function deleteTicketTypeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "ticketType:manage");
  const id = idSchema.safeParse(fd.get("id"));
  if (!id.success) return fail("notFound");
  const r = await deleteTicketType(actor, id.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.ticketDeleted" };
}
