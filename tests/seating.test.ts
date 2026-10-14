import { beforeEach, describe, expect, it } from "vitest";
import type { TicketStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { claimSeat, confirmClaim, moveClaim, releaseClaim, releaseExpiredClaims } from "@/lib/seating/claims";
import { chooseSeat, getSeatMap } from "@/lib/seating/booking";
import { applyTemplate, createBlankChart, deleteTemplate, loadChartData, saveAsTemplate, saveChart, searchUsers } from "@/lib/seating/charts";
import { centroid, findDuplicateLabels, isLightColor, makeLabels, nextPrefix, relabelOrder, rotatePoint, rowPositions, seatSpacing, snap, tableLayout } from "@/lib/seating/geometry";
import { chartPayloadSchema, type ChartPayload } from "@/lib/validation/chart";
import { createEvent } from "@/lib/events/service";
import { ForbiddenError } from "@/lib/permissions";
import { eventSchema } from "@/lib/validation/events";
import { asActor, makeEvent, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const HOUR = 3600_000;

async function scenario() {
  const fl = await makeUser({ tags: ["FESTIVALLEDARE"] });
  const event = await makeEvent(fl.id);
  const chart = await db.seatingChart.create({ data: { eventId: event.id, name: "Karta", gridSize: 20 } });
  const std = await db.seatZone.create({ data: { chartId: chart.id, name: "Standard", color: "#0072B2" } });
  const vip = await db.seatZone.create({ data: { chartId: chart.id, name: "VIP", color: "#E69F00" } });
  const seats: Record<string, string> = {};
  for (const [i, label] of ["A1", "A2", "A3", "A4", "A5", "V1", "V2"].entries()) {
    seats[label] = (await db.seat.create({ data: { chartId: chart.id, label, x: 40 + i * 40, y: 40, zoneId: label.startsWith("V") ? vip.id : std.id } })).id;
  }
  const mkType = (name: string, zoneIds: string[], includesSeat = true) =>
    db.ticketType.create({ data: { eventId: event.id, name, priceOre: 0, quantity: 1000, includesSeat, zones: { create: zoneIds.map((zoneId) => ({ zoneId })) } } });
  const types = { std: await mkType("Std", [std.id]), vip: await mkType("VIP", [vip.id]), any: await mkType("Any", []), visitor: await mkType("Visitor", [], false) };

  let n = 0;
  const ticket = async (type: keyof typeof types, opts: { user?: Awaited<ReturnType<typeof makeUser>>; status?: TicketStatus; orderExpiresAt?: Date } = {}) => {
    const user = opts.user ?? (await makeUser());
    const order = await db.order.create({ data: { number: `T-${++n}-${Math.random()}`, userId: user.id, eventId: event.id, subtotalOre: 0, totalOre: 0, expiresAt: opts.orderExpiresAt ?? new Date(Date.now() + 30 * 60_000) } });
    const t = await db.ticket.create({ data: { eventId: event.id, userId: user.id, ticketTypeId: types[type].id, orderId: order.id, status: opts.status ?? "ACTIVE", qrNonce: "n" } });
    return { ...t, user };
  };
  return { fl, event, chart, std, vip, seats, types, ticket };
}

const claim = (seatId: string, ticketId: string, extra: Partial<Parameters<typeof claimSeat>[0]> = {}) => claimSeat({ seatId, ticketId, status: "CONFIRMED", ...extra });

describe("seat claims: no double booking, guaranteed by the database", () => {
  it("50 parallel attempts on the same seat → exactly 1 success", async () => {
    const s = await scenario();
    const tickets = await Promise.all(Array.from({ length: 50 }, () => s.ticket("any")));
    const results = await Promise.all(tickets.map((t) => claim(s.seats.A1!, t.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "taken")).toHaveLength(49);
    expect(await db.seatClaim.count({ where: { seatId: s.seats.A1 } })).toBe(1);
  });

  it("50 parallel attempts spread over 5 seats → every seat taken exactly once", async () => {
    const s = await scenario();
    const tickets = await Promise.all(Array.from({ length: 50 }, () => s.ticket("any")));
    const ids = ["A1", "A2", "A3", "A4", "A5"].map((l) => s.seats[l]!);
    const results = await Promise.all(tickets.map((t, i) => claim(ids[i % 5]!, t.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(await db.seatClaim.count()).toBe(5);
  });

  it("one ticket can never hold two seats, even when asking in parallel", async () => {
    const s = await scenario();
    const t = await s.ticket("any");
    const results = await Promise.all(["A1", "A2", "A3", "A4", "A5"].map((l) => claim(s.seats[l]!, t.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "alreadyHasSeat").length).toBeGreaterThanOrEqual(1);
    expect(await db.seatClaim.count({ where: { ticketId: t.id } })).toBe(1);
  });

  it("a live hold blocks others, an expired hold can be reclaimed (and is cleaned up)", async () => {
    const s = await scenario();
    const [a, b, c] = await Promise.all([s.ticket("any"), s.ticket("any"), s.ticket("any")]);
    const now = new Date("2026-11-01T12:00:00Z");
    expect(await claimSeat({ seatId: s.seats.A1!, ticketId: a.id, status: "HELD", expiresAt: new Date(now.getTime() + 30 * 60_000), now })).toMatchObject({ ok: true });
    expect(await claimSeat({ seatId: s.seats.A1!, ticketId: b.id, status: "CONFIRMED", now: new Date(now.getTime() + 29 * 60_000) })).toEqual({ ok: false, reason: "taken" });
    // 31 minutes later the hold has lapsed
    expect(await claimSeat({ seatId: s.seats.A1!, ticketId: b.id, status: "CONFIRMED", now: new Date(now.getTime() + 31 * 60_000) })).toMatchObject({ ok: true });
    expect(await db.seatClaim.findMany({ where: { seatId: s.seats.A1 } })).toMatchObject([{ ticketId: b.id, status: "CONFIRMED" }]);
    expect(await db.seatClaim.count({ where: { ticketId: a.id } })).toBe(0);
    expect(await claim(s.seats.A1!, c.id)).toEqual({ ok: false, reason: "taken" }); // CONFIRMED never expires
  });

  it("20 parallel claimants of an expired hold → exactly 1 wins", async () => {
    const s = await scenario();
    const holder = await s.ticket("any");
    await db.seatClaim.create({ data: { seatId: s.seats.A1!, ticketId: holder.id, status: "HELD", expiresAt: new Date(Date.now() - HOUR) } });
    const tickets = await Promise.all(Array.from({ length: 20 }, () => s.ticket("any")));
    const results = await Promise.all(tickets.map((t) => claim(s.seats.A1!, t.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.seatClaim.count({ where: { seatId: s.seats.A1 } })).toBe(1);
  });

  it("enforces seat and ticket rules", async () => {
    const s = await scenario();
    await db.seat.update({ where: { id: s.seats.A2 }, data: { blocked: true } });
    const reservedFor = await makeUser();
    await db.seat.update({ where: { id: s.seats.A3 }, data: { reservedForUserId: reservedFor.id } });
    const other = await makeEvent(s.fl.id);
    const foreignChart = await db.seatingChart.create({ data: { eventId: other.id, name: "x" } });
    const fz = await db.seatZone.create({ data: { chartId: foreignChart.id, name: "z", color: "#000000" } });
    const foreignSeat = await db.seat.create({ data: { chartId: foreignChart.id, label: "F1", x: 0, y: 0, zoneId: fz.id } });

    const std = await s.ticket("std");
    expect(await claim(s.seats.A2!, std.id)).toEqual({ ok: false, reason: "blocked" });
    expect(await claim(s.seats.A3!, std.id)).toEqual({ ok: false, reason: "reservedForOther" });
    expect(await claim(s.seats.V1!, std.id)).toEqual({ ok: false, reason: "zoneNotAllowed" });
    expect(await claim(foreignSeat.id, std.id)).toEqual({ ok: false, reason: "wrongChart" });
    expect(await claim("nope", std.id)).toEqual({ ok: false, reason: "notFound" });
    expect(await claim(s.seats.A1!, "nope")).toEqual({ ok: false, reason: "notFound" });
    expect(await claim(s.seats.A1!, (await s.ticket("visitor")).id)).toEqual({ ok: false, reason: "ticketNoSeat" });
    expect(await claim(s.seats.A1!, (await s.ticket("any", { status: "CANCELLED" })).id)).toEqual({ ok: false, reason: "ticketInactive" });
    expect(await db.seatClaim.count()).toBe(0);

    // the reserved user, and only they, may take the reserved seat
    const own = await s.ticket("std", { user: reservedFor });
    expect(await claim(s.seats.A3!, own.id)).toMatchObject({ ok: true });
  });

  it("a ticket type without zone links may use any zone", async () => {
    const s = await scenario();
    expect(await claim(s.seats.V1!, (await s.ticket("any")).id)).toMatchObject({ ok: true });
  });
});

describe("moving a claim", () => {
  it("moves atomically: new seat taken, old seat freed", async () => {
    const s = await scenario();
    const t = await s.ticket("any");
    await claim(s.seats.A1!, t.id);
    expect(await moveClaim({ ticketId: t.id, toSeatId: s.seats.A2! })).toMatchObject({ ok: true });
    expect((await db.seatClaim.findMany()).map((c) => c.seatId)).toEqual([s.seats.A2]);
    const other = await s.ticket("any");
    expect(await claim(s.seats.A1!, other.id)).toMatchObject({ ok: true });
  });

  it("moving onto a taken seat fails and keeps the old claim", async () => {
    const s = await scenario();
    const [a, b] = await Promise.all([s.ticket("any"), s.ticket("any")]);
    await claim(s.seats.A1!, a.id);
    await claim(s.seats.A2!, b.id);
    expect(await moveClaim({ ticketId: a.id, toSeatId: s.seats.A2! })).toEqual({ ok: false, reason: "taken" });
    expect((await db.seatClaim.findUniqueOrThrow({ where: { ticketId: a.id } })).seatId).toBe(s.seats.A1);
  });

  it("20 tickets moving to the same free seat in parallel → exactly 1 succeeds, everyone keeps a seat", async () => {
    const s = await scenario();
    const tickets = await Promise.all(Array.from({ length: 5 }, () => s.ticket("any")));
    const labels = ["A1", "A2", "A3", "A4", "A5"];
    await Promise.all(tickets.map((t, i) => claim(s.seats[labels[i]!]!, t.id)));
    const results = await Promise.all(tickets.map((t) => moveClaim({ ticketId: t.id, toSeatId: s.seats.V1! })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.seatClaim.count()).toBe(5);
    expect(new Set((await db.seatClaim.findMany()).map((c) => c.seatId)).size).toBe(5);
  });

  it("can move onto an expired hold; no-op to the same seat; error without a claim", async () => {
    const s = await scenario();
    const [a, b, c] = await Promise.all([s.ticket("any"), s.ticket("any"), s.ticket("any")]);
    await db.seatClaim.create({ data: { seatId: s.seats.A2!, ticketId: b.id, status: "HELD", expiresAt: new Date(Date.now() - HOUR) } });
    await claim(s.seats.A1!, a.id);
    expect(await moveClaim({ ticketId: a.id, toSeatId: s.seats.A2! })).toMatchObject({ ok: true });
    expect(await moveClaim({ ticketId: a.id, toSeatId: s.seats.A2! })).toMatchObject({ ok: true });
    expect(await moveClaim({ ticketId: c.id, toSeatId: s.seats.A3! })).toEqual({ ok: false, reason: "noClaim" });
  });

  it("respects zones when moving", async () => {
    const s = await scenario();
    const t = await s.ticket("std");
    await claim(s.seats.A1!, t.id);
    expect(await moveClaim({ ticketId: t.id, toSeatId: s.seats.V1! })).toEqual({ ok: false, reason: "zoneNotAllowed" });
  });
});

describe("confirm / release / expiry", () => {
  it("confirms a hold, releases a claim, and sweeps expired holds", async () => {
    const s = await scenario();
    const [a, b, c] = await Promise.all([s.ticket("any", { status: "PENDING" }), s.ticket("any", { status: "PENDING" }), s.ticket("any")]);
    await claimSeat({ seatId: s.seats.A1!, ticketId: a.id, status: "HELD", expiresAt: new Date(Date.now() + HOUR) });
    await claimSeat({ seatId: s.seats.A2!, ticketId: b.id, status: "HELD", expiresAt: new Date(Date.now() - 1000) });
    await claim(s.seats.A3!, c.id);

    expect(await confirmClaim(a.id)).toBe(true);
    expect(await db.seatClaim.findUniqueOrThrow({ where: { ticketId: a.id } })).toMatchObject({ status: "CONFIRMED", expiresAt: null });
    expect(await confirmClaim(c.id)).toBe(true); // already confirmed
    expect(await confirmClaim("nope")).toBe(false);

    expect(await releaseExpiredClaims()).toBe(1); // only b's lapsed hold
    expect(await db.seatClaim.count()).toBe(2);
    expect(await releaseClaim(c.id)).toBe(true);
    expect(await releaseClaim(c.id)).toBe(false);
  });

  it("HELD claims require an expiry", async () => {
    const s = await scenario();
    await expect(claimSeat({ seatId: s.seats.A1!, ticketId: (await s.ticket("any")).id, status: "HELD" })).rejects.toThrow();
  });
});

describe("chooseSeat (member-facing rules)", () => {
  it("ACTIVE ticket → CONFIRMED claim, then a move; PENDING ticket → HELD until the order expires", async () => {
    const s = await scenario();
    const actor = (t: { user: { id: string; emailVerifiedAt: Date | null } }) => ({ id: t.user.id, emailVerifiedAt: t.user.emailVerifiedAt, tags: [] as never[] });
    const t = await s.ticket("any");
    expect(await chooseSeat(actor(t), t.id, s.seats.A1!)).toEqual({ ok: true, seatId: s.seats.A1, moved: false });
    expect(await db.seatClaim.findUniqueOrThrow({ where: { ticketId: t.id } })).toMatchObject({ status: "CONFIRMED", expiresAt: null });
    expect(await chooseSeat(actor(t), t.id, s.seats.A2!)).toEqual({ ok: true, seatId: s.seats.A2, moved: true });

    const expires = new Date(Date.now() + 25 * 60_000);
    const p = await s.ticket("any", { status: "PENDING", orderExpiresAt: expires });
    expect(await chooseSeat(actor(p), p.id, s.seats.A3!)).toMatchObject({ ok: true });
    expect(await db.seatClaim.findUniqueOrThrow({ where: { ticketId: p.id } })).toMatchObject({ status: "HELD", expiresAt: expires });
  });

  it("refuses other people's tickets, unverified members, visitors, closed windows", async () => {
    const s = await scenario();
    const owner = await s.ticket("any");
    const stranger = await makeUser();
    const strangerActor = asActor({ ...stranger, tags: [] });
    expect(await chooseSeat(strangerActor, owner.id, s.seats.A1!)).toMatchObject({ ok: false });
    expect(await db.seatClaim.count()).toBe(0);

    const unverified = await makeUser({ verified: false });
    const ut = await s.ticket("any", { user: unverified });
    await expect(chooseSeat(asActor({ ...unverified, tags: [] }), ut.id, s.seats.A1!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(chooseSeat(null as never, owner.id, s.seats.A1!)).rejects.toThrow();

    expect(await chooseSeat(strangerActor, "nope", s.seats.A1!)).toEqual({ ok: false, reason: "notFound" });
  });

  it("enforces seatChangeDeadline for members but not for Festivalledare (audited)", async () => {
    const s = await scenario();
    await db.event.update({ where: { id: s.event.id }, data: { seatChangeDeadline: new Date("2026-12-01T00:00:00Z") } });
    const t = await s.ticket("any");
    const member = { id: t.user.id, emailVerifiedAt: t.user.emailVerifiedAt, tags: [] as never[] };
    expect(await chooseSeat(member, t.id, s.seats.A1!, { now: new Date("2026-11-30T23:59:00Z") })).toMatchObject({ ok: true });
    expect(await chooseSeat(member, t.id, s.seats.A2!, { now: new Date("2026-12-01T00:00:01Z") })).toEqual({ ok: false, reason: "deadlinePassed" });
    expect((await db.seatClaim.findUniqueOrThrow({ where: { ticketId: t.id } })).seatId).toBe(s.seats.A1);

    const staff = asActor({ ...s.fl, tags: [{ tag: "FESTIVALLEDARE" as const }] });
    expect(await chooseSeat(staff, t.id, s.seats.A2!, { now: new Date("2026-12-02T00:00:00Z"), ip: "3.3.3.3" })).toMatchObject({ ok: true, moved: true });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "seat.assign" } })).toMatchObject({ actorId: s.fl.id, entityId: t.id, ip: "3.3.3.3" });
  });

  it("refuses for draft / cancelled events and cancelled tickets", async () => {
    const s = await scenario();
    const t = await s.ticket("any");
    const member = { id: t.user.id, emailVerifiedAt: t.user.emailVerifiedAt, tags: [] as never[] };
    await db.event.update({ where: { id: s.event.id }, data: { status: "CANCELLED" } });
    expect(await chooseSeat(member, t.id, s.seats.A1!)).toEqual({ ok: false, reason: "eventNotOpen" });
    await db.event.update({ where: { id: s.event.id }, data: { status: "PUBLISHED" } });
    await db.ticket.update({ where: { id: t.id }, data: { status: "CANCELLED" } });
    expect(await chooseSeat(member, t.id, s.seats.A1!)).toEqual({ ok: false, reason: "ticketInactive" });
  });
});

describe("seat map for viewers", () => {
  it("shows states per viewer; nicknames only if the event allows; no personal data leaks", async () => {
    const s = await scenario();
    const me = await makeUser({ nickname: "Me-Myself" });
    const other = await makeUser({ nickname: "Neighbour", email: "neighbour-secret@example.test" });
    const reservedFor = await makeUser({ nickname: "VipGuest" });
    const mine = await s.ticket("any", { user: me });
    const theirs = await s.ticket("any", { user: other });
    await claim(s.seats.A1!, mine.id);
    await claim(s.seats.A2!, theirs.id);
    await db.seat.update({ where: { id: s.seats.A3 }, data: { blocked: true } });
    await db.seat.update({ where: { id: s.seats.A4 }, data: { reservedForUserId: reservedFor.id } });

    const meActor = asActor({ ...me, tags: [] });
    const m = (await getSeatMap(s.event.id, meActor))!;
    const state = (l: string) => m.seats.find((x) => x.label === l)!;
    expect(state("A1").state).toBe("mine");
    expect(state("A2").state).toBe("taken");
    expect(state("A3").state).toBe("blocked");
    expect(state("A4").state).toBe("reserved");
    expect(state("A5")).toMatchObject({ state: "free", selectable: true });
    expect(state("A1").selectable).toBe(false);
    expect(m.pick).toMatchObject({ ticketId: mine.id, currentSeatId: s.seats.A1, allowedZoneIds: null });
    expect(m.zones.map((z) => z.name).sort()).toEqual(["Standard", "VIP"]);

    // nicknames hidden by default…
    expect(state("A2").nickname).toBeUndefined();
    // …shown when the event opts in, for visitors too, and only for taken seats
    await db.event.update({ where: { id: s.event.id }, data: { showNicknamesOnMap: true } });
    const visitor = (await getSeatMap(s.event.id, null))!;
    expect(visitor.seats.find((x) => x.label === "A2")!.nickname).toBe("Neighbour");
    expect(visitor.seats.find((x) => x.label === "A3")!.nickname).toBeUndefined();
    expect(visitor.pick).toBeNull();
    expect(visitor.seats.every((x) => !x.selectable)).toBe(true);
    expect(visitor.seats.find((x) => x.label === "A1")!.state).toBe("taken"); // not "mine" for visitors

    const json = JSON.stringify(visitor);
    for (const secret of ["neighbour-secret", other.id, theirs.id, reservedFor.id, "VipGuest", "realName", "email", "ticketId", "userId"]) expect(json).not.toContain(secret);
  });

  it("treats expired holds as free, live holds as taken; reserved seat is selectable for its owner", async () => {
    const s = await scenario();
    const holder = await s.ticket("any", { status: "PENDING" });
    const holder2 = await s.ticket("any", { status: "PENDING" });
    await db.seatClaim.create({ data: { seatId: s.seats.A1!, ticketId: holder.id, status: "HELD", expiresAt: new Date(Date.now() - 1000) } });
    await db.seatClaim.create({ data: { seatId: s.seats.A2!, ticketId: holder2.id, status: "HELD", expiresAt: new Date(Date.now() + HOUR) } });
    const guest = await makeUser();
    await db.seat.update({ where: { id: s.seats.A4 }, data: { reservedForUserId: guest.id } });
    await s.ticket("any", { user: guest });

    const m = (await getSeatMap(s.event.id, asActor({ ...guest, tags: [] })))!;
    expect(m.seats.find((x) => x.label === "A1")!.state).toBe("free");
    expect(m.seats.find((x) => x.label === "A2")!.state).toBe("taken");
    expect(m.seats.find((x) => x.label === "A4")).toMatchObject({ state: "free", selectable: true });
  });

  it("limits selectable seats to the ticket type's zones and explains why picking is unavailable", async () => {
    const s = await scenario();
    const u = await makeUser();
    const t = await s.ticket("vip", { user: u });
    const m = (await getSeatMap(s.event.id, asActor({ ...u, tags: [] })))!;
    expect(m.seats.filter((x) => x.selectable).map((x) => x.label).sort()).toEqual(["V1", "V2"]);
    expect(m.pick?.ticketId).toBe(t.id);

    const noSeat = await makeUser();
    await s.ticket("visitor", { user: noSeat });
    expect((await getSeatMap(s.event.id, asActor({ ...noSeat, tags: [] })))!.pickBlockedReason).toBe("noSeatTicket");

    const pending = await makeUser();
    await s.ticket("any", { user: pending, status: "PENDING" });
    expect((await getSeatMap(s.event.id, asActor({ ...pending, tags: [] })))!.pickBlockedReason).toBe("ticketNotActive");

    const unv = await makeUser({ verified: false });
    await s.ticket("any", { user: unv });
    expect((await getSeatMap(s.event.id, asActor({ ...unv, tags: [] })))!.pickBlockedReason).toBe("unverified");

    await db.event.update({ where: { id: s.event.id }, data: { seatChangeDeadline: new Date(Date.now() - HOUR) } });
    expect((await getSeatMap(s.event.id, asActor({ ...u, tags: [] })))!.pickBlockedReason).toBe("deadlinePassed");
  });

  it("returns null for events without a chart", async () => {
    const fl = await makeUser({ tags: ["FESTIVALLEDARE"] });
    expect(await getSeatMap((await makeEvent(fl.id)).id, null)).toBeNull();
  });
});

// ───────────────────────── chart saving ─────────────────────────

async function payloadOf(chartId: string): Promise<ChartPayload> {
  const d = (await loadChartData(chartId))!;
  return chartPayloadSchema.parse({
    name: d.name, width: d.width, height: d.height, gridSize: d.gridSize,
    zones: d.zones,
    seats: d.seats.map(({ reservedForLabel: _l, ...s }) => s),
    objects: d.objects,
  });
}
const flActor = (fl: { id: string; emailVerifiedAt: Date | null }) => ({ id: fl.id, emailVerifiedAt: fl.emailVerifiedAt, tags: ["FESTIVALLEDARE" as const] });

describe("saving a chart (one transaction)", () => {
  it("adds, edits and deletes seats, zones and objects; writes an audit summary", async () => {
    const s = await scenario();
    const p = await payloadOf(s.chart.id);
    p.zones.push({ id: "new-zone", name: "Extra", color: "#009E73" });
    p.seats = p.seats.filter((x) => x.label !== "A5"); // delete
    p.seats.find((x) => x.label === "A1")!.x += 100; // move
    p.seats.push({ id: "tmp-1", label: "N1", x: 400, y: 400, rotation: 90, zoneId: "new-zone", groupId: "g1", blocked: false, reservedForUserId: null });
    p.objects.push({ id: "tmp-o", kind: "STAGE", x: 10, y: 10, width: 200, height: 60, rotation: 0, label: "Scen" });
    p.name = "Nytt namn";

    expect(await saveChart(flActor(s.fl), s.chart.id, p, "4.4.4.4")).toEqual({ ok: true });
    const after = (await loadChartData(s.chart.id))!;
    expect(after.name).toBe("Nytt namn");
    expect(after.seats.map((x) => x.label).sort()).toEqual(["A1", "A2", "A3", "A4", "N1", "V1", "V2"]);
    expect(after.seats.find((x) => x.label === "A1")!.x).toBe(140);
    const n1 = after.seats.find((x) => x.label === "N1")!;
    expect(after.zones.find((z) => z.id === n1.zoneId)!.name).toBe("Extra"); // client zone id remapped
    expect(after.objects).toHaveLength(1);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "chart.save" } });
    expect(log).toMatchObject({ actorId: s.fl.id, eventId: s.event.id, ip: "4.4.4.4" });
    expect(log.diff).toMatchObject({ seats: { added: 1, removed: 1, changed: 1, total: 7 }, zones: { added: 1, removed: 0 }, objects: { added: 1 } });
  });

  it("can swap two labels in one save", async () => {
    const s = await scenario();
    const p = await payloadOf(s.chart.id);
    const a1 = p.seats.find((x) => x.label === "A1")!;
    const a2 = p.seats.find((x) => x.label === "A2")!;
    [a1.label, a2.label] = ["A2", "A1"];
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: true });
    expect((await db.seat.findUniqueOrThrow({ where: { id: a1.id } })).label).toBe("A2");
    expect((await db.seat.findUniqueOrThrow({ where: { id: a2.id } })).label).toBe("A1");
  });

  it("rejects duplicate labels (case-insensitive) and changes nothing", async () => {
    const s = await scenario();
    const p = await payloadOf(s.chart.id);
    p.seats[0]!.label = "a2";
    p.name = "Ska inte sparas";
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: false, reason: "invalidLabels" });
    expect((await db.seatingChart.findUniqueOrThrow({ where: { id: s.chart.id } })).name).toBe("Karta");
  });

  it("refuses to delete or block a seat with a claim, and rolls back everything", async () => {
    const s = await scenario();
    const t = await s.ticket("any");
    await claim(s.seats.A1!, t.id);
    const p = await payloadOf(s.chart.id);
    p.seats = p.seats.filter((x) => x.label !== "A1");
    p.seats.push({ id: "tmp", label: "NEW", x: 1, y: 1, rotation: 0, zoneId: p.zones[0]!.id, groupId: null, blocked: false, reservedForUserId: null });
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: false, reason: "seatHasClaim", labels: ["A1"] });
    expect(await db.seat.count({ where: { label: "NEW" } })).toBe(0); // nothing applied
    expect(await db.seat.count({ where: { chartId: s.chart.id } })).toBe(7);

    const p2 = await payloadOf(s.chart.id);
    p2.seats.find((x) => x.label === "A1")!.blocked = true;
    expect(await saveChart(flActor(s.fl), s.chart.id, p2)).toEqual({ ok: false, reason: "seatHasClaim", labels: ["A1"] });
  });

  it("allows moving / relabelling / recolouring a claimed seat, but not into an incompatible zone", async () => {
    const s = await scenario();
    const t = await s.ticket("std"); // Standard zone only
    await claim(s.seats.A1!, t.id);

    const p = await payloadOf(s.chart.id);
    const a1 = p.seats.find((x) => x.label === "A1")!;
    a1.x += 80;
    a1.label = "A1b";
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: true });
    expect(await db.seatClaim.count({ where: { ticketId: t.id } })).toBe(1); // claim follows the seat

    const p2 = await payloadOf(s.chart.id);
    p2.seats.find((x) => x.label === "A1b")!.zoneId = s.vip.id;
    expect(await saveChart(flActor(s.fl), s.chart.id, p2)).toEqual({ ok: false, reason: "zoneIncompatible", labels: ["A1b"] });

    // a ticket type without zone restrictions may be moved to any zone
    const t2 = await s.ticket("any");
    await claim(s.seats.A2!, t2.id);
    const p3 = await payloadOf(s.chart.id);
    p3.seats.find((x) => x.label === "A2")!.zoneId = s.vip.id;
    expect(await saveChart(flActor(s.fl), s.chart.id, p3)).toEqual({ ok: true });
  });

  it("refuses to reserve a claimed seat for someone else, and rejects unknown users", async () => {
    const s = await scenario();
    const t = await s.ticket("any");
    await claim(s.seats.A1!, t.id);
    const stranger = await makeUser();
    const p = await payloadOf(s.chart.id);
    p.seats.find((x) => x.label === "A1")!.reservedForUserId = stranger.id;
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: false, reason: "reservedConflict", labels: ["A1"] });

    const p2 = await payloadOf(s.chart.id);
    p2.seats.find((x) => x.label === "A5")!.reservedForUserId = "ghost";
    expect(await saveChart(flActor(s.fl), s.chart.id, p2)).toEqual({ ok: false, reason: "badUser" });

    const p3 = await payloadOf(s.chart.id);
    p3.seats.find((x) => x.label === "A5")!.reservedForUserId = stranger.id;
    expect(await saveChart(flActor(s.fl), s.chart.id, p3)).toEqual({ ok: true });
    expect((await db.seat.findUniqueOrThrow({ where: { id: s.seats.A5 } })).reservedForUserId).toBe(stranger.id);
  });

  it("won't delete a zone that ticket types use, but can delete an unused one", async () => {
    const s = await scenario();
    const p = await payloadOf(s.chart.id);
    p.zones = p.zones.filter((z) => z.id !== s.vip.id);
    p.seats = p.seats.filter((x) => !x.label.startsWith("V"));
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: false, reason: "zoneInUse", names: ["VIP"] });

    await db.ticketTypeZone.deleteMany({ where: { zoneId: s.vip.id } });
    expect(await saveChart(flActor(s.fl), s.chart.id, p)).toEqual({ ok: true });
    expect(await db.seatZone.count({ where: { chartId: s.chart.id } })).toBe(1);
  });

  it("rejects payloads that reference unknown zones, and non-staff", async () => {
    const s = await scenario();
    const p = await payloadOf(s.chart.id);
    expect(chartPayloadSchema.safeParse({ ...p, seats: [{ ...p.seats[0], zoneId: "missing" }] }).success).toBe(false);
    expect(chartPayloadSchema.safeParse({ ...p, zones: [{ id: "z", name: "x", color: "red" }] }).success).toBe(false);
    const member = asActor({ ...(await makeUser()), tags: [] });
    await expect(saveChart(member, s.chart.id, p)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await saveChart(flActor(s.fl), "nope", p)).toEqual({ ok: false, reason: "notFound" });
  });

  it("refuses on cancelled events", async () => {
    const s = await scenario();
    await db.event.update({ where: { id: s.event.id }, data: { status: "CANCELLED" } });
    expect(await saveChart(flActor(s.fl), s.chart.id, await payloadOf(s.chart.id))).toEqual({ ok: false, reason: "eventCancelled" });
  });

  it("a claim racing a save never ends up on a seat the save deleted", async () => {
    const s = await scenario();
    const tickets = await Promise.all(Array.from({ length: 10 }, () => s.ticket("any")));
    const p = await payloadOf(s.chart.id);
    p.seats = p.seats.filter((x) => x.label !== "A1");
    const [save, ...claims] = await Promise.all([saveChart(flActor(s.fl), s.chart.id, p), ...tickets.map((t) => claim(s.seats.A1!, t.id))]);
    if (save.ok) {
      expect(claims.every((c) => !c.ok)).toBe(true); // seat gone → no claim may exist
      expect(await db.seatClaim.count()).toBe(0);
    } else {
      expect(save).toMatchObject({ reason: "seatHasClaim" });
      expect(await db.seatClaim.count({ where: { seatId: s.seats.A1 } })).toBe(1);
    }
    expect(await db.seatClaim.count({ where: { seat: { chartId: s.chart.id } } })).toBeLessThanOrEqual(1);
  });
});

describe("templates and chart creation", () => {
  it("saves an event chart as a template and applies it to another event (deep copy, no reservations)", async () => {
    const s = await scenario();
    const guest = await makeUser();
    await db.seat.update({ where: { id: s.seats.A1 }, data: { reservedForUserId: guest.id, blocked: false } });
    await db.chartObject.create({ data: { chartId: s.chart.id, kind: "KITCHEN", x: 0, y: 0, width: 50, height: 50 } });

    const fl = flActor(s.fl);
    const tpl = await saveAsTemplate(fl, s.event.id, "Standardmall");
    expect(tpl.ok).toBe(true);
    if (!tpl.ok) return;
    const tchart = await db.seatingChart.findUniqueOrThrow({ where: { id: tpl.templateId }, include: { seats: true, zones: true, objects: true } });
    expect(tchart).toMatchObject({ isTemplate: true, eventId: null, name: "Standardmall" });
    expect(tchart.seats).toHaveLength(7);
    expect(tchart.seats.every((x) => x.reservedForUserId === null)).toBe(true);
    expect(tchart.objects).toHaveLength(1);

    const e2 = await createEvent(fl, eventSchema.parse({ name: "Ny", description: "d", venueName: "v", address: "a", startsAt: "2027-05-01T18:00", endsAt: "2027-05-02T18:00", registrationOpensAt: "2027-01-01T10:00", registrationClosesAt: "2027-04-30T10:00", minAge: "14" }));
    expect(await applyTemplate(fl, e2.id, tpl.templateId)).toMatchObject({ ok: true });
    const copy = (await loadChartData((await db.seatingChart.findUniqueOrThrow({ where: { eventId: e2.id } })).id))!;
    expect(copy.seats).toHaveLength(7);
    expect(copy.zones.map((z) => z.id)).not.toContain(s.std.id);
    expect(await applyTemplate(fl, e2.id, tpl.templateId)).toMatchObject({ ok: false, reason: "badChart" }); // only once

    // the template can be edited with template:manage and deleted
    const p = await payloadOf(tpl.templateId);
    p.seats.pop();
    expect(await saveChart(fl, tpl.templateId, p)).toEqual({ ok: true });
    expect(await deleteTemplate(fl, tpl.templateId)).toEqual({ ok: true });
    expect(await db.seatingChart.count({ where: { id: tpl.templateId } })).toBe(0);
    expect(await db.seatingChart.count({ where: { eventId: e2.id } })).toBe(1); // copies are independent
  });

  it("creates a blank chart once per event", async () => {
    const fl = flActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ev = await makeEvent(fl.id);
    const r = await createBlankChart(fl, ev.id);
    expect(r.ok).toBe(true);
    expect(await db.seatZone.count()).toBe(1);
    expect(await createBlankChart(fl, ev.id)).toMatchObject({ ok: false, reason: "badChart" });
    await expect(createBlankChart(asActor({ ...(await makeUser()), tags: [] }), ev.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("searches users by nickname or email, staff only, never anonymized", async () => {
    const fl = flActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    await makeUser({ nickname: "DragonSlayer", email: "dragon@example.test" });
    const gone = await makeUser({ nickname: "DragonGone" });
    await db.user.update({ where: { id: gone.id }, data: { anonymizedAt: new Date() } });
    expect((await searchUsers(fl, "dragon")).map((u) => u.nickname)).toEqual(["DragonSlayer"]);
    expect((await searchUsers(fl, "DRAGON@example")).map((u) => u.nickname)).toEqual(["DragonSlayer"]);
    expect(await searchUsers(fl, "d")).toEqual([]);
    await expect(searchUsers(asActor({ ...(await makeUser()), tags: [] }), "dragon")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("geometry helpers", () => {
  it("snaps to the grid and rotates around a centre", () => {
    expect(snap(29, 20)).toBe(20);
    expect(snap(31, 20)).toBe(40);
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
    expect(centroid([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toEqual({ x: 5, y: 10 });
  });

  it("lays out rows and tables", () => {
    expect(seatSpacing(20)).toBe(40);
    expect(seatSpacing(40)).toBe(40);
    expect(seatSpacing(10)).toBe(40);
    expect(rowPositions({ count: 3, startX: 20, startY: 60, spacing: 40, orientation: "horizontal" })).toEqual([{ x: 20, y: 60 }, { x: 60, y: 60 }, { x: 100, y: 60 }]);
    expect(rowPositions({ count: 2, startX: 0, startY: 0, spacing: 40, orientation: "vertical" })[1]).toEqual({ x: 0, y: 40 });
    const t = tableLayout({ count: 5, cx: 200, cy: 200, spacing: 40 });
    expect(t.seats).toHaveLength(5);
    expect(t.seats.filter((x) => x.rotation === 0)).toHaveLength(3); // odd seat goes on top
    expect(t.seats.filter((x) => x.rotation === 180)).toHaveLength(2);
    expect(t.table.width).toBe(120);
  });

  it("proposes unused row prefixes and sequential labels", () => {
    expect(nextPrefix([])).toBe("A");
    expect(nextPrefix(["A1", "A2", "B1", "c3"])).toBe("D");
    expect(nextPrefix(Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}1`))).toBe("AA");
    expect(makeLabels("B", 3)).toEqual(["B1", "B2", "B3"]);
    expect(makeLabels("T", 2, 5)).toEqual(["T5", "T6"]);
  });

  it("finds duplicate labels case-insensitively", () => {
    expect([...findDuplicateLabels([{ id: "1", label: "A1" }, { id: "2", label: "a1 " }, { id: "3", label: "A2" }])].sort()).toEqual(["1", "2"]);
  });

  it("orders seats for auto-labelling", () => {
    const seats = [{ id: "d", x: 40, y: 40 }, { id: "a", x: 0, y: 0 }, { id: "c", x: 0, y: 40 }, { id: "b", x: 40, y: 0 }];
    expect(relabelOrder(seats, 20, "x").map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(relabelOrder(seats, 20, "y").map((s) => s.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("picks readable label colours", () => {
    expect(isLightColor("#F0E442")).toBe(true);
    expect(isLightColor("#0072B2")).toBe(false);
  });
});
