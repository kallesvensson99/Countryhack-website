import { z } from "zod";
import { dateTimeSchema } from "./events";

const text = (max: number) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");
const optionalText = (max: number) => z.string().trim().max(max, "validation.tooLong").default("");
const optionalInt = (min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((s, ctx) => {
      if (!s) return null;
      const n = /^\d{1,6}$/.test(s) ? Number(s) : NaN;
      if (!(n >= min && n <= max)) {
        ctx.addIssue({ code: "custom", message: "validation.numberInvalid" });
        return z.NEVER;
      }
      return n;
    });
const requiredInt = (min: number, max: number) =>
  z
    .string()
    .trim()
    .transform((s, ctx) => {
      const n = /^\d{1,6}$/.test(s) ? Number(s) : NaN;
      if (!(n >= min && n <= max)) {
        ctx.addIssue({ code: "custom", message: "validation.numberInvalid" });
        return z.NEVER;
      }
      return n;
    });

export const MAX_TEAM_MEMBERS = 20;
export const MAX_TEAMS_PER_CAPTAIN = 5;

/** Names are compared ignoring case and extra spaces. */
export const normaliseTeamName = (name: string) => name.trim().replace(/\s+/g, " ");
export const teamNameKey = (name: string) => normaliseTeamName(name).toLowerCase();

export const teamSchema = z.object({
  name: z
    .string()
    .transform(normaliseTeamName)
    .pipe(z.string().min(2, "validation.teamNameLength").max(40, "validation.teamNameLength").regex(/^[\p{L}\p{N}_.\- ]+$/u, "validation.teamNameChars")),
  tag: z
    .string()
    .trim()
    .toUpperCase()
    .max(5, "validation.teamTag")
    .regex(/^[\p{L}\p{N}]*$/u, "validation.teamTag")
    .default(""),
  description: optionalText(500),
});

export const inviteSchema = z.object({ teamId: z.string().min(1).max(60), nickname: text(30) });

export const TOURNAMENT_STATUSES = ["DRAFT", "PUBLISHED", "CANCELLED"] as const;

export const tournamentSchema = z
  .object({
    name: text(100),
    game: text(60),
    description: optionalText(5000),
    format: optionalText(200),
    teamSize: requiredInt(1, 50),
    maxSubstitutes: z.string().trim().default("1").pipe(requiredInt(0, 10)),
    maxTeams: optionalInt(2, 1000),
    registrationClosesAt: dateTimeSchema,
    startsAt: z
      .string()
      .trim()
      .optional()
      .transform((s) => (s ? s : undefined))
      .pipe(dateTimeSchema.optional()),
    eventId: z.string().trim().max(60).default("").transform((s) => s || null),
    status: z.enum(TOURNAMENT_STATUSES, "validation.required"),
  })
  .superRefine((v, ctx) => {
    if (v.startsAt && v.registrationClosesAt > v.startsAt) ctx.addIssue({ code: "custom", path: ["registrationClosesAt"], message: "validation.tournamentCloseAfterStart" });
  });

export type TeamInput = z.output<typeof teamSchema>;
export type TournamentInput = z.output<typeof tournamentSchema>;
