import { Prisma } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { assertCan, can, type Actor } from "../permissions";
import { MAX_TEAM_MEMBERS, MAX_TEAMS_PER_CAPTAIN, teamNameKey, type TeamInput } from "../validation/teams";

type Fail<R extends string> = { ok: false; reason: R };
type Tx = Prisma.TransactionClient;
const TEAM_FIELDS = ["name", "tag", "description", "captainId"] as const;

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** The captain of the team, or a moderator (Festivalledare / Admin). Anyone else is refused. */
function assertCaptainOrModerator(actor: Actor, team: { captainId: string }) {
  if (team.captainId !== actor.id) assertCan(actor, "team:moderate");
}

// ───────────── create / edit / disband ─────────────

/** Whoever creates a team becomes its captain (and its first member). */
export async function createTeam(actor: Actor, input: TeamInput, ip?: string | null): Promise<{ ok: true; id: string } | Fail<"nameTaken" | "tooManyTeams">> {
  assertCan(actor, "team:create");
  if ((await db.team.count({ where: { captainId: actor.id } })) >= MAX_TEAMS_PER_CAPTAIN) return { ok: false, reason: "tooManyTeams" };
  try {
    return await db.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: { name: input.name, nameKey: teamNameKey(input.name), tag: input.tag, description: input.description, captainId: actor.id, members: { create: { userId: actor.id } } },
      });
      await writeAudit(tx, { actorId: actor.id, action: "team.create", entityType: "Team", entityId: team.id, diff: { name: { from: null, to: team.name } }, ip });
      return { ok: true as const, id: team.id };
    });
  } catch (e) {
    if (isUnique(e)) return { ok: false, reason: "nameTaken" };
    throw e;
  }
}

export async function updateTeam(actor: Actor, id: string, input: TeamInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "nameTaken">> {
  try {
    return await db.$transaction(async (tx) => {
      const before = await tx.team.findUnique({ where: { id } });
      if (!before) return { ok: false as const, reason: "notFound" as const };
      assertCaptainOrModerator(actor, before);
      const after = await tx.team.update({ where: { id }, data: { name: input.name, nameKey: teamNameKey(input.name), tag: input.tag, description: input.description } });
      await writeAudit(tx, { actorId: actor.id, action: "team.update", entityType: "Team", entityId: id, diff: diffObjects(before, after, TEAM_FIELDS), ip });
      return { ok: true as const };
    });
  } catch (e) {
    if (isUnique(e)) return { ok: false, reason: "nameTaken" };
    throw e;
  }
}

/** Deletes the team with its invitations and tournament registrations. */
export async function disbandTeam(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  return db.$transaction(async (tx) => {
    const team = await tx.team.findUnique({ where: { id }, include: { _count: { select: { members: true, registrations: true } } } });
    if (!team) return { ok: false as const, reason: "notFound" as const };
    assertCaptainOrModerator(actor, team);
    await tx.team.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "team.disband", entityType: "Team", entityId: id, diff: { name: { from: team.name, to: null }, members: { from: team._count.members, to: 0 }, registrations: { from: team._count.registrations, to: 0 } }, ip });
    return { ok: true as const };
  });
}

// ───────────── members and invitations ─────────────

async function dropRosterSpots(tx: Tx, teamId: string, userId: string) {
  await tx.tournamentPlayer.deleteMany({ where: { userId, registration: { teamId } } });
}

/** The captain invites a user by nickname. The user has to accept before they join. */
export async function inviteMember(actor: Actor, teamId: string, nickname: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "userNotFound" | "alreadyMember" | "alreadyInvited" | "teamFull">> {
  return db.$transaction(async (tx) => {
    const team = await tx.team.findUnique({ where: { id: teamId }, include: { _count: { select: { members: true, invites: true } } } });
    if (!team) return { ok: false as const, reason: "notFound" as const };
    if (team.captainId !== actor.id) assertCan(actor, "team:moderate"); // anyone else is refused; a moderator may help
    if (team._count.members + team._count.invites >= MAX_TEAM_MEMBERS) return { ok: false as const, reason: "teamFull" as const };
    const user = await tx.user.findFirst({ where: { nickname: { equals: nickname.trim(), mode: "insensitive" }, anonymizedAt: null, emailVerifiedAt: { not: null } } });
    if (!user) return { ok: false as const, reason: "userNotFound" as const };
    if (await tx.teamMember.findUnique({ where: { teamId_userId: { teamId, userId: user.id } } })) return { ok: false as const, reason: "alreadyMember" as const };
    if (await tx.teamInvite.findUnique({ where: { teamId_userId: { teamId, userId: user.id } } })) return { ok: false as const, reason: "alreadyInvited" as const };
    const invite = await tx.teamInvite.create({ data: { teamId, userId: user.id, invitedById: actor.id } });
    await writeAudit(tx, { actorId: actor.id, action: "team.invite", entityType: "TeamInvite", entityId: invite.id, diff: { team: { from: null, to: team.name }, invited: { from: null, to: user.id } }, ip });
    return { ok: true as const };
  });
}

export async function cancelInvite(actor: Actor, inviteId: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  return db.$transaction(async (tx) => {
    const invite = await tx.teamInvite.findUnique({ where: { id: inviteId }, include: { team: true } });
    if (!invite) return { ok: false as const, reason: "notFound" as const };
    assertCaptainOrModerator(actor, invite.team);
    await tx.teamInvite.delete({ where: { id: inviteId } });
    await writeAudit(tx, { actorId: actor.id, action: "team.invite.cancel", entityType: "TeamInvite", entityId: inviteId, diff: { team: { from: invite.team.name, to: null } }, ip });
    return { ok: true as const };
  });
}

/** The invited user answers. Only they can; anyone else gets "notFound". */
export async function respondToInvite(user: Actor, inviteId: string, accept: boolean, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "teamFull">> {
  assertCan(user, "team:create"); // a logged-in, verified account
  return db.$transaction(async (tx) => {
    const invite = await tx.teamInvite.findUnique({ where: { id: inviteId }, include: { team: { include: { _count: { select: { members: true } } } } } });
    if (!invite || invite.userId !== user.id) return { ok: false as const, reason: "notFound" as const };
    if (accept) {
      if (invite.team._count.members >= MAX_TEAM_MEMBERS) return { ok: false as const, reason: "teamFull" as const };
      await tx.teamMember.upsert({ where: { teamId_userId: { teamId: invite.teamId, userId: user.id } }, update: {}, create: { teamId: invite.teamId, userId: user.id } });
    }
    await tx.teamInvite.delete({ where: { id: inviteId } });
    await writeAudit(tx, { actorId: user.id, action: accept ? "team.invite.accept" : "team.invite.decline", entityType: "TeamInvite", entityId: inviteId, diff: { team: { from: null, to: invite.team.name } }, ip });
    return { ok: true as const };
  });
}

/** The captain removes a member (not themselves: transfer the captaincy or disband). The member also leaves any roster of the team. */
export async function removeMember(actor: Actor, teamId: string, userId: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "isCaptain">> {
  return db.$transaction(async (tx) => {
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (!team) return { ok: false as const, reason: "notFound" as const };
    assertCaptainOrModerator(actor, team);
    if (userId === team.captainId) return { ok: false as const, reason: "isCaptain" as const };
    const gone = await tx.teamMember.deleteMany({ where: { teamId, userId } });
    if (gone.count === 0) return { ok: false as const, reason: "notFound" as const };
    await dropRosterSpots(tx, teamId, userId);
    await writeAudit(tx, { actorId: actor.id, action: "team.member.remove", entityType: "Team", entityId: teamId, diff: { member: { from: userId, to: null } }, ip });
    return { ok: true as const };
  });
}

export async function leaveTeam(user: Actor, teamId: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "captainCannotLeave">> {
  return db.$transaction(async (tx) => {
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (!team || !(await tx.teamMember.findUnique({ where: { teamId_userId: { teamId, userId: user.id } } }))) return { ok: false as const, reason: "notFound" as const };
    if (team.captainId === user.id) return { ok: false as const, reason: "captainCannotLeave" as const };
    await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId: user.id } } });
    await dropRosterSpots(tx, teamId, user.id);
    await writeAudit(tx, { actorId: user.id, action: "team.member.leave", entityType: "Team", entityId: teamId, diff: { member: { from: user.id, to: null } }, ip });
    return { ok: true as const };
  });
}

/** Hand the captaincy to another member. */
export async function transferCaptain(actor: Actor, teamId: string, newCaptainId: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound" | "notMember">> {
  return db.$transaction(async (tx) => {
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (!team) return { ok: false as const, reason: "notFound" as const };
    assertCaptainOrModerator(actor, team);
    if (!(await tx.teamMember.findUnique({ where: { teamId_userId: { teamId, userId: newCaptainId } } }))) return { ok: false as const, reason: "notMember" as const };
    if (newCaptainId !== team.captainId) {
      await tx.team.update({ where: { id: teamId }, data: { captainId: newCaptainId } });
      await writeAudit(tx, { actorId: actor.id, action: "team.captain.transfer", entityType: "Team", entityId: teamId, diff: { captainId: { from: team.captainId, to: newCaptainId } }, ip });
    }
    return { ok: true as const };
  });
}

// ───────────── reading ─────────────

/** Everyone's view of the teams: names, tags, captain and size. Only nicknames, never real names or e-mail. */
export function listTeams(opts: { q?: string } = {}) {
  const q = opts.q?.trim();
  return db.team.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { tag: { contains: q, mode: "insensitive" } }] } : {},
    orderBy: { name: "asc" },
    include: { captain: { select: { nickname: true } }, _count: { select: { members: true } } },
  });
}

export function getTeam(id: string) {
  return db.team.findUnique({
    where: { id },
    include: {
      captain: { select: { id: true, nickname: true } },
      members: { orderBy: { joinedAt: "asc" }, include: { user: { select: { id: true, nickname: true } } } },
      invites: { orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, nickname: true } } } },
      registrations: { orderBy: { createdAt: "desc" }, include: { tournament: { select: { id: true, slug: true, name: true, game: true, status: true } }, roster: { select: { userId: true } } } },
    },
  });
}

/** Teams the user is a member of (captain first). */
export async function myTeams(userId: string) {
  const rows = await db.team.findMany({ where: { members: { some: { userId } } }, orderBy: { name: "asc" }, include: { _count: { select: { members: true } } } });
  return rows.sort((a, b) => Number(b.captainId === userId) - Number(a.captainId === userId));
}

export function myInvites(userId: string) {
  return db.teamInvite.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, include: { team: { select: { id: true, name: true } }, invitedBy: { select: { nickname: true } } } });
}

export const canModerateTeams = (actor: Actor | null) => can(actor, "team:moderate");
