import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ccss_test" });

/** The seeded users log in many times per run; clear the login rate limiter between tests. */
export async function resetRateLimits() {
  await prisma.rateLimit.deleteMany();
}

export const db = prisma;
export const SLUG = "ccss-lan-hostlan";

/** Removes a member's tickets/orders/food for the seeded event so a test can start clean. */
export async function wipeAttendee(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const event = await prisma.event.findUniqueOrThrow({ where: { slug: SLUG } });
  const orders = await prisma.order.findMany({ where: { userId: user.id, eventId: event.id }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await prisma.mealCollection.deleteMany({ where: { foodPurchase: { ticket: { userId: user.id, eventId: event.id } } } });
  await prisma.seatClaim.deleteMany({ where: { ticket: { userId: user.id, eventId: event.id } } });
  await prisma.foodPurchase.deleteMany({ where: { ticket: { userId: user.id, eventId: event.id } } });
  await prisma.ticket.deleteMany({ where: { userId: user.id, eventId: event.id } });
  await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
  return { user, event };
}

/** A paid, ACTIVE ticket (optionally with a breakfast package) for a seeded member. */
export async function makeAttendee(email: string, opts: { allergies?: string | null; food?: boolean } = {}) {
  const { user, event } = await wipeAttendee(email);
  if (opts.allergies !== undefined) await prisma.user.update({ where: { id: user.id }, data: { allergies: opts.allergies } });
  const type = await prisma.ticketType.findFirstOrThrow({ where: { eventId: event.id, name: "Standard med plats" } });
  const order = await prisma.order.create({ data: { number: `E2E-D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, userId: user.id, eventId: event.id, status: "PAID", subtotalOre: 15000, totalOre: 15000, expiresAt: new Date(), paidAt: new Date() } });
  const ticket = await prisma.ticket.create({ data: { eventId: event.id, userId: user.id, ticketTypeId: type.id, orderId: order.id, status: "ACTIVE", qrNonce: Math.random().toString(16).slice(2, 14).padEnd(24, "0") } });
  if (opts.food) {
    const pkg = await prisma.foodPackage.findFirstOrThrow({ where: { eventId: event.id, name: "Frukostpaket" }, include: { variants: { orderBy: { sortOrder: "asc" } } } });
    await prisma.foodPurchase.create({ data: { orderId: order.id, ticketId: ticket.id, packageId: pkg.id, variantId: pkg.variants[0]!.id, allergiesSnapshot: opts.allergies ?? null, status: "ACTIVE" } });
  }
  return { user, event, ticket, order };
}
