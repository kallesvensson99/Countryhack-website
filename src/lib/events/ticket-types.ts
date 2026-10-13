import { db } from "../db";
import { writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import type { TicketTypeInput } from "../validation/events";

export type TicketTypeResult<T = { id: string }> =
  | { ok: true; value: T }
  | { ok: false; reason: "notFound" | "badZones" | "hasSales" | "eventCancelled" | "quantityBelowSold" };

const toData = (i: TicketTypeInput) => ({
  name: i.name,
  description: i.description,
  priceOre: i.price,
  quantity: i.quantity,
  salesStartsAt: i.salesStartsAt ?? null,
  salesEndsAt: i.salesEndsAt ?? null,
  includesSeat: i.includesSeat,
  requiresDiscountCode: i.requiresDiscountCode,
  hidden: i.hidden,
  sortOrder: i.sortOrder,
});

/** Zones must belong to this event's chart. Empty list = "any zone". */
async function zonesBelongToEvent(eventId: string, zoneIds: string[]): Promise<boolean> {
  if (zoneIds.length === 0) return true;
  const n = await db.seatZone.count({ where: { id: { in: zoneIds }, chart: { eventId } } });
  return n === new Set(zoneIds).size;
}

export async function createTicketType(actor: Actor, eventId: string, input: TicketTypeInput, zoneIds: string[], ip?: string | null): Promise<TicketTypeResult> {
  assertCan(actor, "ticketType:manage");
  const ev = await db.event.findUnique({ where: { id: eventId } });
  if (!ev) return { ok: false, reason: "notFound" };
  if (ev.status === "CANCELLED") return { ok: false, reason: "eventCancelled" };
  if (!(await zonesBelongToEvent(eventId, zoneIds))) return { ok: false, reason: "badZones" };
  return db.$transaction(async (tx) => {
    const tt = await tx.ticketType.create({
      data: { eventId, ...toData(input), zones: { create: [...new Set(zoneIds)].map((zoneId) => ({ zoneId })) } },
    });
    await writeAudit(tx, { actorId: actor.id, action: "ticketType.create", entityType: "TicketType", entityId: tt.id, eventId, diff: { name: tt.name, priceOre: tt.priceOre, quantity: tt.quantity }, ip });
    return { ok: true as const, value: { id: tt.id } };
  });
}

export async function updateTicketType(actor: Actor, ticketTypeId: string, input: TicketTypeInput, zoneIds: string[], ip?: string | null): Promise<TicketTypeResult> {
  assertCan(actor, "ticketType:manage");
  const before = await db.ticketType.findUnique({ where: { id: ticketTypeId }, include: { event: true, zones: true } });
  if (!before) return { ok: false, reason: "notFound" };
  if (before.event.status === "CANCELLED") return { ok: false, reason: "eventCancelled" };
  if (!(await zonesBelongToEvent(before.eventId, zoneIds))) return { ok: false, reason: "badZones" };
  const sold = await db.ticket.count({ where: { ticketTypeId, status: { not: "CANCELLED" } } });
  if (input.quantity < sold) return { ok: false, reason: "quantityBelowSold" };

  return db.$transaction(async (tx) => {
    await tx.ticketType.update({ where: { id: ticketTypeId }, data: toData(input) });
    await tx.ticketTypeZone.deleteMany({ where: { ticketTypeId } });
    await tx.ticketTypeZone.createMany({ data: [...new Set(zoneIds)].map((zoneId) => ({ ticketTypeId, zoneId })) });
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const after = toData(input);
    for (const k of Object.keys(after) as (keyof typeof after)[]) {
      const a = JSON.stringify(before[k]);
      const b = JSON.stringify(after[k]);
      if (a !== b) diff[k] = { from: before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k], to: after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k] };
    }
    const oldZones = before.zones.map((z) => z.zoneId).sort().join(",");
    const newZones = [...new Set(zoneIds)].sort().join(",");
    if (oldZones !== newZones) diff.zones = { from: oldZones.split(",").filter(Boolean), to: newZones.split(",").filter(Boolean) };
    if (Object.keys(diff).length) {
      await writeAudit(tx, { actorId: actor.id, action: "ticketType.update", entityType: "TicketType", entityId: ticketTypeId, eventId: before.eventId, diff: diff as never, ip });
    }
    return { ok: true as const, value: { id: ticketTypeId } };
  });
}

/** Only never-sold types can be deleted; otherwise hide them instead. */
export async function deleteTicketType(actor: Actor, ticketTypeId: string, ip?: string | null): Promise<TicketTypeResult> {
  assertCan(actor, "ticketType:manage");
  const tt = await db.ticketType.findUnique({ where: { id: ticketTypeId } });
  if (!tt) return { ok: false, reason: "notFound" };
  const used = (await db.ticket.count({ where: { ticketTypeId } })) + (await db.orderItem.count({ where: { ticketTypeId } }));
  if (used > 0) return { ok: false, reason: "hasSales" };
  await db.$transaction(async (tx) => {
    await tx.ticketType.delete({ where: { id: ticketTypeId } });
    await writeAudit(tx, { actorId: actor.id, action: "ticketType.delete", entityType: "TicketType", entityId: ticketTypeId, eventId: tt.eventId, diff: { name: tt.name }, ip });
  });
  return { ok: true, value: { id: ticketTypeId } };
}
