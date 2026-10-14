import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { BOM, csvCell, neutralize, toCsv } from "@/lib/attendees/csv";
import { attendeeCsvRows, CSV_HEADER, listAttendees, parseFilters } from "@/lib/attendees/query";
import { broadcastRecipients, broadcastSchema, listBroadcasts, sendBroadcast } from "@/lib/broadcast/service";
import { checkIn } from "@/lib/checkin/service";
import { setEmailSender, type OutgoingEmail } from "@/lib/email/sender";
import { processOutbox } from "@/lib/email/outbox";
import { ForbiddenError } from "@/lib/permissions";
import { setPaymentProvider } from "@/lib/payments";
import { cancelOrder } from "@/lib/orders/refund";
import { getEventStats } from "@/lib/stats/event-stats";
import { FakeProvider, actorOf, buyPaid, shop, type Shop } from "./commerce-helpers";
import { makeUser, resetDb } from "./helpers";

// The CSV route authenticates through the session cookie; here we just decide who is "logged in".
const session = vi.hoisted(() => ({ user: null as null | { id: string; emailVerifiedAt: Date | null; tags: readonly ("FESTIVALLEDARE" | "ADMIN")[] } }));
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: async () => session.user }));
vi.mock("@/lib/auth/request", () => ({ getClientIp: async () => "9.9.9.9", getUserAgent: async () => "vitest", isSameOrigin: () => true }));

beforeEach(async () => {
  await resetDb();
  setPaymentProvider(new FakeProvider());
  session.user = null;
});
afterEach(() => {
  setPaymentProvider(undefined);
  setEmailSender(undefined);
});

const crewActor = async () => actorOf({ ...(await makeUser({ tags: ["FESTIVALLEDARE"] })), tags: [{ tag: "FESTIVALLEDARE" }] });

/** A realistic event: tickets of several kinds, food, a partial refund and some check-ins. */
async function busyEvent() {
  const s = await shop();
  const crew = await crewActor();
  const food = (p: Shop["food"]["helhelg"], v = "Standard") => [{ packageId: p.id, variantId: s.food.hv(p, v) }];
  const anna = await buyPaid(s, { seatId: s.seats.A1!, food: food(s.food.helhelg, "Vegansk") }, { nickname: "anna", realName: "Anna Andersson", allergies: "nötter" });
  const bo = await buyPaid(s, { ticketTypeId: s.types.vip.id, seatId: s.seats.V1!, food: food(s.food.frukost) }, { nickname: "bo", realName: "Bo Bengtsson" });
  const cia = await buyPaid(s, { ticketTypeId: s.types.visitor.id }, { nickname: "cia", realName: "Cia Carlsson" });
  const dan = await buyPaid(s, { seatId: s.seats.A2! }, { nickname: "dan", realName: "Dan Dahl" });
  await cancelOrder(s.fl, dan.order.id, { refundOre: 5000 }); // Dan: cancelled, 50 kr back
  const pending = await s.buyer({ nickname: "pelle" });
  const { startCheckout } = await import("@/lib/orders/checkout");
  await startCheckout(pending.actor, s.input({ seatId: s.seats.A3! })); // unpaid, seat held
  await checkIn(crew, s.event.id, anna.ticket.id);
  await checkIn(crew, s.event.id, cia.ticket.id);
  return { s, crew, anna, bo, cia, dan, pending };
}

describe("event statistics", () => {
  it("counts tickets per type, seats per zone, revenue after refunds, food per variant and check-ins", async () => {
    const { s, crew } = await busyEvent();
    const st = await getEventStats(crew, s.event.id);

    const byName = (n: string) => st.tickets.find((t) => t.name === n)!;
    expect(byName("Standard")).toMatchObject({ active: 1, pending: 1, checkedIn: 1, quantity: 5 }); // Anna active, Pelle pending (Dan cancelled)
    expect(byName("VIP")).toMatchObject({ active: 1, pending: 0, checkedIn: 0 });
    expect(byName("Besökare")).toMatchObject({ active: 1, checkedIn: 1 });
    expect(st.ticketTotals).toMatchObject({ active: 3, pending: 1, checkedIn: 2 });

    expect(st.seats).toMatchObject({ total: 5, taken: 2, held: 1, free: 2 }); // A1, V1 confirmed; A3 held; A2 released by the cancellation
    expect(st.seats!.byZone.find((z) => z.name === "Standard")).toMatchObject({ total: 4, taken: 1 });
    expect(st.seats!.byZone.find((z) => z.name === "VIP")).toMatchObject({ total: 1, taken: 1 });

    // charged: 150 (Anna) + 300 (Helhelg) + 250 (VIP) + 80 (Frukost) + 50 (Cia) + 150 (Dan) = 980 kr; refunded 50 kr
    expect(st.revenue).toMatchObject({ chargedOre: 98000, refundedOre: 5000, netOre: 93000 });
    expect(st.revenue.orders).toMatchObject({ paid: 3, pending: 1, cancelled: 1, refunded: 0 });

    const hel = st.food.find((f) => f.name === "Helhelg")!;
    expect(hel).toMatchObject({ total: 1, quantity: 2 });
    expect(hel.variants).toEqual([{ name: "Standard", count: 0 }, { name: "Vegansk", count: 1 }]);
    expect(st.food.find((f) => f.name === "Frukost")!.total).toBe(1);
    expect(st.food.find((f) => f.name === "Försent")!.total).toBe(0);
  });

  it("treats a full refund as returned money, and is for Festivalledare only", async () => {
    const s = await shop();
    const b = await buyPaid(s);
    await cancelOrder(s.fl, b.order.id, {});
    const st = await getEventStats(s.fl, s.event.id);
    expect(st.revenue).toMatchObject({ chargedOre: 15000, refundedOre: 15000, netOre: 0 });
    expect(st.revenue.orders.refunded).toBe(1);
    await expect(getEventStats((await s.buyer()).actor, s.event.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getEventStats(actorOf({ ...(await makeUser({ tags: ["ADMIN"] })), tags: [{ tag: "ADMIN" }] }), s.event.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("works for an event without a chart or sales", async () => {
    const flUser = await makeUser({ tags: ["FESTIVALLEDARE"] });
    const { makeEvent } = await import("./helpers");
    const ev = await makeEvent(flUser.id);
    const st = await getEventStats(actorOf({ ...flUser, tags: [{ tag: "FESTIVALLEDARE" }] }), ev.id);
    expect(st.seats).toBeNull();
    expect(st.revenue.netOre).toBe(0);
    expect(st.tickets).toEqual([]);
  });
});

describe("attendee list", () => {
  it("lists active ticket holders only, sorted by nickname, with food, seat, minors and check-in", async () => {
    const { s, crew, anna } = await busyEvent();
    const rows = await listAttendees(crew, s.event.id);
    expect(rows.map((r) => r.nickname)).toEqual(["anna", "bo", "cia"]); // Dan cancelled, Pelle unpaid
    const a = rows[0]!;
    expect(a).toMatchObject({ realName: "Anna Andersson", ticketType: "Standard", seat: "A1", allergies: "nötter", minor: false, food: ["Helhelg (Vegansk)"], orderNumber: anna.order.number });
    expect(a.checkedInAt).not.toBeNull();
    expect(rows[1]!).toMatchObject({ seat: "V1", checkedInAt: null, checkedInBy: null });
  });

  it("filters by search, ticket type, checked in, has food and minors", async () => {
    const { s, crew, bo } = await busyEvent();
    await db.user.update({ where: { id: bo.user.id }, data: { birthDate: new Date("2000-01-01T00:00:00Z") } });
    const kid = await buyPaid(s, { ticketTypeId: s.types.visitor.id }, { nickname: "kim" });
    const born = new Date(); born.setUTCFullYear(born.getUTCFullYear() - 15);
    await db.user.update({ where: { id: kid.user.id }, data: { birthDate: new Date(Date.UTC(born.getUTCFullYear(), 5, 15)), guardianName: "G", guardianPhone: "070" } });
    const nick = async (f: Parameters<typeof listAttendees>[2]) => (await listAttendees(crew, s.event.id, f)).map((r) => r.nickname);

    expect(await nick({ q: "ANNA" })).toEqual(["anna"]);
    expect(await nick({ q: "bengtsson" })).toEqual(["bo"]);
    expect(await nick({ q: "V1" })).toEqual(["bo"]); // seat
    expect(await nick({ ticketTypeId: s.types.visitor.id })).toEqual(["cia", "kim"]);
    expect(await nick({ checkedIn: "yes" })).toEqual(["anna", "cia"]);
    expect(await nick({ checkedIn: "no" })).toEqual(["bo", "kim"]);
    expect(await nick({ food: "yes" })).toEqual(["anna", "bo"]);
    expect(await nick({ food: "no" })).toEqual(["cia", "kim"]);
    expect(await nick({ minors: "yes" })).toEqual(["kim"]);
    expect(await nick({ ticketTypeId: s.types.visitor.id, food: "no", checkedIn: "no" })).toEqual(["kim"]); // combined
    expect(await nick({ q: "zzz" })).toEqual([]);
  });

  it("parses filters from a query string defensively", () => {
    expect(parseFilters({ q: "x", type: "t1", checkedIn: "yes", food: "no", minors: "yes" })).toEqual({ q: "x", ticketTypeId: "t1", checkedIn: "yes", food: "no", minors: "yes" });
    expect(parseFilters({ checkedIn: "maybe", minors: "no", q: ["a", "b"] })).toEqual({ q: "a", ticketTypeId: undefined, checkedIn: undefined, food: undefined, minors: undefined });
    expect(parseFilters({ q: "x".repeat(500) }).q).toHaveLength(100);
  });

  it("is for Festivalledare only", async () => {
    const s = await shop();
    await expect(listAttendees((await s.buyer()).actor, s.event.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("CSV", () => {
  it("starts with a BOM, uses CRLF, and quotes delimiters, quotes and line breaks", () => {
    const csv = toCsv([["a", "b;c", 'say "hi"', "two\nlines", 5, null, true]]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}a;"b;c";"say ""hi""";"two\nlines";5;;true\r\n`);
    expect(toCsv([["a,b", "c"]], ",")).toBe(`${BOM}"a,b",c\r\n`);
    expect(toCsv([["a,b", "c"]], ";")).toBe(`${BOM}a,b;c\r\n`); // a comma is plain text when ";" is the delimiter
  });

  it("neutralises spreadsheet formulas but leaves phone numbers and names alone", () => {
    for (const evil of ["=HYPERLINK(\"http://x\",\"y\")", "+SUM(A1)", "-2+3", "@cmd", "\t=1", "\r=1"]) expect(neutralize(evil), JSON.stringify(evil)).toBe(`'${evil}`);
    for (const fine of ["+46 70 123 45 67", "070-123 45 67", "(08) 123", "Åsa", "a=b", "x+y", ""]) expect(neutralize(fine)).toBe(fine);
    expect(csvCell("=1+1", ";")).toBe("'=1+1");
    expect(csvCell("=A;B", ";")).toBe(`"'=A;B"`); // neutralised first, then quoted
  });

  it("keeps åäö intact and builds a row per attendee with every column", async () => {
    const { s, crew } = await busyEvent();
    const rows = attendeeCsvRows(await listAttendees(crew, s.event.id));
    expect(rows[0]).toEqual(CSV_HEADER);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.length === CSV_HEADER.length)).toBe(true);
    const csv = toCsv(rows);
    expect(csv).toContain("Födelsedatum");
    expect(csv).toContain("Anna Andersson;anna;");
    expect(csv).toContain("Helhelg (Vegansk)");
    expect(csv.split("\r\n").length).toBe(5 + 0); // header + 3 rows + trailing empty
  });
});

describe("GET /api/events/[id]/attendees.csv", () => {
  async function get(eventId: string, query = "") {
    const { GET } = await import("@/app/api/events/[id]/attendees.csv/route");
    return GET(new Request(`http://localhost/api/events/${eventId}/attendees.csv${query}`), { params: Promise.resolve({ id: eventId }) });
  }

  it("401 for visitors, 403 for members and admins, 404 for unknown events", async () => {
    const s = await shop();
    expect((await get(s.event.id)).status).toBe(401);
    session.user = { ...(await s.buyer()).actor };
    expect((await get(s.event.id)).status).toBe(403);
    const admin = await makeUser({ tags: ["ADMIN"] });
    session.user = actorOf({ ...admin, tags: [{ tag: "ADMIN" }] });
    expect((await get(s.event.id)).status).toBe(403);
    session.user = s.fl;
    expect((await get("nope")).status).toBe(404);
    expect(await db.auditLog.count({ where: { action: "attendees.export" } })).toBe(0);
  });

  it("returns a UTF-8 CSV download, honours filters and delimiter, and audits the export", async () => {
    const { s, crew } = await busyEvent();
    session.user = crew;
    const res = await get(s.event.id, "?checkedIn=yes");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="attendees-event-\d+-\d{8}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("anna");
    expect(text).toContain("cia");
    expect(text).not.toContain(";bo;"); // filtered out
    expect(text.split("\r\n")[0]).toContain(";"); // Swedish Excel

    const comma = await (await get(s.event.id, "?delimiter=comma")).text();
    expect(comma.split("\r\n")[0]).toContain("Namn,Nickname,");

    const logs = await db.auditLog.findMany({ where: { action: "attendees.export" }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actorId: crew.id, eventId: s.event.id, ip: "9.9.9.9", diff: { rows: 2, filters: { checkedIn: "yes" }, delimiter: ";" } });
  });

  it("neutralises hostile names in the file", async () => {
    const s = await shop();
    await buyPaid(s, {}, { nickname: "evil", realName: "=cmd|' /C calc'!A0" });
    session.user = s.fl;
    const text = await (await get(s.event.id)).text();
    expect(text).toContain("'=cmd");
    expect(text).not.toMatch(/(^|;)=cmd/m);
  });
});

describe("email to attendees", () => {
  it("queues one email per active ticket holder (distinct people), in their language, and logs the mailing", async () => {
    const { s, crew, anna } = await busyEvent();
    await db.user.update({ where: { id: anna.user.id }, data: { locale: "en" } });
    const r = await sendBroadcast(crew, s.event.id, broadcastSchema.parse({ subject: "Dörrarna öppnar 17:00", body: "Hej!\nVälkommen." }), "3.3.3.3");
    expect(r).toMatchObject({ ok: true, recipientCount: 3 });
    const mails = await db.emailOutbox.findMany({ where: { template: "broadcast" }, orderBy: { to: "asc" } });
    expect(mails).toHaveLength(3); // Dan (cancelled) and Pelle (unpaid) get nothing
    expect(mails.map((m) => m.locale).sort()).toEqual(["en", "sv", "sv"]);
    expect(mails.every((m) => m.status === "PENDING")).toBe(true);

    const b = await db.broadcast.findFirstOrThrow({ where: { eventId: s.event.id } });
    expect(b).toMatchObject({ subject: "Dörrarna öppnar 17:00", recipientCount: 3, sentById: crew.id });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "broadcast.send" } })).toMatchObject({ ip: "3.3.3.3", diff: { subject: "Dörrarna öppnar 17:00", recipients: 3 } });
    expect((await listBroadcasts(crew, s.event.id)).map((x) => x.id)).toEqual([b.id]);
  });

  it("delivers through the outbox with the reason for the mail and escaped content", async () => {
    const s = await shop();
    const crew = await crewActor();
    const m = await buyPaid(s, {}, { nickname: "mottagare" });
    await sendBroadcast(crew, s.event.id, broadcastSchema.parse({ subject: "Viktigt <b>", body: "Se <script>x</script> här" }));
    const sent: OutgoingEmail[] = [];
    setEmailSender({ send: async (e) => void sent.push(e) });
    await db.emailOutbox.deleteMany({ where: { template: { not: "broadcast" } } }); // ignore the receipt
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]).toMatchObject({ to: m.user.email, subject: "Viktigt <b>" });
    expect(sent[0]!.html).not.toContain("<script>");
    expect(sent[0]!.html).toContain("&lt;script&gt;");
    expect(sent[0]!.html).toContain("Du får det här meddelandet för att du har en biljett till");
    expect(sent[0]!.text).toContain("Se <script>x</script> här");
  });

  it("refuses to send to nobody, validates input, rate limits, and is for Festivalledare only", async () => {
    const s = await shop();
    const crew = await crewActor();
    const input = broadcastSchema.parse({ subject: "Hej", body: "Hej" });
    expect(await sendBroadcast(crew, s.event.id, input)).toEqual({ ok: false, reason: "noRecipients" });
    expect(await sendBroadcast(crew, "nope", input)).toEqual({ ok: false, reason: "notFound" });
    expect(await db.broadcast.count()).toBe(0);

    expect(broadcastSchema.safeParse({ subject: "", body: "x" }).success).toBe(false);
    expect(broadcastSchema.safeParse({ subject: "x", body: " " }).success).toBe(false);
    expect(broadcastSchema.safeParse({ subject: "x".repeat(151), body: "x" }).success).toBe(false);
    expect(broadcastSchema.safeParse({ subject: "x", body: "x".repeat(5001) }).success).toBe(false);

    await buyPaid(s);
    // 5 attempts per hour in total; the "no recipients" attempt above already used one
    for (let i = 0; i < 4; i++) expect((await sendBroadcast(crew, s.event.id, input)).ok).toBe(true);
    expect(await sendBroadcast(crew, s.event.id, input)).toEqual({ ok: false, reason: "rateLimited" });
    expect(await db.broadcast.count()).toBe(4);

    await expect(sendBroadcast((await s.buyer()).actor, s.event.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendBroadcast(actorOf({ ...(await makeUser({ tags: ["ADMIN"] })), tags: [{ tag: "ADMIN" }] }), s.event.id, input)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("recipient list ignores anonymized accounts and duplicates", async () => {
    const s = await shop();
    const a = await buyPaid(s, {}, { nickname: "a" });
    const b = await buyPaid(s, {}, { nickname: "b" });
    await db.user.update({ where: { id: b.user.id }, data: { anonymizedAt: new Date() } });
    expect((await broadcastRecipients(s.event.id)).map((r) => r.id)).toEqual([a.user.id]);
  });
});
