"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { ForbiddenError, assertCan } from "@/lib/permissions";
import { cancelInvite, createTeam, disbandTeam, inviteMember, leaveTeam, removeMember, respondToInvite, transferCaptain, updateTeam } from "@/lib/teams/service";
import { teamSchema } from "@/lib/validation/teams";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  nameTaken: "messages.teamNameTaken",
  tooManyTeams: "messages.teamTooMany",
  userNotFound: "messages.teamUserNotFound",
  alreadyMember: "messages.teamAlreadyMember",
  alreadyInvited: "messages.teamAlreadyInvited",
  teamFull: "messages.teamFull",
  captainCannotLeave: "messages.teamCaptainCannotLeave",
  isCaptain: "messages.teamIsCaptain",
  notMember: "messages.teamNotMember",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");
const forbidden = (): ActionState => ({ message: "messages.forbidden" });

/** Wraps a service call: a refusal for somebody who may not do it becomes a friendly message instead of an error page. */
async function guarded<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

export async function createTeamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = teamSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const r = await createTeam(actor, parsed.data, await getClientIp());
  if (!r.ok) return fail(r.reason, values);
  refresh();
  redirect({ href: `/lag/${r.id}`, locale: await getLocale() });
  return {};
}

export async function updateTeamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const tid = id.safeParse(raw.id);
  const parsed = teamSchema.safeParse(raw);
  if (!tid.success) return fail("notFound", values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const r = await guarded(() => updateTeam(actor, tid.data, parsed.data, ip));
  if (r === null) return forbidden();
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.teamSaved", values };
}

export async function disbandTeamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const tid = id.safeParse(fd.get("id"));
  if (!tid.success) return fail("notFound");
  const ip = await getClientIp();
  const r = await guarded(() => disbandTeam(actor, tid.data, ip));
  if (r === null) return forbidden();
  if (!r.ok) return fail(r.reason);
  refresh();
  redirect({ href: "/lag", locale: await getLocale() });
  return {};
}

export async function inviteMemberAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const tid = id.safeParse(raw.teamId);
  const nick = z.string().trim().min(1, "validation.required").max(30, "validation.tooLong").safeParse(raw.nickname);
  if (!tid.success) return fail("notFound", values);
  if (!nick.success) return { errors: { nickname: nick.error.issues[0]!.message }, values };
  const ip = await getClientIp();
  const r = await guarded(() => inviteMember(actor, tid.data, nick.data, ip));
  if (r === null) return forbidden();
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.teamInvited" };
}

export async function cancelInviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const iid = id.safeParse(fd.get("id"));
  if (!iid.success) return fail("notFound");
  const ip = await getClientIp();
  const r = await guarded(() => cancelInvite(actor, iid.data, ip));
  if (r === null) return forbidden();
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.teamInviteCancelled" };
}

const answerSchema = z.object({ id, answer: z.enum(["accept", "decline"]) });

export async function respondInviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const parsed = answerSchema.safeParse(formToObject(fd));
  if (!parsed.success) return fail("invalid");
  const r = await respondToInvite(actor, parsed.data.id, parsed.data.answer === "accept", await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: parsed.data.answer === "accept" ? "messages.teamInviteAccepted" : "messages.teamInviteDeclined" };
}

const memberSchema = z.object({ teamId: id, userId: id });

export async function removeMemberAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const p = memberSchema.safeParse(formToObject(fd));
  if (!p.success) return fail("invalid");
  const ip = await getClientIp();
  const r = await guarded(() => removeMember(actor, p.data.teamId, p.data.userId, ip));
  if (r === null) return forbidden();
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.teamMemberRemoved" };
}

export async function leaveTeamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const tid = id.safeParse(fd.get("teamId"));
  if (!tid.success) return fail("notFound");
  const r = await leaveTeam(actor, tid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  redirect({ href: "/lag", locale: await getLocale() });
  return {};
}

export async function transferCaptainAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const p = memberSchema.safeParse(formToObject(fd));
  if (!p.success) return fail("invalid");
  const ip = await getClientIp();
  const r = await guarded(() => transferCaptain(actor, p.data.teamId, p.data.userId, ip));
  if (r === null) return forbidden();
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.teamCaptainChanged" };
}

