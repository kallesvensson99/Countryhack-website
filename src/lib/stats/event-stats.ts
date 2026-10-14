import { db } from "../db";
import { assertCan, type Actor } from "../permissions";

export interface EventStats {
  tickets: { typeId: string; name: string; quantity: number; active: number; pending: number; checkedIn: number; priceOre: number }[];
  ticketTotals: { active: number; pending: number; checkedIn: number; capacity: number };
  seats: { total: number; blocked: number; taken: number; held: number; free: number; byZone: { name: string; color: string; total: number; taken: number }[] } | null;
  revenue: { chargedOre: number; refundedOre: number; netOre: number; orders: { paid: number; pending: number; cancelled: number; refunded: number; expired: number } };
  food: { packageId: string; name: string; quantity: number | null; total: number; valueOre: number; variants: { name: string; count: number }[] }[];
}

/**
 * Dashboard numbers for one event.
 * Revenue = money actually received minus money actually returned (payments, not order totals), so partial refunds count right.
 */
export async function getEventStats(actor: Actor, eventId: string): Promise<EventStats> {
  assertCan(actor, "sales:view");
  const [types, byStatus, checkedIn, chart, payments, orderCounts, foodRows, foodPackages] = await Promise.all([
    db.ticketType.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }] }),
    db.ticket.groupBy({ by: ["ticketTypeId", "status"], where: { eventId }, _count: { _all: true } }),
    db.ticket.groupBy({ by: ["ticketTypeId"], where: { eventId, status: "ACTIVE", checkedInAt: { not: null } }, _count: { _all: true } }),
    db.seatingChart.findUnique({ where: { eventId }, include: { zones: { orderBy: { name: "asc" } }, seats: { include: { claim: true } } } }),
    db.payment.groupBy({ by: ["kind"], where: { status: "succeeded", order: { eventId } }, _sum: { amountOre: true } }),
    db.order.groupBy({ by: ["status"], where: { eventId }, _count: { _all: true } }),
    db.foodPurchase.groupBy({ by: ["packageId", "variantId"], where: { status: "ACTIVE", ticket: { eventId } }, _count: { _all: true } }),
    db.foodPackage.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }], include: { variants: { orderBy: { sortOrder: "asc" } } } }),
  ]);

  const count = (typeId: string, status: string) => byStatus.find((b) => b.ticketTypeId === typeId && b.status === status)?._count._all ?? 0;
  const tickets = types.map((t) => ({
    typeId: t.id, name: t.name, quantity: t.quantity, priceOre: t.priceOre,
    active: count(t.id, "ACTIVE"), pending: count(t.id, "PENDING"),
    checkedIn: checkedIn.find((c) => c.ticketTypeId === t.id)?._count._all ?? 0,
  }));

  let seats: EventStats["seats"] = null;
  if (chart) {
    const now = new Date();
    const live = (s: (typeof chart.seats)[number]) => !!s.claim && !(s.claim.status === "HELD" && s.claim.expiresAt && s.claim.expiresAt <= now);
    const usable = chart.seats.filter((s) => !s.blocked);
    seats = {
      total: usable.length,
      blocked: chart.seats.length - usable.length,
      taken: usable.filter((s) => live(s) && s.claim!.status === "CONFIRMED").length,
      held: usable.filter((s) => live(s) && s.claim!.status === "HELD").length,
      free: usable.filter((s) => !live(s)).length,
      byZone: chart.zones.map((z) => {
        const zs = usable.filter((s) => s.zoneId === z.id);
        return { name: z.name, color: z.color, total: zs.length, taken: zs.filter((s) => live(s) && s.claim!.status === "CONFIRMED").length };
      }),
    };
  }

  const charged = payments.find((p) => p.kind === "CHARGE")?._sum.amountOre ?? 0;
  const refunded = payments.find((p) => p.kind === "REFUND")?._sum.amountOre ?? 0;
  const oc = (s: string) => orderCounts.find((o) => o.status === s)?._count._all ?? 0;

  const food = foodPackages.map((p) => {
    const variants = p.variants.map((v) => ({ name: v.name, count: foodRows.find((r) => r.packageId === p.id && r.variantId === v.id)?._count._all ?? 0 }));
    const total = variants.reduce((s, v) => s + v.count, 0);
    return { packageId: p.id, name: p.name, quantity: p.quantity, total, valueOre: total * p.priceOre, variants };
  });

  return {
    tickets,
    ticketTotals: {
      active: tickets.reduce((s, t) => s + t.active, 0),
      pending: tickets.reduce((s, t) => s + t.pending, 0),
      checkedIn: tickets.reduce((s, t) => s + t.checkedIn, 0),
      capacity: tickets.reduce((s, t) => s + t.quantity, 0),
    },
    seats,
    revenue: { chargedOre: charged, refundedOre: refunded, netOre: charged - refunded, orders: { paid: oc("PAID"), pending: oc("PENDING"), cancelled: oc("CANCELLED"), refunded: oc("REFUNDED"), expired: oc("EXPIRED") } },
    food,
  };
}
