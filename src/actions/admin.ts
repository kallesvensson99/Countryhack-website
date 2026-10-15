"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { setUserTag, updateOrgSettings } from "@/lib/admin/service";
import { echoValues, fieldErrors, formToObject, orgSettingsSchema, type ActionState } from "@/lib/validation/account";

const tagSchema = z.object({
  userId: z.string().min(1),
  tag: z.enum(["FESTIVALLEDARE", "ANSVARIG", "ADMIN"]),
  enabled: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function setTagAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "userTag:manage");
  const parsed = tagSchema.safeParse(formToObject(fd));
  if (!parsed.success) return { message: "messages.invalidInput" };
  const r = await setUserTag(actor, parsed.data.userId, parsed.data.tag, parsed.data.enabled, await getClientIp());
  if (!r.ok) return { message: r.reason === "lastAdmin" ? "messages.lastAdmin" : "messages.userNotFound" };
  revalidatePath("/[locale]/admin/users", "page");
  return { ok: true, message: "messages.tagUpdated" };
}

export async function updateOrgSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "orgSettings:edit");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = orgSettingsSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  await updateOrgSettings(actor, parsed.data, await getClientIp());
  return { ok: true, message: "messages.settingsSaved", values };
}
