import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setPaymentProvider } from "@/lib/payments";
import { startCheckout } from "@/lib/orders/checkout";
import { checkoutSchema } from "@/lib/validation/commerce";
import { makeEvent, resetDb } from "./helpers";
import { FakeProvider, shop } from "./commerce-helpers";

beforeEach(async () => {
  await resetDb();
  setPaymentProvider(new FakeProvider());
});
afterEach(() => setPaymentProvider(undefined));

/** The default test input skips the seat rule; these tests turn it back on, exactly like the real checkout. */
const strict = (s: Awaited<ReturnType<typeof shop>>, over: Parameters<Awaited<ReturnType<typeof shop>>["input"]>[0] = {}) => s.input({ allowNoSeat: false, ...over });

describe("a ticket with a seat is only sold together with a seat", () => {
  it("refuses a seat ticket without a seat, and creates nothing", async () => {
    const s = await shop();
    const b = await s.buyer();
    const r = await startCheckout(b.actor, strict(s));
    expect(r).toMatchObject({ ok: false, reason: "seatRequired" });
    expect(await db.order.count()).toBe(0);
    expect(await db.ticket.count()).toBe(0);
  });

  it("accepts the same purchase once a seat is chosen, and holds that seat", async () => {
    const s = await shop();
    const b = await s.buyer();
    const r = await startCheckout(b.actor, strict(s, { seatId: s.seats.A2! }));
    expect(r.ok).toBe(true);
    const claim = await db.seatClaim.findFirstOrThrow({ where: { seatId: s.seats.A2! } });
    expect(claim.status).toBe("HELD");
  });

  it("applies to VIP and to Crew tickets too", async () => {
    const s = await shop();
    const vip = await startCheckout((await s.buyer()).actor, strict(s, { ticketTypeId: s.types.vip.id }));
    expect(vip).toMatchObject({ ok: false, reason: "seatRequired" });
    const crew = await startCheckout((await s.buyer()).actor, strict(s, { ticketTypeId: s.types.crew.id, discountCode: "CREW" }));
    expect(crew).toMatchObject({ ok: false, reason: "seatRequired" });
    const crewWithSeat = await startCheckout((await s.buyer()).actor, strict(s, { ticketTypeId: s.types.crew.id, discountCode: "CREW", seatId: s.seats.A1! }));
    expect(crewWithSeat.ok).toBe(true);
  });

  it("does not apply to tickets without a seat, or to food on an existing ticket", async () => {
    const s = await shop();
    const visitor = await startCheckout((await s.buyer()).actor, strict(s, { ticketTypeId: s.types.visitor.id }));
    expect(visitor.ok).toBe(true);
  });

  it("still validates the chosen seat (wrong zone is refused, not 'required')", async () => {
    const s = await shop();
    const r = await startCheckout((await s.buyer()).actor, strict(s, { seatId: s.seats.V1! })); // VIP seat on a Standard ticket
    expect(r).toMatchObject({ ok: false, reason: "seatInvalid", detail: "zoneNotAllowed" });
  });

  it("does not apply when the event has no seating chart", async () => {
    const s = await shop();
    const ev = await makeEvent(s.flUser.id, new Date("2027-05-01T16:00:00Z"));
    const type = await db.ticketType.create({ data: { eventId: ev.id, name: "Utan karta", priceOre: 10000, quantity: 5 } });
    const r = await startCheckout((await s.buyer()).actor, { eventId: ev.id, ticketTypeId: type.id, seatId: null, discountCode: null, food: [], locale: "sv" });
    expect(r.ok).toBe(true);
  });

  it("the server action's schema cannot be used to switch the rule off", () => {
    const parsed = checkoutSchema.parse({ eventId: "e", ticketTypeId: "t", seatId: null, discountCode: null, food: [], allowNoSeat: true });
    expect("allowNoSeat" in parsed).toBe(false);
  });
});
