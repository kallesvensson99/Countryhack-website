import { z } from "zod";

/** Error messages are i18n keys under "validation" (see account.ts). */
const text = (max: number) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");
const optionalText = (max: number) => z.string().trim().max(max, "validation.tooLong").default("");
const checkbox = z.string().optional().transform((v) => v === "on" || v === "true");

export const FAQ_GROUP_IDS = ["TICKETS", "SEATS_FOOD", "ON_SITE", "ACCOUNT"] as const;

export const faqItemSchema = z.object({
  group: z.enum(FAQ_GROUP_IDS, "validation.required"),
  questionSv: text(300),
  answerSv: text(4000),
  questionEn: optionalText(300),
  answerEn: optionalText(4000),
});

export const crewJobSchema = z
  .object({
    title: text(100),
    description: text(2000),
    titleEn: optionalText(100),
    descriptionEn: optionalText(2000),
    before: checkbox,
    during: checkbox,
    after: checkbox,
    spots: z
      .string()
      .trim()
      .optional()
      .transform((s, ctx) => {
        if (!s) return null;
        const n = /^\d{1,4}$/.test(s) ? Number(s) : NaN;
        if (!(n >= 1 && n <= 1000)) {
          ctx.addIssue({ code: "custom", message: "validation.numberInvalid" });
          return z.NEVER;
        }
        return n;
      }),
    isOpen: checkbox,
  })
  .superRefine((v, ctx) => {
    if (!v.before && !v.during && !v.after) ctx.addIssue({ code: "custom", path: ["during"], message: "validation.crewWhen" });
  });

export const crewApplicationSchema = z.object({
  jobId: z.string().min(1).max(60),
  message: text(1500),
  availability: text(300),
});

export type FaqItemInput = z.output<typeof faqItemSchema>;
export type CrewJobInput = z.output<typeof crewJobSchema>;
export type CrewApplicationInput = z.output<typeof crewApplicationSchema>;
