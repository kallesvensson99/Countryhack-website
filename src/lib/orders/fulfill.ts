import { db } from "../db";
import { writeAudit } from "../audit";
import { appUrl } from "../auth/service";
import { enqueueEmail } from "../email/outbox";
import { claimSeat, confirmClaim } from "../seating/claims";
import { confirmationPayload, loadReceipt } from "./receipt";

export type FulfillOutcome = "paid" | "alreadyPaid" | "latePaid" | "amountMismatch" | "ignored" | "notFound";

export interface PaymentInfo {
  provider: string;
  /** Provider reference of the charge (Stripe: payment_intent). Null for free orders. */
  paymentRef: string | null;
  sessionId?: string;
  amountOre: number;
}

/**
 * Order state machine, payment side. Idempotent: calling it again for an order that is already PAID changes nothing.
 *
 *   PENDING ──paid──▶ PAID          (tickets/food → ACTIVE, seat claim confirmed, code use counted, email queued)
 *   EXPIRED ──paid──▶ PAID          ("late payment": ticket/food re-activated, held seat re-claimed if still free,
 *                                    otherwise active without seat + "pick a new seat" email)
 *   CANCELLED/REFUNDED + payment    recorded and flagged for manual attention, never re-activated
 */
export async function fulfillOrder(orderId: string, pay: PaymentInfo): Promise<FulfillOutcome> {
  type Result = { outcome: FulfillOutcome; wasExpired: boolean; ticketIds: string[]; seatId: string | null; userId: string; locale: string; eventId: string };
  const result: Result | null = await db.$transaction(async (tx): Promise<Result | null> => {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { tickets: true, foodPurchases: true, user: true, payments: true } });
    if (!order) return null;
    const base = { wasExpired: false, ticketIds: [] as string[], seatId: null as string | null, userId: order.userId, locale: order.user.locale, eventId: order.eventId };
    const chargeRow = order.payments.find((p) => p.kind === "CHARGE");
    const raw = (chargeRow?.raw ?? {}) as { seatId?: string | null };

    if (order.status === "PAID") return { ...base, outcome: "alreadyPaid" };

    if (order.status !== "PENDING" && order.status !== "EXPIRED") {
      await tx.payment.create({ data: { orderId, provider: pay.provider, providerRef: pay.paymentRef ?? `none-${orderId}`, kind: "CHARGE", amountOre: pay.amountOre, status: "succeeded", raw: { note: "payment received for a closed order", status: order.status } } });
      await writeAudit(tx, { actorId: null, action: "order.payment_on_closed_order", entityType: "Order", entityId: orderId, eventId: order.eventId, diff: { status: order.status, amountOre: pay.amountOre, paymentRef: pay.paymentRef } });
      return { ...base, outcome: "ignored" };
    }
    if (pay.amountOre !== order.totalOre) {
      await writeAudit(tx, { actorId: null, action: "order.amount_mismatch", entityType: "Order", entityId: orderId, eventId: order.eventId, diff: { expectedOre: order.totalOre, paidOre: pay.amountOre } });
      return { ...base, outcome: "amountMismatch" };
    }

    const wasExpired = order.status === "EXPIRED";
    await tx.order.update({ where: { id: orderId }, data: { status: "PAID", paidAt: new Date() } });

    if (pay.paymentRef) {
      const data = { providerRef: pay.paymentRef, status: "succeeded", raw: { ...raw, sessionId: pay.sessionId ?? null, paymentRef: pay.paymentRef } };
      if (chargeRow) await tx.payment.update({ where: { id: chargeRow.id }, data });
      else await tx.payment.create({ data: { orderId, provider: pay.provider, kind: "CHARGE", amountOre: pay.amountOre, ...data } });
    }

    // ---- tickets
    const activeTicketIds: string[] = [];
    let conflict = false;
    for (const t of order.tickets) {
      if (t.status === "ACTIVE") {
        activeTicketIds.push(t.id);
        continue;
      }
      if (t.status === "CANCELLED") {
        // Expired order whose ticket was released: only re-activate if the member hasn't bought another one meanwhile.
        const other = await tx.ticket.count({ where: { eventId: t.eventId, userId: t.userId, status: { not: "CANCELLED" }, id: { not: t.id } } });
        if (other > 0) {
          conflict = true;
          continue;
        }
      }
      await tx.ticket.update({ where: { id: t.id }, data: { status: "ACTIVE" } });
      activeTicketIds.push(t.id);
    }
    // ---- food (only on tickets that are active)
    const activeTickets = new Set(activeTicketIds);
    for (const f of order.foodPurchases) {
      const ticketOk = activeTickets.has(f.ticketId) || (await tx.ticket.count({ where: { id: f.ticketId, status: "ACTIVE" } })) > 0;
      if (ticketOk && f.status !== "ACTIVE") await tx.foodPurchase.update({ where: { id: f.id }, data: { status: "ACTIVE" } });
    }
    if (order.discountCodeId) await tx.discountCode.update({ where: { id: order.discountCodeId }, data: { usedCount: { increment: 1 } } });

    await writeAudit(tx, { actorId: null, action: wasExpired ? "order.paid_late" : "order.paid", entityType: "Order", entityId: orderId, eventId: order.eventId, diff: { totalOre: order.totalOre, provider: pay.provider, conflict } });
    if (conflict) {
      await writeAudit(tx, { actorId: null, action: "order.late_payment_conflict", entityType: "Order", entityId: orderId, eventId: order.eventId, diff: { note: "paid after expiry, but the member holds another ticket; refund manually", paymentRef: pay.paymentRef } });
    }

    const receipt = await loadReceipt(tx, orderId);
    if (receipt) await enqueueEmail(tx, { to: order.user.email, template: "order-confirmation", locale: order.user.locale, payload: confirmationPayload(receipt, order.user.locale) });

    return { ...base, outcome: wasExpired ? "latePaid" : "paid", wasExpired, ticketIds: activeTicketIds, seatId: raw.seatId ?? null };
  }, { timeout: 30_000 });

  if (!result) return "notFound";

  // ---- seats (separate transactions: claims have their own locking)
  if (result.outcome === "paid" || result.outcome === "latePaid") {
    let seated = false;
    for (const ticketId of result.ticketIds) seated = (await confirmClaim(ticketId)) || seated;
    if (!seated && result.seatId && result.ticketIds.length === 1) {
      // the hold was swept (or the order had expired): try to take the same seat again
      seated = (await claimSeat({ seatId: result.seatId, ticketId: result.ticketIds[0]!, status: "CONFIRMED" })).ok;
      if (!seated) {
        await db.$transaction(async (tx) => {
          const user = await tx.user.findUniqueOrThrow({ where: { id: result.userId } });
          const event = await tx.event.findUniqueOrThrow({ where: { id: result.eventId } });
          await enqueueEmail(tx, { to: user.email, template: "seat-needed", locale: user.locale, payload: { name: user.realName, eventName: event.name, url: appUrl(user.locale, `/events/${event.slug}`) } });
          await writeAudit(tx, { actorId: null, action: "order.seat_lost", entityType: "Order", entityId: orderId, eventId: result.eventId, diff: { seatId: result.seatId, late: result.wasExpired } });
        });
      }
    }
  }
  return result.outcome;
}

