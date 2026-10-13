import { z } from "zod";
import { parseSekToOre } from "../money";
import { parseStockholmLocal } from "../time";

/** Error messages are i18n keys under "validation". */

const text = (max: number) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");

/** datetime-local string (Stockholm wall-clock) → UTC Date. */
export const dateTimeSchema = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const d = parseStockholmLocal(s);
    if (!d) {
      ctx.addIssue({ code: "custom", message: "validation.dateInvalid" });
      return z.NEVER;
    }
    return d;
  });

const optionalDateTime = z
  .string()
  .trim()
  .optional()
  .transform((s) => (s ? s : undefined))
  .pipe(dateTimeSchema.optional());

const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

export const eventSchema = z
  .object({
    name: text(120),
    description: text(5000),
    venueName: text(150),
    address: text(300),
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    registrationOpensAt: dateTimeSchema,
    registrationClosesAt: dateTimeSchema,
    minAge: z.coerce.number({ message: "validation.numberInvalid" }).int("validation.numberInvalid").min(0, "validation.numberInvalid").max(99, "validation.numberInvalid"),
    seatChangeDeadline: optionalDateTime,
    showNicknamesOnMap: checkbox,
  })
  .superRefine((v, ctx) => {
    const bad = (path: string, message = "validation.dateOrder") => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.endsAt <= v.startsAt) bad("endsAt");
    if (v.registrationClosesAt <= v.registrationOpensAt) bad("registrationClosesAt");
    if (v.registrationClosesAt > v.endsAt) bad("registrationClosesAt");
    if (v.seatChangeDeadline && v.seatChangeDeadline > v.endsAt) bad("seatChangeDeadline");
  });

export const createEventSchema = eventSchema.and(z.object({ templateId: z.string().optional() }));

export const ticketTypeSchema = z
  .object({
    name: text(100),
    description: z.string().trim().max(1000, "validation.tooLong").default(""),
    price: z
      .string()
      .trim()
      .transform((s, ctx) => {
        const ore = parseSekToOre(s);
        if (ore === null) {
          ctx.addIssue({ code: "custom", message: "validation.priceInvalid" });
          return z.NEVER;
        }
        return ore;
      }),
    quantity: z.coerce.number({ message: "validation.numberInvalid" }).int("validation.numberInvalid").min(0, "validation.numberInvalid").max(100000, "validation.numberInvalid"),
    salesStartsAt: optionalDateTime,
    salesEndsAt: optionalDateTime,
    includesSeat: checkbox,
    requiresDiscountCode: checkbox,
    hidden: checkbox,
    sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.salesStartsAt && v.salesEndsAt && v.salesEndsAt <= v.salesStartsAt) {
      ctx.addIssue({ code: "custom", path: ["salesEndsAt"], message: "validation.dateOrder" });
    }
  });

export type EventInput = z.output<typeof eventSchema>;
export type TicketTypeInput = z.output<typeof ticketTypeSchema>;
