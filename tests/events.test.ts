import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEvent, duplicateEvent, removeEventImage, setEventImage, setEventStatus, slugify, updateEvent } from "@/lib/events/service";
import { createTicketType, deleteTicketType, updateTicketType } from "@/lib/events/ticket-types";
import { getEventForViewer, saleState, soldByType } from "@/lib/events/queries";
import { ForbiddenError } from "@/lib/permissions";
import { LocalDiskStorage, setStorage, sniffImage } from "@/lib/storage";
import { oreToInput, parseSekToOre } from "@/lib/money";
import { parseStockholmLocal, toStockholmInput } from "@/lib/time";
import { eventSchema, ticketTypeSchema } from "@/lib/validation/events";
import { asActor, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const eventForm = {
  name: "Vår-LAN åäö!",
  description: "Beskrivning",
  venueName: "Hallen",
  address: "Gatan 1",
  startsAt: "2027-03-12T18:00",
  endsAt: "2027-03-14T12:00",
  registrationOpensAt: "2027-01-01T08:00",
  registrationClosesAt: "2027-03-10T23:59",
  minAge: "14",
};
const ticketForm = { name: "Standard", description: "", price: "150", quantity: "50", includesSeat: "on" };

const leader = async () => asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
const evInput = (over: Record<string, string> = {}) => eventSchema.parse({ ...eventForm, ...over });
const ttInput = (over: Record<string, string> = {}) => ticketTypeSchema.parse({ ...ticketForm, ...over });

describe("time helpers (Europe/Stockholm ⇄ UTC)", () => {
  it("converts summer and winter time", () => {
    expect(parseStockholmLocal("2027-07-01T12:00")!.toISOString()).toBe("2027-07-01T10:00:00.000Z"); // CEST +2
    expect(parseStockholmLocal("2027-01-15T12:00")!.toISOString()).toBe("2027-01-15T11:00:00.000Z"); // CET +1
  });
  it("round-trips for display", () => {
    for (const s of ["2027-03-12T18:00", "2027-10-31T02:30", "2027-12-31T23:59"]) expect(toStockholmInput(parseStockholmLocal(s)!)).toBe(s);
  });
  it("handles the DST switch days", () => {
    expect(parseStockholmLocal("2027-03-28T02:30")).toBeNull(); // doesn't exist (clocks jump 02:00→03:00)
    expect(parseStockholmLocal("2027-03-28T03:30")!.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(parseStockholmLocal("2027-10-31T02:30")).not.toBeNull(); // ambiguous hour resolves to one instant
  });
  it("rejects malformed input", () => {
    for (const s of ["", "2027-03-12", "2027-13-01T10:00", "2027-02-30T10:00", "12/03/2027 18:00"]) expect(parseStockholmLocal(s)).toBeNull();
  });
});

describe("money input", () => {
  it("parses kronor to öre", () => {
    expect(parseSekToOre("150")).toBe(15000);
    expect(parseSekToOre("149,50")).toBe(14950);
    expect(parseSekToOre("149.5")).toBe(14950);
    expect(parseSekToOre("0")).toBe(0);
  });
  it("rejects junk", () => {
    for (const s of ["", "-5", "1 500", "1.234", "abc", "1,2,3"]) expect(parseSekToOre(s)).toBeNull();
  });
  it("formats öre for inputs", () => {
    expect(oreToInput(15000)).toBe("150");
    expect(oreToInput(14905)).toBe("149,05");
  });
});

describe("event validation", () => {
  it("converts Stockholm times to UTC", () => {
    expect(evInput().startsAt.toISOString()).toBe("2027-03-12T17:00:00.000Z");
  });
  it("checks date order", () => {
    expect(eventSchema.safeParse({ ...eventForm, endsAt: "2027-03-12T17:00" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...eventForm, registrationClosesAt: "2027-01-01T08:00" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...eventForm, registrationClosesAt: "2027-04-01T08:00" }).success).toBe(false); // after event end
    expect(eventSchema.safeParse({ ...eventForm, seatChangeDeadline: "2027-04-01T08:00" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...eventForm, seatChangeDeadline: "2027-03-11T08:00" }).success).toBe(true);
  });
  it("validates minAge and ticket price", () => {
    expect(eventSchema.safeParse({ ...eventForm, minAge: "-1" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...eventForm, minAge: "x" }).success).toBe(false);
    expect(ticketTypeSchema.safeParse({ ...ticketForm, price: "gratis" }).success).toBe(false);
    expect(ticketTypeSchema.safeParse({ ...ticketForm, salesStartsAt: "2027-02-01T10:00", salesEndsAt: "2027-01-01T10:00" }).success).toBe(false);
    expect(ttInput({ price: "149,50" }).price).toBe(14950);
  });
});

describe("creating and editing events", () => {
  it("slugifies Swedish names", () => {
    expect(slugify("Vår-LAN åäö!")).toBe("var-lan-aao");
    expect(slugify("!!!")).toBe("event");
  });

  it("creates a DRAFT with a unique slug, and audits", async () => {
    const fl = await leader();
    const a = await createEvent(fl, evInput(), { ip: "1.1.1.1" });
    const b = await createEvent(fl, evInput());
    expect(a).toMatchObject({ status: "DRAFT", slug: "var-lan-aao", createdById: fl.id, minAge: 14 });
    expect(b.slug).toBe("var-lan-aao-2");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "event.create", entityId: a.id } });
    expect(log).toMatchObject({ actorId: fl.id, eventId: a.id, ip: "1.1.1.1" });
  });

  it("is forbidden for members and for admins without the Festivalledare tag", async () => {
    const member = asActor(await makeUser());
    const admin = asActor(await makeUser({ tags: ["ADMIN"] }));
    await expect(createEvent(member, evInput())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createEvent(admin, evInput())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.event.count()).toBe(0);
  });

  it("copies a template chart when creating from a template", async () => {
    const fl = await leader();
    const tpl = await db.seatingChart.create({ data: { name: "Mall", isTemplate: true, zones: { create: [{ name: "Z", color: "#f00" }] } } });
    const zone = await db.seatZone.findFirstOrThrow({ where: { chartId: tpl.id } });
    await db.seat.create({ data: { chartId: tpl.id, label: "A1", x: 1, y: 1, zoneId: zone.id } });
    const ev = await createEvent(fl, evInput(), { templateId: tpl.id });
    const chart = await db.seatingChart.findUniqueOrThrow({ where: { eventId: ev.id }, include: { seats: true, zones: true } });
    expect(chart).toMatchObject({ isTemplate: false });
    expect(chart.seats).toHaveLength(1);
    expect(chart.zones[0]!.id).not.toBe(zone.id);
    expect(chart.seats[0]!.zoneId).toBe(chart.zones[0]!.id);
  });

  it("updates with an audit diff and refuses to edit cancelled events", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    expect(await updateEvent(fl, ev.id, evInput({ name: "Nytt namn", minAge: "16" }))).toMatchObject({ ok: true });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "event.update" } });
    expect(log.diff).toEqual({ name: { from: "Vår-LAN åäö!", to: "Nytt namn" }, minAge: { from: 14, to: 16 } });
    expect((await db.event.findUniqueOrThrow({ where: { id: ev.id } })).slug).toBe("var-lan-aao"); // slug is stable

    await setEventStatus(fl, ev.id, "CANCELLED");
    expect(await updateEvent(fl, ev.id, evInput())).toEqual({ ok: false, reason: "cancelled" });
    expect(await updateEvent(fl, "nope", evInput())).toEqual({ ok: false, reason: "notFound" });
  });
});

describe("status flow DRAFT → PUBLISHED → CLOSED, CANCELLED from anywhere", () => {
  it("allows the legal transitions only", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    expect(await setEventStatus(fl, ev.id, "CLOSED")).toMatchObject({ ok: false, reason: "badTransition" }); // can't skip
    expect(await setEventStatus(fl, ev.id, "PUBLISHED")).toMatchObject({ ok: true });
    expect(await setEventStatus(fl, ev.id, "DRAFT" as never)).toMatchObject({ ok: false, reason: "badTransition" }); // no going back
    expect(await setEventStatus(fl, ev.id, "CLOSED")).toMatchObject({ ok: true });
    expect(await setEventStatus(fl, ev.id, "PUBLISHED")).toMatchObject({ ok: false });
    expect(await setEventStatus(fl, ev.id, "CANCELLED")).toMatchObject({ ok: true });
    expect(await setEventStatus(fl, ev.id, "CANCELLED")).toMatchObject({ ok: false, reason: "badTransition" });
    const logs = await db.auditLog.findMany({ where: { action: "event.status" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.diff)).toEqual([{ status: { from: "DRAFT", to: "PUBLISHED" } }, { status: { from: "PUBLISHED", to: "CLOSED" } }, { status: { from: "CLOSED", to: "CANCELLED" } }]);
  });

  it("CANCELLED is reachable from DRAFT too", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    expect(await setEventStatus(fl, ev.id, "CANCELLED")).toMatchObject({ ok: true });
  });

  it("concurrent identical transitions: exactly one wins", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    const r = await Promise.all([setEventStatus(fl, ev.id, "PUBLISHED"), setEventStatus(fl, ev.id, "PUBLISHED"), setEventStatus(fl, ev.id, "PUBLISHED")]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "event.status" } })).toBe(1);
  });
});

/** An event with everything attached, including data that must NOT be copied. */
async function buildFullEvent(fl: ReturnType<typeof asActor>) {
  const ev = await createEvent(fl, evInput());
  const chart = await db.seatingChart.create({ data: { eventId: ev.id, name: "Karta", width: 900, height: 600, gridSize: 10 } });
  const std = await db.seatZone.create({ data: { chartId: chart.id, name: "Standard", color: "#00f" } });
  const vip = await db.seatZone.create({ data: { chartId: chart.id, name: "VIP", color: "#fa0" } });
  const buyer = await makeUser();
  const seats = await Promise.all(
    ["A1", "A2", "B1"].map((label, i) => db.seat.create({ data: { chartId: chart.id, label, x: i * 20, y: 10, zoneId: i < 2 ? std.id : vip.id, groupId: "row-a", reservedForUserId: label === "B1" ? buyer.id : null, blocked: label === "A2" } })),
  );
  await db.chartObject.create({ data: { chartId: chart.id, kind: "STAGE", x: 0, y: 0, width: 100, height: 40, label: "Scen" } });

  const standard = await createTicketType(fl, ev.id, ttInput({ name: "Standard" }), [std.id]);
  const vipType = await createTicketType(fl, ev.id, ttInput({ name: "VIP", price: "250" }), [vip.id]);
  const crew = await createTicketType(fl, ev.id, ttInput({ name: "Crew", price: "0", hidden: "on", requiresDiscountCode: "on" }), []);
  if (!standard.ok || !vipType.ok || !crew.ok) throw new Error("setup");

  const fri = await db.meal.create({ data: { eventId: ev.id, name: "Fredagsmiddag", servedAt: new Date("2027-03-12T18:00:00Z") } });
  const sat = await db.meal.create({ data: { eventId: ev.id, name: "Lördagslunch", servedAt: new Date("2027-03-13T11:00:00Z") } });
  const pkg = await db.foodPackage.create({
    data: {
      eventId: ev.id, name: "Helhelg", priceOre: 30000, quantity: 60, salesEndsAt: new Date("2027-03-05T00:00:00Z"),
      meals: { create: [{ mealId: fri.id }, { mealId: sat.id }] },
      variants: { create: [{ name: "Standard", sortOrder: 0 }, { name: "Vegansk", sortOrder: 1 }] },
    },
  });

  // Data that must not be copied:
  const order = await db.order.create({ data: { number: "CCSS-2027-0001", userId: buyer.id, eventId: ev.id, status: "PAID", subtotalOre: 15000, totalOre: 15000, expiresAt: new Date() } });
  const ticket = await db.ticket.create({ data: { eventId: ev.id, userId: buyer.id, ticketTypeId: standard.value.id, orderId: order.id, status: "ACTIVE", qrNonce: "n" } });
  await db.seatClaim.create({ data: { seatId: seats[0]!.id, ticketId: ticket.id, status: "CONFIRMED" } });
  await db.discountCode.create({ data: { eventId: ev.id, code: "CREW", kind: "PERCENT", value: 100, usedCount: 3, ticketTypes: { create: [{ ticketTypeId: crew.value.id }] } } });
  return { ev, chart, pkg, std, vip, buyer };
}

describe("duplicating an event", () => {
  it("deep-copies chart, ticket types, meals, packages and variants as a DRAFT", async () => {
    const fl = await leader();
    const { ev, chart, std, vip } = await buildFullEvent(fl);
    await setEventStatus(fl, ev.id, "PUBLISHED");

    const r = await duplicateEvent(fl, ev.id, "2.2.2.2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const copy = await db.event.findUniqueOrThrow({
      where: { id: r.value.id },
      include: {
        chart: { include: { zones: true, seats: true, objects: true } },
        ticketTypes: { include: { zones: true }, orderBy: { name: "asc" } },
        meals: true,
        foodPackages: { include: { meals: true, variants: { orderBy: { sortOrder: "asc" } } } },
      },
    });
    expect(copy).toMatchObject({ status: "DRAFT", name: "Vår-LAN åäö! (kopia)", createdById: fl.id, minAge: 14 });
    expect(copy.slug).not.toBe(ev.slug);
    expect(copy.startsAt).toEqual(ev.startsAt);

    // chart
    expect(copy.chart).toMatchObject({ name: "Karta", width: 900, height: 600, gridSize: 10, isTemplate: false });
    expect(copy.chart!.id).not.toBe(chart.id);
    expect(copy.chart!.zones.map((z) => z.name).sort()).toEqual(["Standard", "VIP"]);
    expect(copy.chart!.zones.map((z) => z.id)).not.toContain(std.id);
    expect(copy.chart!.seats.map((s) => s.label).sort()).toEqual(["A1", "A2", "B1"]);
    expect(copy.chart!.objects).toHaveLength(1);
    const newZoneIds = new Set(copy.chart!.zones.map((z) => z.id));
    expect(copy.chart!.seats.every((s) => newZoneIds.has(s.zoneId))).toBe(true); // zone ids remapped
    const zoneNameOfSeat = (label: string) => copy.chart!.zones.find((z) => z.id === copy.chart!.seats.find((s) => s.label === label)!.zoneId)!.name;
    expect(zoneNameOfSeat("A1")).toBe("Standard");
    expect(zoneNameOfSeat("B1")).toBe("VIP");
    expect(copy.chart!.seats.find((s) => s.label === "A2")!.blocked).toBe(true); // blocked state kept
    expect(copy.chart!.seats.every((s) => s.reservedForUserId === null)).toBe(true); // per-event reservations dropped

    // ticket types with remapped zone links
    expect(copy.ticketTypes.map((t) => t.name)).toEqual(["Crew", "Standard", "VIP"]);
    const vipCopy = copy.ticketTypes.find((t) => t.name === "VIP")!;
    expect(vipCopy.priceOre).toBe(25000);
    expect(vipCopy.zones.map((z) => z.zoneId)).toEqual([copy.chart!.zones.find((z) => z.name === "VIP")!.id]);
    expect(vipCopy.zones.map((z) => z.zoneId)).not.toContain(vip.id);
    expect(copy.ticketTypes.find((t) => t.name === "Crew")).toMatchObject({ hidden: true, requiresDiscountCode: true });

    // food
    expect(copy.meals.map((m) => m.name).sort()).toEqual(["Fredagsmiddag", "Lördagslunch"]);
    expect(copy.foodPackages).toHaveLength(1);
    const pkg = copy.foodPackages[0]!;
    expect(pkg.variants.map((v) => v.name)).toEqual(["Standard", "Vegansk"]);
    expect(pkg.meals.map((m) => m.mealId).sort()).toEqual(copy.meals.map((m) => m.id).sort()); // linked to the NEW meals

    // not copied
    expect(await db.order.count({ where: { eventId: copy.id } })).toBe(0);
    expect(await db.ticket.count({ where: { eventId: copy.id } })).toBe(0);
    expect(await db.seatClaim.count({ where: { seat: { chartId: copy.chart!.id } } })).toBe(0);
    expect(await db.discountCode.count({ where: { eventId: copy.id } })).toBe(0);

    // the original is untouched
    expect(await db.seatClaim.count({ where: { seat: { chartId: chart.id } } })).toBe(1);
    expect(await db.ticketType.count({ where: { eventId: ev.id } })).toBe(3);
    expect((await db.event.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe("PUBLISHED");

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "event.duplicate" } });
    expect(log).toMatchObject({ eventId: copy.id, ip: "2.2.2.2", diff: { copiedFrom: ev.id } });
  });

  it("duplicates events without a chart, and again (unique slugs)", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    const a = await duplicateEvent(fl, ev.id);
    const b = await duplicateEvent(fl, ev.id);
    expect(a.ok && b.ok && a.value.slug !== b.value.slug).toBe(true);
    expect(await duplicateEvent(fl, "nope")).toEqual({ ok: false, reason: "notFound" });
  });

  it("is forbidden for members", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    await expect(duplicateEvent(asActor(await makeUser()), ev.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("ticket types", () => {
  it("creates, updates (with audit) and links zones of the event's own chart", async () => {
    const fl = await leader();
    const { ev, std, vip } = await buildFullEvent(fl);
    const r = await createTicketType(fl, ev.id, ttInput({ name: "Early bird", price: "99,50", salesEndsAt: "2027-02-01T12:00" }), [std.id, vip.id]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tt = await db.ticketType.findUniqueOrThrow({ where: { id: r.value.id }, include: { zones: true } });
    expect(tt).toMatchObject({ priceOre: 9950, quantity: 50, includesSeat: true, hidden: false });
    expect(tt.salesEndsAt!.toISOString()).toBe("2027-02-01T11:00:00.000Z");
    expect(tt.zones).toHaveLength(2);

    expect(await updateTicketType(fl, tt.id, ttInput({ name: "Early bird", price: "120", quantity: "40" }), [std.id])).toMatchObject({ ok: true });
    const after = await db.ticketType.findUniqueOrThrow({ where: { id: tt.id }, include: { zones: true } });
    expect(after).toMatchObject({ priceOre: 12000, quantity: 40, salesEndsAt: null });
    expect(after.zones.map((z) => z.zoneId)).toEqual([std.id]);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "ticketType.update", entityId: tt.id } });
    expect(log.diff).toMatchObject({ priceOre: { from: 9950, to: 12000 }, quantity: { from: 50, to: 40 } });
  });

  it("rejects zones from another event's chart", async () => {
    const fl = await leader();
    const a = await buildFullEvent(fl);
    const other = await createEvent(fl, evInput());
    expect(await createTicketType(fl, other.id, ttInput(), [a.std.id])).toEqual({ ok: false, reason: "badZones" });
    expect(await createTicketType(fl, other.id, ttInput(), ["bogus"])).toEqual({ ok: false, reason: "badZones" });
  });

  it("won't drop quantity below tickets sold, and won't delete types with sales", async () => {
    const fl = await leader();
    const { ev } = await buildFullEvent(fl);
    const std = await db.ticketType.findFirstOrThrow({ where: { eventId: ev.id, name: "Standard" } });
    expect(await updateTicketType(fl, std.id, ttInput({ quantity: "0" }), [])).toEqual({ ok: false, reason: "quantityBelowSold" });
    expect(await deleteTicketType(fl, std.id)).toEqual({ ok: false, reason: "hasSales" });
    const vipT = await db.ticketType.findFirstOrThrow({ where: { eventId: ev.id, name: "VIP" } });
    expect(await deleteTicketType(fl, vipT.id)).toMatchObject({ ok: true });
    expect(await db.ticketType.count({ where: { id: vipT.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "ticketType.delete" } })).toBe(1);
  });

  it("is forbidden for members and blocked on cancelled events", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    await expect(createTicketType(asActor(await makeUser()), ev.id, ttInput(), [])).rejects.toBeInstanceOf(ForbiddenError);
    await setEventStatus(fl, ev.id, "CANCELLED");
    expect(await createTicketType(fl, ev.id, ttInput(), [])).toEqual({ ok: false, reason: "eventCancelled" });
  });
});

describe("visibility and availability", () => {
  it("drafts are visible to Festivalledare and Admin only", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    const admin = asActor(await makeUser({ tags: ["ADMIN"] }));
    const member = asActor(await makeUser());
    expect(await getEventForViewer(ev.slug, null)).toBeNull();
    expect(await getEventForViewer(ev.slug, member)).toBeNull();
    expect((await getEventForViewer(ev.slug, fl))?.id).toBe(ev.id);
    expect((await getEventForViewer(ev.slug, admin))?.id).toBe(ev.id);
    await setEventStatus(fl, ev.id, "PUBLISHED");
    expect((await getEventForViewer(ev.slug, null))?.id).toBe(ev.id);
    expect(await getEventForViewer("missing", fl)).toBeNull();
  });

  it("counts PENDING and ACTIVE tickets as sold, not CANCELLED", async () => {
    const fl = await leader();
    const { ev } = await buildFullEvent(fl); // 1 ACTIVE Standard ticket
    const std = await db.ticketType.findFirstOrThrow({ where: { eventId: ev.id, name: "Standard" } });
    const u = await makeUser();
    const o = await db.order.create({ data: { number: "X-1", userId: u.id, eventId: ev.id, subtotalOre: 0, totalOre: 0, expiresAt: new Date() } });
    await db.ticket.create({ data: { eventId: ev.id, userId: u.id, ticketTypeId: std.id, orderId: o.id, status: "PENDING", qrNonce: "n" } });
    const c = await makeUser();
    await db.ticket.create({ data: { eventId: ev.id, userId: c.id, ticketTypeId: std.id, orderId: o.id, status: "CANCELLED", qrNonce: "n" } });
    expect((await soldByType(ev.id)).get(std.id)).toBe(2);
  });

  it("derives the sale state from window and stock", () => {
    const now = new Date("2027-02-01T12:00:00Z");
    const base = { quantity: 10, salesStartsAt: null, salesEndsAt: null };
    expect(saleState(base, 0, now)).toBe("open");
    expect(saleState(base, 10, now)).toBe("soldOut");
    expect(saleState({ ...base, salesStartsAt: new Date("2027-03-01T00:00:00Z") }, 0, now)).toBe("upcoming");
    expect(saleState({ ...base, salesEndsAt: new Date("2027-02-01T12:00:00Z") }, 0, now)).toBe("ended"); // end is exclusive
    expect(saleState({ ...base, salesEndsAt: new Date("2027-02-01T12:00:01Z") }, 0, now)).toBe("open");
  });
});

describe("image upload", () => {
  let dir: string;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  const files = async () => (await readdir(path.join(dir, "events")).catch(() => [])).sort();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ccss-up-"));
    setStorage(new LocalDiskStorage(dir));
  });
  afterAll(async () => {
    setStorage(undefined);
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => rm(path.join(dir, "events"), { recursive: true, force: true }));

  it("sniffs real image types from magic bytes", () => {
    expect(sniffImage(png)?.ext).toBe("png");
    expect(sniffImage(jpg)?.ext).toBe("jpg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]))?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a......"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it("stores the image under a random name and replaces/removes the old file", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    const r1 = await setEventImage(fl, ev.id, png);
    expect(r1.ok && r1.value.imagePath).toMatch(/^\/uploads\/events\/[a-f0-9]{32}\.png$/);
    expect(await files()).toHaveLength(1);

    const r2 = await setEventImage(fl, ev.id, jpg);
    expect(r2.ok && r2.value.imagePath).toMatch(/\.jpg$/);
    expect(await files()).toHaveLength(1); // old png removed
    expect(await files()).toEqual([expect.stringMatching(/\.jpg$/)]);

    expect(await removeEventImage(fl, ev.id)).toMatchObject({ ok: true });
    expect(await files()).toHaveLength(0);
    expect((await db.event.findUniqueOrThrow({ where: { id: ev.id } })).imagePath).toBeNull();
  });

  it("rejects non-images and oversize files, and refuses non-staff", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    expect(await setEventImage(fl, ev.id, Buffer.from("not an image at all"))).toEqual({ ok: false, reason: "badImage" });
    expect(await setEventImage(fl, ev.id, Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).toEqual({ ok: false, reason: "tooLarge" });
    expect(await setEventImage(fl, "nope", png)).toEqual({ ok: false, reason: "notFound" });
    await expect(setEventImage(asActor(await makeUser()), ev.id, png)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await files()).toHaveLength(0);
  });

  it("keeps a shared file when a duplicate still uses it", async () => {
    const fl = await leader();
    const ev = await createEvent(fl, evInput());
    await setEventImage(fl, ev.id, png);
    const dup = await duplicateEvent(fl, ev.id);
    if (!dup.ok) throw new Error("dup");
    await setEventImage(fl, ev.id, jpg); // original moves on…
    expect(await files()).toHaveLength(2); // …but the png stays for the copy
    await removeEventImage(fl, dup.value.id);
    expect(await files()).toHaveLength(1);
  });
});
