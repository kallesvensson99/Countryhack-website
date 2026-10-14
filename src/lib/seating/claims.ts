import { Prisma } from "@prisma/client";
import { db } from "../db";

/**
 * Seat claims. The database guarantees no double booking:
 *   SeatClaim.seatId   UNIQUE  → a seat has at most one claim
 *   SeatClaim.ticketId UNIQUE  → a ticket has at most one seat
 * Claiming = (in one transaction) delete an *expired* HELD claim on the seat, then INSERT.
 * A unique violation means somebody else holds it.
 */

export type ClaimError =
  | "taken"
  | "blocked"
  | "reservedForOther"
  | "zoneNotAllowed"
  | "ticketNoSeat"
  | "ticketInactive"
  | "wrongChart"
  | "alreadyHasSeat"
  | "noClaim"
  | "notFound";

export type ClaimResult = { ok: true; claimId: string } | { ok: false; reason: ClaimError };

type Tx = Prisma.TransactionClient;

class Reject extends Error {
  constructor(public reason: ClaimError) {
    super(reason);
  }
}

/**
 * Locks the seat row FOR SHARE (concurrent claims don't block each other, but a chart save —
 * which locks seats FOR UPDATE — does) and checks everything that can disqualify this ticket for this seat.
 */
async function assertClaimable(tx: Tx, seatId: string, ticketId: string): Promise<void> {
  const seats = await tx.$queryRaw<{ chartId: string; zoneId: string; blocked: boolean; reservedForUserId: string | null }[]>`
    SELECT "chartId", "zoneId", "blocked", "reservedForUserId" FROM "Seat" WHERE "id" = ${seatId} FOR SHARE`;
  const seat = seats[0];
  if (!seat) throw new Reject("notFound");
  if (seat.blocked) throw new Reject("blocked");

  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    include: { ticketType: { include: { zones: true } }, event: { include: { chart: { select: { id: true } } } } },
  });
  if (!ticket) throw new Reject("notFound");
  if (ticket.status === "CANCELLED") throw new Reject("ticketInactive");
  if (!ticket.ticketType.includesSeat) throw new Reject("ticketNoSeat");
  if (ticket.event.chart?.id !== seat.chartId) throw new Reject("wrongChart");
  const allowed = ticket.ticketType.zones.map((z) => z.zoneId);
  if (allowed.length > 0 && !allowed.includes(seat.zoneId)) throw new Reject("zoneNotAllowed");
  if (seat.reservedForUserId && seat.reservedForUserId !== ticket.userId) throw new Reject("reservedForOther");
}

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function claimSeat(args: {
  seatId: string;
  ticketId: string;
  status: "HELD" | "CONFIRMED";
  /** Required for HELD: when the hold lapses. */
  expiresAt?: Date | null;
  now?: Date;
}): Promise<ClaimResult> {
  const now = args.now ?? new Date();
  if (args.status === "HELD" && !args.expiresAt) throw new Error("HELD claims need expiresAt");
  try {
    return await db.$transaction(async (tx) => {
      await assertClaimable(tx, args.seatId, args.ticketId);
      if (await tx.seatClaim.findUnique({ where: { ticketId: args.ticketId } })) throw new Reject("alreadyHasSeat");
      await tx.seatClaim.deleteMany({ where: { seatId: args.seatId, status: "HELD", expiresAt: { lte: now } } });
      const claim = await tx.seatClaim.create({
        data: { seatId: args.seatId, ticketId: args.ticketId, status: args.status, expiresAt: args.status === "HELD" ? args.expiresAt! : null },
      });
      return { ok: true as const, claimId: claim.id };
    });
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.reason };
    if (isUniqueViolation(e)) return { ok: false, reason: JSON.stringify(e.meta).includes("ticketId") ? "alreadyHasSeat" : "taken" };
    throw e;
  }
}

/** Moves the ticket's existing claim to another seat in a single transaction (the old seat is freed atomically). */
export async function moveClaim(args: { ticketId: string; toSeatId: string; now?: Date }): Promise<ClaimResult> {
  const now = args.now ?? new Date();
  try {
    return await db.$transaction(async (tx) => {
      await assertClaimable(tx, args.toSeatId, args.ticketId);
      const claim = await tx.seatClaim.findUnique({ where: { ticketId: args.ticketId } });
      if (!claim) throw new Reject("noClaim");
      if (claim.seatId === args.toSeatId) return { ok: true as const, claimId: claim.id };
      await tx.seatClaim.deleteMany({ where: { seatId: args.toSeatId, status: "HELD", expiresAt: { lte: now } } });
      await tx.seatClaim.update({ where: { id: claim.id }, data: { seatId: args.toSeatId } });
      return { ok: true as const, claimId: claim.id };
    });
  } catch (e) {
    if (e instanceof Reject) return { ok: false, reason: e.reason };
    if (isUniqueViolation(e)) return { ok: false, reason: "taken" };
    throw e;
  }
}

/** HELD → CONFIRMED (payment succeeded). Returns false if the ticket has no claim any more. */
export async function confirmClaim(ticketId: string): Promise<boolean> {
  const r = await db.seatClaim.updateMany({ where: { ticketId, status: "HELD" }, data: { status: "CONFIRMED", expiresAt: null } });
  return r.count === 1 || (await db.seatClaim.count({ where: { ticketId, status: "CONFIRMED" } })) === 1;
}

export async function releaseClaim(ticketId: string): Promise<boolean> {
  return (await db.seatClaim.deleteMany({ where: { ticketId } })).count > 0;
}

/** Worker: drop holds whose time ran out. */
export async function releaseExpiredClaims(now: Date = new Date()): Promise<number> {
  return (await db.seatClaim.deleteMany({ where: { status: "HELD", expiresAt: { lte: now } } })).count;
}
