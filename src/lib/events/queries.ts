import type { TicketType } from "@prisma/client";
import { db } from "../db";
import { can, type Actor } from "../permissions";

/** Events a visitor may see in the public list. */
export function listPublicEvents() {
  return db.event.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { startsAt: "asc" },
  });
}

/** Event page data, or null if it doesn't exist or the viewer may not see it (drafts: staff only). */
export async function getEventForViewer(slug: string, viewer: Actor | null) {
  const event = await db.event.findUnique({
    where: { slug },
    include: { chart: { select: { id: true } }, ticketTypes: { orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }], include: { zones: true } } },
  });
  if (!event || !can(viewer, "event:view", { eventStatus: event.status })) return null;
  return event;
}

export type SaleState = "upcoming" | "open" | "ended" | "soldOut";

/** Active (non-cancelled) tickets per ticket type. PENDING tickets count: they hold stock while unpaid. */
export async function soldByType(eventId: string): Promise<Map<string, number>> {
  const rows = await db.ticket.groupBy({ by: ["ticketTypeId"], where: { eventId, status: { not: "CANCELLED" } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.ticketTypeId, r._count._all]));
}

export function saleState(tt: Pick<TicketType, "quantity" | "salesStartsAt" | "salesEndsAt">, sold: number, now = new Date()): SaleState {
  if (tt.salesStartsAt && now < tt.salesStartsAt) return "upcoming";
  if (tt.salesEndsAt && now >= tt.salesEndsAt) return "ended";
  if (sold >= tt.quantity) return "soldOut";
  return "open";
}
