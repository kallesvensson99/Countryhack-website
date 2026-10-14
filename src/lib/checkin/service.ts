import { Prisma } from "@prisma/client";
import { db } from "../db";
import { isMinor } from "../age";
import { writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import { verifyTicketToken } from "../tickets/qr";

/** Everything the crew needs on screen at the door. Plain JSON-serialisable. */
export interface AttendeeCard {
  ticketId: string;
  eventId: string;
  orderNumber: string;
  realName: string;
  nickname: string;
  phone: string;
  ticketType: string;
  seat: string | null;
  checkedIn: { at: string; by: string } | null;
  /** Present when the attendee is under 18 (by actual date of birth, today). */
  minor: { guardianName: string | null; guardianPhone: string | null } | null;
  allergies: string | null;
  dietary: string | null;
  food: {
    purchaseId: string;
    packageName: string;
    variantName: string;
    meals: { id: string; name: string; servedAt: string; collected: { at: string; by: string } | null }[];
  }[];
}

export type LookupError = "invalidCode" | "notFound" | "wrongEvent" | "notActive" | "eventNotOpen";
export type LookupResult = { ok: true; card: AttendeeCard } | { ok: false; reason: LookupError };

async function loadCard(ticketId: string, now = new Date()): Promise<AttendeeCard | null> {
  const t = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      user: true,
      order: { select: { number: true } },
      ticketType: { select: { name: true } },
      checkedInBy: { select: { nickname: true } },
      seatClaim: { include: { seat: { select: { label: true } } } },
      foodPurchases: {
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        include: {
          package: { include: { meals: { include: { meal: true } } } },
          variant: true,
          collections: { include: { collectedBy: { select: { nickname: true } } } },
        },
      },
    },
  });
  if (!t) return null;
  const minor = isMinor(t.user.birthDate, now);
  return {
    ticketId: t.id,
    eventId: t.eventId,
    orderNumber: t.order.number,
    realName: t.user.realName,
    nickname: t.user.nickname,
    phone: t.user.phone,
    ticketType: t.ticketType.name,
    seat: t.seatClaim?.seat.label ?? null,
    checkedIn: t.checkedInAt ? { at: t.checkedInAt.toISOString(), by: t.checkedInBy?.nickname ?? "–" } : null,
    minor: minor ? { guardianName: t.user.guardianName, guardianPhone: t.user.guardianPhone } : null,
    allergies: t.user.allergies?.trim() || null,
    dietary: t.user.dietaryPreferences?.trim() || null,
    food: t.foodPurchases.map((f) => ({
      purchaseId: f.id,
      packageName: f.package.name,
      variantName: f.variant.name,
      meals: f.package.meals
        .map((m) => m.meal)
        .sort((a, b) => a.servedAt.getTime() - b.servedAt.getTime())
        .map((meal) => {
          const c = f.collections.find((x) => x.mealId === meal.id);
          return { id: meal.id, name: meal.name, servedAt: meal.servedAt.toISOString(), collected: c ? { at: c.collectedAt.toISOString(), by: c.collectedBy.nickname } : null };
        }),
    })),
  };
}

async function eventOpen(eventId: string): Promise<boolean> {
  const ev = await db.event.findUnique({ where: { id: eventId }, select: { status: true } });
  return ev?.status === "PUBLISHED" || ev?.status === "CLOSED";
}

/** A scanned QR code → attendee card. The signature, the per-ticket nonce, the event and the ticket status are all checked. */
export async function lookupByToken(actor: Actor, eventId: string, token: string): Promise<LookupResult> {
  assertCan(actor, "checkin:perform");
  const parsed = verifyTicketToken(token);
  if (!parsed) return { ok: false, reason: "invalidCode" };
  const ticket = await db.ticket.findUnique({ where: { id: parsed.ticketId }, select: { id: true, eventId: true, qrNonce: true, status: true } });
  // a rotated nonce invalidates old printouts/screenshots
  if (!ticket || ticket.qrNonce !== parsed.nonce) return { ok: false, reason: ticket ? "invalidCode" : "notFound" };
  if (ticket.eventId !== eventId) return { ok: false, reason: "wrongEvent" };
  if (ticket.status !== "ACTIVE") return { ok: false, reason: "notActive" };
  if (!(await eventOpen(eventId))) return { ok: false, reason: "eventNotOpen" };
  return { ok: true, card: (await loadCard(ticket.id))! };
}

export async function getCard(actor: Actor, eventId: string, ticketId: string): Promise<LookupResult> {
  assertCan(actor, "checkin:perform");
  const t = await db.ticket.findUnique({ where: { id: ticketId }, select: { eventId: true, status: true } });
  if (!t) return { ok: false, reason: "notFound" };
  if (t.eventId !== eventId) return { ok: false, reason: "wrongEvent" };
  if (t.status !== "ACTIVE") return { ok: false, reason: "notActive" };
  return { ok: true, card: (await loadCard(ticketId))! };
}

export interface SearchHit {
  ticketId: string;
  realName: string;
  nickname: string;
  ticketType: string;
  orderNumber: string;
  checkedIn: boolean;
}

/** Name, nickname or order number (case-insensitive, partial). Only active tickets of this event. */
export async function searchAttendees(actor: Actor, eventId: string, q: string): Promise<SearchHit[]> {
  assertCan(actor, "checkin:perform");
  const term = q.trim();
  if (term.length < 2) return [];
  const tickets = await db.ticket.findMany({
    where: {
      eventId,
      status: "ACTIVE",
      user: { anonymizedAt: null },
      OR: [
        { user: { realName: { contains: term, mode: "insensitive" } } },
        { user: { nickname: { contains: term, mode: "insensitive" } } },
        { order: { number: { contains: term, mode: "insensitive" } } },
      ],
    },
    include: { user: { select: { realName: true, nickname: true } }, order: { select: { number: true } }, ticketType: { select: { name: true } } },
    orderBy: [{ user: { nickname: "asc" } }],
    take: 20,
  });
  return tickets.map((t) => ({ ticketId: t.id, realName: t.user.realName, nickname: t.user.nickname, ticketType: t.ticketType.name, orderNumber: t.order.number, checkedIn: !!t.checkedInAt }));
}

export type CheckInResult =
  | { ok: true; card: AttendeeCard }
  | { ok: false; reason: "alreadyCheckedIn"; card: AttendeeCard }
  | { ok: false; reason: "notFound" | "notActive" | "eventNotOpen" | "wrongEvent" };

/**
 * One conditional UPDATE does the check-in, so two crew members scanning the same ticket at the same
 * moment can't both succeed: exactly one gets `ok`, the other gets `alreadyCheckedIn` with who/when.
 */
export async function checkIn(actor: Actor, eventId: string, ticketId: string, ip?: string | null): Promise<CheckInResult> {
  assertCan(actor, "checkin:perform");
  const t = await db.ticket.findUnique({ where: { id: ticketId }, select: { eventId: true, status: true } });
  if (!t) return { ok: false, reason: "notFound" };
  if (t.eventId !== eventId) return { ok: false, reason: "wrongEvent" };
  if (t.status !== "ACTIVE") return { ok: false, reason: "notActive" };
  if (!(await eventOpen(eventId))) return { ok: false, reason: "eventNotOpen" };

  const won = await db.$transaction(async (tx) => {
    const r = await tx.ticket.updateMany({ where: { id: ticketId, status: "ACTIVE", checkedInAt: null }, data: { checkedInAt: new Date(), checkedInById: actor.id } });
    if (r.count === 1) await writeAudit(tx, { actorId: actor.id, action: "ticket.checkin", entityType: "Ticket", entityId: ticketId, eventId, diff: { checkedIn: true }, ip });
    return r.count === 1;
  });
  const card = (await loadCard(ticketId))!;
  return won ? { ok: true, card } : { ok: false, reason: "alreadyCheckedIn", card };
}

/** For mistakes (wrong person tapped). Audited. */
export async function undoCheckIn(actor: Actor, eventId: string, ticketId: string, ip?: string | null): Promise<CheckInResult> {
  assertCan(actor, "checkin:perform");
  const t = await db.ticket.findUnique({ where: { id: ticketId }, select: { eventId: true } });
  if (!t) return { ok: false, reason: "notFound" };
  if (t.eventId !== eventId) return { ok: false, reason: "wrongEvent" };
  await db.$transaction(async (tx) => {
    const r = await tx.ticket.updateMany({ where: { id: ticketId, checkedInAt: { not: null } }, data: { checkedInAt: null, checkedInById: null } });
    if (r.count === 1) await writeAudit(tx, { actorId: actor.id, action: "ticket.checkin.undo", entityType: "Ticket", entityId: ticketId, eventId, diff: { checkedIn: false }, ip });
  });
  return { ok: true, card: (await loadCard(ticketId))! };
}

export type CollectResult = { ok: true; card: AttendeeCard } | { ok: false; reason: "notFound" | "wrongMeal" | "alreadyCollected" | "wrongEvent"; card?: AttendeeCard };

/** Marks one meal of one food purchase as collected (unique per purchase + meal). */
export async function collectMeal(actor: Actor, eventId: string, foodPurchaseId: string, mealId: string, ip?: string | null): Promise<CollectResult> {
  assertCan(actor, "checkin:perform");
  const fp = await db.foodPurchase.findUnique({ where: { id: foodPurchaseId }, include: { ticket: { select: { eventId: true, id: true } }, package: { include: { meals: true } } } });
  if (!fp || fp.status !== "ACTIVE") return { ok: false, reason: "notFound" };
  if (fp.ticket.eventId !== eventId) return { ok: false, reason: "wrongEvent" };
  if (!fp.package.meals.some((m) => m.mealId === mealId)) return { ok: false, reason: "wrongMeal" };
  try {
    await db.$transaction(async (tx) => {
      await tx.mealCollection.create({ data: { foodPurchaseId, mealId, collectedById: actor.id } });
      await writeAudit(tx, { actorId: actor.id, action: "meal.collect", entityType: "FoodPurchase", entityId: foodPurchaseId, eventId, diff: { mealId, collected: true }, ip });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "alreadyCollected", card: (await loadCard(fp.ticket.id))! };
    throw e;
  }
  return { ok: true, card: (await loadCard(fp.ticket.id))! };
}

export async function uncollectMeal(actor: Actor, eventId: string, foodPurchaseId: string, mealId: string, ip?: string | null): Promise<CollectResult> {
  assertCan(actor, "checkin:perform");
  const fp = await db.foodPurchase.findUnique({ where: { id: foodPurchaseId }, include: { ticket: { select: { eventId: true, id: true } } } });
  if (!fp) return { ok: false, reason: "notFound" };
  if (fp.ticket.eventId !== eventId) return { ok: false, reason: "wrongEvent" };
  await db.$transaction(async (tx) => {
    const r = await tx.mealCollection.deleteMany({ where: { foodPurchaseId, mealId } });
    if (r.count) await writeAudit(tx, { actorId: actor.id, action: "meal.uncollect", entityType: "FoodPurchase", entityId: foodPurchaseId, eventId, diff: { mealId, collected: false }, ip });
  });
  return { ok: true, card: (await loadCard(fp.ticket.id))! };
}
