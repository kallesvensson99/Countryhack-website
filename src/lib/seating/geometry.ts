import { SEAT_SIZE } from "./types";

export interface Point {
  x: number;
  y: number;
}

export const snap = (v: number, grid: number): number => Math.round(v / grid) * grid;

export function rotatePoint(p: Point, center: Point, degrees: number): Point {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function centroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}

export const normalizeDegrees = (d: number): number => ((Math.round(d * 100) / 100) % 360 + 360) % 360;

/** Seat spacing: a whole number of grid cells, never tighter than a seat plus a small gap. */
export function seatSpacing(gridSize: number): number {
  return Math.max(1, Math.ceil((SEAT_SIZE + 6) / gridSize)) * gridSize;
}

/** `count` seat centres in a line starting at (startX, startY). */
export function rowPositions(opts: { count: number; startX: number; startY: number; spacing: number; orientation: "horizontal" | "vertical" }): Point[] {
  return Array.from({ length: opts.count }, (_, i) => ({
    x: opts.startX + (opts.orientation === "horizontal" ? i * opts.spacing : 0),
    y: opts.startY + (opts.orientation === "vertical" ? i * opts.spacing : 0),
  }));
}

/**
 * Seats on both long sides of a table, centred on (cx, cy). The top side gets the extra seat for odd counts.
 * Seats face the table: top row rotation 0, bottom row rotation 180.
 */
export function tableLayout(opts: { count: number; cx: number; cy: number; spacing: number }) {
  const top = Math.ceil(opts.count / 2);
  const bottom = opts.count - top;
  const perSide = Math.max(top, 1);
  const tableWidth = perSide * opts.spacing;
  const left = opts.cx - ((perSide - 1) * opts.spacing) / 2;
  const seats: (Point & { rotation: number })[] = [];
  for (let i = 0; i < top; i++) seats.push({ x: left + i * opts.spacing, y: opts.cy - opts.spacing, rotation: 0 });
  for (let i = 0; i < bottom; i++) seats.push({ x: left + i * opts.spacing, y: opts.cy + opts.spacing, rotation: 180 });
  return { seats, table: { x: opts.cx - tableWidth / 2, y: opts.cy - opts.spacing / 2, width: tableWidth, height: opts.spacing } };
}

export const makeLabels = (prefix: string, count: number, start = 1): string[] => Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);

/** Letters A..Z, AA..AZ, BA.. — the first one that isn't the leading-letters prefix of any existing label. */
export function nextPrefix(existingLabels: string[]): string {
  const used = new Set(existingLabels.map((l) => /^[A-Za-z]+/.exec(l)?.[0]?.toUpperCase()).filter(Boolean));
  for (let n = 0; ; n++) {
    let s = "";
    let k = n;
    do {
      s = String.fromCharCode(65 + (k % 26)) + s;
      k = Math.floor(k / 26) - 1;
    } while (k >= 0);
    if (!used.has(s)) return s;
  }
}

/** Case-insensitive duplicates → the set of ids involved. */
export function findDuplicateLabels<T extends { id: string; label: string }>(items: T[]): Set<string> {
  const byLabel = new Map<string, string[]>();
  for (const it of items) {
    const k = it.label.trim().toLowerCase();
    byLabel.set(k, [...(byLabel.get(k) ?? []), it.id]);
  }
  return new Set([...byLabel.values()].filter((ids) => ids.length > 1).flat());
}

/**
 * Assign sequential labels to seats in reading order.
 * axis "x": rows top→bottom, each left→right. axis "y": columns left→right, each top→bottom.
 */
export function relabelOrder<T extends Point & { id: string }>(seats: T[], gridSize: number, axis: "x" | "y"): T[] {
  const band = (v: number) => Math.round(v / gridSize);
  return [...seats].sort((a, b) => (axis === "x" ? band(a.y) - band(b.y) || a.x - b.x : band(a.x) - band(b.x) || a.y - b.y));
}

export function boundsOverlap(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): boolean {
  return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
}

/** Perceived brightness test, to choose black or white label text on a zone colour. */
export function isLightColor(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}
