import { z } from "zod";
import { isMinor } from "../age";

/**
 * Shared between client and server. Error messages are i18n keys under the
 * "validation" namespace; the UI translates them.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "validation.required")
  .max(254, "validation.tooLong")
  .pipe(z.email("validation.emailInvalid"));

export const passwordSchema = z
  .string()
  .min(10, "validation.passwordTooShort")
  .max(128, "validation.tooLong");

const text = (max = 100) => z.string().trim().min(1, "validation.required").max(max, "validation.tooLong");
const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max, "validation.tooLong")
    .optional()
    .transform((v) => (v ? v : undefined));

export const nicknameSchema = z
  .string()
  .trim()
  .min(2, "validation.nicknameLength")
  .max(30, "validation.nicknameLength")
  .regex(/^[\p{L}\p{N}_.\- ]+$/u, "validation.nicknameChars");

export const phoneSchema = z
  .string()
  .trim()
  .min(1, "validation.required")
  .regex(/^\+?[0-9 ()\-]{6,20}$/, "validation.phoneInvalid");

/** "YYYY-MM-DD" → Date at UTC midnight (matches a Postgres DATE column). */
export const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "validation.birthDateInvalid")
  .transform((s, ctx) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      ctx.addIssue({ code: "custom", message: "validation.birthDateInvalid" });
      return z.NEVER;
    }
    if (d > new Date() || d.getUTCFullYear() < 1900) {
      ctx.addIssue({ code: "custom", message: "validation.birthDateInvalid" });
      return z.NEVER;
    }
    return d;
  });

const profileFields = {
  realName: text(100),
  nickname: nicknameSchema,
  birthDate: birthDateSchema,
  phone: phoneSchema,
  allergies: optionalText(500),
  dietaryPreferences: optionalText(500),
  guardianName: optionalText(100),
  guardianPhone: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(phoneSchema.optional()),
  locale: z.enum(["sv", "en"]),
};

/** Guardian details are required when the user is under 18 (by actual birth date). */
function requireGuardianIfMinor(
  v: { birthDate: Date; guardianName?: string | undefined; guardianPhone?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (isMinor(v.birthDate)) {
    if (!v.guardianName) ctx.addIssue({ code: "custom", path: ["guardianName"], message: "validation.guardianRequired" });
    if (!v.guardianPhone) ctx.addIssue({ code: "custom", path: ["guardianPhone"], message: "validation.guardianRequired" });
  }
}

export const profileSchema = z.object(profileFields).superRefine(requireGuardianIfMinor);

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    ...profileFields,
    // Checked in the refinement below (not as a field rule) so a missing consent doesn't
    // stop Zod from also reporting the guardian errors in the same pass.
    acceptPrivacy: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.acceptPrivacy !== "on") ctx.addIssue({ code: "custom", path: ["acceptPrivacy"], message: "validation.consentRequired" });
    requireGuardianIfMinor(v, ctx);
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "validation.required").max(128),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, "validation.required").max(128),
  confirmation: z.string().trim().min(1, "validation.required"),
});

export const orgSettingsSchema = z.object({
  name: text(150),
  orgNumber: optionalText(30),
  address: optionalText(300),
  contactEmail: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.email("validation.emailInvalid").optional()),
  privacyPolicyVersion: text(20),
});

export type ActionState = {
  ok?: boolean;
  /** i18n key (under "messages") for a top-level status message. */
  message?: string;
  /** field name → i18n key under "validation" */
  errors?: Record<string, string>;
  /** Submitted (non-secret) values, so the form keeps what the user typed. */
  values?: Record<string, string>;
};

/** Flatten a ZodError into { field: firstMessageKey }. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_");
    out[key] ??= issue.message;
  }
  return out;
}

export function formToObject(fd: FormData): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) o[k] = v;
  return o;
}

const SECRET_FIELDS = new Set(["password", "token", "confirmation"]);

/** Submitted values to echo back into the form (React 19 resets uncontrolled forms after an action). Never includes secrets. */
export function echoValues(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !SECRET_FIELDS.has(k)));
}
