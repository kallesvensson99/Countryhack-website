import { db } from "../db";
import { writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import type { ChartPayload } from "../validation/chart";
import { copyChart } from "./copy";
import { ZONE_COLORS, type ChartData } from "./types";

export type ChartError =
  | { reason: "notFound" | "eventCancelled" | "invalidLabels" | "badUser" | "badChart" }
  | { reason: "seatHasClaim"; labels: string[] }
  | { reason: "zoneIncompatible"; labels: string[] }
  | { reason: "reservedConflict"; labels: string[] }
  | { reason: "zoneInUse"; names: string[] };
export type ChartResult<T = object> = ({ ok: true } & T) | ({ ok: false } & ChartError);

const fail = (e: ChartError) => ({ ok: false as const, ...e });

/** Chart in the shape the editor works with. */
export async function loadChartData(chartId: string): Promise<ChartData | null> {
  const c = await db.seatingChart.findUnique({
    where: { id: chartId },
    include: { zones: { orderBy: { name: "asc" } }, seats: { include: { reservedForUser: { select: { nickname: true } } }, orderBy: { label: "asc" } }, objects: true },
  });
  if (!c) return null;
  return {
    id: c.id, name: c.name, width: c.width, height: c.height, gridSize: c.gridSize,
    zones: c.zones.map((z) => ({ id: z.id, name: z.name, color: z.color })),
    seats: c.seats.map((s) => ({
      id: s.id, label: s.label, x: s.x, y: s.y, rotation: s.rotation, zoneId: s.zoneId, groupId: s.groupId,
      blocked: s.blocked, reservedForUserId: s.reservedForUserId, reservedForLabel: s.reservedForUser?.nickname ?? null,
    })),
    objects: c.objects.map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation, label: o.label })),
  };
}

const TMP = "~tmp~";
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * Saves the whole chart in ONE transaction (all or nothing).
 * The editor sends the complete desired state; items whose id exists in this chart are updated,
 * unknown ids are created, existing items missing from the payload are deleted. Refuses (without changing anything):
 *  - deleting / blocking a seat that has a claim, or reserving it for someone else
 *  - moving a claimed seat to a zone its ticket type may not use
 *  - deleting a zone that ticket types reference
 *  - duplicate labels (case-insensitive)
 */
export async function saveChart(actor: Actor, chartId: string, data: ChartPayload, ip?: string | null): Promise<ChartResult> {
  const meta = await db.seatingChart.findUnique({ where: { id: chartId }, select: { isTemplate: true, event: { select: { id: true, status: true } } } });
  if (!meta) return fail({ reason: "notFound" });
  assertCan(actor, meta.isTemplate ? "template:manage" : "chart:manage");
  if (meta.event?.status === "CANCELLED") return fail({ reason: "eventCancelled" });

  const labelKeys = data.seats.map((s) => s.label.trim().toLowerCase());
  if (new Set(labelKeys).size !== labelKeys.length) return fail({ reason: "invalidLabels" });

  const reservedIds = [...new Set(data.seats.map((s) => s.reservedForUserId).filter((x): x is string => !!x))];
  if (reservedIds.length) {
    const ok = await db.user.count({ where: { id: { in: reservedIds }, anonymizedAt: null } });
    if (ok !== reservedIds.length) return fail({ reason: "badUser" });
  }

  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "SeatingChart" WHERE "id" = ${chartId} FOR UPDATE`;
      // Lock every seat: concurrent claims (FOR SHARE) wait until we commit and then see the new state.
      await tx.$queryRaw`SELECT "id" FROM "Seat" WHERE "chartId" = ${chartId} ORDER BY "id" FOR UPDATE`;

      const chart = await tx.seatingChart.findUniqueOrThrow({
        where: { id: chartId },
        include: {
          zones: { include: { ticketTypes: true } },
          objects: true,
          seats: { include: { claim: { include: { ticket: { include: { ticketType: { include: { zones: true } } } } } } } },
        },
      });

      // ---- zones
      const zoneIdMap = new Map<string, string>(); // payload id → real id
      const existingZones = new Map(chart.zones.map((z) => [z.id, z]));
      for (const z of data.zones) if (existingZones.has(z.id)) zoneIdMap.set(z.id, z.id);
      const removedZones = chart.zones.filter((z) => !data.zones.some((p) => p.id === z.id));
      const inUse = removedZones.filter((z) => z.ticketTypes.length > 0);
      if (inUse.length) return fail({ reason: "zoneInUse", names: inUse.map((z) => z.name) });

      // ---- seat checks against claims
      const existingSeats = new Map(chart.seats.map((s) => [s.id, s]));
      const payloadSeatIds = new Set(data.seats.map((s) => s.id));
      const removedClaimed = chart.seats.filter((s) => !payloadSeatIds.has(s.id) && s.claim);
      if (removedClaimed.length) return fail({ reason: "seatHasClaim", labels: removedClaimed.map((s) => s.label) });

      const blockedClaimed: string[] = [];
      const incompatible: string[] = [];
      const reservedConflict: string[] = [];
      for (const p of data.seats) {
        const cur = existingSeats.get(p.id);
        if (!cur?.claim) continue;
        if (p.blocked) blockedClaimed.push(cur.label);
        if (p.reservedForUserId && p.reservedForUserId !== cur.claim.ticket.userId) reservedConflict.push(cur.label);
        if (p.zoneId !== cur.zoneId) {
          const allowed = cur.claim.ticket.ticketType.zones.map((z) => z.zoneId);
          const target = zoneIdMap.get(p.zoneId); // new zones aren't in any ticket type's list
          if (allowed.length > 0 && (!target || !allowed.includes(target))) incompatible.push(cur.label);
        }
      }
      if (blockedClaimed.length) return fail({ reason: "seatHasClaim", labels: blockedClaimed });
      if (reservedConflict.length) return fail({ reason: "reservedConflict", labels: reservedConflict });
      if (incompatible.length) return fail({ reason: "zoneIncompatible", labels: incompatible });

      // ---- apply: zones
      for (const z of data.zones) {
        const cur = existingZones.get(z.id);
        if (cur) {
          if (cur.name !== z.name || cur.color !== z.color) await tx.seatZone.update({ where: { id: z.id }, data: { name: z.name, color: z.color } });
        } else {
          zoneIdMap.set(z.id, (await tx.seatZone.create({ data: { chartId, name: z.name, color: z.color } })).id);
        }
      }

      // ---- apply: seats. Labels that change go through a temporary label so that swaps don't collide.
      const changingLabel = data.seats.filter((p) => existingSeats.get(p.id) && existingSeats.get(p.id)!.label !== p.label.trim());
      for (const p of changingLabel) await tx.seat.update({ where: { id: p.id }, data: { label: TMP + p.id } });
      const removedSeatIds = chart.seats.filter((s) => !payloadSeatIds.has(s.id)).map((s) => s.id);
      if (removedSeatIds.length) await tx.seat.deleteMany({ where: { id: { in: removedSeatIds } } });

      let changed = 0;
      const fresh: typeof data.seats = [];
      for (const p of data.seats) {
        const cur = existingSeats.get(p.id);
        const zoneId = zoneIdMap.get(p.zoneId)!;
        if (!cur) {
          fresh.push(p);
          continue;
        }
        const label = p.label.trim();
        if (cur.label !== label || !same(cur.x, p.x) || !same(cur.y, p.y) || !same(cur.rotation, p.rotation) || cur.zoneId !== zoneId || cur.groupId !== p.groupId || cur.blocked !== p.blocked || cur.reservedForUserId !== p.reservedForUserId) {
          await tx.seat.update({ where: { id: p.id }, data: { label, x: p.x, y: p.y, rotation: p.rotation, zoneId, groupId: p.groupId, blocked: p.blocked, reservedForUserId: p.reservedForUserId } });
          changed++;
        }
      }
      if (fresh.length) {
        await tx.seat.createMany({
          data: fresh.map((p) => ({ chartId, label: p.label.trim(), x: p.x, y: p.y, rotation: p.rotation, zoneId: zoneIdMap.get(p.zoneId)!, groupId: p.groupId, blocked: p.blocked, reservedForUserId: p.reservedForUserId })),
        });
      }
      if (removedZones.length) await tx.seatZone.deleteMany({ where: { id: { in: removedZones.map((z) => z.id) } } });

      // ---- apply: objects (replace-by-diff)
      const existingObjects = new Map(chart.objects.map((o) => [o.id, o]));
      const payloadObjectIds = new Set(data.objects.map((o) => o.id));
      const removedObjects = chart.objects.filter((o) => !payloadObjectIds.has(o.id)).map((o) => o.id);
      if (removedObjects.length) await tx.chartObject.deleteMany({ where: { id: { in: removedObjects } } });
      const freshObjects = data.objects.filter((o) => !existingObjects.has(o.id));
      for (const o of data.objects) {
        const cur = existingObjects.get(o.id);
        if (cur) {
          await tx.chartObject.update({ where: { id: o.id }, data: { kind: o.kind, x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation, label: o.label || null } });
        }
      }
      if (freshObjects.length) await tx.chartObject.createMany({ data: freshObjects.map((o) => ({ chartId, kind: o.kind, x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation, label: o.label || null })) });

      await tx.seatingChart.update({ where: { id: chartId }, data: { name: data.name, width: data.width, height: data.height, gridSize: data.gridSize } });

      await writeAudit(tx, {
        actorId: actor.id,
        action: "chart.save",
        entityType: "SeatingChart",
        entityId: chartId,
        eventId: meta.event?.id ?? null,
        diff: {
          seats: { added: fresh.length, removed: removedSeatIds.length, changed, total: data.seats.length },
          zones: { added: data.zones.filter((z) => !existingZones.has(z.id)).length, removed: removedZones.length, total: data.zones.length },
          objects: { added: freshObjects.length, removed: removedObjects.length, total: data.objects.length },
        },
        ip,
      });
      return { ok: true as const };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

export async function createBlankChart(actor: Actor, eventId: string, ip?: string | null): Promise<ChartResult<{ chartId: string }>> {
  assertCan(actor, "chart:manage");
  const ev = await db.event.findUnique({ where: { id: eventId }, include: { chart: true } });
  if (!ev) return fail({ reason: "notFound" });
  if (ev.status === "CANCELLED") return fail({ reason: "eventCancelled" });
  if (ev.chart) return fail({ reason: "badChart" });
  return db.$transaction(async (tx) => {
    const chart = await tx.seatingChart.create({ data: { eventId, name: ev.name, zones: { create: [{ name: "Standard", color: ZONE_COLORS[0] }] } } });
    await writeAudit(tx, { actorId: actor.id, action: "chart.create", entityType: "SeatingChart", entityId: chart.id, eventId, diff: { blank: true }, ip });
    return { ok: true as const, chartId: chart.id };
  });
}

/** Only for events without a chart (replacing one would silently drop ticket types' zone links). */
export async function applyTemplate(actor: Actor, eventId: string, templateId: string, ip?: string | null): Promise<ChartResult<{ chartId: string }>> {
  assertCan(actor, "chart:manage");
  const ev = await db.event.findUnique({ where: { id: eventId }, include: { chart: true } });
  const tpl = await db.seatingChart.findFirst({ where: { id: templateId, isTemplate: true } });
  if (!ev || !tpl) return fail({ reason: "notFound" });
  if (ev.status === "CANCELLED") return fail({ reason: "eventCancelled" });
  if (ev.chart) return fail({ reason: "badChart" });
  return db.$transaction(async (tx) => {
    const { chartId } = await copyChart(tx, tpl.id, { name: tpl.name, eventId, isTemplate: false });
    await writeAudit(tx, { actorId: actor.id, action: "chart.fromTemplate", entityType: "SeatingChart", entityId: chartId, eventId, diff: { templateId }, ip });
    return { ok: true as const, chartId };
  });
}

export async function saveAsTemplate(actor: Actor, eventId: string, name: string, ip?: string | null): Promise<ChartResult<{ templateId: string }>> {
  assertCan(actor, "template:manage");
  const chart = await db.seatingChart.findUnique({ where: { eventId } });
  if (!chart) return fail({ reason: "notFound" });
  return db.$transaction(async (tx) => {
    const { chartId } = await copyChart(tx, chart.id, { name: name.trim().slice(0, 100) || chart.name, eventId: null, isTemplate: true });
    await writeAudit(tx, { actorId: actor.id, action: "template.create", entityType: "SeatingChart", entityId: chartId, eventId, diff: { fromChart: chart.id }, ip });
    return { ok: true as const, templateId: chartId };
  });
}

export async function deleteTemplate(actor: Actor, templateId: string, ip?: string | null): Promise<ChartResult> {
  assertCan(actor, "template:manage");
  const tpl = await db.seatingChart.findFirst({ where: { id: templateId, isTemplate: true } });
  if (!tpl) return fail({ reason: "notFound" });
  await db.$transaction(async (tx) => {
    await tx.seatingChart.delete({ where: { id: templateId } });
    await writeAudit(tx, { actorId: actor.id, action: "template.delete", entityType: "SeatingChart", entityId: templateId, diff: { name: tpl.name }, ip });
  });
  return { ok: true };
}

export function listTemplates() {
  return db.seatingChart.findMany({ where: { isTemplate: true }, orderBy: { name: "asc" }, include: { _count: { select: { seats: true } } } });
}

/** Festivalledare picking a user for a reserved seat. */
export async function searchUsers(actor: Actor, q: string) {
  assertCan(actor, "chart:manage");
  const term = q.trim();
  if (term.length < 2) return [];
  return db.user.findMany({
    where: { anonymizedAt: null, OR: [{ nickname: { contains: term, mode: "insensitive" } }, { email: { contains: term.toLowerCase() } }] },
    select: { id: true, nickname: true, email: true },
    orderBy: { nickname: "asc" },
    take: 8,
  });
}
