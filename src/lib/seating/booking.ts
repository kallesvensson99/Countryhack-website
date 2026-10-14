import { db } from "../db";
import { writeAudit } from "../audit";
import { assertCan, can, type Actor } from "../permissions";
import { claimSeat, moveClaim, type ClaimError } from "./claims";
import type { MapSeat, SeatMapData, SeatState } from "./types";

export type ChooseSeatError = ClaimError | "forbidden" | "deadlinePassed" | "eventNotOpen";
export type ChooseSeatResult = { ok: true; seatId: string; moved: boolean } | { ok: false; reason: ChooseSeatError };

const isStaff = (a: Actor) => a.tags.includes("FESTIVALLEDARE");

/**
 * A member chooses (or changes) the seat for one of their tickets.
 *  - ACTIVE ticket → CONFIRMED claim (or move of the existing one)
 *  - PENDING ticket (inside checkout) → HELD claim lasting until the order expires
 * Allowed until event.seatChangeDeadline; Festivalledare may assign seats on any ticket and bypass the deadline.
 */
export async function chooseSeat(actor: Actor, ticketId: string, seatId: string, opts: { ip?: string | null; now?: Date } = {}): Promise<ChooseSeatResult> {
  assertCan(actor, "seat:choose");
  const now = opts.now ?? new Date();
  const ticket = await db.ticket.findUnique({ where: { id: ticketId }, include: { event: true, order: true, seatClaim: true } });
  if (!ticket || !can(actor, "ticket:view", { ownerId: ticket.userId })) return { ok: false, reason: ticket ? "forbidden" : "notFound" };
  const staff = isStaff(actor);
  if (!staff && ticket.userId !== actor.id) return { ok: false, reason: "forbidden" };
  if (ticket.status === "CANCELLED") return { ok: false, reason: "ticketInactive" };
  if (ticket.event.status !== "PUBLISHED" && ticket.event.status !== "CLOSED") return { ok: false, reason: "eventNotOpen" };
  if (!staff && ticket.event.seatChangeDeadline && now > ticket.event.seatChangeDeadline) return { ok: false, reason: "deadlinePassed" };

  const had = !!ticket.seatClaim;
  const r = had
    ? await moveClaim({ ticketId, toSeatId: seatId, now })
    : ticket.status === "PENDING"
      ? await claimSeat({ seatId, ticketId, status: "HELD", expiresAt: ticket.order.expiresAt, now })
      : await claimSeat({ seatId, ticketId, status: "CONFIRMED", now });
  if (!r.ok) return r;

  if (actor.id !== ticket.userId) {
    await writeAudit(db, { actorId: actor.id, action: "seat.assign", entityType: "Ticket", entityId: ticketId, eventId: ticket.eventId, diff: { seatId: { from: ticket.seatClaim?.seatId ?? null, to: seatId } }, ip: opts.ip });
  }
  return { ok: true, seatId, moved: had };
}

/**
 * The booking map for one event, tailored to a viewer. Contains no personal data except
 * the nickname of a seat's occupant when (and only when) the event has showNicknamesOnMap on.
 */
export async function getSeatMap(eventId: string, viewer: Actor | null, now: Date = new Date()): Promise<SeatMapData | null> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    include: { chart: { include: { zones: true, objects: true, seats: { include: { claim: { include: { ticket: { include: { user: { select: { id: true, nickname: true } } } } } } } } } } },
  });
  if (!event?.chart) return null;
  const chart = event.chart;

  // The viewer's own ticket (one active ticket per member per event is enforced by the DB).
  let pick: SeatMapData["pick"] = null;
  let pickBlockedReason: SeatMapData["pickBlockedReason"] = null;
  if (viewer) {
    const ticket = await db.ticket.findFirst({
      where: { eventId, userId: viewer.id, status: { not: "CANCELLED" } },
      include: { ticketType: { include: { zones: true } }, seatClaim: true },
    });
    if (ticket) {
      if (!ticket.ticketType.includesSeat) pickBlockedReason = "noSeatTicket";
      else if (ticket.status !== "ACTIVE") pickBlockedReason = "ticketNotActive";
      else if (!viewer.emailVerifiedAt) pickBlockedReason = "unverified";
      else if (event.status !== "PUBLISHED" && event.status !== "CLOSED") pickBlockedReason = "eventNotOpen";
      else if (event.seatChangeDeadline && now > event.seatChangeDeadline) pickBlockedReason = "deadlinePassed";
      else {
        const zones = ticket.ticketType.zones.map((z) => z.zoneId);
        pick = { ticketId: ticket.id, currentSeatId: ticket.seatClaim?.seatId ?? null, allowedZoneIds: zones.length ? zones : null };
      }
    }
  }

  const seats: MapSeat[] = chart.seats.map((s) => {
    const claim = s.claim && !(s.claim.status === "HELD" && s.claim.expiresAt && s.claim.expiresAt <= now) ? s.claim : null; // expired holds count as free
    let state: SeatState;
    if (claim && viewer && claim.ticket.userId === viewer.id) state = "mine";
    else if (claim) state = "taken";
    else if (s.blocked) state = "blocked";
    else if (s.reservedForUserId && s.reservedForUserId !== viewer?.id) state = "reserved";
    else state = "free";

    const zoneOk = !pick || !pick.allowedZoneIds || pick.allowedZoneIds.includes(s.zoneId);
    const seat: MapSeat = {
      id: s.id, label: s.label, x: s.x, y: s.y, rotation: s.rotation, zoneId: s.zoneId, state,
      selectable: !!pick && zoneOk && state === "free",
    };
    if (state === "taken" && event.showNicknamesOnMap && claim) seat.nickname = claim.ticket.user.nickname;
    return seat;
  });

  return {
    chart: { width: chart.width, height: chart.height, gridSize: chart.gridSize },
    zones: chart.zones.map((z) => ({ id: z.id, name: z.name, color: z.color })),
    objects: chart.objects.map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation, label: o.label })),
    seats,
    showNicknames: event.showNicknamesOnMap,
    pick,
    pickBlockedReason,
  };
}
