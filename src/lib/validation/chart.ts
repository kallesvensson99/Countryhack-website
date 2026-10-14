import { z } from "zod";

/** Payload of the chart editor's "save". New items carry any client-made id that isn't in the database yet. */

const num = z.number().finite().min(-10000).max(10000);
const id = z.string().min(1).max(60);

export const chartPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    width: z.number().int().min(200).max(5000),
    height: z.number().int().min(200).max(5000),
    gridSize: z.number().int().min(5).max(100),
    zones: z
      .array(z.object({ id, name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }))
      .min(1)
      .max(20),
    seats: z
      .array(
        z.object({
          id,
          label: z.string().trim().min(1).max(12),
          x: num,
          y: num,
          rotation: z.number().finite().min(0).max(360),
          zoneId: id,
          groupId: id.nullable(),
          blocked: z.boolean(),
          reservedForUserId: id.nullable(),
        }),
      )
      .max(1000),
    objects: z
      .array(
        z.object({
          id,
          kind: z.enum(["TABLE", "STAGE", "ENTRANCE", "KITCHEN", "TOILET", "WALL", "LABEL"]),
          x: num,
          y: num,
          width: z.number().finite().min(1).max(5000),
          height: z.number().finite().min(1).max(5000),
          rotation: z.number().finite().min(0).max(360),
          label: z.string().trim().max(60).nullable(),
        }),
      )
      .max(300),
  })
  .superRefine((v, ctx) => {
    const dupe = (items: { id: string }[], path: string) => {
      if (new Set(items.map((i) => i.id)).size !== items.length) ctx.addIssue({ code: "custom", path: [path], message: "duplicate ids" });
    };
    dupe(v.zones, "zones");
    dupe(v.seats, "seats");
    dupe(v.objects, "objects");
    const zoneIds = new Set(v.zones.map((z) => z.id));
    if (v.seats.some((s) => !zoneIds.has(s.zoneId))) ctx.addIssue({ code: "custom", path: ["seats"], message: "seat references unknown zone" });
  });

export type ChartPayload = z.output<typeof chartPayloadSchema>;
