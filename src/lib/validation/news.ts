import { z } from "zod";
import { dateTimeSchema } from "./events";

const text = (max: number) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");
const optionalText = (max: number) => z.string().trim().max(max, "validation.tooLong").default("");
const checkbox = z.string().optional().transform((v) => v === "on" || v === "true");

export const newsPostSchema = z.object({
  title: text(150),
  titleEn: optionalText(150),
  body: text(20000),
  bodyEn: optionalText(20000),
  /** ticked = published (or scheduled, if the date is in the future) */
  published: checkbox,
  /** datetime-local in Stockholm time, optional: empty = now (or keep the current date when editing) */
  publishedAt: z
    .string()
    .trim()
    .optional()
    .transform((s) => (s ? s : undefined))
    .pipe(dateTimeSchema.optional()),
  removeImage: checkbox,
});

export type NewsPostInput = z.output<typeof newsPostSchema>;
