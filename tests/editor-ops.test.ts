import { describe, expect, it } from "vitest";
import {
  addObject, addRow, addSeat, addTable, addZone, canDeleteZone, clampDelta, deleteItems, deleteZone, itemsInRect, moveItems, objectKey,
  patchSeats, relabelSeats, rotateItems, seatKey, toPayload, uniqueLabels, type Doc,
} from "@/lib/seating/editor-ops";
import { findDuplicateLabels } from "@/lib/seating/geometry";
import { chartPayloadSchema } from "@/lib/validation/chart";

const empty = (): Doc => ({ name: "Test", width: 1200, height: 800, gridSize: 20, zones: [{ id: "z1", name: "Standard", color: "#0072B2" }], seats: [], objects: [] });
let n = 0;
const id = () => `id${++n}`;

describe("editor operations", () => {
  it("adds a row of seats with sequential unique labels, snapped to the grid, centred", () => {
    const { doc, keys } = addRow(empty(), { count: 10, prefix: "A", orientation: "horizontal", zoneId: "z1", centre: { x: 600, y: 300 }, id });
    expect(doc.seats.map((s) => s.label)).toEqual(Array.from({ length: 10 }, (_, i) => `A${i + 1}`));
    expect(doc.seats.every((s) => s.x % 20 === 0 && s.y % 20 === 0)).toBe(true);
    expect(new Set(doc.seats.map((s) => s.groupId)).size).toBe(1);
    expect(doc.seats[1]!.x - doc.seats[0]!.x).toBe(40);
    expect(keys.size).toBe(10);
    const xs = doc.seats.map((s) => s.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(600, -2);
  });

  it("continues numbering when the prefix already exists, so labels stay unique", () => {
    let d = addRow(empty(), { count: 3, prefix: "A", orientation: "vertical", zoneId: "z1", id }).doc;
    d = addRow(d, { count: 2, prefix: "A", orientation: "vertical", zoneId: "z1", centre: { x: 200, y: 400 }, id }).doc;
    expect(d.seats.map((s) => s.label)).toEqual(["A1", "A2", "A3", "A4", "A5"]);
    expect(findDuplicateLabels(d.seats).size).toBe(0);
    expect(uniqueLabels(["B7", "b2"], "B", 2)).toEqual(["B8", "B9"]);
    expect(uniqueLabels(["A1"], "A.", 1)).toEqual(["A.1"]); // regex-special prefixes are safe
  });

  it("adds a table group: seats on both sides plus a TABLE object", () => {
    const { doc, keys } = addTable(empty(), { count: 6, prefix: "T1-", zoneId: "z1", centre: { x: 400, y: 400 }, id });
    expect(doc.seats).toHaveLength(6);
    expect(doc.seats.map((s) => s.label)).toEqual(["T1-1", "T1-2", "T1-3", "T1-4", "T1-5", "T1-6"]);
    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0]).toMatchObject({ kind: "TABLE", width: 120 });
    expect(keys.size).toBe(7);
    expect(doc.seats.filter((s) => s.rotation === 180)).toHaveLength(3);
  });

  it("adds single seats and objects with defaults", () => {
    let d = addSeat(empty(), { zoneId: "z1", centre: { x: 100, y: 100 }, id }).doc;
    d = addSeat(d, { zoneId: "z1", id }).doc;
    expect(d.seats.map((s) => s.label)).toEqual(["A1", "B1"]);
    const o = addObject(d, { kind: "STAGE", id }).doc.objects[0]!;
    expect(o).toMatchObject({ kind: "STAGE", width: 300, height: 80, rotation: 0 });
  });

  it("moves selections but keeps them inside the canvas", () => {
    const d = addRow(empty(), { count: 2, prefix: "A", orientation: "horizontal", zoneId: "z1", centre: { x: 100, y: 100 }, id }).doc;
    const keys = new Set(d.seats.map((s) => seatKey(s.id)));
    const moved = moveItems(d, keys, 40, 20);
    expect(moved.seats[0]!.x - d.seats[0]!.x).toBe(40);
    expect(moved.seats[0]!.y - d.seats[0]!.y).toBe(20);
    const clamped = clampDelta(d, keys, -10_000, 10_000);
    expect(Math.min(...d.seats.map((s) => s.x)) + clamped.dx).toBe(0);
    expect(Math.max(...d.seats.map((s) => s.y)) + clamped.dy).toBe(800);
    expect(moveItems(d, new Set(), 40, 40)).toBe(d); // no-op returns the same document
  });

  it("rotates a selection rigidly around its centre", () => {
    const d = addRow(empty(), { count: 3, prefix: "A", orientation: "horizontal", zoneId: "z1", centre: { x: 400, y: 400 }, id }).doc;
    const r = rotateItems(d, new Set(d.seats.map((s) => seatKey(s.id))), 90);
    // a horizontal row becomes vertical; the middle seat (the centre) stays put
    expect(r.seats.map((s) => Math.round(s.x))).toEqual([r.seats[1]!.x, r.seats[1]!.x, r.seats[1]!.x].map(Math.round));
    expect(Math.abs(r.seats[2]!.y - r.seats[0]!.y)).toBeCloseTo(80, 0);
    expect(r.seats[1]!.x).toBeCloseTo(d.seats[1]!.x, 5);
    expect(r.seats.every((s) => s.rotation === 90)).toBe(true);
    expect(rotateItems(r, new Set(r.seats.map((s) => seatKey(s.id))), 270).seats.every((s) => s.rotation === 0)).toBe(true);
  });

  it("rotates objects around their own centre as well", () => {
    const d = addObject(empty(), { kind: "STAGE", centre: { x: 400, y: 300 }, id }).doc;
    const o = d.objects[0]!;
    const r = rotateItems(d, new Set([objectKey(o.id)]), 90).objects[0]!;
    expect(r.rotation).toBe(90);
    expect(r.x + r.width / 2).toBeCloseTo(o.x + o.width / 2, 5);
    expect(r.y + r.height / 2).toBeCloseTo(o.y + o.height / 2, 5);
  });

  it("deletes selected seats and objects", () => {
    const t = addTable(empty(), { count: 4, prefix: "T", zoneId: "z1", id }).doc;
    const keys = new Set([seatKey(t.seats[0]!.id), objectKey(t.objects[0]!.id)]);
    const d = deleteItems(t, keys);
    expect(d.seats).toHaveLength(3);
    expect(d.objects).toHaveLength(0);
  });

  it("numbers selected seats in reading order", () => {
    let d = addRow(empty(), { count: 3, prefix: "X", orientation: "horizontal", zoneId: "z1", centre: { x: 400, y: 200 }, id }).doc;
    d = addRow(d, { count: 3, prefix: "Y", orientation: "horizontal", zoneId: "z1", centre: { x: 400, y: 240 }, id }).doc;
    const ids = new Set(d.seats.map((s) => s.id));
    const r = relabelSeats(d, ids, { prefix: "R", start: 1, axis: "x" });
    expect(r.seats.map((s) => s.label)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    const c = relabelSeats(d, ids, { prefix: "C", start: 10, axis: "y" });
    expect(c.seats.find((s) => s.id === d.seats[3]!.id)!.label).toBe("C11"); // first column, second row
  });

  it("manages zones: can't delete used or last zones", () => {
    let d = addRow(empty(), { count: 2, prefix: "A", orientation: "horizontal", zoneId: "z1", id }).doc;
    d = addZone(d, "#E69F00", "VIP", "z2");
    expect(canDeleteZone(d, "z1")).toBe(false); // used
    expect(canDeleteZone(d, "z2")).toBe(true);
    expect(deleteZone(d, "z2").zones).toHaveLength(1);
    expect(canDeleteZone(deleteZone(d, "z2"), "z1")).toBe(false); // last one
    d = patchSeats(d, new Set(d.seats.map((s) => s.id)), { zoneId: "z2" });
    expect(canDeleteZone(d, "z1")).toBe(true);
  });

  it("rubber-band selection picks intersecting items", () => {
    let d = addRow(empty(), { count: 4, prefix: "A", orientation: "horizontal", zoneId: "z1", centre: { x: 200, y: 100 }, id }).doc;
    d = addObject(d, { kind: "STAGE", centre: { x: 800, y: 600 }, id }).doc;
    const hit = itemsInRect(d, { x1: 0, y1: 0, x2: 200, y2: 200 });
    expect(hit.size).toBe(2); // two leftmost seats
    expect(itemsInRect(d, { x1: 1200, y1: 0, x2: 1000, y2: 700 }).size).toBe(0); // reversed corners work; the stage ends at x=950
    expect(itemsInRect(d, { x1: 1000, y1: 700, x2: 700, y2: 560 }).size).toBe(1); // …and does hit the stage
  });

  it("produces payloads the server schema accepts", () => {
    let d = addRow(empty(), { count: 5, prefix: "A", orientation: "horizontal", zoneId: "z1", id }).doc;
    d = addTable(d, { count: 4, prefix: "T1-", zoneId: "z1", id }).doc;
    d = addObject(d, { kind: "KITCHEN", id }).doc;
    d = { ...d, seats: d.seats.map((s) => ({ ...s, reservedForLabel: "x" })) };
    const parsed = chartPayloadSchema.safeParse(toPayload(d));
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(toPayload(d))).not.toContain("reservedForLabel");
  });
});
