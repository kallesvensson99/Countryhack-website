"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { broadcastSchema, sendBroadcast } from "@/lib/broadcast/service";
import { checkIn, collectMeal, getCard, lookupByToken, searchAttendees, uncollectMeal, undoCheckIn, type AttendeeCard, type SearchHit } from "@/lib/checkin/service";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);

export type CardResponse = { ok: true; card: AttendeeCard; notice?: "alreadyCheckedIn" } | { ok: false; error: string };

const ERR: Record<string, string> = {
  invalidCode: "checkin.err_invalidCode",
  notFound: "checkin.err_notFound",
  wrongEvent: "checkin.err_wrongEvent",
  notActive: "checkin.err_notActive",
  eventNotOpen: "checkin.err_eventNotOpen",
  wrongMeal: "checkin.err_wrongMeal",
  alreadyCollected: "checkin.err_alreadyCollected",
};
const bad = (reason: string): CardResponse => ({ ok: false, error: ERR[reason] ?? "messages.invalidInput" });

async function actor() {
  const a = await getCurrentUser();
  assertCan(a, "checkin:perform");
  return a;
}

export async function scanAction(eventId: string, token: string): Promise<CardResponse> {
  const a = await actor();
  if (!id.safeParse(eventId).success || typeof token !== "string" || token.length > 300) return bad("invalidCode");
  const r = await lookupByToken(a, eventId, token);
  return r.ok ? { ok: true, card: r.card } : bad(r.reason);
}

export async function searchAction(eventId: string, q: string): Promise<SearchHit[]> {
  const a = await actor();
  if (!id.safeParse(eventId).success) return [];
  return searchAttendees(a, eventId, String(q).slice(0, 80));
}

export async function openCardAction(eventId: string, ticketId: string): Promise<CardResponse> {
  const a = await actor();
  if (!id.safeParse(eventId).success || !id.safeParse(ticketId).success) return bad("notFound");
  const r = await getCard(a, eventId, ticketId);
  return r.ok ? { ok: true, card: r.card } : bad(r.reason);
}

export async function checkInAction(eventId: string, ticketId: string): Promise<CardResponse> {
  const a = await actor();
  if (!id.safeParse(eventId).success || !id.safeParse(ticketId).success) return bad("notFound");
  const r = await checkIn(a, eventId, ticketId, await getClientIp());
  if (r.ok) return { ok: true, card: r.card };
  if (r.reason === "alreadyCheckedIn") return { ok: true, card: r.card, notice: "alreadyCheckedIn" };
  return bad(r.reason);
}

export async function undoCheckInAction(eventId: string, ticketId: string): Promise<CardResponse> {
  const a = await actor();
  if (!id.safeParse(eventId).success || !id.safeParse(ticketId).success) return bad("notFound");
  const r = await undoCheckIn(a, eventId, ticketId, await getClientIp());
  return r.ok ? { ok: true, card: r.card } : bad(r.reason);
}

export async function collectMealAction(eventId: string, purchaseId: string, mealId: string, collect: boolean): Promise<CardResponse> {
  const a = await actor();
  if (![eventId, purchaseId, mealId].every((v) => id.safeParse(v).success)) return bad("notFound");
  const ip = await getClientIp();
  const r = collect ? await collectMeal(a, eventId, purchaseId, mealId, ip) : await uncollectMeal(a, eventId, purchaseId, mealId, ip);
  if (r.ok) return { ok: true, card: r.card };
  // already collected by someone else: show the up-to-date card with a notice instead of an error
  if (r.reason === "alreadyCollected" && r.card) return { ok: true, card: r.card };
  return bad(r.reason);
}

export async function broadcastAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const a = await getCurrentUser();
  assertCan(a, "broadcast:send");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const eventId = id.safeParse(raw.eventId);
  const parsed = broadcastSchema.safeParse(raw);
  if (!eventId.success) return { message: "messages.notFound", values };
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  if (raw.confirm !== "on") return { errors: { confirm: "validation.required" }, values };
  const r = await sendBroadcast(a, eventId.data, parsed.data, await getClientIp());
  if (!r.ok) {
    const map = { notFound: "messages.notFound", noRecipients: "messages.broadcastNoRecipients", rateLimited: "messages.rateLimited", eventCancelled: "messages.eventCancelled" } as const;
    return { message: map[r.reason], values };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "messages.broadcastSent", values: { count: String(r.recipientCount) } };
}
