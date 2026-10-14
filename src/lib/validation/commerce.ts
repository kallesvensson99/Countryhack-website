import { z } from "zod";
import { parseSekToOre } from "../money";
import { dateTimeSchema } from "./events";

const text = (max: number) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");
const optionalDateTime = z.string().trim().optional().transform((s) => (s ? s : undefined)).pipe(dateTimeSchema.optional());
const checkbox = z.string().optional().transform((v) => v === "on" || v === "true");
const optionalInt = (max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      const n = /^\d{1,9}$/.test(s) ? Number(s) : NaN;
      if (!(n >= 0 && n <= max)) {
        ctx.addIssue({ code: "custom", message: "validation.numberInvalid" });
        return z.NEVER;
      }
      return n;
    });

const priceSchema = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const ore = parseSekToOre(s);
    if (ore === null) {
      ctx.addIssue({ code: "custom", message: "validation.priceInvalid" });
      return z.NEVER;
    }
    return ore;
  });

export const mealSchema = z.object({ name: text(100), servedAt: dateTimeSchema });

export const foodPackageSchema = z.object({
  name: text(100),
  description: z.string().trim().max(1000, "validation.tooLong").default(""),
  price: priceSchema,
  quantity: optionalInt(100000),
  salesEndsAt: dateTimeSchema,
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
  /** one variant per line */
  variants: z
    .string()
    .default("")
    .transform((s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    .pipe(
      z
        .array(z.string().max(60, "validation.tooLong"))
        .min(1, "validation.variantsRequired")
        .max(12, "validation.tooLong")
        .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, "validation.variantsDuplicate"),
    ),
});

export const discountCodeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2, "validation.codeFormat")
      .max(32, "validation.codeFormat")
      .regex(/^[\p{L}\p{N}_-]+$/u, "validation.codeFormat"),
    kind: z.enum(["PERCENT", "FIXED"]),
    value: z.string().trim().min(1, "validation.required"),
    appliesTo: z.enum(["ALL", "TICKETS", "FOOD"]),
    maxUses: optionalInt(1_000_000),
    validFrom: optionalDateTime,
    validUntil: optionalDateTime,
  })
  .transform((v, ctx) => {
    let value: number | null = null;
    if (v.kind === "PERCENT") {
      const n = /^\d{1,3}$/.test(v.value) ? Number(v.value) : NaN;
      if (n >= 1 && n <= 100) value = n;
      else ctx.addIssue({ code: "custom", path: ["value"], message: "validation.percentInvalid" });
    } else {
      const ore = parseSekToOre(v.value);
      if (ore !== null && ore > 0) value = ore;
      else ctx.addIssue({ code: "custom", path: ["value"], message: "validation.priceInvalid" });
    }
    if (v.validFrom && v.validUntil && v.validUntil <= v.validFrom) ctx.addIssue({ code: "custom", path: ["validUntil"], message: "validation.dateOrder" });
    if (value === null) return z.NEVER;
    return { ...v, value };
  });

export const checkoutSchema = z.object({
  eventId: z.string().min(1).max(60),
  ticketTypeId: z.string().max(60).nullish().transform((v) => v || null),
  seatId: z.string().max(60).nullish().transform((v) => v || null),
  discountCode: z.string().trim().max(40).nullish().transform((v) => v || null),
  food: z.array(z.object({ packageId: z.string().min(1).max(60), variantId: z.string().min(1).max(60) })).max(20),
});

export { checkbox };
export type MealInput = z.output<typeof mealSchema>;
export type FoodPackageInput = z.output<typeof foodPackageSchema>;
export type DiscountCodeInput = z.output<typeof discountCodeSchema>;
