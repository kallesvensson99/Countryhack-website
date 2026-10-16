import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { stockholmParts } from "../age";
import { appUrl } from "../auth/service";
import { LIMITS, rateLimit } from "../auth/rate-limit";
import { env } from "../env";
import { assertCan, type Actor } from "../permissions";
import { getPaymentProvider } from "../payments";
import { claimSeat } from "../seating/claims";
import { expireOrder } from "./expire";
import { fulfillOrder } from "./fulfill";
import { buildQuote, type Quote, type QuoteError, type QuoteInput, type QuoteResult } from "./quote";

export interface CheckoutInput extends QuoteInput {
  locale: "sv" | "en";
  /** Skip the "a seat must be chosen" rule. Never set by the UI or the server action (their schema drops it); for tests and tooling. */
  allowNoSeat?: boolean;
}

export type CheckoutError = QuoteError | "rateLimited" | "seatUnavailable" | "providerError";
export type CheckoutResult =
  | { ok: true; kind: "redirect"; url: string; orderNumber: string }
  | { ok: true; kind: "free"; orderNumber: string }
  | { ok: false; reason: CheckoutError; detail?: string };

/** Live price preview: validates exactly like checkout but writes nothing. */
export async function previewQuote(actor: Actor, input: QuoteInput, now = new Date()): Promise<QuoteResult> {
  assertCan(actor, input.ticketTypeId ? "ticket:buy" : "food:buy");
  return buildQuote(db, actor.id, input, { now, allowEmpty: true });
}

async function nextOrderNumber(tx: Prisma.TransactionClient, now: Date): Promise<string> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_number_seq') AS n`;
  const n = rows[0]!.n;
  return `CCSS-${stockholmParts(now).year}-${String(n).padStart(4, "0")}`;
}

class Abort extends Error {
  constructor(public result: Extract<CheckoutResult, { ok: false }>) {
    super(result.reason);
  }
}

/**
 * Creates a PENDING order (ticket, food, seat hold) and sends the member to the payment provider.
 * Everything that can run out (ticket stock, food stock, code uses) is checked after locking the rows involved,
 * so concurrent buyers can't oversell.
 */
export async function startCheckout(actor: Actor, input: CheckoutInput, opts: { ip?: string | null; now?: Date } = {}): Promise<CheckoutResult> {
  assertCan(actor, input.ticketTypeId ? "ticket:buy" : "food:buy");
  const now = opts.now ?? new Date();
  if (!(await rateLimit(`checkout:user:${actor.id}`, LIMITS.checkout)).ok) return { ok: false, reason: "rateLimited" };

  // A new attempt replaces the member's own unpaid order for this event (frees their ticket, seat hold, food).
  const own = await db.order.findMany({ where: { userId: actor.id, eventId: input.eventId, status: "PENDING" }, select: { id: true } });
  for (const o of own) await expireOrder(o.id, { force: true });

  let created: { orderId: string; number: string; quote: Quote; ticketId: string | null; totalOre: number; expiresAt: Date };
  try {
    created = await db.$transaction(async (tx) => {
      // Lock what could run out, in a fixed order (no deadlocks between concurrent buyers).
      if (input.ticketTypeId) await tx.$queryRaw`SELECT 1 FROM "TicketType" WHERE "id" = ${input.ticketTypeId} FOR UPDATE`;
      for (const id of [...new Set(input.food.map((f) => f.packageId))].sort()) await tx.$queryRaw`SELECT 1 FROM "FoodPackage" WHERE "id" = ${id} FOR UPDATE`;
      if (input.discountCode?.trim()) {
        await tx.$queryRaw`SELECT 1 FROM "DiscountCode" WHERE "eventId" = ${input.eventId} AND lower("code") = lower(${input.discountCode.trim()}) FOR UPDATE`;
      }

      const q = await buildQuote(tx, actor.id, input, { now, requireSeat: !input.allowNoSeat });
      if (!q.ok) throw new Abort({ ok: false, reason: q.reason, detail: q.detail });
      const quote = q.quote;
      const expiresAt = new Date(now.getTime() + env().SEAT_HOLD_MINUTES * 60_000);

      const order = await tx.order.create({
        data: {
          number: await nextOrderNumber(tx, now),
          userId: actor.id,
          eventId: quote.event.id,
          status: "PENDING",
          subtotalOre: quote.subtotalOre,
          discountOre: quote.discountOre,
          totalOre: quote.totalOre,
          discountCodeId: quote.code?.id ?? null,
          expiresAt,
          items: { create: quote.lines.map((l) => ({ kind: l.kind, description: l.description, unitPriceOre: l.priceOre, quantity: 1, ticketTypeId: l.ticketTypeId, foodPackageId: l.foodPackageId, foodVariantId: l.foodVariantId })) },
        },
      });

      let ticketId: string | null = quote.activeTicketId;
      if (quote.ticketType) {
        const t = await tx.ticket.create({
          data: { eventId: quote.event.id, userId: actor.id, ticketTypeId: quote.ticketType.id, orderId: order.id, status: "PENDING", qrNonce: randomBytes(12).toString("hex") },
        });
        ticketId = t.id;
      } else if (!ticketId) {
        // food on top of an unpaid ticket can't happen: those orders were just replaced
        throw new Abort({ ok: false, reason: "noTicketForFood" });
      }
      for (const f of quote.food) {
        await tx.foodPurchase.create({
          data: { orderId: order.id, ticketId: ticketId!, packageId: f.pkg.id, variantId: f.variant.id, allergiesSnapshot: quote.user.allergies, status: "PENDING" },
        });
      }
      return { orderId: order.id, number: order.number, quote, ticketId: quote.ticketType ? ticketId : null, totalOre: order.totalOre, expiresAt };
    }, { timeout: 30_000 });
  } catch (e) {
    if (e instanceof Abort) return e.result;
    // the partial unique index (one active ticket per member per event) caught a concurrent double submit
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "alreadyHasTicket" };
    throw e;
  }

  const abandon = async () => {
    await db.$transaction(async (tx) => {
      await tx.seatClaim.deleteMany({ where: { ticketId: created.ticketId ?? "-" } });
      await tx.foodPurchase.deleteMany({ where: { orderId: created.orderId } });
      await tx.ticket.deleteMany({ where: { orderId: created.orderId } });
      await tx.order.delete({ where: { id: created.orderId } }); // never paid, so nothing to keep for bookkeeping
    });
  };

  // ---- seat hold (30 min, same as the order)
  if (input.seatId && created.ticketId) {
    const r = await claimSeat({ seatId: input.seatId, ticketId: created.ticketId, status: "HELD", expiresAt: created.expiresAt, now });
    if (!r.ok) {
      await abandon();
      return { ok: false, reason: "seatUnavailable", detail: r.reason };
    }
  }

  // ---- free order (e.g. Crew with a 100 % code): no provider involved
  if (created.totalOre === 0) {
    await fulfillOrder(created.orderId, { provider: "none", paymentRef: null, amountOre: 0 });
    return { ok: true, kind: "free", orderNumber: created.number };
  }

  // ---- payment session
  const provider = getPaymentProvider();
  try {
    const session = await provider.createCheckoutSession({
      orderId: created.orderId,
      orderNumber: created.number,
      customerEmail: created.quote.user.email,
      locale: input.locale,
      lines: created.quote.lines.map((l, i) => ({ name: l.description, amountOre: created.quote.netPerLine[i]! })),
      totalOre: created.totalOre,
      successUrl: appUrl(input.locale, `/my/orders/${created.number}?checkout=success`),
      cancelUrl: appUrl(input.locale, `/events/${created.quote.event.slug}?checkout=cancelled`),
      expiresAt: created.expiresAt,
    });
    await db.payment.create({
      data: { orderId: created.orderId, provider: provider.name, providerRef: session.sessionId, kind: "CHARGE", amountOre: created.totalOre, status: "pending", raw: { url: session.url, seatId: input.seatId ?? null } },
    });
    return { ok: true, kind: "redirect", url: session.url, orderNumber: created.number };
  } catch (e) {
    console.error(`[checkout] provider failed for ${created.number}`, e);
    await expireOrder(created.orderId, { force: true });
    return { ok: false, reason: "providerError", detail: e instanceof Error ? e.message : String(e) };
  }
}
