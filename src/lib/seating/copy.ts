import type { Prisma } from "@prisma/client";

/**
 * Deep-copies a chart with its zones, seats and objects (zone ids are remapped).
 * Used when duplicating an event and (stage c) when creating charts from templates.
 * Per-user seat reservations are NOT copied: they belong to one event's attendees.
 */
export async function copyChart(
  tx: Prisma.TransactionClient,
  sourceChartId: string,
  target: { name: string; eventId: string | null; isTemplate: boolean },
): Promise<{ chartId: string; zoneMap: Map<string, string> }> {
  const src = await tx.seatingChart.findUniqueOrThrow({
    where: { id: sourceChartId },
    include: { zones: true, seats: true, objects: true },
  });
  const chart = await tx.seatingChart.create({
    data: { name: target.name, eventId: target.eventId, isTemplate: target.isTemplate, width: src.width, height: src.height, gridSize: src.gridSize },
  });

  const zoneMap = new Map<string, string>();
  for (const z of src.zones) {
    const nz = await tx.seatZone.create({ data: { chartId: chart.id, name: z.name, color: z.color } });
    zoneMap.set(z.id, nz.id);
  }
  if (src.seats.length) {
    await tx.seat.createMany({
      data: src.seats.map((s) => ({
        chartId: chart.id,
        label: s.label,
        x: s.x,
        y: s.y,
        rotation: s.rotation,
        zoneId: zoneMap.get(s.zoneId)!,
        groupId: s.groupId,
        blocked: s.blocked,
      })),
    });
  }
  if (src.objects.length) {
    await tx.chartObject.createMany({
      data: src.objects.map((o) => ({ chartId: chart.id, kind: o.kind, x: o.x, y: o.y, width: o.width, height: o.height, rotation: o.rotation, label: o.label })),
    });
  }
  return { chartId: chart.id, zoneMap };
}
