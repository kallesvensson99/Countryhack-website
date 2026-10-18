import type { Tournament, TournamentStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { slugify } from "../events/service";
import { assertCan, can, type Actor } from "../permissions";
import type { TournamentInput } from "../validation/teams";

type Fail<R extends string> = { ok: false; reason: R };
type Tx = Prisma.TransactionClient;
const T_FIELDS = ["name", "game", "description", "format", "teamSize", "maxSubstitutes", "maxTeams", "registrationClosesAt", "startsAt", "eventId", "status"] as const;

export type RegistrationState = "open" | "closed" | "full" | "cancelled" | "draft";

/** Can teams enter right now? `count` = registered teams. */
export function registrationState(t: Pick<Tournament, "status" | "registrationClosesAt" | "maxTeams">, count: number, now = new Date()): RegistrationState {
  if (t.status === "DRAFT") return "draft";
  if (t.status === "CANCELLED") return "cancelled";
  if (now >= t.registrationClosesAt) return "closed";
  if (t.maxTeams !== null && count >= t.maxTeams) return "full";
  return "open";
}

/** A roster holds the team size plus up to `maxSubstitutes` extra players. */
export const rosterBounds = (t: Pick<Tournament, "teamSize" | "maxSubstitutes">) => ({ min: t.teamSize, max: t.teamSize + t.maxSubstitutes });

// ───────────── managing tournaments (Festivalledare / Admin) ─────────────

async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name).replace(/^event$/, "turnering");
  const taken = new Set((await tx.tournament.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((t) => t.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function createTournament(actor: Actor, input: TournamentInput, ip?: string | null): Promise<{ ok: true; id: string; slug: string } | Fail<"badEvent">> {
  assertCan(actor, "tournament:manage");
  return db.$transaction(async (tx) => {
    if (input.eventId && !(await tx.event.findUnique({ where: { id: input.eventId }, select: { id: true } }))) return { ok: false as const, reason: "badEvent" as const };
    const t = await tx.tournament.create({ data: { ...input, slug: await uniqueSlug(tx, input.name), createdById: actor.id } });
    await writeAudit(tx, { actorId: actor.id, action: "tournament.create", entityType: "Tournament", entityId: t.id, diff: { name: { from: null, to: t.name }, status: { from: null, to: t.status } }, ip });
    return { ok: true as const, id: t.id, slug: t.slug };
  });
}

/** The team size can't change once teams are registered (their rosters were checked against it). */
export async function updateTournament(actor: Actor, id: string, input: TournamentInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "badEvent" | "hasRegistrations">> {
  assertCan(actor, "tournament:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.tournament.findUnique({ where: { id }, include: { _count: { select: { registrations: true } } } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    if (input.eventId && !(await tx.event.findUnique({ where: { id: input.eventId }, select: { id: true } }))) return { ok: false as const, reason: "badEvent" as const };
    if (before._count.registrations > 0 && (input.teamSize !== before.teamSize || input.maxSubstitutes !== before.maxSubstitutes)) return { ok: false as const, reason: "hasRegistrations" as const };
    const after = await tx.tournament.update({ where: { id }, data: input });
    await writeAudit(tx, { actorId: actor.id, action: "tournament.update", entityType: "Tournament", entityId: id, diff: diffObjects(before, after, T_FIELDS), ip });
    return { ok: true as const };
  });
}

export async function deleteTournament(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "tournament:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.tournament.findUnique({ where: { id }, include: { _count: { select: { registrations: true } } } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    await tx.tournament.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "tournament.delete", entityType: "Tournament", entityId: id, diff: { name: { from: before.name, to: null }, registrations: { from: before._count.registrations, to: 0 } }, ip });
    return { ok: true as const };
  });
}

// ───────────── reading ─────────────

/** Published (and cancelled) tournaments that haven't started or have no start time, soonest first. */
export function listPublicTournaments() {
  return db.tournament.findMany({
    where: { status: { in: ["PUBLISHED", "CANCELLED"] } },
    orderBy: [{ startsAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    include: { event: { select: { name: true, slug: true } }, _count: { select: { registrations: true } } },
  });
}

export function listAllTournaments(actor: Actor) {
  assertCan(actor, "tournament:manage");
  return db.tournament.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: { event: { select: { name: true } }, _count: { select: { registrations: true } } },
  });
}

/** A tournament by slug; drafts are visible to staff only. */
export async function getTournamentForViewer(viewer: Actor | null, slug: string) {
  const t = await db.tournament.findUnique({
    where: { slug },
    include: {
      event: { select: { id: true, name: true, slug: true } },
      registrations: {
        orderBy: { createdAt: "asc" },
        include: { team: { select: { id: true, name: true, tag: true, captainId: true } }, roster: { include: { user: { select: { id: true, nickname: true } } } } },
      },
    },
  });
  if (!t) return null;
  if (t.status === "DRAFT" && !can(viewer, "tournament:manage")) return null;
  return t;
}

/** Tournaments played at an event (published only), for the event page. */
export function tournamentsForEvent(eventId: string) {
  return db.tournament.findMany({ where: { eventId, status: "PUBLISHED" }, orderBy: [{ startsAt: { sort: "asc", nulls: "last" } }], include: { _count: { select: { registrations: true } } } });
}

// ───────────── entering teams ─────────────

export type RegisterError = "notFound" | "notCaptain" | "closed" | "full" | "cancelled" | "alreadyRegistered" | "rosterSize" | "notMember" | "playerTaken";
export type RegisterResult = { ok: true; id: string } | { ok: false; reason: RegisterError; detail?: string };

/** Checks a roster against the tournament and the team. Returns an error or the cleaned list of user ids. */
async function checkRoster(tx: Tx, t: Pick<Tournament, "id" | "teamSize" | "maxSubstitutes">, teamId: string, userIds: string[], ignoreRegistrationId?: string): Promise<{ ok: true; ids: string[] } | { ok: false; reason: RegisterError; detail?: string }> {
  const ids = [...new Set(userIds)];
  const { min, max } = rosterBounds(t);
  if (ids.length < min || ids.length > max) return { ok: false, reason: "rosterSize", detail: `${min}-${max}` };
  const members = await tx.teamMember.findMany({ where: { teamId, userId: { in: ids } }, select: { userId: true } });
  if (members.length !== ids.length) return { ok: false, reason: "notMember" };
  const taken = await tx.tournamentPlayer.findFirst({ where: { tournamentId: t.id, userId: { in: ids }, ...(ignoreRegistrationId ? { registrationId: { not: ignoreRegistrationId } } : {}) }, include: { user: { select: { nickname: true } } } });
  if (taken) return { ok: false, reason: "playerTaken", detail: taken.user.nickname };
  return { ok: true, ids };
}

/** The captain enters the team. The captain picks the players: the team size plus up to the allowed substitutes. */
export async function registerTeam(actor: Actor, tournamentId: string, teamId: string, rosterUserIds: string[], ip?: string | null, now = new Date()): Promise<RegisterResult> {
  assertCan(actor, "team:create");
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Tournament" WHERE "id" = ${tournamentId} FOR UPDATE`; // capacity can't be oversold
      const t = await tx.tournament.findUnique({ where: { id: tournamentId }, include: { _count: { select: { registrations: true } } } });
      const team = await tx.team.findUnique({ where: { id: teamId } });
      if (!t || !team) return { ok: false as const, reason: "notFound" as const };
      if (team.captainId !== actor.id) return { ok: false as const, reason: "notCaptain" as const };
      const state = registrationState(t, t._count.registrations, now);
      if (state === "draft") return { ok: false as const, reason: "notFound" as const };
      if (state === "cancelled" || state === "closed" || state === "full") return { ok: false as const, reason: state };
      if (await tx.tournamentRegistration.findUnique({ where: { tournamentId_teamId: { tournamentId, teamId } } })) return { ok: false as const, reason: "alreadyRegistered" as const };
      const roster = await checkRoster(tx, t, teamId, rosterUserIds);
      if (!roster.ok) return roster;
      const reg = await tx.tournamentRegistration.create({
        data: { tournamentId, teamId, registeredById: actor.id, roster: { create: roster.ids.map((userId) => ({ userId, tournamentId })) } },
      });
      await writeAudit(tx, { actorId: actor.id, action: "tournament.register", entityType: "TournamentRegistration", entityId: reg.id, diff: { tournament: { from: null, to: t.name }, team: { from: null, to: team.name }, players: { from: null, to: roster.ids.length } }, ip });
      return { ok: true as const, id: reg.id };
    });
  } catch (e) {
    // the unique indexes are the backstop for two requests racing
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "alreadyRegistered" };
    throw e;
  }
}

/** Change the roster while registration is open. */
export async function updateRoster(actor: Actor, registrationId: string, rosterUserIds: string[], ip?: string | null, now = new Date()): Promise<RegisterResult> {
  assertCan(actor, "team:create");
  try {
    return await db.$transaction(async (tx) => {
      const reg = await tx.tournamentRegistration.findUnique({ where: { id: registrationId }, include: { team: true, tournament: { include: { _count: { select: { registrations: true } } } } } });
      if (!reg) return { ok: false as const, reason: "notFound" as const };
      if (reg.team.captainId !== actor.id) return { ok: false as const, reason: "notCaptain" as const };
      const state = registrationState(reg.tournament, 0, now); // already in: capacity is irrelevant
      if (state === "cancelled" || state === "closed") return { ok: false as const, reason: state };
      const roster = await checkRoster(tx, reg.tournament, reg.teamId, rosterUserIds, reg.id);
      if (!roster.ok) return roster;
      await tx.tournamentPlayer.deleteMany({ where: { registrationId } });
      await tx.tournamentPlayer.createMany({ data: roster.ids.map((userId) => ({ registrationId, tournamentId: reg.tournamentId, userId })) });
      await writeAudit(tx, { actorId: actor.id, action: "tournament.roster", entityType: "TournamentRegistration", entityId: registrationId, diff: { players: { from: null, to: roster.ids.length } }, ip });
      return { ok: true as const, id: registrationId };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "playerTaken" };
    throw e;
  }
}

/** The captain withdraws the team while registration is open; a moderator can remove any registration at any time. */
export async function withdrawRegistration(actor: Actor, registrationId: string, ip?: string | null, now = new Date()): Promise<{ ok: true } | Fail<"notFound" | "notCaptain" | "closed">> {
  return db.$transaction(async (tx) => {
    const reg = await tx.tournamentRegistration.findUnique({ where: { id: registrationId }, include: { team: true, tournament: true } });
    if (!reg) return { ok: false as const, reason: "notFound" as const };
    const moderator = can(actor, "team:moderate");
    if (reg.team.captainId !== actor.id && !moderator) return { ok: false as const, reason: "notCaptain" as const };
    if (!moderator && (now >= reg.tournament.registrationClosesAt || reg.tournament.status === "CANCELLED")) return { ok: false as const, reason: "closed" as const };
    await tx.tournamentRegistration.delete({ where: { id: registrationId } });
    await writeAudit(tx, { actorId: actor.id, action: "tournament.withdraw", entityType: "TournamentRegistration", entityId: registrationId, diff: { team: { from: reg.team.name, to: null }, tournament: { from: reg.tournament.name, to: null } }, ip });
    return { ok: true as const };
  });
}

export type { TournamentStatus };
