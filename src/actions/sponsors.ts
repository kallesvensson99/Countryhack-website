"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { createSponsor, deleteSponsor, updateSponsor } from "@/lib/sponsors/service";
import { sponsorSchema } from "@/lib/validation/crew";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  badImage: "messages.badImage",
  tooLarge: "messages.imageTooLarge",
  logoRequired: "messages.sponsorLogoRequired",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

/** Create (no `id` field; a logo file is required) or update (a new logo file is optional) a sponsor. */
export async function saveSponsorAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "sponsor:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = sponsorSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const file = fd.get("logo");
  const logo = file instanceof File && file.size > 0 ? Buffer.from(await file.arrayBuffer()) : undefined;
  const ip = await getClientIp();
  if (raw.id) {
    const r = await updateSponsor(actor, raw.id, parsed.data, logo, ip);
    if (!r.ok) return fail(r.reason, values);
  } else {
    if (!logo) return fail("logoRequired", values);
    const r = await createSponsor(actor, parsed.data, logo, ip);
    if (!r.ok) return fail(r.reason, values);
  }
  refresh();
  return { ok: true, message: "messages.sponsorSaved", values: raw.id ? values : undefined };
}

export async function deleteSponsorAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "sponsor:manage");
  const sid = id.safeParse(fd.get("id"));
  if (!sid.success) return fail("notFound");
  const r = await deleteSponsor(actor, sid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.sponsorDeleted" };
}
