"use server";

import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { getCurrentUser, clearSessionCookie } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { anonymizeUser } from "@/lib/gdpr";
import { updateProfile } from "@/lib/profile/service";
import { deleteAccountSchema, echoValues, fieldErrors, formToObject, profileSchema, type ActionState } from "@/lib/validation/account";

export async function updateProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await getCurrentUser();
  assertCan(user, "profile:edit", { ownerId: user?.id });
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const r = await updateProfile(user.id, parsed.data);
  if (!r.ok) return { errors: r.errors, values };
  return { ok: true, message: "messages.profileSaved", values };
}

const CONFIRM_WORDS = ["RADERA", "DELETE"];

export async function deleteAccountAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await getCurrentUser();
  assertCan(user, "account:delete", { ownerId: user?.id });
  const raw = formToObject(fd);
  const parsed = deleteAccountSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  if (!CONFIRM_WORDS.includes(parsed.data.confirmation.toUpperCase())) return { errors: { confirmation: "validation.confirmationMismatch" } };

  const r = await anonymizeUser(user.id, { password: parsed.data.password, ip: await getClientIp() });
  if (!r.ok) {
    const map = {
      wrongPassword: { errors: { password: "validation.wrongPassword" } },
      lastAdmin: { message: "messages.deleteLastAdmin" },
      activeTickets: { message: "messages.deleteActiveTickets" },
      alreadyAnonymized: { message: "messages.deleteFailed" },
    } as const;
    return map[r.reason];
  }
  await clearSessionCookie();
  redirect({ href: "/?deleted=1", locale: await getLocale() });
  return {};
}
