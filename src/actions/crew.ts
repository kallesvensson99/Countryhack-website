"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { applyToJob, createJob, deleteJob, setApplicationStatus, updateJob, withdrawApplication } from "@/lib/crew/service";
import { ForbiddenError, assertCan } from "@/lib/permissions";
import { crewApplicationSchema, crewJobSchema } from "@/lib/validation/crew";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  closed: "messages.crewClosed",
  duplicate: "messages.crewDuplicate",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

/** Create (no `id` field) or update a crew job. */
export async function saveCrewJobAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "crewJob:create");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = crewJobSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  try {
    if (raw.id) {
      const r = await updateJob(actor, raw.id, parsed.data, ip);
      if (!r.ok) return fail(r.reason, values);
    } else {
      await createJob(actor, parsed.data, ip);
    }
  } catch (e) {
    if (e instanceof ForbiddenError) return { message: "messages.forbidden", values };
    throw e;
  }
  refresh();
  return { ok: true, message: "messages.crewJobSaved", values: raw.id ? values : undefined };
}

export async function deleteCrewJobAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "crewJob:create");
  const jid = id.safeParse(fd.get("id"));
  if (!jid.success) return fail("notFound");
  try {
    const r = await deleteJob(actor, jid.data, await getClientIp());
    if (!r.ok) return fail(r.reason);
  } catch (e) {
    if (e instanceof ForbiddenError) return { message: "messages.forbidden" };
    throw e;
  }
  refresh();
  return { ok: true, message: "messages.crewJobDeleted" };
}

const statusSchema = z.object({ id, status: z.enum(["NEW", "ACCEPTED", "DECLINED"]) });

export async function setApplicationStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "crewJob:create");
  const parsed = statusSchema.safeParse(formToObject(fd));
  if (!parsed.success) return fail("invalid");
  try {
    const r = await setApplicationStatus(actor, parsed.data.id, parsed.data.status, await getClientIp());
    if (!r.ok) return fail(r.reason);
  } catch (e) {
    if (e instanceof ForbiddenError) return { message: "messages.forbidden" };
    throw e;
  }
  refresh();
  return { ok: true, message: "messages.crewStatusSaved" };
}

export async function applyCrewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await getCurrentUser();
  assertCan(user, "crewApplication:create");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = crewApplicationSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const r = await applyToJob(user, parsed.data, await getClientIp());
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.crewApplied" };
}

export async function withdrawCrewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await getCurrentUser();
  assertCan(user, "crewApplication:create");
  const jid = id.safeParse(fd.get("jobId"));
  if (!jid.success) return fail("notFound");
  const r = await withdrawApplication(user, jid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.crewWithdrawn" };
}
