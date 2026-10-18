import { z } from "zod";
import { SCHEDULE_COLOR_KEYS } from "../schedule/palette";
import { dateTimeSchema } from "./events";

const text = (max: number) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");
const optionalText = (max: number) => z.string().trim().max(max, "validation.tooLong").default("");

export const scheduleCategorySchema = z.object({
  name: text(60),
  nameEn: optionalText(60),
  color: z.enum(SCHEDULE_COLOR_KEYS, "validation.required"),
});

export const MAX_ITEM_HOURS = 24;

export const scheduleItemSchema = z
  .object({
    title: text(100),
    titleEn: optionalText(100),
    description: optionalText(1000),
    descriptionEn: optionalText(1000),
    location: optionalText(100),
    /** empty = no category */
    categoryId: z.string().trim().max(60).default("").transform((s) => s || null),
    /** datetime-local, Stockholm wall-clock */
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
  })
  .superRefine((v, ctx) => {
    if (v.endsAt <= v.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "validation.scheduleEndBeforeStart" });
    else if (v.endsAt.getTime() - v.startsAt.getTime() > MAX_ITEM_HOURS * 3600_000) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "validation.scheduleTooLong" });
  });

export type ScheduleCategoryInput = z.output<typeof scheduleCategorySchema>;
export type ScheduleItemInput = z.output<typeof scheduleItemSchema>;
