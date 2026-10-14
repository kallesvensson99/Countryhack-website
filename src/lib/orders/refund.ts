import { db } from "../db";
import { writeAudit } from "../audit";
import { appUrl } from "../auth/service";
import { enqueueEmail } from "../email/outbox";
import { assertCan, type Actor } from "../permissions";
import { getPaymentProvider } from "../payments";

export type CancelError = "notFound" | "notPaid" | "invalidAmount" | "providerError" | "noCharge";
export type CancelResult = { ok: true; refundedOre: number; status: "CANCELLED" | "REFUNDED" } | { ok: false; reason: CancelError; detail?: string };

/**
 * Cancels a paid order (Festivalledare only): ticket(s) and food are cancelled, the seat is released,
 * and money goes back through the provider — everything by default, or a partial amount.
 * The provider is called FIRST with an idempotency key; the database is only changed once the refund exists,
 * so a failed refund leaves the order untouched and a retry can never refund twice.
 * Status becomes REFUNDED only when the whole amount was returned, otherwise CANCELLED.
 */
export async function cancelOrder(actor: Actor, orderId: string, opts: { refundOre?: number; ip?: string | null }): Promise<CancelResult> {
  assertCan(actor, "order:cancel");
  assertCan(actor, "order:refund");
  const order = await db.order.findUnique({ where: { id: orderId }, include: { payments: true, user: true, event: true } });
  if (!order) return { ok: false, reason: "notFound" };
  if (order.status !== "PAID") return { ok: false, reason: "notPaid" };

  const charge = order.payments.find((p) => p.kind === "CHARGE" && p.status === "succeeded");
  const alreadyRefunded = order.payments.filter((p) => p.kind === "REFUND" && p.status === "succeeded").reduce((s, p) => s + p.amountOre, 0);
  const refundable = order.totalOre - alreadyRefunded;
  const amount = opts.refundOre ?? refundable;
  if (!Number.isInteger(amount) || amount < 0 || amount > refundable) return { ok: false, reason: "invalidAmount" };
  if (amount > 0 && !charge) return { ok: false, reason: "noCharge" };

  let refundId: string | null = null;
  if (amount > 0) {
    try {
      const paymentRef = ((charge!.raw as { paymentRef?: string } | null)?.paymentRef ?? charge!.providerRef);
      refundId = (await getPaymentProvider().refund({ paymentRef, amountOre: amount, idempotencyKey: `refund-${order.id}-${alreadyRefunded}-${amount}` })).refundId;
    } catch (e) {
      console.error(`[orders] refund failed for ${order.number}`, e);
      return { ok: false, reason: "providerError", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  const status = alreadyRefunded + amount >= order.totalOre && order.totalOre > 0 ? "REFUNDED" : "CANCELLED";
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const tickets = await tx.ticket.findMany({ where: { orderId } });
    await tx.order.update({ where: { id: orderId }, data: { status, cancelledAt: new Date(), cancelledById: actor.id } });
    const ticketIds = tickets.map((t) => t.id);
    await tx.seatClaim.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await tx.ticket.updateMany({ where: { id: { in: ticketIds }, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
    await tx.foodPurchase.updateMany({ where: { orderId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
    if (order.discountCodeId) await tx.discountCode.update({ where: { id: order.discountCodeId }, data: { usedCount: { decrement: 1 } } });
    if (refundId) await tx.payment.create({ data: { orderId, provider: charge!.provider, providerRef: refundId, kind: "REFUND", amountOre: amount, status: "succeeded", raw: { by: actor.id } } });
    await writeAudit(tx, {
      actorId: actor.id, action: "order.cancel", entityType: "Order", entityId: orderId, eventId: order.eventId,
      diff: { status: { from: "PAID", to: status }, refundedOre: amount, totalOre: order.totalOre }, ip: opts.ip,
    });
    await enqueueEmail(tx, {
      to: order.user.email, template: "order-cancelled", locale: order.user.locale,
      payload: { name: order.user.realName, orderNumber: order.number, eventName: order.event.name, refundedOre: amount, url: appUrl(order.user.locale, "/my") },
    });
  });
  return { ok: true, refundedOre: amount, status };
}
