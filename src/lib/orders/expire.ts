import { db } from "../db";
import { getPaymentProvider } from "../payments";

/**
 * Expiring an unpaid order frees everything it held: tickets → CANCELLED, food → CANCELLED, seat hold released,
 * and the provider's checkout session is closed so nobody can still pay for it.
 */
export async function expireOrder(orderId: string, opts: { force?: boolean; now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const expired = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { tickets: true } });
    if (!order || order.status !== "PENDING") return false;
    if (!opts.force && order.expiresAt > now) return false;
    await tx.order.update({ where: { id: orderId }, data: { status: "EXPIRED" } });
    const pendingTicketIds = order.tickets.filter((t) => t.status === "PENDING").map((t) => t.id);
    await tx.seatClaim.deleteMany({ where: { ticketId: { in: pendingTicketIds }, status: "HELD" } });
    await tx.ticket.updateMany({ where: { id: { in: pendingTicketIds } }, data: { status: "CANCELLED" } });
    await tx.foodPurchase.updateMany({ where: { orderId, status: "PENDING" }, data: { status: "CANCELLED" } });
    return true;
  });
  if (expired) await closeSessionsForOrder(orderId);
  return expired;
}

const MAX_CLOSE_ATTEMPTS = 10;

/** Closes provider checkout sessions that are still open for an order that is no longer payable. */
async function closeSessionsForOrder(orderId: string): Promise<void> {
  const payments = await db.payment.findMany({ where: { orderId, kind: "CHARGE", status: "pending" } });
  await closePayments(payments);
}

async function closePayments(payments: { id: string; providerRef: string; raw: unknown }[]): Promise<number> {
  let closed = 0;
  for (const p of payments) {
    const raw = (p.raw ?? {}) as { closeAttempts?: number };
    try {
      await getPaymentProvider().expireSession(p.providerRef);
      await db.payment.update({ where: { id: p.id }, data: { status: "expired" } });
      closed++;
    } catch (e) {
      const attempts = (raw.closeAttempts ?? 0) + 1;
      console.error(`[orders] could not close checkout session ${p.providerRef} (attempt ${attempts})`, e);
      await db.payment.update({ where: { id: p.id }, data: { raw: { ...(p.raw as object), closeAttempts: attempts }, status: attempts >= MAX_CLOSE_ATTEMPTS ? "close_failed" : "pending" } });
    }
  }
  return closed;
}

/** Worker: expire everything past its deadline, then retry sessions that failed to close earlier. */
export async function expireDueOrders(now: Date = new Date()): Promise<{ expired: number; sessionsClosed: number }> {
  const due = await db.order.findMany({ where: { status: "PENDING", expiresAt: { lte: now } }, select: { id: true }, take: 200, orderBy: { expiresAt: "asc" } });
  let expired = 0;
  for (const o of due) if (await expireOrder(o.id, { now })) expired++;

  // sessions still open on orders that are no longer PENDING (earlier close attempt failed)
  const stale = await db.payment.findMany({ where: { kind: "CHARGE", status: "pending", order: { status: { in: ["EXPIRED", "CANCELLED"] } } }, take: 100 });
  const sessionsClosed = await closePayments(stale);
  return { expired, sessionsClosed };
}
