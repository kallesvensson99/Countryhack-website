import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { stockholmParts } from "@/lib/age";
import { checkIn, collectMeal, getCard, lookupByToken, searchAttendees, uncollectMeal, undoCheckIn } from "@/lib/checkin/service";
import { setPaymentProvider } from "@/lib/payments";
import { cancelOrder } from "@/lib/orders/refund";
import { ForbiddenError } from "@/lib/permissions";
import { signTicketToken } from "@/lib/tickets/qr";
import { FakeProvider, actorOf, buyPaid, shop, type Shop } from "./commerce-helpers";
import { makeUser, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  setPaymentProvider(new FakeProvider());
});
afterEach(() => setPaymentProvider(undefined));

const token = (t: { id: string; qrNonce: string }) => signTicketToken(t);
const crewActor = async () => actorOf({ ...(await makeUser({ tags: ["FESTIVALLEDARE"] })), tags: [{ tag: "FESTIVALLEDARE" }] });

/** Born exactly `years` years and `dayOffset` days before today (Stockholm calendar), as YYYY-MM-DD. */
function bornYearsAgo(years: number, dayOffset = 0): string {
  const t = stockholmParts(new Date());
  const d = new Date(Date.UTC(t.year - years, t.month - 1, t.day + dayOffset));
  return d.toISOString().slice(0, 10);
}

async function setup() {
  const s = await shop();
  const food = [{ packageId: s.food.helhelg.id, variantId: s.food.hv(s.food.helhelg, "Vegansk") }];
  const maja = await buyPaid(s, { seatId: s.seats.A1!, food }, { nickname: "maja", realName: "Maja Medlem", allergies: "nötter" });
  return { s, maja, crew: await crewActor() };
}

describe("looking up a ticket from its QR code", () => {
  it("returns the attendee card: name, ticket type, seat, food with meals, allergies", async () => {
    const { s, maja, crew } = await setup();
    const r = await lookupByToken(crew, s.event.id, token(maja.ticket));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card).toMatchObject({ realName: "Maja Medlem", nickname: "maja", ticketType: "Standard", seat: "A1", allergies: "nötter", minor: null, checkedIn: null, orderNumber: maja.order.number });
    expect(r.card.food).toHaveLength(1);
    expect(r.card.food[0]).toMatchObject({ packageName: "Helhelg", variantName: "Vegansk" });
    expect(r.card.food[0]!.meals.map((m) => [m.name, m.collected])).toEqual([["Fredagsmiddag", null], ["Lördagslunch", null]]);
  });

  it("rejects forged, tampered, foreign-event and malformed codes", async () => {
    const { s, maja, crew } = await setup();
    const good = token(maja.ticket);
    expect(await lookupByToken(crew, s.event.id, good.slice(0, -2) + "xx")).toEqual({ ok: false, reason: "invalidCode" });
    expect(await lookupByToken(crew, s.event.id, "hello")).toEqual({ ok: false, reason: "invalidCode" });
    expect(await lookupByToken(crew, s.event.id, "")).toEqual({ ok: false, reason: "invalidCode" });
    const other = await shop();
    expect(await lookupByToken(crew, other.event.id, good)).toEqual({ ok: false, reason: "wrongEvent" });
    // a validly signed token for a ticket that doesn't exist
    expect(await lookupByToken(crew, s.event.id, signTicketToken({ id: "cmdoesnotexist12345678", qrNonce: "aabbccddeeff00112233aabb" }))).toEqual({ ok: false, reason: "notFound" });
  });

  it("a rotated nonce invalidates old QR codes", async () => {
    const { s, maja, crew } = await setup();
    const old = token(maja.ticket);
    await db.ticket.update({ where: { id: maja.ticket.id }, data: { qrNonce: "0123456789abcdef01234567" } });
    expect(await lookupByToken(crew, s.event.id, old)).toEqual({ ok: false, reason: "invalidCode" });
    const fresh = await db.ticket.findUniqueOrThrow({ where: { id: maja.ticket.id } });
    expect((await lookupByToken(crew, s.event.id, token(fresh))).ok).toBe(true);
  });

  it("refuses tickets that aren't active (pending, cancelled/refunded) and events that aren't open", async () => {
    const { s, maja, crew } = await setup();
    // refunded
    expect((await cancelOrder(s.fl, maja.order.id, {})).ok).toBe(true);
    expect(await lookupByToken(crew, s.event.id, token(maja.ticket))).toEqual({ ok: false, reason: "notActive" });
    // unpaid
    const b = await s.buyer();
    const { startCheckout } = await import("@/lib/orders/checkout");
    await startCheckout(b.actor, s.input());
    const pending = await db.ticket.findFirstOrThrow({ where: { userId: b.user.id } });
    expect(await lookupByToken(crew, s.event.id, token(pending))).toEqual({ ok: false, reason: "notActive" });

    const paid = await buyPaid(s);
    await db.event.update({ where: { id: s.event.id }, data: { status: "DRAFT" } });
    expect(await lookupByToken(crew, s.event.id, token(paid.ticket))).toEqual({ ok: false, reason: "eventNotOpen" });
    await db.event.update({ where: { id: s.event.id }, data: { status: "CLOSED" } });
    expect((await lookupByToken(crew, s.event.id, token(paid.ticket))).ok).toBe(true); // closed for sales, but the party goes on
  });

  it("is for Festivalledare and Admin only", async () => {
    const { s, maja } = await setup();
    const member = actorOf({ ...(await makeUser()), tags: [] });
    const admin = actorOf({ ...(await makeUser({ tags: ["ADMIN"] })), tags: [{ tag: "ADMIN" }] });
    expect((await lookupByToken(admin, s.event.id, token(maja.ticket))).ok).toBe(true); // an Admin holds every right
    for (const who of [member]) {
      await expect(lookupByToken(who, s.event.id, token(maja.ticket))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(searchAttendees(who, s.event.id, "maja")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(checkIn(who, s.event.id, maja.ticket.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCard(who, s.event.id, maja.ticket.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("searching", () => {
  it("finds by name, nickname and order number — partial and case-insensitive — within this event's active tickets", async () => {
    const { s, maja, crew } = await setup();
    await buyPaid(s, {}, { nickname: "Bertil", realName: "Bertil Bäck" });
    expect((await searchAttendees(crew, s.event.id, "MAJ")).map((h) => h.nickname)).toEqual(["maja"]);
    expect((await searchAttendees(crew, s.event.id, "medlem")).map((h) => h.nickname)).toEqual(["maja"]);
    expect((await searchAttendees(crew, s.event.id, "bäck")).map((h) => h.nickname)).toEqual(["Bertil"]);
    expect((await searchAttendees(crew, s.event.id, maja.order.number.toLowerCase())).map((h) => h.nickname)).toEqual(["maja"]);
    expect(await searchAttendees(crew, s.event.id, "m")).toEqual([]); // too short
    expect(await searchAttendees(crew, s.event.id, "nobody")).toEqual([]);
    expect(await searchAttendees(crew, (await shop()).event.id, "maja")).toEqual([]); // other event
  });

  it("hides unpaid, cancelled and anonymized attendees", async () => {
    const { s, maja, crew } = await setup();
    const gone = await buyPaid(s, {}, { nickname: "majsan" });
    await db.user.update({ where: { id: gone.user.id }, data: { anonymizedAt: new Date() } });
    const refunded = await buyPaid(s, {}, { nickname: "majken" });
    await cancelOrder(s.fl, refunded.order.id, {});
    expect((await searchAttendees(crew, s.event.id, "maj")).map((h) => h.nickname)).toEqual(["maja"]);
    void maja;
  });

  it("reports whether someone is already checked in", async () => {
    const { s, maja, crew } = await setup();
    expect((await searchAttendees(crew, s.event.id, "maja"))[0]!.checkedIn).toBe(false);
    await checkIn(crew, s.event.id, maja.ticket.id);
    expect((await searchAttendees(crew, s.event.id, "maja"))[0]!.checkedIn).toBe(true);
  });
});

describe("checking in", () => {
  it("marks the ticket, records who and when, and audits", async () => {
    const { s, maja, crew } = await setup();
    const r = await checkIn(crew, s.event.id, maja.ticket.id, "7.7.7.7");
    expect(r.ok).toBe(true);
    const t = await db.ticket.findUniqueOrThrow({ where: { id: maja.ticket.id } });
    expect(t.checkedInAt).not.toBeNull();
    expect(t.checkedInById).toBe(crew.id);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "ticket.checkin" } })).toMatchObject({ actorId: crew.id, entityId: maja.ticket.id, eventId: s.event.id, ip: "7.7.7.7" });
    if (r.ok) expect(r.card.checkedIn).toMatchObject({ by: expect.any(String) });
  });

  it("warns on a second check-in and says who did it and when — without changing anything", async () => {
    const { s, maja } = await setup();
    const a = await crewActor();
    const b = await crewActor();
    await checkIn(a, s.event.id, maja.ticket.id);
    const first = await db.ticket.findUniqueOrThrow({ where: { id: maja.ticket.id } });
    const again = await checkIn(b, s.event.id, maja.ticket.id);
    expect(again.ok).toBe(false);
    if (again.ok || again.reason !== "alreadyCheckedIn") throw new Error("expected alreadyCheckedIn");
    expect(again.card.checkedIn?.at).toBe(first.checkedInAt!.toISOString());
    expect(again.card.checkedIn?.by).toBe((await db.user.findUniqueOrThrow({ where: { id: a.id } })).nickname);
    const after = await db.ticket.findUniqueOrThrow({ where: { id: maja.ticket.id } });
    expect(after.checkedInById).toBe(a.id);
    expect(await db.auditLog.count({ where: { action: "ticket.checkin" } })).toBe(1);
  });

  it("two crew members scanning at the same moment: exactly one wins", async () => {
    const { s, maja } = await setup();
    const crews = await Promise.all(Array.from({ length: 8 }, () => crewActor()));
    const results = await Promise.all(crews.map((c) => checkIn(c, s.event.id, maja.ticket.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "alreadyCheckedIn")).toHaveLength(7);
    expect(await db.auditLog.count({ where: { action: "ticket.checkin" } })).toBe(1);
    const winner = results.find((r) => r.ok);
    const t = await db.ticket.findUniqueOrThrow({ where: { id: maja.ticket.id } });
    expect(crews.some((c) => c.id === t.checkedInById)).toBe(true);
    expect(winner).toBeTruthy();
  });

  it("can be undone (audited) and redone", async () => {
    const { s, maja, crew } = await setup();
    await checkIn(crew, s.event.id, maja.ticket.id);
    const u = await undoCheckIn(crew, s.event.id, maja.ticket.id, "1.1.1.1");
    expect(u.ok && u.card.checkedIn).toBe(null);
    expect((await db.ticket.findUniqueOrThrow({ where: { id: maja.ticket.id } })).checkedInById).toBeNull();
    expect(await db.auditLog.count({ where: { action: "ticket.checkin.undo" } })).toBe(1);
    expect((await checkIn(crew, s.event.id, maja.ticket.id)).ok).toBe(true);
  });

  it("refuses wrong events, inactive tickets, unknown tickets and unopened events", async () => {
    const { s, maja, crew } = await setup();
    expect(await checkIn(crew, (await shop()).event.id, maja.ticket.id)).toEqual({ ok: false, reason: "wrongEvent" });
    expect(await checkIn(crew, s.event.id, "nope")).toEqual({ ok: false, reason: "notFound" });
    await db.event.update({ where: { id: s.event.id }, data: { status: "DRAFT" } });
    expect(await checkIn(crew, s.event.id, maja.ticket.id)).toEqual({ ok: false, reason: "eventNotOpen" });
    await db.event.update({ where: { id: s.event.id }, data: { status: "PUBLISHED" } });
    await db.ticket.update({ where: { id: maja.ticket.id }, data: { status: "CANCELLED" } });
    expect(await checkIn(crew, s.event.id, maja.ticket.id)).toEqual({ ok: false, reason: "notActive" });
  });
});

describe("minors", () => {
  const guardian = { guardianName: "Greta Guardian", guardianPhone: "+46 70 111 22 33" };

  async function attendee(s: Shop, birth: string, withGuardian = true) {
    const b = await buyPaid(s, {}, { birthDate: "1995-01-01" });
    await db.user.update({ where: { id: b.user.id }, data: { birthDate: new Date(`${birth}T00:00:00.000Z`), ...(withGuardian ? guardian : {}) } });
    return b;
  }

  it("shows guardian name and phone for under-18s, nothing for adults", async () => {
    const s = await shop();
    const crew = await crewActor();
    const kid = await attendee(s, bornYearsAgo(15));
    const adult = await attendee(s, bornYearsAgo(30), false);
    const k = await getCard(crew, s.event.id, kid.ticket.id);
    const a = await getCard(crew, s.event.id, adult.ticket.id);
    expect(k.ok && k.card.minor).toEqual({ guardianName: "Greta Guardian", guardianPhone: "+46 70 111 22 33" });
    expect(a.ok && a.card.minor).toBeNull();
  });

  it("is judged by actual date of birth: still a minor the day before the 18th birthday, adult on it", async () => {
    const s = await shop();
    const crew = await crewActor();
    const dayBefore = await attendee(s, bornYearsAgo(18, +1)); // turns 18 tomorrow
    const today = await attendee(s, bornYearsAgo(18, 0)); // turns 18 today
    expect((await getCard(crew, s.event.id, dayBefore.ticket.id) as { ok: true; card: { minor: unknown } }).card.minor).not.toBeNull();
    expect((await getCard(crew, s.event.id, today.ticket.id) as { ok: true; card: { minor: unknown } }).card.minor).toBeNull();
  });

  it("flags a minor even if guardian details are missing (so the crew sees the gap)", async () => {
    const s = await shop();
    const crew = await crewActor();
    const kid = await attendee(s, bornYearsAgo(14), false);
    const c = await getCard(crew, s.event.id, kid.ticket.id);
    expect(c.ok && c.card.minor).toEqual({ guardianName: null, guardianPhone: null });
  });
});

describe("collecting meals", () => {
  async function withFood() {
    const { s, maja, crew } = await setup();
    const fp = await db.foodPurchase.findFirstOrThrow({ where: { ticketId: maja.ticket.id } });
    return { s, maja, crew, fp };
  }

  it("marks one meal at a time, once, and shows who collected it", async () => {
    const { s, crew, fp } = await withFood();
    const r = await collectMeal(crew, s.event.id, fp.id, s.meals.fri.id, "2.2.2.2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meals = r.card.food[0]!.meals;
    expect(meals.find((m) => m.name === "Fredagsmiddag")!.collected).toMatchObject({ by: expect.any(String) });
    expect(meals.find((m) => m.name === "Lördagslunch")!.collected).toBeNull();
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "meal.collect" } })).toMatchObject({ actorId: crew.id, ip: "2.2.2.2" });

    const twice = await collectMeal(crew, s.event.id, fp.id, s.meals.fri.id);
    expect(twice).toMatchObject({ ok: false, reason: "alreadyCollected" });
    expect(await db.mealCollection.count()).toBe(1);
  });

  it("concurrent taps collect once", async () => {
    const { s, fp } = await withFood();
    const crews = await Promise.all(Array.from({ length: 6 }, () => crewActor()));
    const results = await Promise.all(crews.map((c) => collectMeal(c, s.event.id, fp.id, s.meals.sat.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.mealCollection.count()).toBe(1);
  });

  it("only meals that belong to the package, only active purchases, only this event; can be undone", async () => {
    const { s, maja, crew, fp } = await withFood();
    const extra = await db.meal.create({ data: { eventId: s.event.id, name: "Natt", servedAt: new Date("2027-03-14T01:00:00Z") } });
    expect(await collectMeal(crew, s.event.id, fp.id, extra.id)).toEqual({ ok: false, reason: "wrongMeal" });
    expect(await collectMeal(crew, (await shop()).event.id, fp.id, s.meals.fri.id)).toEqual({ ok: false, reason: "wrongEvent" });
    expect(await collectMeal(crew, s.event.id, "nope", s.meals.fri.id)).toEqual({ ok: false, reason: "notFound" });

    await collectMeal(crew, s.event.id, fp.id, s.meals.fri.id);
    const undone = await uncollectMeal(crew, s.event.id, fp.id, s.meals.fri.id);
    expect(undone.ok && undone.card.food[0]!.meals.every((m) => m.collected === null)).toBe(true);
    expect(await db.auditLog.count({ where: { action: "meal.uncollect" } })).toBe(1);

    await cancelOrder(s.fl, maja.order.id, {});
    expect(await collectMeal(crew, s.event.id, fp.id, s.meals.fri.id)).toEqual({ ok: false, reason: "notFound" }); // food was cancelled
  });

  it("is for Festivalledare only", async () => {
    const { s, fp } = await withFood();
    const member = actorOf({ ...(await makeUser()), tags: [] });
    await expect(collectMeal(member, s.event.id, fp.id, s.meals.fri.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uncollectMeal(member, s.event.id, fp.id, s.meals.fri.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
