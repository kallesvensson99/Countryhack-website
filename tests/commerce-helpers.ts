import { db } from "@/lib/db";
import type { Actor } from "@/lib/permissions";
import type { CheckoutSession, CreateSessionInput, PaymentProvider, ProviderEvent, RefundInput } from "@/lib/payments";
import { makeEvent, makeUser } from "./helpers";

/** In-memory PaymentProvider for tests: records calls, can be told to fail. */
export class FakeProvider implements PaymentProvider {
  readonly name = "fake";
  sessions: CreateSessionInput[] = [];
  expired: string[] = [];
  refunds: RefundInput[] = [];
  failCreate = false;
  failExpire = false;
  failRefund = false;

  async createCheckoutSession(input: CreateSessionInput): Promise<CheckoutSession> {
    if (this.failCreate) throw new Error("provider down");
    this.sessions.push(input);
    return { sessionId: `cs_${input.orderId}`, url: `https://pay.test/${input.orderId}` };
  }
  async expireSession(sessionId: string) {
    if (this.failExpire) throw new Error("cannot expire");
    this.expired.push(sessionId);
  }
  async refund(input: RefundInput) {
    if (this.failRefund) throw new Error("refund rejected");
    this.refunds.push(input);
    return { refundId: `re_${this.refunds.length}` };
  }
  parseWebhook(): ProviderEvent {
    throw new Error("not used");
  }
}

export const actorOf = (u: { id: string; emailVerifiedAt: Date | null; tags?: { tag: "ADMIN" | "FESTIVALLEDARE" }[] }): Actor => ({
  id: u.id,
  emailVerifiedAt: u.emailVerifiedAt,
  tags: (u.tags ?? []).map((t) => t.tag),
});

let n = 0;

/** A published event (registration open) with chart, ticket types, meals, food packages and discount codes. */
export async function shop() {
  const flUser = await makeUser({ tags: ["FESTIVALLEDARE"] });
  const fl = actorOf(flUser);
  const event = await makeEvent(flUser.id); // starts 2027-03-12, registration open since 2026-01-01
  const chart = await db.seatingChart.create({ data: { eventId: event.id, name: "Karta" } });
  const std = await db.seatZone.create({ data: { chartId: chart.id, name: "Standard", color: "#0072B2" } });
  const vip = await db.seatZone.create({ data: { chartId: chart.id, name: "VIP", color: "#E69F00" } });
  const seats: Record<string, string> = {};
  for (const [i, label] of ["A1", "A2", "A3", "A4", "V1"].entries()) {
    seats[label] = (await db.seat.create({ data: { chartId: chart.id, label, x: 40 + i * 40, y: 40, zoneId: label === "V1" ? vip.id : std.id } })).id;
  }
  const mk = (name: string, priceOre: number, quantity: number, extra: Record<string, unknown> = {}, zones: string[] = []) =>
    db.ticketType.create({ data: { eventId: event.id, name, priceOre, quantity, ...extra, zones: { create: zones.map((zoneId) => ({ zoneId })) } } });
  const types = {
    std: await mk("Standard", 15000, 5, {}, [std.id]),
    vip: await mk("VIP", 25000, 2, {}, [vip.id]),
    crew: await mk("Crew", 0, 3, { hidden: true, requiresDiscountCode: true }),
    visitor: await mk("Besökare", 5000, 50, { includesSeat: false }),
    paidHidden: await mk("Hemlig", 10000, 5, { hidden: true }),
  };

  const meals = {
    fri: await db.meal.create({ data: { eventId: event.id, name: "Fredagsmiddag", servedAt: new Date("2027-03-12T17:00:00Z") } }),
    sat: await db.meal.create({ data: { eventId: event.id, name: "Lördagslunch", servedAt: new Date("2027-03-13T11:00:00Z") } }),
  };
  const deadline = new Date("2027-03-05T00:00:00Z");
  const helhelg = await db.foodPackage.create({
    data: { eventId: event.id, name: "Helhelg", priceOre: 30000, quantity: 2, salesEndsAt: deadline, meals: { create: [{ mealId: meals.fri.id }, { mealId: meals.sat.id }] }, variants: { create: [{ name: "Standard", sortOrder: 0 }, { name: "Vegansk", sortOrder: 1 }] } },
    include: { variants: true },
  });
  const frukost = await db.foodPackage.create({
    data: { eventId: event.id, name: "Frukost", priceOre: 8000, salesEndsAt: deadline, meals: { create: [{ mealId: meals.sat.id }] }, variants: { create: [{ name: "Standard" }] } },
    include: { variants: true },
  });
  const expired = await db.foodPackage.create({
    data: { eventId: event.id, name: "Försent", priceOre: 1000, salesEndsAt: new Date("2026-01-02T00:00:00Z"), variants: { create: [{ name: "Standard" }] } },
    include: { variants: true },
  });
  const food = { helhelg, frukost, expired, hv: (p: typeof helhelg, name = "Standard") => p.variants.find((v) => v.name === name)!.id };

  const mkCode = (code: string, over: Record<string, unknown> = {}, unlock: string[] = []) =>
    db.discountCode.create({ data: { eventId: event.id, code, kind: "PERCENT", value: 10, appliesTo: "ALL", ...over, ticketTypes: { create: unlock.map((ticketTypeId) => ({ ticketTypeId })) } } });
  const codes = {
    early: await mkCode("EARLY10"),
    crew: await mkCode("CREW", { value: 100 }, [types.crew.id, types.paidHidden.id]),
    fixed: await mkCode("MINUS50", { kind: "FIXED", value: 5000, appliesTo: "TICKETS" }),
    foodOnly: await mkCode("MAT20", { value: 20, appliesTo: "FOOD" }),
    one: await mkCode("ONCE", { maxUses: 1 }),
  };

  const buyer = async (opts: Parameters<typeof makeUser>[0] = {}) => {
    const u = await makeUser({ ...opts });
    await db.user.update({ where: { id: u.id }, data: { allergies: opts.nickname === "nut" ? "nötter" : null } });
    return { user: u, actor: actorOf({ ...u, tags: [] }) };
  };
  const input = (over: Partial<Parameters<typeof import("@/lib/orders/checkout").startCheckout>[1]> = {}) => ({
    eventId: event.id, ticketTypeId: types.std.id, seatId: null, discountCode: null, food: [], locale: "sv" as const, ...over,
  });
  return { fl, flUser, event, chart, std, vip, seats, types, meals, food, codes, buyer, input, next: () => ++n };
}

export type Shop = Awaited<ReturnType<typeof shop>>;

import { startCheckout } from "@/lib/orders/checkout";
import { handleProviderEvent } from "@/lib/orders/webhooks";

/** A member who buys through the real checkout and whose payment webhook arrives: ACTIVE ticket, confirmed seat/food. */
export async function buyPaid(s: Shop, over: Parameters<Shop["input"]>[0] = {}, opts: Parameters<Shop["buyer"]>[0] & { allergies?: string | null; realName?: string } = {}) {
  const { allergies, realName, ...userOpts } = opts;
  const b = await s.buyer(userOpts);
  if (allergies !== undefined || realName) await db.user.update({ where: { id: b.user.id }, data: { ...(allergies !== undefined ? { allergies } : {}), ...(realName ? { realName } : {}) } });
  const r = await startCheckout(b.actor, s.input(over));
  if (!r.ok) throw new Error(`checkout failed: ${r.reason}`);
  const order = await db.order.findUniqueOrThrow({ where: { number: r.orderNumber } });
  await handleProviderEvent("fake", { type: "checkout.paid", id: `evt_${order.id}`, orderId: order.id, sessionId: `cs_${order.id}`, paymentRef: `pi_${order.id}`, amountOre: order.totalOre });
  const ticket = await db.ticket.findFirstOrThrow({ where: { userId: b.user.id, eventId: s.event.id } });
  return { ...b, order, ticket };
}
