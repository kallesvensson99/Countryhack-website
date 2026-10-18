import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ForbiddenError } from "@/lib/permissions";
import { buildDays, type Span } from "@/lib/schedule/layout";
import { colorOf, NO_CATEGORY_STYLE, SCHEDULE_COLORS } from "@/lib/schedule/palette";
import { countScheduleItems, createCategory, createItem, deleteCategory, deleteItem, getSchedule, pick, updateCategory, updateItem } from "@/lib/schedule/service";
import { parseStockholmLocal } from "@/lib/time";
import { scheduleCategorySchema, scheduleItemSchema } from "@/lib/validation/schedule";
import { asActor, makeEvent, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const at = (s: string) => parseStockholmLocal(s)!;
const span = (id: string, start: string, end: string): Span => ({ id, startsAt: at(start), endsAt: at(end) });
const cat = (over: Record<string, string> = {}) => scheduleCategorySchema.parse({ name: "Turnering", color: "hay", ...over });
const item = (over: Record<string, string> = {}) => scheduleItemSchema.parse({ title: "Öppning", startsAt: "2026-12-18T17:00", endsAt: "2026-12-18T18:00", ...over });

describe("block layout", () => {
  it("places a single block with its minutes and a sensible axis", () => {
    const days = buildDays([span("a", "2026-12-18T17:30", "2026-12-18T19:00")]);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: "2026-12-18", startHour: 17, endHour: 21 }); // padded to at least 4 hours
    expect(days[0]!.blocks[0]).toMatchObject({ startMin: 17 * 60 + 30, endMin: 19 * 60, lane: 0, lanes: 1, fromPrevDay: false, toNextDay: false });
  });

  it("puts overlapping blocks side by side and gives separate groups their own width", () => {
    const [day] = buildDays([
      span("a", "2026-12-18T10:00", "2026-12-18T12:00"),
      span("b", "2026-12-18T11:00", "2026-12-18T13:00"),
      span("c", "2026-12-18T11:30", "2026-12-18T12:30"),
      span("d", "2026-12-18T14:00", "2026-12-18T15:00"), // alone
    ]);
    const by = Object.fromEntries(day!.blocks.map((b) => [b.item.id, b]));
    expect([by.a!.lane, by.b!.lane, by.c!.lane].sort()).toEqual([0, 1, 2]);
    expect(by.a!.lanes).toBe(3);
    expect(by.b!.lanes).toBe(3);
    expect(by.c!.lanes).toBe(3);
    expect(by.d).toMatchObject({ lane: 0, lanes: 1 });
  });

  it("reuses a lane once its block has ended", () => {
    const [day] = buildDays([
      span("a", "2026-12-18T10:00", "2026-12-18T11:00"),
      span("b", "2026-12-18T10:30", "2026-12-18T12:00"),
      span("c", "2026-12-18T11:00", "2026-12-18T11:45"), // starts when a ends: takes a's lane
    ]);
    const by = Object.fromEntries(day!.blocks.map((b) => [b.item.id, b]));
    expect(by.c!.lane).toBe(by.a!.lane);
    expect(by.a!.lanes).toBe(2);
  });

  it("blocks that only touch do not share width", () => {
    const [day] = buildDays([span("a", "2026-12-18T10:00", "2026-12-18T11:00"), span("b", "2026-12-18T11:00", "2026-12-18T12:00")]);
    expect(day!.blocks.map((b) => b.lanes)).toEqual([1, 1]);
  });

  it("splits a block that runs past midnight over two days, and uses Stockholm time", () => {
    const days = buildDays([span("night", "2026-12-18T22:00", "2026-12-19T02:00")]);
    expect(days.map((d) => d.date)).toEqual(["2026-12-18", "2026-12-19"]);
    expect(days[0]!.blocks[0]).toMatchObject({ startMin: 22 * 60, endMin: 1440, toNextDay: true, fromPrevDay: false });
    expect(days[1]!.blocks[0]).toMatchObject({ startMin: 0, endMin: 120, fromPrevDay: true, toNextDay: false });
    expect(days[0]!.endHour).toBe(24);
  });

  it("a block ending exactly at midnight stays on one day", () => {
    const days = buildDays([span("a", "2026-12-18T22:00", "2026-12-19T00:00")]);
    expect(days.map((d) => d.date)).toEqual(["2026-12-18"]);
  });

  it("orders days and ignores empty or backwards spans", () => {
    const days = buildDays([span("late", "2026-12-20T10:00", "2026-12-20T11:00"), span("early", "2026-12-18T10:00", "2026-12-18T11:00"), span("bad", "2026-12-19T12:00", "2026-12-19T12:00")]);
    expect(days.map((d) => d.date)).toEqual(["2026-12-18", "2026-12-20"]);
    expect(buildDays([])).toEqual([]);
  });

  it("keeps the axis inside the day", () => {
    const [day] = buildDays([span("a", "2026-12-18T23:00", "2026-12-18T23:30")]);
    expect(day!.endHour - day!.startHour).toBeGreaterThanOrEqual(4);
    expect(day!.endHour).toBeLessThanOrEqual(24);
    expect(day!.startHour).toBeGreaterThanOrEqual(0);
  });
});

describe("colour palette", () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  it("every colour has readable text on it (WCAG AA)", () => {
    for (const [key, c] of Object.entries(SCHEDULE_COLORS)) expect(ratio(c.bg, c.fg), key).toBeGreaterThanOrEqual(4.5);
    expect(ratio(NO_CATEGORY_STYLE.bg, NO_CATEGORY_STYLE.fg)).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back for unknown or missing keys", () => {
    expect(colorOf("hay")).toEqual(SCHEDULE_COLORS.hay);
    expect(colorOf("not-a-colour")).toEqual(NO_CATEGORY_STYLE);
    expect(colorOf(null)).toEqual(NO_CATEGORY_STYLE);
  });
});

describe("who may edit the schedule", () => {
  it("Festivalledare and Admin; not Ansvarig or members", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ev = await makeEvent(fl.id);
    expect((await createCategory(fl, ev.id, cat())).ok).toBe(true);
    expect((await createCategory(asActor(await makeUser({ tags: ["ADMIN"] })), ev.id, cat({ name: "Mat" }))).ok).toBe(true);
    for (const tags of [["ANSVARIG"], []] as const) {
      const who = asActor(await makeUser({ tags: [...tags] }));
      await expect(createCategory(who, ev.id, cat({ name: "Hack" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createItem(who, ev.id, item())).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.scheduleCategory.count()).toBe(2);
    expect(await db.scheduleItem.count()).toBe(0);
  });
});

describe("categories", () => {
  it("are created in order, unique per event, edited, and deleting one keeps its blocks", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ev = await makeEvent(fl.id);
    const ev2 = await makeEvent(fl.id);
    const a = await createCategory(fl, ev.id, cat({ name: "A", color: "sky" }), "1.2.3.4");
    const b = await createCategory(fl, ev.id, cat({ name: "B", color: "barn", nameEn: "Bee" }));
    if (!a.ok || !b.ok) throw new Error();
    expect((await createCategory(fl, ev2.id, cat({ name: "A" }))).ok).toBe(true); // same name, other event: fine
    expect(await createCategory(fl, ev.id, cat({ name: "A" }))).toEqual({ ok: false, reason: "duplicate" });
    expect(await createCategory(fl, "no-such-event", cat())).toEqual({ ok: false, reason: "notFound" });
    expect((await getSchedule(ev.id)).categories.map((c) => c.name)).toEqual(["A", "B"]);

    expect((await updateCategory(fl, a.id, cat({ name: "A2", color: "plum" }))).ok).toBe(true);
    expect(await updateCategory(fl, b.id, cat({ name: "A2" }))).toEqual({ ok: false, reason: "duplicate" });
    expect(await updateCategory(fl, "nope", cat())).toEqual({ ok: false, reason: "notFound" });

    const it1 = await createItem(fl, ev.id, item({ categoryId: a.id }));
    if (!it1.ok) throw new Error();
    expect((await deleteCategory(fl, a.id)).ok).toBe(true);
    expect((await db.scheduleItem.findUniqueOrThrow({ where: { id: it1.id } })).categoryId).toBeNull();
    expect(await deleteCategory(fl, a.id)).toEqual({ ok: false, reason: "notFound" });
    const logs = (await db.auditLog.findMany({ where: { eventId: ev.id }, orderBy: { createdAt: "asc" } })).map((l) => l.action);
    expect(logs).toEqual(["schedule.category.create", "schedule.category.create", "schedule.category.update", "schedule.item.create", "schedule.category.delete"]);
  });

  it("only accept colours from the palette and a name", () => {
    expect(scheduleCategorySchema.safeParse({ name: "x", color: "#ff0000" }).success).toBe(false);
    expect(scheduleCategorySchema.safeParse({ name: "x", color: "javascript:alert(1)" }).success).toBe(false);
    expect(scheduleCategorySchema.safeParse({ name: "", color: "hay" }).success).toBe(false);
    expect(scheduleCategorySchema.safeParse({ name: "x" }).success).toBe(false);
    expect(scheduleCategorySchema.parse({ name: "x", color: "teal" })).toMatchObject({ color: "teal", nameEn: "" });
  });
});

describe("items", () => {
  it("are created, listed by start time, edited and deleted with audit rows", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ev = await makeEvent(fl.id);
    const c = await createCategory(fl, ev.id, cat());
    if (!c.ok) throw new Error();
    const late = await createItem(fl, ev.id, item({ title: "Sent", startsAt: "2026-12-19T20:00", endsAt: "2026-12-19T22:00", categoryId: c.id }), "9.9.9.9");
    const early = await createItem(fl, ev.id, item({ title: "Tidigt", startsAt: "2026-12-18T09:00", endsAt: "2026-12-18T10:00" }));
    if (!late.ok || !early.ok) throw new Error();
    const sched = await getSchedule(ev.id);
    expect(sched.items.map((i) => i.title)).toEqual(["Tidigt", "Sent"]);
    expect(sched.items[1]!.category?.name).toBe("Turnering");
    expect(await countScheduleItems(ev.id)).toBe(2);

    expect((await updateItem(fl, late.id, item({ title: "Sent 2", startsAt: "2026-12-19T21:00", endsAt: "2026-12-19T23:00" }))).ok).toBe(true);
    expect((await db.scheduleItem.findUniqueOrThrow({ where: { id: late.id } })).startsAt.toISOString()).toBe("2026-12-19T20:00:00.000Z"); // 21:00 Stockholm
    expect(await updateItem(fl, "nope", item())).toEqual({ ok: false, reason: "notFound" });
    expect((await deleteItem(fl, early.id)).ok).toBe(true);
    expect(await deleteItem(fl, early.id)).toEqual({ ok: false, reason: "notFound" });
    const logs = await db.auditLog.findMany({ where: { eventId: ev.id, entityType: "ScheduleItem" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["schedule.item.create", "schedule.item.create", "schedule.item.update", "schedule.item.delete"]);
    expect(logs[0]).toMatchObject({ actorId: fl.id, ip: "9.9.9.9" });
  });

  it("a block cannot use another event's category", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ev = await makeEvent(fl.id);
    const other = await makeEvent(fl.id);
    const foreign = await createCategory(fl, other.id, cat());
    if (!foreign.ok) throw new Error();
    expect(await createItem(fl, ev.id, item({ categoryId: foreign.id }))).toEqual({ ok: false, reason: "badCategory" });
    const own = await createItem(fl, ev.id, item());
    if (!own.ok) throw new Error();
    expect(await updateItem(fl, own.id, item({ categoryId: foreign.id }))).toEqual({ ok: false, reason: "badCategory" });
    expect(await createItem(fl, "no-such-event", item())).toEqual({ ok: false, reason: "notFound" });
  });

  it("deleting an event removes its schedule", async () => {
    const fl = asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));
    const ev = await makeEvent(fl.id);
    await createCategory(fl, ev.id, cat());
    await createItem(fl, ev.id, item());
    await db.event.delete({ where: { id: ev.id } });
    expect(await db.scheduleCategory.count()).toBe(0);
    expect(await db.scheduleItem.count()).toBe(0);
  });

  it("validates times: the end must follow the start, at most 24 hours, and a real date", () => {
    expect(scheduleItemSchema.safeParse({ title: "x", startsAt: "2026-12-18T17:00", endsAt: "2026-12-18T17:00" }).success).toBe(false);
    expect(scheduleItemSchema.safeParse({ title: "x", startsAt: "2026-12-18T17:00", endsAt: "2026-12-18T16:00" }).success).toBe(false);
    expect(scheduleItemSchema.safeParse({ title: "x", startsAt: "2026-12-18T17:00", endsAt: "2026-12-19T17:01" }).success).toBe(false);
    expect(scheduleItemSchema.safeParse({ title: "x", startsAt: "2026-12-18T17:00", endsAt: "2026-12-19T17:00" }).success).toBe(true);
    expect(scheduleItemSchema.safeParse({ title: "x", startsAt: "i går", endsAt: "2026-12-18T17:00" }).success).toBe(false);
    expect(scheduleItemSchema.safeParse({ title: "", startsAt: "2026-12-18T17:00", endsAt: "2026-12-18T18:00" }).success).toBe(false);
    expect(item().categoryId).toBeNull();
  });

  it("shows English text when present, Swedish otherwise", () => {
    expect(pick("Öppning", "", "en")).toBe("Öppning");
    expect(pick("Öppning", "Opening", "en")).toBe("Opening");
    expect(pick("Öppning", "Opening", "sv")).toBe("Öppning");
  });
});
