import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ageOn, isMinor, meetsEventMinAge } from "@/lib/age";
import { makeEvent, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

async function makeTicketScaffold() {
  const admin = await makeUser();
  const event = await makeEvent(admin.id);
  const ticketType = await db.ticketType.create({ data: { eventId: event.id, name: "Standard", priceOre: 15000, quantity: 100 } });
  const order = async (userId: string) =>
    db.order.create({
      data: { number: `T-${Math.random().toString(36).slice(2)}`, userId, eventId: event.id, subtotalOre: 15000, totalOre: 15000, expiresAt: new Date() },
    });
  const ticket = async (userId: string, status: "PENDING" | "ACTIVE" | "CANCELLED") =>
    db.ticket.create({ data: { eventId: event.id, userId, ticketTypeId: ticketType.id, orderId: (await order(userId)).id, status, qrNonce: "n" } });
  return { admin, event, ticket };
}

describe("one active ticket per member per event (partial unique index)", () => {
  it("blocks a second PENDING/ACTIVE ticket", async () => {
    const { ticket } = await makeTicketScaffold();
    const u = await makeUser();
    await ticket(u.id, "PENDING");
    await expect(ticket(u.id, "ACTIVE")).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows a new ticket once the previous one is cancelled", async () => {
    const { ticket } = await makeTicketScaffold();
    const u = await makeUser();
    await ticket(u.id, "CANCELLED");
    await ticket(u.id, "CANCELLED");
    await expect(ticket(u.id, "ACTIVE")).resolves.toBeTruthy();
  });

  it("allows tickets for the same member at different events and for different members", async () => {
    const { ticket, admin } = await makeTicketScaffold();
    const a = await makeUser();
    const b = await makeUser();
    await ticket(a.id, "ACTIVE");
    await expect(ticket(b.id, "ACTIVE")).resolves.toBeTruthy();

    const event2 = await makeEvent(admin.id);
    const tt2 = await db.ticketType.create({ data: { eventId: event2.id, name: "S", priceOre: 0, quantity: 1 } });
    const o2 = await db.order.create({ data: { number: "T-other", userId: a.id, eventId: event2.id, subtotalOre: 0, totalOre: 0, expiresAt: new Date() } });
    await expect(db.ticket.create({ data: { eventId: event2.id, userId: a.id, ticketTypeId: tt2.id, orderId: o2.id, qrNonce: "n" } })).resolves.toBeTruthy();
  });

  it("holds under concurrency: exactly one of 10 parallel inserts succeeds", async () => {
    const { ticket } = await makeTicketScaffold();
    const u = await makeUser();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => ticket(u.id, "PENDING")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("other DB-level constraints", () => {
  it("nickname is unique case-insensitively", async () => {
    await makeUser({ nickname: "Gamer" });
    await expect(makeUser({ nickname: "gAMER" })).rejects.toBeTruthy();
  });

  it("discount code is unique per event case-insensitively, but may repeat across events", async () => {
    const admin = await makeUser();
    const e1 = await makeEvent(admin.id);
    const e2 = await makeEvent(admin.id);
    await db.discountCode.create({ data: { eventId: e1.id, code: "CREW", kind: "PERCENT", value: 100 } });
    await expect(db.discountCode.create({ data: { eventId: e1.id, code: "crew", kind: "PERCENT", value: 100 } })).rejects.toBeTruthy();
    await expect(db.discountCode.create({ data: { eventId: e2.id, code: "crew", kind: "PERCENT", value: 100 } })).resolves.toBeTruthy();
  });

  it("rejects negative money", async () => {
    const admin = await makeUser();
    const e = await makeEvent(admin.id);
    await expect(db.ticketType.create({ data: { eventId: e.id, name: "x", priceOre: -1, quantity: 1 } })).rejects.toBeTruthy();
  });
});

describe("age rule: year(event.startsAt) − year(birthDate) ≥ minAge", () => {
  const event = new Date("2027-03-12T16:00:00Z");
  const born = (s: string) => new Date(`${s}T00:00:00.000Z`);

  it("allows anyone turning 14 during the event year, even after the event date", () => {
    expect(meetsEventMinAge(born("2013-12-31"), event, 14)).toBe(true); // turns 14 on 31 Dec 2027
    expect(meetsEventMinAge(born("2013-01-01"), event, 14)).toBe(true);
  });

  it("rejects those who turn 14 the year after", () => {
    expect(meetsEventMinAge(born("2014-01-01"), event, 14)).toBe(false);
  });

  it("respects a custom minAge", () => {
    expect(meetsEventMinAge(born("2009-06-01"), event, 18)).toBe(true);
    expect(meetsEventMinAge(born("2010-06-01"), event, 18)).toBe(false);
  });

  it("uses Stockholm's calendar for the event year (New Year's Eve edge)", () => {
    // 23:30 UTC on 31 Dec 2026 is already 1 Jan 2027 in Stockholm
    expect(meetsEventMinAge(born("2013-06-01"), new Date("2026-12-31T23:30:00Z"), 14)).toBe(true);
  });
});

describe("actual age / minor detection", () => {
  const born = (s: string) => new Date(`${s}T00:00:00.000Z`);
  it("turns 18 on the birthday, not before", () => {
    expect(ageOn(born("2000-06-15"), new Date("2018-06-14T12:00:00Z"))).toBe(17);
    expect(ageOn(born("2000-06-15"), new Date("2018-06-15T12:00:00Z"))).toBe(18);
    expect(isMinor(born("2000-06-15"), new Date("2018-06-14T12:00:00Z"))).toBe(true);
    expect(isMinor(born("2000-06-15"), new Date("2018-06-15T12:00:00Z"))).toBe(false);
  });
});
