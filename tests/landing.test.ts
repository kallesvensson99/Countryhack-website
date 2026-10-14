import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { FAQ_GROUPS } from "@/lib/content/faq";
import { getNextEvent, listUpcomingEvents, seatAvailability } from "@/lib/events/queries";
import { jsonLd } from "@/lib/seo";
import { makeEvent, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const DAY = 24 * 3600_000;

async function eventAt(creatorId: string, startsInDays: number, over: Record<string, unknown> = {}, lengthDays = 2) {
  const startsAt = new Date(Date.now() + startsInDays * DAY);
  const e = await makeEvent(creatorId, startsAt);
  return db.event.update({ where: { id: e.id }, data: { endsAt: new Date(startsAt.getTime() + lengthDays * DAY), registrationClosesAt: startsAt, ...over } });
}

describe("which event is 'next'", () => {
  it("is the soonest published event that hasn't ended, and ignores everything else", async () => {
    const u = await makeUser({ tags: ["FESTIVALLEDARE"] });
    await eventAt(u.id, 10, { status: "DRAFT", name: "draft" });
    await eventAt(u.id, 5, { status: "CANCELLED", name: "cancelled" });
    await eventAt(u.id, 7, { status: "CLOSED", name: "closed" });
    await eventAt(u.id, -30, { name: "past" });
    await eventAt(u.id, 90, { name: "later" });
    const soon = await eventAt(u.id, 30, { name: "soon" });
    expect((await getNextEvent())?.id).toBe(soon.id);
    expect((await listUpcomingEvents()).map((e) => e.name)).toEqual(["soon", "later"]);
  });

  it("still features an event that is running right now, and drops it once it has ended", async () => {
    const u = await makeUser({ tags: ["FESTIVALLEDARE"] });
    const running = await eventAt(u.id, -1, { name: "running" }, 3);
    const later = await eventAt(u.id, 60, { name: "later" });
    expect((await getNextEvent())?.id).toBe(running.id);
    expect((await getNextEvent(new Date(Date.now() + 5 * DAY)))?.id).toBe(later.id);
    expect(await getNextEvent(new Date(Date.now() + 100 * DAY))).toBeNull();
  });

  it("returns null when nothing is published, and lists only public ticket types", async () => {
    const u = await makeUser({ tags: ["FESTIVALLEDARE"] });
    expect(await getNextEvent()).toBeNull();
    const e = await eventAt(u.id, 20);
    await db.ticketType.createMany({
      data: [
        { eventId: e.id, name: "Standard", priceOre: 15000, quantity: 10, sortOrder: 2 },
        { eventId: e.id, name: "Early", priceOre: 10000, quantity: 10, sortOrder: 1 },
        { eventId: e.id, name: "Crew", priceOre: 0, quantity: 5, hidden: true, requiresDiscountCode: true },
        { eventId: e.id, name: "Kodbiljett", priceOre: 5000, quantity: 5, requiresDiscountCode: true, sortOrder: 3 }, // listed, but needs a code
      ],
    });
    const next = await getNextEvent();
    expect(next!.ticketTypes.map((t) => t.name)).toEqual(["Early", "Standard", "Kodbiljett"]);
  });
});

describe("seat availability for the landing page", () => {
  it("counts free seats: blocked seats don't count, live claims and holds do, expired holds are free again", async () => {
    const u = await makeUser({ tags: ["FESTIVALLEDARE"] });
    const e = await eventAt(u.id, 20);
    expect(await seatAvailability(e.id)).toBeNull();
    const chart = await db.seatingChart.create({ data: { eventId: e.id, name: "c" } });
    const z = await db.seatZone.create({ data: { chartId: chart.id, name: "z", color: "#000000" } });
    const seats = await Promise.all(["A1", "A2", "A3", "A4", "A5"].map((label, i) => db.seat.create({ data: { chartId: chart.id, label, x: i, y: 0, zoneId: z.id, blocked: label === "A5" } })));
    expect(await seatAvailability(e.id)).toEqual({ free: 4, total: 4 });

    const tt = await db.ticketType.create({ data: { eventId: e.id, name: "t", priceOre: 0, quantity: 9 } });
    const buyers = await Promise.all([1, 2, 3].map(() => makeUser()));
    const claim = async (i: number, status: "HELD" | "CONFIRMED", expiresAt: Date | null) => {
      const order = await db.order.create({ data: { number: `L-${i}-${Math.random()}`, userId: buyers[i]!.id, eventId: e.id, subtotalOre: 0, totalOre: 0, expiresAt: new Date() } });
      const ticket = await db.ticket.create({ data: { eventId: e.id, userId: buyers[i]!.id, ticketTypeId: tt.id, orderId: order.id, status: "ACTIVE", qrNonce: "n" } });
      await db.seatClaim.create({ data: { seatId: seats[i]!.id, ticketId: ticket.id, status, expiresAt } });
    };
    await claim(0, "CONFIRMED", null);
    await claim(1, "HELD", new Date(Date.now() + 10 * 60_000));
    await claim(2, "HELD", new Date(Date.now() - 60_000)); // lapsed
    expect(await seatAvailability(e.id)).toEqual({ free: 2, total: 4 });
  });
});

describe("JSON-LD", () => {
  it("can't be used to break out of the script tag", () => {
    const out = jsonLd({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });

  it("escapes the Unicode line separators too, and still round-trips", () => {
    const tricky = "a" + String.fromCharCode(0x2028) + "b" + String.fromCharCode(0x2029) + "c";
    const out = jsonLd({ v: tricky });
    expect(out).not.toContain(String.fromCharCode(0x2028));
    expect(out).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(out).v).toBe(tricky);
  });
});

// ───────────── translations stay in sync ─────────────

type Tree = { [k: string]: string | Tree };
const load = (l: string): Tree => JSON.parse(readFileSync(`messages/${l}.json`, "utf8"));
const flat = (t: Tree, p = ""): Record<string, string> =>
  Object.entries(t).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === "string" ? { ...acc, [`${p}${k}`]: v } : { ...acc, ...flat(v, `${p}${k}.`) }), {});
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]!).sort();

describe("messages", () => {
  const sv = flat(load("sv"));
  const en = flat(load("en"));

  it("Swedish and English have exactly the same keys", () => {
    const missingInEn = Object.keys(sv).filter((k) => !(k in en));
    const missingInSv = Object.keys(en).filter((k) => !(k in sv));
    expect({ missingInEn, missingInSv }).toEqual({ missingInEn: [], missingInSv: [] });
  });

  it("use the same {placeholders} in both languages, and nothing is empty", () => {
    const mismatched = Object.keys(sv).filter((k) => k in en && JSON.stringify(placeholders(sv[k]!)) !== JSON.stringify(placeholders(en[k]!)));
    expect(mismatched).toEqual([]);
    expect(Object.entries({ ...sv, ...en }).filter(([, v]) => v.trim() === "")).toEqual([]);
  });

  it("every FAQ question has a question and an answer in both languages", () => {
    for (const lang of [sv, en]) {
      for (const g of FAQ_GROUPS) {
        expect(lang[`faq.group_${g.id}`], g.id).toBeTruthy();
        for (const id of g.items) {
          expect(lang[`faq.q_${id}`], `q_${id}`).toBeTruthy();
          expect(lang[`faq.a_${id}`], `a_${id}`).toBeTruthy();
        }
      }
    }
    const ids = FAQ_GROUPS.flatMap((g) => g.items);
    expect(new Set(ids).size).toBe(ids.length); // anchors (#q-<id>) must be unique
  });

  it("the age answer mentions the live age limit", () => {
    expect(sv["faq.a_age"]).toContain("{minAge}");
    expect(en["faq.a_age"]).toContain("{minAge}");
    expect(sv["faq.a_refund"]).toContain("{contact}");
  });
});
