import type { ChartObjectKind } from "@prisma/client";
import { centroid, makeLabels, nextPrefix, normalizeDegrees, relabelOrder, rotatePoint, rowPositions, seatSpacing, snap, tableLayout } from "./geometry";
import type { ObjectData, SeatData, ZoneData } from "./types";

/** Pure editor operations: (document, intent) → new document. The React editor only wires these to the UI. */

export interface Doc {
  name: string;
  width: number;
  height: number;
  gridSize: number;
  zones: ZoneData[];
  seats: SeatData[];
  objects: ObjectData[];
}

/** "s:<seatId>" or "o:<objectId>" */
export type Key = string;
export const seatKey = (id: string): Key => `s:${id}`;
export const objectKey = (id: string): Key => `o:${id}`;

let counter = 0;
/** Ids that don't exist in the database yet; the server replaces them on save. */
export const newId = (): string => `new-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export const OBJECT_DEFAULTS: Record<ChartObjectKind, { width: number; height: number }> = {
  TABLE: { width: 160, height: 40 },
  STAGE: { width: 300, height: 80 },
  ENTRANCE: { width: 80, height: 40 },
  KITCHEN: { width: 120, height: 80 },
  TOILET: { width: 60, height: 60 },
  WALL: { width: 200, height: 10 },
  LABEL: { width: 120, height: 30 },
};

const selectedSeats = (doc: Doc, keys: Set<Key>) => doc.seats.filter((s) => keys.has(seatKey(s.id)));
const selectedObjects = (doc: Doc, keys: Set<Key>) => doc.objects.filter((o) => keys.has(objectKey(o.id)));

/** Shrinks (dx, dy) so every selected item's centre stays inside the canvas. */
export function clampDelta(doc: Doc, keys: Set<Key>, dx: number, dy: number): { dx: number; dy: number } {
  const pts = [...selectedSeats(doc, keys).map((s) => ({ x: s.x, y: s.y })), ...selectedObjects(doc, keys).map((o) => ({ x: o.x + o.width / 2, y: o.y + o.height / 2 }))];
  if (pts.length === 0) return { dx: 0, dy: 0 };
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  return {
    dx: Math.min(Math.max(dx, -minX), doc.width - maxX),
    dy: Math.min(Math.max(dy, -minY), doc.height - maxY),
  };
}

export function moveItems(doc: Doc, keys: Set<Key>, dx: number, dy: number): Doc {
  const c = clampDelta(doc, keys, dx, dy);
  if (c.dx === 0 && c.dy === 0) return doc;
  return {
    ...doc,
    seats: doc.seats.map((s) => (keys.has(seatKey(s.id)) ? { ...s, x: s.x + c.dx, y: s.y + c.dy } : s)),
    objects: doc.objects.map((o) => (keys.has(objectKey(o.id)) ? { ...o, x: o.x + c.dx, y: o.y + c.dy } : o)),
  };
}

/** Rotates the selection as a rigid body around its centre. */
export function rotateItems(doc: Doc, keys: Set<Key>, degrees: number): Doc {
  const seats = selectedSeats(doc, keys);
  const objects = selectedObjects(doc, keys);
  if (seats.length + objects.length === 0) return doc;
  const centre = centroid([...seats.map((s) => ({ x: s.x, y: s.y })), ...objects.map((o) => ({ x: o.x + o.width / 2, y: o.y + o.height / 2 }))]);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    ...doc,
    seats: doc.seats.map((s) => {
      if (!keys.has(seatKey(s.id))) return s;
      const p = rotatePoint(s, centre, degrees);
      return { ...s, x: round(p.x), y: round(p.y), rotation: normalizeDegrees(s.rotation + degrees) };
    }),
    objects: doc.objects.map((o) => {
      if (!keys.has(objectKey(o.id))) return o;
      const c = rotatePoint({ x: o.x + o.width / 2, y: o.y + o.height / 2 }, centre, degrees);
      return { ...o, x: round(c.x - o.width / 2), y: round(c.y - o.height / 2), rotation: normalizeDegrees(o.rotation + degrees) };
    }),
  };
}

export function deleteItems(doc: Doc, keys: Set<Key>): Doc {
  return { ...doc, seats: doc.seats.filter((s) => !keys.has(seatKey(s.id))), objects: doc.objects.filter((o) => !keys.has(objectKey(o.id))) };
}

/** Labels `prefix1..prefixN`, continuing after the highest existing number for that prefix so they stay unique. */
export function uniqueLabels(existing: string[], prefix: string, count: number): string[] {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`, "i");
  const max = existing.reduce((m, l) => Math.max(m, Number(re.exec(l)?.[1] ?? 0)), 0);
  return makeLabels(prefix, count, max + 1);
}

const centreOf = (doc: Doc, centre?: { x: number; y: number }) => centre ?? { x: doc.width / 2, y: doc.height / 2 };

export function addRow(
  doc: Doc,
  o: { count: number; prefix: string; orientation: "horizontal" | "vertical"; zoneId: string; centre?: { x: number; y: number }; id?: () => string },
): { doc: Doc; keys: Set<Key> } {
  const id = o.id ?? newId;
  const spacing = seatSpacing(doc.gridSize);
  const c = centreOf(doc, o.centre);
  const span = (o.count - 1) * spacing;
  const start = {
    x: snap(o.orientation === "horizontal" ? c.x - span / 2 : c.x, doc.gridSize),
    y: snap(o.orientation === "vertical" ? c.y - span / 2 : c.y, doc.gridSize),
  };
  const groupId = id();
  const labels = uniqueLabels(doc.seats.map((s) => s.label), o.prefix, o.count);
  const seats: SeatData[] = rowPositions({ count: o.count, startX: start.x, startY: start.y, spacing, orientation: o.orientation }).map((p, i) => ({
    id: id(), label: labels[i]!, x: p.x, y: p.y, rotation: 0, zoneId: o.zoneId, groupId, blocked: false, reservedForUserId: null,
  }));
  return { doc: { ...doc, seats: [...doc.seats, ...seats] }, keys: new Set(seats.map((s) => seatKey(s.id))) };
}

export function addTable(
  doc: Doc,
  o: { count: number; prefix: string; zoneId: string; centre?: { x: number; y: number }; id?: () => string },
): { doc: Doc; keys: Set<Key> } {
  const id = o.id ?? newId;
  const spacing = seatSpacing(doc.gridSize);
  const c = centreOf(doc, o.centre);
  const layout = tableLayout({ count: o.count, cx: snap(c.x, doc.gridSize), cy: snap(c.y, doc.gridSize), spacing });
  const groupId = id();
  const labels = uniqueLabels(doc.seats.map((s) => s.label), o.prefix, o.count);
  const seats: SeatData[] = layout.seats.map((p, i) => ({
    id: id(), label: labels[i]!, x: p.x, y: p.y, rotation: p.rotation, zoneId: o.zoneId, groupId, blocked: false, reservedForUserId: null,
  }));
  const table: ObjectData = { id: id(), kind: "TABLE", ...layout.table, rotation: 0, label: null };
  return { doc: { ...doc, seats: [...doc.seats, ...seats], objects: [...doc.objects, table] }, keys: new Set([...seats.map((s) => seatKey(s.id)), objectKey(table.id)]) };
}

export function addSeat(doc: Doc, o: { zoneId: string; centre?: { x: number; y: number }; id?: () => string }): { doc: Doc; keys: Set<Key> } {
  const id = (o.id ?? newId)();
  const c = centreOf(doc, o.centre);
  const prefix = nextPrefix(doc.seats.map((s) => s.label));
  const seat: SeatData = { id, label: `${prefix}1`, x: snap(c.x, doc.gridSize), y: snap(c.y, doc.gridSize), rotation: 0, zoneId: o.zoneId, groupId: null, blocked: false, reservedForUserId: null };
  return { doc: { ...doc, seats: [...doc.seats, seat] }, keys: new Set([seatKey(id)]) };
}

export function addObject(doc: Doc, o: { kind: ChartObjectKind; centre?: { x: number; y: number }; id?: () => string }): { doc: Doc; keys: Set<Key> } {
  const id = (o.id ?? newId)();
  const size = OBJECT_DEFAULTS[o.kind];
  const c = centreOf(doc, o.centre);
  const obj: ObjectData = { id, kind: o.kind, x: snap(c.x - size.width / 2, doc.gridSize), y: snap(c.y - size.height / 2, doc.gridSize), ...size, rotation: 0, label: null };
  return { doc: { ...doc, objects: [...doc.objects, obj] }, keys: new Set([objectKey(id)]) };
}

export function patchSeats(doc: Doc, ids: Set<string>, patch: Partial<SeatData>): Doc {
  return { ...doc, seats: doc.seats.map((s) => (ids.has(s.id) ? { ...s, ...patch } : s)) };
}

export function patchObject(doc: Doc, id: string, patch: Partial<ObjectData>): Doc {
  return { ...doc, objects: doc.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) };
}

/** Numbers the selected seats prefix{start}, prefix{start+1}… in reading order. */
export function relabelSeats(doc: Doc, ids: Set<string>, o: { prefix: string; start: number; axis: "x" | "y" }): Doc {
  const ordered = relabelOrder(doc.seats.filter((s) => ids.has(s.id)), doc.gridSize, o.axis);
  const labels = new Map(ordered.map((s, i) => [s.id, `${o.prefix}${o.start + i}`]));
  return { ...doc, seats: doc.seats.map((s) => (labels.has(s.id) ? { ...s, label: labels.get(s.id)! } : s)) };
}

export function addZone(doc: Doc, color: string, name: string, id: string = newId()): Doc {
  return { ...doc, zones: [...doc.zones, { id, name, color }] };
}

export function patchZone(doc: Doc, id: string, patch: Partial<ZoneData>): Doc {
  return { ...doc, zones: doc.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) };
}

/** A zone can only be removed when no seat uses it and it isn't the last one. */
export function canDeleteZone(doc: Doc, id: string): boolean {
  return doc.zones.length > 1 && !doc.seats.some((s) => s.zoneId === id);
}

export function deleteZone(doc: Doc, id: string): Doc {
  return canDeleteZone(doc, id) ? { ...doc, zones: doc.zones.filter((z) => z.id !== id) } : doc;
}

/** Bounding boxes (centre ± half size) for rubber-band selection. */
export function itemsInRect(doc: Doc, r: { x1: number; y1: number; x2: number; y2: number }, seatHalf = 14): Set<Key> {
  const x1 = Math.min(r.x1, r.x2);
  const x2 = Math.max(r.x1, r.x2);
  const y1 = Math.min(r.y1, r.y2);
  const y2 = Math.max(r.y1, r.y2);
  const keys = new Set<Key>();
  for (const s of doc.seats) if (s.x + seatHalf >= x1 && s.x - seatHalf <= x2 && s.y + seatHalf >= y1 && s.y - seatHalf <= y2) keys.add(seatKey(s.id));
  for (const o of doc.objects) if (o.x + o.width >= x1 && o.x <= x2 && o.y + o.height >= y1 && o.y <= y2) keys.add(objectKey(o.id));
  return keys;
}

export function toPayload(doc: Doc) {
  return {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    gridSize: doc.gridSize,
    zones: doc.zones,
    seats: doc.seats.map(({ reservedForLabel: _label, ...s }) => s),
    objects: doc.objects,
  };
}
