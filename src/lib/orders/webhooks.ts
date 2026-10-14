import { Prisma } from "@prisma/client";
import { db } from "../db";
import type { ProviderEvent } from "../payments";
import { fulfillOrder, type FulfillOutcome } from "./fulfill";

export type WebhookOutcome = { status: "duplicate" } | { status: "ignored" } | { status: "processed"; outcome?: FulfillOutcome };

/**
 * Shared by the Stripe webhook route and the mock checkout page.
 * Idempotent: WebhookEvent.externalId is UNIQUE, so a redelivered event is acknowledged and skipped.
 * If processing throws, the row stays unprocessed and the provider's retry runs it again.
 */
export async function handleProviderEvent(provider: string, event: ProviderEvent): Promise<WebhookOutcome> {
  if (event.type === "ignored") return { status: "ignored" };

  try {
    await db.webhookEvent.create({ data: { provider, externalId: event.id } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const existing = await db.webhookEvent.findUniqueOrThrow({ where: { externalId: event.id } });
    if (existing.processedAt) return { status: "duplicate" };
    // seen before but never finished (crashed mid-way): fall through and process again
  }

  let outcome: FulfillOutcome | undefined;
  if (event.type === "checkout.paid") {
    outcome = await fulfillOrder(event.orderId, { provider, paymentRef: event.paymentRef, sessionId: event.sessionId, amountOre: event.amountOre });
  } else if (event.type === "checkout.expired") {
    // We close sessions ourselves; just keep the payment row honest.
    await db.payment.updateMany({ where: { provider, providerRef: event.sessionId, status: "pending" }, data: { status: "expired" } });
  }
  await db.webhookEvent.update({ where: { externalId: event.id }, data: { processedAt: new Date() } });
  return { status: "processed", outcome };
}
