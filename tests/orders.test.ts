import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setEmailSender, type OutgoingEmail } from "@/lib/email/sender";
import { processOutbox } from "@/lib/email/outbox";
import { startCheckout, previewQuote } from "@/lib/orders/checkout";
import { expireDueOrders, expireOrder } from "@/lib/orders/expire";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { computeDiscount, computeTotals } from "@/lib/orders/pricing";
import { cancelOrder } from "@/lib/orders/refund";
import { handleProviderEvent } from "@/lib/orders/webhooks";
import { claimSeat } from "@/lib/seating/claims";
import { ForbiddenError } from "@/lib/permissions";
import { setPaymentProvider } from "@/lib/payments";
import { FakeProvider, actorOf, shop, type Shop } from "./commerce-helpers";
import { makeUser, resetDb } from "./helpers";

let provider: FakeProvider;
beforeEach(async () => {
  await resetDb();
  provider = new FakeProvider();
  setPaymentProvider(provider);
});
afterEach(() => {
  setPaymentProvider(undefined);
  setEmailSender(undefined);
});

const paidEvent = (orderId: string, amountOre: number, id = `evt_${orderId}`) =>
  ({ type: "checkout.paid", id, orderId, sessionId: `cs_${orderId}`, paymentRef: `pi_${orderId}`, amountOre }) as const;

/** Buys through the real checkout and delivers the "paid" webhook. */
async function buy(s: Shop, over: Parameters<Shop["input"]>[0] = {}, opts: { nickname?: string } = {}) {
  const b = await s.buyer(opts);
  const r = await startCheckout(b.actor, s.input(over));
  if (!r.ok) throw new Error(`checkout failed: ${r.reason}`);
  const order = await db.order.findUniqueOrThrow({ where: { number: r.orderNumber } });
  return { ...b, order, result: r };
}
async function pay(orderId: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  return handleProviderEvent("fake", paidEvent(orderId, o.totalOre));
}

describe("pricing (pure)", () => {
  const T = (priceOre: number) => ({ kind: "TICKET" as const, priceOre });
  const F = (priceOre: number) => ({ kind: "FOOD" as const, priceOre });
  const pct = (value: number, appliesTo: "ALL" | "TICKETS" | "FOOD" = "ALL") => ({ kind: "PERCENT" as const, value, appliesTo });

  it("rounds percentages down and never discounts more than the eligible amount", () => {
    expect(computeDiscount([T(14950)], pct(10)).discountOre).toBe(1495);
    expect(computeDiscount([T(999)], pct(10)).discountOre).toBe(99); // floor(99.9)
    expect(computeDiscount([T(1000)], pct(100)).discountOre).toBe(1000);
    expect(computeDiscount([T(1000)], { kind: "FIXED", value: 5000, appliesTo: "ALL" }).discountOre).toBe(1000);
    expect(computeDiscount([T(1000)], null).discountOre).toBe(0);
  });

  it("respects what the code applies to", () => {
    const lines = [T(15000), F(30000)];
    expect(computeDiscount(lines, pct(10, "TICKETS")).discountOre).toBe(1500);
    expect(computeDiscount(lines, pct(10, "FOOD")).discountOre).toBe(3000);
    expect(computeDiscount(lines, pct(10, "ALL")).discountOre).toBe(4500);
    expect(computeDiscount([T(1000)], pct(50, "FOOD")).discountOre).toBe(0); // nothing eligible
  });

  it("allocates the discount over lines so the parts sum exactly", () => {
    for (const [prices, value] of [[[333, 333, 334], 10], [[101, 202, 303], 33], [[1, 1, 1], 50], [[15000, 8000, 30000], 7]] as const) {
      const d = computeDiscount(prices.map(T), pct(value));
      expect(d.perLine.reduce((a, b) => a + b, 0)).toBe(d.discountOre);
      d.perLine.forEach((x, i) => expect(x).toBeLessThanOrEqual(prices[i]!));
    }
    const t = computeTotals([T(15000), F(8000)], { kind: "FIXED", value: 5000, appliesTo: "TICKETS" });
    expect(t).toMatchObject({ subtotalOre: 23000, discountOre: 5000, totalOre: 18000, netPerLine: [10000, 8000] });
    expect(t.netPerLine.reduce((a, b) => a + b, 0)).toBe(t.totalOre);
  });
});

describe("checkout: happy path", () => {
  it("creates a PENDING order with ticket, food, discount, seat hold and a provider session", async () => {
    const s = await shop();
    const b = await s.buyer({ nickname: "nut" });
    const now = new Date();
    const r = await startCheckout(b.actor, s.input({ seatId: s.seats.A2!, discountCode: "early10", food: [{ packageId: s.food.helhelg.id, variantId: s.food.hv(s.food.helhelg, "Vegansk") }] }), { now });
    expect(r).toMatchObject({ ok: true, kind: "redirect" });
    if (!r.ok || r.kind !== "redirect") return;
    expect(r.orderNumber).toMatch(/^CCSS-\d{4}-0001$/);
    expect(r.url).toMatch(/^https:\/\/pay\.test\//);

    const order = await db.order.findUniqueOrThrow({ where: { number: r.orderNumber }, include: { items: true, tickets: true, foodPurchases: true, payments: true, discountCode: true } });
    expect(order).toMatchObject({ status: "PENDING", subtotalOre: 45000, discountOre: 4500, totalOre: 40500, userId: b.user.id });
    expect(order.discountCode?.code).toBe("EARLY10");
    expect(order.expiresAt.getTime() - now.getTime()).toBe(30 * 60_000);
    expect(order.items.map((i) => [i.kind, i.description, i.unitPriceOre]).sort()).toEqual([["FOOD", "Helhelg – Vegansk", 30000], ["TICKET", "Standard", 15000]]);
    expect(order.tickets).toMatchObject([{ status: "PENDING", userId: b.user.id }]);
    expect(order.tickets[0]!.qrNonce).toHaveLength(24);
    expect(order.foodPurchases).toMatchObject([{ status: "PENDING", allergiesSnapshot: "nötter" }]); // snapshot of the profile
    expect(order.payments).toMatchObject([{ kind: "CHARGE", status: "pending", providerRef: `cs_${order.id}`, amountOre: 40500 }]);

    const claim = await db.seatClaim.findUniqueOrThrow({ where: { ticketId: order.tickets[0]!.id } });
    expect(claim).toMatchObject({ seatId: s.seats.A2, status: "HELD" });
    expect(claim.expiresAt).toEqual(order.expiresAt);

    // the provider got line items after discount that add up to the total
    const session = provider.sessions[0]!;
    expect(session.lines.reduce((sum, l) => sum + l.amountOre, 0)).toBe(40500);
    expect(session).toMatchObject({ orderNumber: r.orderNumber, totalOre: 40500, customerEmail: b.user.email, locale: "sv" });
    expect(session.successUrl).toContain(`/sv/my/orders/${r.orderNumber}`);
  });

  it("numbers orders sequentially", async () => {
    const s = await shop();
    const a = await buy(s);
    const b = await buy(s);
    const year = new Date().getFullYear();
    expect(a.order.number).toBe(`CCSS-${year}-0001`);
    expect(b.order.number).toBe(`CCSS-${year}-0002`);
  });

  it("previews prices without writing anything", async () => {
    const s = await shop();
    const b = await s.buyer();
    const q = await previewQuote(b.actor, s.input({ discountCode: "MINUS50", food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] }));
    expect(q).toMatchObject({ ok: true, quote: { subtotalOre: 23000, discountOre: 5000, totalOre: 18000 } });
    expect(await db.order.count()).toBe(0);
    expect(await db.ticket.count()).toBe(0);
  });

  it("food can be added later to an existing ticket (food-only order)", async () => {
    const s = await shop();
    const first = await buy(s);
    await pay(first.order.id);
    const r = await startCheckout(first.actor, s.input({ ticketTypeId: null, food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] }));
    expect(r.ok).toBe(true);
    const ticket = await db.ticket.findFirstOrThrow({ where: { userId: first.user.id } });
    expect(await db.ticket.count({ where: { userId: first.user.id } })).toBe(1);
    expect(await db.foodPurchase.findFirstOrThrow({ where: { ticketId: ticket.id, status: "PENDING" } })).toMatchObject({ packageId: s.food.frukost.id });
    // …but not the same package twice
    await pay((await db.order.findFirstOrThrow({ where: { userId: first.user.id, status: "PENDING" } })).id);
    expect(await startCheckout(first.actor, s.input({ ticketTypeId: null, food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] }))).toMatchObject({ ok: false, reason: "foodDuplicate" });
  });
});

describe("checkout: rules", () => {
  const reason = async (s: Shop, actor: ReturnType<typeof actorOf>, over: Parameters<Shop["input"]>[0]) => {
    const r = await startCheckout(actor, s.input(over));
    return r.ok ? "ok" : r.reason;
  };

  it("applies the birth-year age rule (event starts 2027, minAge 14)", async () => {
    const s = await shop();
    const old = await s.buyer({ birthDate: "2013-12-31" }); // turns 14 during 2027
    const young = await s.buyer({ birthDate: "2014-01-01" }); // turns 14 in 2028
    expect(await reason(s, young.actor, {})).toBe("tooYoung");
    expect(await reason(s, old.actor, {})).toBe("ok");
    expect(await db.ticket.count({ where: { userId: young.user.id } })).toBe(0);
  });

  it("enforces the registration window and ticket sales windows", async () => {
    const s = await shop();
    const b = await s.buyer();
    const before = new Date("2025-12-31T00:00:00Z");
    const after = new Date("2027-03-13T00:00:00Z");
    expect((await startCheckout(b.actor, s.input(), { now: before }))).toMatchObject({ ok: false, reason: "registrationClosed" });
    expect((await startCheckout(b.actor, s.input(), { now: after }))).toMatchObject({ ok: false, reason: "registrationClosed" });
    await db.ticketType.update({ where: { id: s.types.std.id }, data: { salesStartsAt: new Date("2030-01-01T00:00:00Z") } });
    expect(await reason(s, b.actor, {})).toBe("ticketNotOnSale");
    await db.ticketType.update({ where: { id: s.types.std.id }, data: { salesStartsAt: null, salesEndsAt: new Date("2026-02-01T00:00:00Z") } });
    expect(await reason(s, b.actor, {})).toBe("ticketNotOnSale");
  });

  it("only sells published events", async () => {
    const s = await shop();
    const b = await s.buyer();
    for (const status of ["DRAFT", "CLOSED", "CANCELLED"] as const) {
      await db.event.update({ where: { id: s.event.id }, data: { status } });
      expect(await reason(s, b.actor, {})).toBe("eventNotOpen");
    }
  });

  it("gates hidden / code-only ticket types behind a code that unlocks them", async () => {
    const s = await shop();
    const a = await s.buyer();
    expect(await reason(s, a.actor, { ticketTypeId: s.types.crew.id })).toBe("needsCode");
    expect(await reason(s, a.actor, { ticketTypeId: s.types.paidHidden.id })).toBe("needsCode");
    expect(await reason(s, a.actor, { ticketTypeId: s.types.crew.id, discountCode: "EARLY10" })).toBe("needsCode"); // valid code, but doesn't unlock Crew
    expect(await reason(s, a.actor, { ticketTypeId: s.types.paidHidden.id, discountCode: "crew" })).toBe("ok"); // case-insensitive
  });

  it("allows one active ticket per member per event", async () => {
    const s = await shop();
    const first = await buy(s);
    await pay(first.order.id);
    expect(await reason(s, first.actor, {})).toBe("alreadyHasTicket");
    expect(await reason(s, first.actor, { ticketTypeId: s.types.visitor.id })).toBe("alreadyHasTicket");
  });

  it("a double submit by the same member creates exactly one order", async () => {
    const s = await shop();
    const b = await s.buyer();
    const results = await Promise.all([1, 2, 3, 4].map(() => startCheckout(b.actor, s.input())));
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(await db.ticket.count({ where: { userId: b.user.id, status: { not: "CANCELLED" } } })).toBe(1);
    expect(await db.order.count({ where: { userId: b.user.id, status: "PENDING" } })).toBeLessThanOrEqual(1);
  });

  it("starting over replaces the member's own unpaid order (ticket, seat hold, session)", async () => {
    const s = await shop();
    const b = await s.buyer();
    const first = await startCheckout(b.actor, s.input({ seatId: s.seats.A1! }));
    expect(first.ok).toBe(true);
    const second = await startCheckout(b.actor, s.input({ seatId: s.seats.A1!, ticketTypeId: s.types.visitor.id, discountCode: null }));
    // visitor tickets have no seat → seat on a no-seat ticket is rejected, and the first order was already replaced
    expect(second).toMatchObject({ ok: false, reason: "seatNeedsTicket" });
    const orders = await db.order.findMany({ where: { userId: b.user.id }, orderBy: { createdAt: "asc" }, include: { tickets: true } });
    expect(orders[0]).toMatchObject({ status: "EXPIRED" });
    expect(orders[0]!.tickets[0]!.status).toBe("CANCELLED");
    expect(await db.seatClaim.count()).toBe(0);
    expect(provider.expired).toEqual([`cs_${orders[0]!.id}`]);

    const third = await startCheckout(b.actor, s.input({ seatId: s.seats.A1! }));
    expect(third.ok).toBe(true); // the seat is free again
  });

  it("food: needs a ticket, respects deadline, stock and duplicates", async () => {
    const s = await shop();
    const b = await s.buyer();
    const food = (p: typeof s.food.helhelg) => [{ packageId: p.id, variantId: s.food.hv(p) }];
    expect(await reason(s, b.actor, { ticketTypeId: null, food: food(s.food.frukost) })).toBe("noTicketForFood");
    expect(await reason(s, b.actor, { food: food(s.food.expired) })).toBe("foodNotOnSale");
    expect(await reason(s, b.actor, { food: [...food(s.food.frukost), ...food(s.food.frukost)] })).toBe("foodDuplicate");
    expect(await reason(s, b.actor, { food: [{ packageId: s.food.helhelg.id, variantId: s.food.hv(s.food.frukost) }] })).toBe("foodInvalid"); // variant of another package

    // Helhelg has quantity 2
    for (let i = 0; i < 2; i++) {
      const x = await s.buyer();
      expect((await startCheckout(x.actor, s.input({ food: food(s.food.helhelg) }))).ok).toBe(true);
    }
    expect(await reason(s, b.actor, { food: food(s.food.helhelg) })).toBe("foodSoldOut");
  });

  it("rejects bad discount codes", async () => {
    const s = await shop();
    const b = await s.buyer();
    expect(await reason(s, b.actor, { discountCode: "NOPE" })).toBe("codeUnknown");
    await db.discountCode.update({ where: { id: s.codes.early.id }, data: { validFrom: new Date("2030-01-01T00:00:00Z") } });
    expect(await reason(s, b.actor, { discountCode: "EARLY10" })).toBe("codeNotYetValid");
    await db.discountCode.update({ where: { id: s.codes.early.id }, data: { validFrom: null, validUntil: new Date("2026-02-01T00:00:00Z") } });
    expect(await reason(s, b.actor, { discountCode: "EARLY10" })).toBe("codeExpired");
    await db.discountCode.update({ where: { id: s.codes.early.id }, data: { validUntil: null } });
    expect(await reason(s, b.actor, { discountCode: " early10 " })).toBe("ok");
  });

  it("maxUses counts pending orders too: parallel buyers can't overshoot", async () => {
    const s = await shop();
    const buyers = await Promise.all(Array.from({ length: 6 }, () => s.buyer()));
    const results = await Promise.all(buyers.map((b) => startCheckout(b.actor, s.input({ discountCode: "ONCE" }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "codeExhausted")).toHaveLength(5);
  });

  it("selling the last tickets: 10 parallel buyers for 5 tickets → exactly 5 orders", async () => {
    const s = await shop(); // Standard has quantity 5
    const buyers = await Promise.all(Array.from({ length: 10 }, () => s.buyer()));
    const results = await Promise.all(buyers.map((b) => startCheckout(b.actor, s.input())));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "soldOut")).toHaveLength(5);
    expect(await db.ticket.count({ where: { ticketTypeId: s.types.std.id, status: { not: "CANCELLED" } } })).toBe(5);
  });

  it("food stock under concurrency: 8 buyers for 2 Helhelg → exactly 2", async () => {
    const s = await shop();
    const buyers = await Promise.all(Array.from({ length: 8 }, () => s.buyer()));
    const results = await Promise.all(buyers.map((b) => startCheckout(b.actor, s.input({ food: [{ packageId: s.food.helhelg.id, variantId: s.food.hv(s.food.helhelg) }] }))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await db.foodPurchase.count({ where: { packageId: s.food.helhelg.id, status: { not: "CANCELLED" } } })).toBe(2);
  });

  it("seats: zone, blocked, taken (race lost → order removed cleanly)", async () => {
    const s = await shop();
    const b = await s.buyer();
    expect(await reason(s, b.actor, { seatId: s.seats.V1! })).toBe("seatInvalid"); // Standard ticket, VIP seat
    await db.seat.update({ where: { id: s.seats.A3 }, data: { blocked: true } });
    expect(await reason(s, b.actor, { seatId: s.seats.A3! })).toBe("seatInvalid");

    const other = await s.buyer();
    const first = await startCheckout(other.actor, s.input({ seatId: s.seats.A1! }));
    expect(first.ok).toBe(true);
    const r = await startCheckout(b.actor, s.input({ seatId: s.seats.A1! }));
    expect(r).toMatchObject({ ok: false, reason: "seatUnavailable", detail: "taken" });
    expect(await db.order.count({ where: { userId: b.user.id } })).toBe(0); // nothing left behind
    expect(await db.ticket.count({ where: { userId: b.user.id } })).toBe(0);
    expect(await db.seatClaim.count()).toBe(1);
    // 20 racing for one seat: one wins
    const racers = await Promise.all(Array.from({ length: 4 }, () => s.buyer()));
    const results = await Promise.all(racers.map((x) => startCheckout(x.actor, s.input({ seatId: s.seats.A4! }))));
    expect(results.filter((x) => x.ok)).toHaveLength(1);
  });

  it("is forbidden for unverified members; provider errors leave nothing behind", async () => {
    const s = await shop();
    const u = await makeUser({ verified: false });
    await expect(startCheckout(actorOf({ ...u, tags: [] }), s.input())).rejects.toBeInstanceOf(ForbiddenError);

    const b = await s.buyer();
    provider.failCreate = true;
    const r = await startCheckout(b.actor, s.input({ seatId: s.seats.A1! }));
    expect(r).toMatchObject({ ok: false, reason: "providerError" });
    expect(await db.order.findFirstOrThrow({ where: { userId: b.user.id } })).toMatchObject({ status: "EXPIRED" });
    expect(await db.ticket.count({ where: { userId: b.user.id, status: { not: "CANCELLED" } } })).toBe(0);
    expect(await db.seatClaim.count()).toBe(0);
    provider.failCreate = false;
    expect((await startCheckout(b.actor, s.input())).ok).toBe(true); // can simply try again
  });

  it("is rate limited", async () => {
    const s = await shop();
    const b = await s.buyer();
    let last;
    for (let i = 0; i < 31; i++) last = await startCheckout(b.actor, s.input({ ticketTypeId: s.types.visitor.id }));
    expect(last).toMatchObject({ ok: false, reason: "rateLimited" });
  });
});

describe("free orders (Crew with a 100 % code)", () => {
  it("complete without a provider: PAID, ticket ACTIVE, seat CONFIRMED, code use counted, receipt queued", async () => {
    const s = await shop();
    const b = await s.buyer();
    const r = await startCheckout(b.actor, s.input({ ticketTypeId: s.types.crew.id, discountCode: "CREW", seatId: s.seats.V1! }));
    expect(r).toMatchObject({ ok: true, kind: "free" });
    expect(provider.sessions).toHaveLength(0);
    const order = await db.order.findFirstOrThrow({ where: { userId: b.user.id }, include: { tickets: { include: { seatClaim: true } } } });
    expect(order).toMatchObject({ status: "PAID", totalOre: 0, discountOre: 0 + 0 });
    expect(order.tickets[0]).toMatchObject({ status: "ACTIVE" });
    expect(order.tickets[0]!.seatClaim).toMatchObject({ status: "CONFIRMED", expiresAt: null });
    expect((await db.discountCode.findUniqueOrThrow({ where: { id: s.codes.crew.id } })).usedCount).toBe(1);
    expect(await db.emailOutbox.count({ where: { template: "order-confirmation", to: b.user.email } })).toBe(1);
    expect(await db.payment.count()).toBe(0);
  });

  it("a code that fully covers ticket + food is free as well", async () => {
    const s = await shop();
    const b = await s.buyer();
    const r = await startCheckout(b.actor, s.input({ ticketTypeId: s.types.crew.id, discountCode: "CREW", food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] }));
    expect(r).toMatchObject({ ok: true, kind: "free" });
    expect(await db.foodPurchase.findFirstOrThrow({ where: { ticket: { userId: b.user.id } } })).toMatchObject({ status: "ACTIVE" });
    expect(await db.order.findFirstOrThrow({ where: { userId: b.user.id } })).toMatchObject({ subtotalOre: 8000, discountOre: 8000, totalOre: 0, status: "PAID" });
  });
});

describe("payment webhooks → fulfilment", () => {
  it("marks the order PAID and activates ticket, food and seat; queues a receipt with the ticket QR", async () => {
    const s = await shop();
    const b = await buy(s, { seatId: s.seats.A2!, discountCode: "EARLY10", food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] });
    expect(await pay(b.order.id)).toEqual({ status: "processed", outcome: "paid" });

    const o = await db.order.findUniqueOrThrow({ where: { id: b.order.id }, include: { tickets: { include: { seatClaim: true } }, foodPurchases: true, payments: true } });
    expect(o.status).toBe("PAID");
    expect(o.paidAt).not.toBeNull();
    expect(o.tickets[0]).toMatchObject({ status: "ACTIVE" });
    expect(o.tickets[0]!.seatClaim).toMatchObject({ status: "CONFIRMED", expiresAt: null });
    expect(o.foodPurchases[0]!.status).toBe("ACTIVE");
    expect(o.payments).toMatchObject([{ kind: "CHARGE", status: "succeeded", providerRef: `pi_${o.id}` }]);
    expect((await db.discountCode.findUniqueOrThrow({ where: { id: s.codes.early.id } })).usedCount).toBe(1);

    const sent: OutgoingEmail[] = [];
    setEmailSender({ send: async (m) => void sent.push(m) });
    await db.orgSettings.updateMany({ data: { orgNumber: "802000-1234", address: "Storgatan 1, Stad" } });
    await db.emailOutbox.deleteMany();
    await fulfillOrder(o.id, { provider: "fake", paymentRef: "x", amountOre: o.totalOre }); // already paid → no new mail
    expect(await db.emailOutbox.count()).toBe(0);
    // re-render the original receipt through the outbox
    const { loadReceipt, confirmationPayload } = await import("@/lib/orders/receipt");
    const { enqueueEmail } = await import("@/lib/email/outbox");
    await enqueueEmail(db, { to: b.user.email, template: "order-confirmation", locale: "sv", payload: confirmationPayload((await loadReceipt(db, o.id))!, "sv") });
    await processOutbox();
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.subject).toContain(o.number);
    expect(mail.html).toContain("Föreningen är inte momsregistrerad");
    expect(mail.html).toContain("Cable connectors spelsällskap (CCSS)");
    expect(mail.html).toContain("802000-1234");
    expect(mail.html).toContain("Storgatan 1, Stad");
    expect(mail.html).toContain("EARLY10");
    expect(mail.html).not.toMatch(/moms\s*\d|VAT\s*\d|25 ?%/i); // no VAT breakdown
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments![0]!.content.subarray(1, 4).toString()).toBe("PNG");
    expect(mail.attachments![0]!.cid).toBe("ticket-0");
    expect(mail.html).toContain("cid:ticket-0");
  });

  it("is idempotent: a redelivered event, or a second event for a paid order, changes nothing", async () => {
    const s = await shop();
    const b = await buy(s, { discountCode: "EARLY10" });
    const ev = paidEvent(b.order.id, b.order.totalOre);
    expect(await handleProviderEvent("fake", ev)).toMatchObject({ status: "processed", outcome: "paid" });
    expect(await handleProviderEvent("fake", ev)).toEqual({ status: "duplicate" });
    expect(await handleProviderEvent("fake", paidEvent(b.order.id, b.order.totalOre, "evt_other"))).toMatchObject({ outcome: "alreadyPaid" });
    expect((await db.discountCode.findUniqueOrThrow({ where: { id: s.codes.early.id } })).usedCount).toBe(1);
    expect(await db.emailOutbox.count({ where: { template: "order-confirmation" } })).toBe(1);
    expect(await db.webhookEvent.count()).toBe(2);
  });

  it("five simultaneous deliveries of the same event fulfil exactly once", async () => {
    const s = await shop();
    const b = await buy(s, { discountCode: "EARLY10" });
    await Promise.all(Array.from({ length: 5 }, () => handleProviderEvent("fake", paidEvent(b.order.id, b.order.totalOre))));
    expect((await db.discountCode.findUniqueOrThrow({ where: { id: s.codes.early.id } })).usedCount).toBe(1);
    expect(await db.emailOutbox.count({ where: { template: "order-confirmation" } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: b.order.id } })).toBe(1);
  });

  it("refuses to fulfil when the paid amount doesn't match the order", async () => {
    const s = await shop();
    const b = await buy(s);
    expect(await handleProviderEvent("fake", paidEvent(b.order.id, b.order.totalOre - 100))).toMatchObject({ outcome: "amountMismatch" });
    expect((await db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe("PENDING");
    expect(await db.auditLog.count({ where: { action: "order.amount_mismatch" } })).toBe(1);
  });

  it("ignores events of other kinds and unknown orders", async () => {
    expect(await handleProviderEvent("fake", { type: "ignored", id: "x" })).toEqual({ status: "ignored" });
    expect(await handleProviderEvent("fake", paidEvent("nope", 100))).toMatchObject({ status: "processed", outcome: "notFound" });
  });

  it("records (but never activates) a payment that arrives for a cancelled order", async () => {
    const s = await shop();
    const b = await buy(s);
    await pay(b.order.id);
    expect((await cancelOrder(s.fl, b.order.id, {})).ok).toBe(true);
    expect(await fulfillOrder(b.order.id, { provider: "fake", paymentRef: "pi_again", amountOre: b.order.totalOre })).toBe("ignored");
    expect(await db.ticket.count({ where: { userId: b.user.id, status: "ACTIVE" } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "order.payment_on_closed_order" } })).toBe(1);
  });
});

describe("late payments (order already expired)", () => {
  async function expiredOrder(s: Shop, over: Parameters<Shop["input"]>[0] = {}) {
    const b = await buy(s, over);
    expect(await expireOrder(b.order.id, { force: true })).toBe(true);
    return b;
  }

  it("re-activates ticket and food, and re-takes the seat if it's still free", async () => {
    const s = await shop();
    const b = await expiredOrder(s, { seatId: s.seats.A1!, food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] });
    expect(await db.seatClaim.count()).toBe(0);
    expect(await pay(b.order.id)).toEqual({ status: "processed", outcome: "latePaid" });
    const o = await db.order.findUniqueOrThrow({ where: { id: b.order.id }, include: { tickets: { include: { seatClaim: true } }, foodPurchases: true } });
    expect(o.status).toBe("PAID");
    expect(o.tickets[0]).toMatchObject({ status: "ACTIVE" });
    expect(o.tickets[0]!.seatClaim).toMatchObject({ seatId: s.seats.A1, status: "CONFIRMED" });
    expect(o.foodPurchases[0]!.status).toBe("ACTIVE");
    expect(await db.auditLog.count({ where: { action: "order.paid_late" } })).toBe(1);
    expect(await db.emailOutbox.count({ where: { template: "seat-needed" } })).toBe(0);
  });

  it("if the seat is gone: ticket active without a seat, 'pick a new seat' email queued, logged", async () => {
    const s = await shop();
    const b = await expiredOrder(s, { seatId: s.seats.A1! });
    const rival = await buy(s, { seatId: s.seats.A1! }); // someone takes the seat after the hold lapsed
    await pay(rival.order.id);

    expect(await pay(b.order.id)).toEqual({ status: "processed", outcome: "latePaid" });
    const t = await db.ticket.findFirstOrThrow({ where: { userId: b.user.id }, include: { seatClaim: true } });
    expect(t).toMatchObject({ status: "ACTIVE", seatClaim: null });
    const mail = await db.emailOutbox.findFirstOrThrow({ where: { template: "seat-needed" } });
    expect(mail.to).toBe(b.user.email);
    expect(await db.auditLog.count({ where: { action: "order.seat_lost" } })).toBe(1);
    // they can now choose a new seat as usual
    const { chooseSeat } = await import("@/lib/seating/booking");
    expect(await chooseSeat(b.actor, t.id, s.seats.A2!)).toMatchObject({ ok: true });
  });

  it("if the member bought a new ticket meanwhile: order is PAID, old ticket stays cancelled, flagged for manual refund", async () => {
    const s = await shop();
    const b = await expiredOrder(s);
    const second = await startCheckout(b.actor, s.input());
    expect(second.ok).toBe(true);
    await pay((await db.order.findFirstOrThrow({ where: { userId: b.user.id, status: "PENDING" } })).id);

    expect(await pay(b.order.id)).toMatchObject({ outcome: "latePaid" });
    expect((await db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe("PAID");
    expect(await db.ticket.count({ where: { userId: b.user.id, status: "ACTIVE" } })).toBe(1); // still exactly one
    expect(await db.auditLog.count({ where: { action: "order.late_payment_conflict" } })).toBe(1);
  });
});

describe("expiry (worker)", () => {
  it("expires only overdue unpaid orders and frees ticket, food, seat and the provider session", async () => {
    const s = await shop();
    const due = await buy(s, { seatId: s.seats.A1!, food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] });
    const fresh = await buy(s, { seatId: s.seats.A2! });
    const paid = await buy(s, { seatId: s.seats.A3! });
    await pay(paid.order.id);
    await db.order.update({ where: { id: due.order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await expireDueOrders()).toEqual({ expired: 1, sessionsClosed: 0 }); // the session is closed right when the order expires; the sweep only retries failures
    const o = await db.order.findUniqueOrThrow({ where: { id: due.order.id }, include: { tickets: true, foodPurchases: true, payments: true } });
    expect(o.status).toBe("EXPIRED");
    expect(o.tickets[0]!.status).toBe("CANCELLED");
    expect(o.foodPurchases[0]!.status).toBe("CANCELLED");
    expect(o.payments[0]!.status).toBe("expired");
    expect(provider.expired).toEqual([`cs_${due.order.id}`]);
    expect(await db.seatClaim.findMany({ select: { seatId: true } }).then((c) => c.map((x) => x.seatId).sort())).toEqual([s.seats.A2, s.seats.A3].sort());

    expect((await db.order.findUniqueOrThrow({ where: { id: fresh.order.id } })).status).toBe("PENDING");
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.order.id } })).status).toBe("PAID");
    // idempotent
    expect(await expireDueOrders()).toEqual({ expired: 0, sessionsClosed: 0 });
    // stock is back: the freed seat can be bought again
    const again = await s.buyer();
    expect((await startCheckout(again.actor, s.input({ seatId: s.seats.A1! }))).ok).toBe(true);
  });

  it("an order is expired even if closing the provider session fails — and the close is retried later", async () => {
    const s = await shop();
    const b = await buy(s);
    await db.order.update({ where: { id: b.order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    provider.failExpire = true;
    expect(await expireDueOrders()).toEqual({ expired: 1, sessionsClosed: 0 });
    expect((await db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe("EXPIRED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: b.order.id } })).status).toBe("pending");

    provider.failExpire = false;
    expect(await expireDueOrders()).toEqual({ expired: 0, sessionsClosed: 1 });
    expect((await db.payment.findFirstOrThrow({ where: { orderId: b.order.id } })).status).toBe("expired");
    expect(provider.expired).toEqual([`cs_${b.order.id}`]);
  });

  it("does not expire an order before its deadline", async () => {
    const s = await shop();
    const b = await buy(s);
    expect(await expireOrder(b.order.id)).toBe(false);
    expect(await expireOrder(b.order.id, { now: new Date(Date.now() + 31 * 60_000) })).toBe(true);
  });

  it("a hold lapses at the same moment as the order", async () => {
    const s = await shop();
    const b = await buy(s, { seatId: s.seats.A1! });
    const other = await s.buyer();
    const tk = await db.ticket.findFirstOrThrow({ where: { userId: b.user.id } });
    const later = new Date(b.order.expiresAt.getTime() + 1000);
    expect(await claimSeat({ seatId: s.seats.A1!, ticketId: tk.id, status: "CONFIRMED", now: later })).toMatchObject({ ok: false }); // own ticket already holds it
    void other;
    expect((await db.seatClaim.findUniqueOrThrow({ where: { ticketId: tk.id } })).expiresAt).toEqual(b.order.expiresAt);
  });
});

describe("cancel & refund (Festivalledare)", () => {
  it("full refund: provider called once with an idempotency key; order REFUNDED; ticket, food and seat released", async () => {
    const s = await shop();
    const b = await buy(s, { seatId: s.seats.A1!, discountCode: "EARLY10", food: [{ packageId: s.food.frukost.id, variantId: s.food.hv(s.food.frukost) }] });
    await pay(b.order.id);
    const r = await cancelOrder(s.fl, b.order.id, { ip: "5.5.5.5" });
    expect(r).toEqual({ ok: true, refundedOre: 20700, status: "REFUNDED" });
    expect(provider.refunds).toEqual([{ paymentRef: `pi_${b.order.id}`, amountOre: 20700, idempotencyKey: `refund-${b.order.id}-0-20700` }]);

    const o = await db.order.findUniqueOrThrow({ where: { id: b.order.id }, include: { tickets: true, foodPurchases: true, payments: true } });
    expect(o).toMatchObject({ status: "REFUNDED", cancelledById: s.fl.id });
    expect(o.cancelledAt).not.toBeNull();
    expect(o.tickets[0]!.status).toBe("CANCELLED");
    expect(o.foodPurchases[0]!.status).toBe("CANCELLED");
    expect(await db.seatClaim.count()).toBe(0);
    expect(o.payments.filter((p) => p.kind === "REFUND")).toMatchObject([{ amountOre: 20700, status: "succeeded", providerRef: "re_1" }]);
    expect((await db.discountCode.findUniqueOrThrow({ where: { id: s.codes.early.id } })).usedCount).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "order.cancel" } })).toMatchObject({ actorId: s.fl.id, eventId: s.event.id, ip: "5.5.5.5" });
    expect(await db.emailOutbox.count({ where: { template: "order-cancelled", to: b.user.email } })).toBe(1);

    // the member can buy again, and the cancelled order can't be refunded twice
    expect((await startCheckout(b.actor, s.input())).ok).toBe(true);
    expect(await cancelOrder(s.fl, b.order.id, {})).toEqual({ ok: false, reason: "notPaid" });
    expect(provider.refunds).toHaveLength(1);
  });

  it("partial refund: order CANCELLED (not REFUNDED) with the amount recorded", async () => {
    const s = await shop();
    const b = await buy(s);
    await pay(b.order.id);
    expect(await cancelOrder(s.fl, b.order.id, { refundOre: 10000 })).toEqual({ ok: true, refundedOre: 10000, status: "CANCELLED" });
    expect(provider.refunds[0]!.amountOre).toBe(10000);
    expect((await db.payment.findFirstOrThrow({ where: { orderId: b.order.id, kind: "REFUND" } })).amountOre).toBe(10000);
    expect(await db.ticket.count({ where: { userId: b.user.id, status: "ACTIVE" } })).toBe(0);
  });

  it("validates the amount; a failing provider leaves everything untouched and can be retried", async () => {
    const s = await shop();
    const b = await buy(s, { seatId: s.seats.A1! });
    await pay(b.order.id);
    for (const refundOre of [-1, 15001, 1.5]) expect(await cancelOrder(s.fl, b.order.id, { refundOre })).toEqual({ ok: false, reason: "invalidAmount" });

    provider.failRefund = true;
    expect(await cancelOrder(s.fl, b.order.id, {})).toMatchObject({ ok: false, reason: "providerError" });
    expect((await db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe("PAID");
    expect(await db.ticket.count({ where: { userId: b.user.id, status: "ACTIVE" } })).toBe(1);
    expect(await db.seatClaim.count()).toBe(1);
    expect(await db.payment.count({ where: { kind: "REFUND" } })).toBe(0);

    provider.failRefund = false;
    expect(await cancelOrder(s.fl, b.order.id, {})).toMatchObject({ ok: true, status: "REFUNDED" });
  });

  it("can cancel with a zero refund, and cancels free orders without touching the provider", async () => {
    const s = await shop();
    const paid = await buy(s);
    await pay(paid.order.id);
    expect(await cancelOrder(s.fl, paid.order.id, { refundOre: 0 })).toEqual({ ok: true, refundedOre: 0, status: "CANCELLED" });
    expect(provider.refunds).toHaveLength(0);

    const crew = await s.buyer();
    await startCheckout(crew.actor, s.input({ ticketTypeId: s.types.crew.id, discountCode: "CREW" }));
    const freeOrder = await db.order.findFirstOrThrow({ where: { userId: crew.user.id } });
    expect(await cancelOrder(s.fl, freeOrder.id, {})).toEqual({ ok: true, refundedOre: 0, status: "CANCELLED" });
    expect(provider.refunds).toHaveLength(0);
  });

  it("only Festivalledare may cancel or refund; unpaid and unknown orders are rejected", async () => {
    const s = await shop();
    const b = await buy(s);
    await expect(cancelOrder(b.actor, b.order.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    const admin = actorOf({ ...(await makeUser({ tags: ["ADMIN"] })), tags: [{ tag: "ADMIN" }] });
    await expect(cancelOrder(admin, b.order.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(await cancelOrder(s.fl, b.order.id, {})).toEqual({ ok: false, reason: "notPaid" }); // still PENDING
    expect(await cancelOrder(s.fl, "nope", {})).toEqual({ ok: false, reason: "notFound" });
  });
});
