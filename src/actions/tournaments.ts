"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { assertCan } from "@/lib/permissions";
import { createTournament, deleteTournament, registerTeam, updateRoster, updateTournament, withdrawRegistration } from "@/lib/tournaments/service";
import { tournamentSchema } from "@/lib/validation/teams";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  badEvent: "messages.tournamentBadEvent",
  hasRegistrations: "messages.tournamentHasRegistrations",
  notCaptain: "messages.tournamentNotCaptain",
  closed: "messages.tournamentClosed",
  full: "messages.tournamentFull",
  cancelled: "messages.tournamentCancelled",
  alreadyRegistered: "messages.tournamentAlreadyRegistered",
  rosterSize: "messages.tournamentRosterSize",
  notMember: "messages.tournamentNotMember",
  playerTaken: "messages.tournamentPlayerTaken",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

/** Create (no `id` field) or update a tournament. Festivalledare and Admin only. */
export async function saveTournamentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "tournament:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = tournamentSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  const r = raw.id ? await updateTournament(actor, raw.id, parsed.data, ip) : await createTournament(actor, parsed.data, ip);
  if (!r.ok) return fail(r.reason, values);
  refresh();
  return { ok: true, message: "messages.tournamentSaved", values: raw.id ? values : undefined };
}

export async function deleteTournamentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "tournament:manage");
  const tid = id.safeParse(fd.get("id"));
  if (!tid.success) return fail("notFound");
  const r = await deleteTournament(actor, tid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.tournamentDeleted" };
}

const players = (fd: FormData) => fd.getAll("player").filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 60);

/** The captain enters a team: the form carries the team and one `player` field per ticked roster member. */
export async function registerTeamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const tournamentId = id.safeParse(fd.get("tournamentId"));
  const teamId = id.safeParse(fd.get("teamId"));
  if (!tournamentId.success || !teamId.success) return fail("notFound");
  const r = await registerTeam(actor, tournamentId.data, teamId.data, players(fd), await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.tournamentRegistered" };
}

export async function updateRosterAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const rid = id.safeParse(fd.get("registrationId"));
  if (!rid.success) return fail("notFound");
  const r = await updateRoster(actor, rid.data, players(fd), await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.tournamentRosterSaved" };
}

/** The captain withdraws the team; a Festivalledare / Admin can remove any registration. */
export async function withdrawRegistrationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "team:create");
  const rid = id.safeParse(fd.get("registrationId"));
  if (!rid.success) return fail("notFound");
  const r = await withdrawRegistration(actor, rid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.tournamentWithdrawn" };
}
