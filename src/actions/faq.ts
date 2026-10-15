"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { createFaqItem, deleteFaqItem, importDefaultFaq, moveFaqItem, updateFaqItem } from "@/lib/content/faq-store";
import { assertCan } from "@/lib/permissions";
import { faqItemSchema } from "@/lib/validation/crew";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = { notFound: "messages.notFound", alreadyImported: "messages.faqAlreadyImported" };
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

/** Create (no `id` field) or update a FAQ entry. */
export async function saveFaqAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "faq:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = faqItemSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const r = raw.id ? await updateFaqItem(actor, raw.id, parsed.data, ip) : await createFaqItem(actor, parsed.data, ip);
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.faqSaved", values: raw.id ? values : undefined };
}

export async function deleteFaqAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "faq:manage");
  const fid = id.safeParse(fd.get("id"));
  if (!fid.success) return fail("notFound");
  const r = await deleteFaqItem(actor, fid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.faqDeleted" };
}

const moveSchema = z.object({ id, direction: z.enum(["up", "down"]) });

export async function moveFaqAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "faq:manage");
  const parsed = moveSchema.safeParse(formToObject(fd));
  if (!parsed.success) return fail("invalid");
  const r = await moveFaqItem(actor, parsed.data.id, parsed.data.direction, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.faqMoved" };
}

export async function importFaqAction(_prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "faq:manage");
  const r = await importDefaultFaq(actor, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.faqImported" };
}
