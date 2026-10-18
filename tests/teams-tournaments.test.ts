import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { anonymizeUser, exportUserData } from "@/lib/gdpr";
import { ForbiddenError, UnauthenticatedError } from "@/lib/permissions";
import { cancelInvite, createTeam, disbandTeam, getTeam, inviteMember, leaveTeam, listTeams, myInvites, myTeams, removeMember, respondToInvite, transferCaptain, updateTeam } from "@/lib/teams/service";
import {
  createTournament, deleteTournament, getTournamentForViewer, listPublicTournaments, registerTeam, registrationState, rosterBounds, updateRoster, updateTournament, withdrawRegistration,
} from "@/lib/tournaments/service";
import { inviteSchema, teamNameKey, teamSchema, tournamentSchema } from "@/lib/validation/teams";
import { asActor, makeEvent, makeUser, resetDb, TEST_PASSWORD } from "./helpers";

beforeEach(resetDb);

const NOW = new Date("2026-11-01T12:00:00Z");
const team = (over: Record<string, string> = {}) => teamSchema.parse({ name: "Kabelkungarna", ...over });
const tourney = (over: Record<string, string> = {}) =>
  tournamentSchema.parse({ name: "CS-turnering", game: "Counter-Strike 2", teamSize: "2", maxSubstitutes: "1", registrationClosesAt: "2026-12-10T12:00", status: "PUBLISHED", ...over });

async function person(opts: Parameters<typeof makeUser>[0] = {}) {
  const u = await makeUser(opts);
  return { u, a: asActor(u) };
}
const leader = async () => (await person({ tags: ["FESTIVALLEDARE"] })).a;

/** A captain with a team of `n` members in total. */
async function squad(n: number, name = "Lag") {
  const cap = await person();
  const t = await createTeam(cap.a, team({ name }));
  if (!t.ok) throw new Error("team");
  const members = [cap];
  for (let i = 1; i < n; i++) {
    const m = await person();
    await db.teamMember.create({ data: { teamId: t.id, userId: m.u.id } });
    members.push(m);
  }
  return { cap, teamId: t.id, members };
}

describe("creating teams", () => {
  it("the creator becomes captain and the first member; teams are not tied to an event", async () => {
    const { u, a } = await person();
    const r = await createTeam(a, team({ name: "  Kabel   kungarna ", tag: "kk" }), "1.2.3.4");
    if (!r.ok) throw new Error();
    const t = await getTeam(r.id);
    expect(t).toMatchObject({ name: "Kabel kungarna", tag: "KK", captainId: u.id });
    expect(t!.members.map((m) => m.user.id)).toEqual([u.id]);
    expect(Object.keys(t!)).not.toContain("eventId");
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "team.create" } }))).toMatchObject({ actorId: u.id, ip: "1.2.3.4" });
  });

  it("names are unique ignoring case and spaces; one captain may lead at most five teams", async () => {
    const a = (await person()).a;
    const b = (await person()).a;
    expect((await createTeam(a, team({ name: "Alfa" }))).ok).toBe(true);
    expect(await createTeam(b, team({ name: "  ALFA " }))).toEqual({ ok: false, reason: "nameTaken" });
    expect(teamNameKey(" Älg   Lag ")).toBe("älg lag");
    for (let i = 0; i < 4; i++) expect((await createTeam(a, team({ name: `Lag ${i}` }))).ok).toBe(true);
    expect(await createTeam(a, team({ name: "Sjätte" }))).toEqual({ ok: false, reason: "tooManyTeams" });
  });

  it("needs a verified account", async () => {
    const unverified = asActor(await makeUser({ verified: false }));
    await expect(createTeam(unverified, team())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTeam(null as never, team())).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("validates the name, tag and description", () => {
    expect(teamSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(teamSchema.safeParse({ name: "x".repeat(41) }).success).toBe(false);
    expect(teamSchema.safeParse({ name: "Lag <script>" }).success).toBe(false);
    expect(teamSchema.safeParse({ name: "Bra Lag", tag: "TOOLONG" }).success).toBe(false);
    expect(teamSchema.safeParse({ name: "Bra Lag", tag: "a-b" }).success).toBe(false);
    expect(teamSchema.safeParse({ name: "Bra Lag", description: "x".repeat(501) }).success).toBe(false);
    expect(teamSchema.parse({ name: "Åsa & Co".replace("&", "och") })).toMatchObject({ name: "Åsa och Co", tag: "" });
  });
});

describe("editing and disbanding", () => {
  it("only the captain (or a moderator) may edit or disband; the name stays unique", async () => {
    const s = await squad(2, "Ett");
    const other = await createTeam((await person()).a, team({ name: "Två" }));
    if (!other.ok) throw new Error();
    expect((await updateTeam(s.cap.a, s.teamId, team({ name: "Ett 2", tag: "E2", description: "Hej" }))).ok).toBe(true);
    expect(await updateTeam(s.cap.a, s.teamId, team({ name: "två" }))).toEqual({ ok: false, reason: "nameTaken" });
    expect(await updateTeam(s.cap.a, "nope", team())).toEqual({ ok: false, reason: "notFound" });
    await expect(updateTeam(s.members[1]!.a, s.teamId, team())).rejects.toBeInstanceOf(ForbiddenError); // a plain member
    await expect(disbandTeam(s.members[1]!.a, s.teamId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await updateTeam(await leader(), s.teamId, team({ name: "Modererat" }))).ok).toBe(true);
    expect((await disbandTeam(s.cap.a, s.teamId)).ok).toBe(true);
    expect(await disbandTeam(s.cap.a, s.teamId)).toEqual({ ok: false, reason: "notFound" });
    expect(await db.teamMember.count({ where: { teamId: s.teamId } })).toBe(0);
  });

  it("a moderator can disband any team", async () => {
    const s = await squad(3);
    expect((await disbandTeam(await leader(), s.teamId)).ok).toBe(true);
    expect(await db.team.count()).toBe(0);
  });
});

describe("invitations", () => {
  it("the captain invites by nickname; the invited user accepts or declines", async () => {
    const s = await squad(1);
    const bo = await person({ nickname: "Bosse" });
    expect(await inviteMember(s.cap.a, s.teamId, "  bOSSE ")).toEqual({ ok: true }); // case-insensitive
    expect((await myInvites(bo.u.id)).map((i) => i.team.name)).toEqual(["Lag"]);
    expect(await inviteMember(s.cap.a, s.teamId, "Bosse")).toEqual({ ok: false, reason: "alreadyInvited" });
    const invite = (await myInvites(bo.u.id))[0]!;
    const stranger = (await person()).a;
    expect(await respondToInvite(stranger, invite.id, true)).toEqual({ ok: false, reason: "notFound" }); // not theirs
    expect(await respondToInvite(bo.a, invite.id, true)).toEqual({ ok: true });
    expect((await getTeam(s.teamId))!.members.map((m) => m.user.nickname)).toContain("Bosse");
    expect(await db.teamInvite.count()).toBe(0);
    expect(await inviteMember(s.cap.a, s.teamId, "Bosse")).toEqual({ ok: false, reason: "alreadyMember" });
    expect((await myTeams(bo.u.id)).map((t) => t.name)).toEqual(["Lag"]);

    const cy = await person({ nickname: "Cyrano" });
    await inviteMember(s.cap.a, s.teamId, "Cyrano");
    expect(await respondToInvite(cy.a, (await myInvites(cy.u.id))[0]!.id, false)).toEqual({ ok: true });
    expect(await db.teamMember.count({ where: { userId: cy.u.id } })).toBe(0);
  });

  it("only the captain invites; unknown, unverified and anonymised users can't be invited; the captain can cancel", async () => {
    const s = await squad(2);
    await person({ nickname: "Dolf", verified: false });
    await expect(inviteMember(s.members[1]!.a, s.teamId, "Nån")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await inviteMember(s.cap.a, s.teamId, "Finnsinte")).toEqual({ ok: false, reason: "userNotFound" });
    expect(await inviteMember(s.cap.a, s.teamId, "Dolf")).toEqual({ ok: false, reason: "userNotFound" }); // unverified
    expect(await inviteMember(s.cap.a, "nope", "x")).toEqual({ ok: false, reason: "notFound" });
    const eva = await person({ nickname: "Eva" });
    await inviteMember(s.cap.a, s.teamId, "Eva");
    const inv = (await myInvites(eva.u.id))[0]!;
    await expect(cancelInvite(s.members[1]!.a, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await cancelInvite(s.cap.a, inv.id)).ok).toBe(true);
    expect(await cancelInvite(s.cap.a, inv.id)).toEqual({ ok: false, reason: "notFound" });
  });

  it("a team holds at most 20 people, counting open invitations", async () => {
    const s = await squad(1);
    for (let i = 0; i < 19; i++) {
      const m = await person({ nickname: `spelare${i}` });
      expect(await inviteMember(s.cap.a, s.teamId, `spelare${i}`)).toEqual({ ok: true });
      void m;
    }
    await person({ nickname: "tjugoett" });
    expect(await inviteMember(s.cap.a, s.teamId, "tjugoett")).toEqual({ ok: false, reason: "teamFull" });
  });
});

describe("members leaving, removed, and captaincy", () => {
  it("members can leave; the captain cannot; the captain can remove members but not themselves", async () => {
    const s = await squad(3);
    const [, m1, m2] = s.members;
    expect(await leaveTeam(m1!.a, s.teamId)).toEqual({ ok: true });
    expect(await leaveTeam(m1!.a, s.teamId)).toEqual({ ok: false, reason: "notFound" });
    expect(await leaveTeam(s.cap.a, s.teamId)).toEqual({ ok: false, reason: "captainCannotLeave" });
    expect(await removeMember(s.cap.a, s.teamId, s.cap.u.id)).toEqual({ ok: false, reason: "isCaptain" });
    await expect(removeMember(m2!.a, s.teamId, m1!.u.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await removeMember(s.cap.a, s.teamId, m2!.u.id)).ok).toBe(true);
    expect(await removeMember(s.cap.a, s.teamId, m2!.u.id)).toEqual({ ok: false, reason: "notFound" });
    expect((await getTeam(s.teamId))!.members).toHaveLength(1);
  });

  it("the captaincy can be handed to a member, and only to a member", async () => {
    const s = await squad(2);
    const outsider = await person();
    expect(await transferCaptain(s.cap.a, s.teamId, outsider.u.id)).toEqual({ ok: false, reason: "notMember" });
    await expect(transferCaptain(s.members[1]!.a, s.teamId, s.members[1]!.u.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await transferCaptain(s.cap.a, s.teamId, s.members[1]!.u.id)).toEqual({ ok: true });
    expect((await getTeam(s.teamId))!.captainId).toBe(s.members[1]!.u.id);
    expect(await leaveTeam(s.cap.a, s.teamId)).toEqual({ ok: true }); // no longer captain
  });

  it("the directory shows teams with sizes and nicknames only", async () => {
    await squad(2, "Alfa");
    await squad(3, "Beta");
    const all = await listTeams();
    expect(all.map((t) => [t.name, t._count.members])).toEqual([["Alfa", 2], ["Beta", 3]]);
    expect(JSON.stringify(all)).not.toContain("@example.test"); // no e-mail addresses
    expect((await listTeams({ q: "bet" })).map((t) => t.name)).toEqual(["Beta"]);
  });
});

describe("tournaments", () => {
  it("only Festivalledare and Admin manage; slugs are unique; status and event are checked", async () => {
    const fl = await leader();
    const ev = await makeEvent(fl.id);
    const r = await createTournament(fl, tourney({ eventId: ev.id }));
    if (!r.ok) throw new Error();
    expect(r.slug).toBe("cs-turnering");
    expect((await createTournament(asActor(await makeUser({ tags: ["ADMIN"] })), tourney())) ).toMatchObject({ ok: true, slug: "cs-turnering-2" });
    for (const tags of [["ANSVARIG"], []] as const) await expect(createTournament(asActor(await makeUser({ tags: [...tags] })), tourney())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await createTournament(fl, tourney({ eventId: "no-such-event" }))).toEqual({ ok: false, reason: "badEvent" });
    expect((await updateTournament(fl, r.id, tourney({ name: "Nytt namn", teamSize: "2" }))).ok).toBe(true);
    expect(await updateTournament(fl, "nope", tourney())).toEqual({ ok: false, reason: "notFound" });
    expect((await deleteTournament(fl, r.id)).ok).toBe(true);
    expect(await deleteTournament(fl, r.id)).toEqual({ ok: false, reason: "notFound" });
  });

  it("drafts are staff-only; published and cancelled ones are public", async () => {
    const fl = await leader();
    const pub = await createTournament(fl, tourney({ name: "Publik" }));
    const draft = await createTournament(fl, tourney({ name: "Utkast", status: "DRAFT" }));
    const cancelled = await createTournament(fl, tourney({ name: "Inställd", status: "CANCELLED" }));
    if (!pub.ok || !draft.ok || !cancelled.ok) throw new Error();
    expect((await listPublicTournaments()).map((t) => t.name).sort()).toEqual(["Inställd", "Publik"]);
    const member = asActor(await makeUser());
    expect(await getTournamentForViewer(null, draft.slug)).toBeNull();
    expect(await getTournamentForViewer(member, draft.slug)).toBeNull();
    expect((await getTournamentForViewer(fl, draft.slug))?.name).toBe("Utkast");
    expect((await getTournamentForViewer(null, pub.slug))?.name).toBe("Publik");
  });

  it("validates the form", () => {
    expect(tournamentSchema.safeParse({ name: "x", game: "y", teamSize: "0", registrationClosesAt: "2026-12-01T12:00", status: "PUBLISHED" }).success).toBe(false);
    expect(tournamentSchema.safeParse({ name: "x", game: "y", teamSize: "5", maxSubstitutes: "11", registrationClosesAt: "2026-12-01T12:00", status: "PUBLISHED" }).success).toBe(false);
    expect(tournamentSchema.safeParse({ name: "x", game: "y", teamSize: "5", maxTeams: "1", registrationClosesAt: "2026-12-01T12:00", status: "PUBLISHED" }).success).toBe(false);
    expect(tournamentSchema.safeParse({ name: "x", game: "y", teamSize: "5", registrationClosesAt: "2026-12-10T12:00", startsAt: "2026-12-05T12:00", status: "PUBLISHED" }).success).toBe(false); // closes after it starts
    expect(tournamentSchema.safeParse({ name: "x", game: "y", teamSize: "5", registrationClosesAt: "2026-12-01T12:00", status: "OPEN" }).success).toBe(false);
    const ok = tournamentSchema.parse({ name: "x", game: "y", teamSize: "5", registrationClosesAt: "2026-12-01T12:00", status: "DRAFT" });
    expect(ok).toMatchObject({ teamSize: 5, maxSubstitutes: 1, maxTeams: null, eventId: null });
    expect(ok.startsAt).toBeUndefined();
    expect(inviteSchema.safeParse({ teamId: "t", nickname: "" }).success).toBe(false);
  });

  it("knows when registration is open, full, closed or cancelled", () => {
    const base = { status: "PUBLISHED" as const, registrationClosesAt: new Date("2026-12-10T11:00:00Z"), maxTeams: 2 };
    expect(registrationState(base, 0, NOW)).toBe("open");
    expect(registrationState(base, 2, NOW)).toBe("full");
    expect(registrationState({ ...base, maxTeams: null }, 99, NOW)).toBe("open");
    expect(registrationState(base, 0, new Date("2026-12-10T11:00:00Z"))).toBe("closed");
    expect(registrationState({ ...base, status: "CANCELLED" }, 0, NOW)).toBe("cancelled");
    expect(registrationState({ ...base, status: "DRAFT" }, 0, NOW)).toBe("draft");
    expect(rosterBounds({ teamSize: 5, maxSubstitutes: 2 })).toEqual({ min: 5, max: 7 });
  });
});

describe("entering a team in a tournament", () => {
  async function setup(over: Record<string, string> = {}, members = 4) {
    const fl = await leader();
    const t = await createTournament(fl, tourney(over));
    if (!t.ok) throw new Error();
    const s = await squad(members);
    return { fl, t, s, ids: (n: number) => s.members.slice(0, n).map((m) => m.u.id) };
  }

  it("the captain registers the team with a roster of the right size", async () => {
    const { t, s, ids } = await setup();
    const r = await registerTeam(s.cap.a, t.id, s.teamId, ids(2), "5.5.5.5", NOW);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const reg = await db.tournamentRegistration.findUniqueOrThrow({ where: { id: r.id }, include: { roster: true } });
    expect(reg).toMatchObject({ tournamentId: t.id, teamId: s.teamId, registeredById: s.cap.u.id });
    expect(reg.roster.map((p) => p.userId).sort()).toEqual(ids(2).sort());
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "tournament.register" } })).toMatchObject({ actorId: s.cap.u.id, ip: "5.5.5.5" });
  });

  it("refuses non-captains, unknown things, double entries and drafts", async () => {
    const { fl, t, s, ids } = await setup();
    expect(await registerTeam(s.members[1]!.a, t.id, s.teamId, ids(2), null, NOW)).toEqual({ ok: false, reason: "notCaptain" });
    expect(await registerTeam((await person()).a, t.id, s.teamId, ids(2), null, NOW)).toEqual({ ok: false, reason: "notCaptain" });
    expect(await registerTeam(s.cap.a, "nope", s.teamId, ids(2), null, NOW)).toEqual({ ok: false, reason: "notFound" });
    expect(await registerTeam(s.cap.a, t.id, "nope", ids(2), null, NOW)).toEqual({ ok: false, reason: "notFound" });
    expect((await registerTeam(s.cap.a, t.id, s.teamId, ids(2), null, NOW)).ok).toBe(true);
    expect(await registerTeam(s.cap.a, t.id, s.teamId, ids(2), null, NOW)).toEqual({ ok: false, reason: "alreadyRegistered" });
    const draft = await createTournament(fl, tourney({ name: "Utkast", status: "DRAFT" }));
    if (!draft.ok) throw new Error();
    expect(await registerTeam(s.cap.a, draft.id, s.teamId, ids(2), null, NOW)).toEqual({ ok: false, reason: "notFound" });
    await expect(registerTeam(asActor(await makeUser({ verified: false })), t.id, s.teamId, ids(2), null, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("checks the roster: size, membership and one team per player", async () => {
    const { t, s, ids } = await setup({}, 5);
    expect(await registerTeam(s.cap.a, t.id, s.teamId, ids(1), null, NOW)).toMatchObject({ ok: false, reason: "rosterSize" }); // needs 2
    expect(await registerTeam(s.cap.a, t.id, s.teamId, ids(4), null, NOW)).toMatchObject({ ok: false, reason: "rosterSize" }); // 2 + 1 substitute at most
    expect(await registerTeam(s.cap.a, t.id, s.teamId, [s.cap.u.id, s.cap.u.id], null, NOW)).toMatchObject({ ok: false, reason: "rosterSize" }); // duplicates count once
    const stranger = await person();
    expect(await registerTeam(s.cap.a, t.id, s.teamId, [s.cap.u.id, stranger.u.id], null, NOW)).toEqual({ ok: false, reason: "notMember" });
    expect((await registerTeam(s.cap.a, t.id, s.teamId, ids(3), null, NOW)).ok).toBe(true); // 2 players + 1 substitute

    // a person who is on another registered team's roster can't be picked again
    const other = await createTeam(stranger.a, team({ name: "Andra" }));
    if (!other.ok) throw new Error();
    await db.teamMember.create({ data: { teamId: other.id, userId: s.members[1]!.u.id } }); // also plays for the first team
    const r = await registerTeam(stranger.a, t.id, other.id, [stranger.u.id, s.members[1]!.u.id], null, NOW);
    expect(r).toMatchObject({ ok: false, reason: "playerTaken", detail: s.members[1]!.u.nickname });
  });

  it("respects the team limit, the deadline and cancellation", async () => {
    const { fl, t, s, ids } = await setup({ maxTeams: "2" });
    const s2 = await squad(2, "Lag två");
    const s3 = await squad(2, "Lag tre");
    expect((await registerTeam(s.cap.a, t.id, s.teamId, ids(2), null, NOW)).ok).toBe(true);
    expect((await registerTeam(s2.cap.a, t.id, s2.teamId, s2.members.map((m) => m.u.id), null, NOW)).ok).toBe(true);
    expect(await registerTeam(s3.cap.a, t.id, s3.teamId, s3.members.map((m) => m.u.id), null, NOW)).toEqual({ ok: false, reason: "full" });
    const late = new Date("2026-12-10T12:00:01Z");
    const open = await createTournament(fl, tourney({ name: "Sen" }));
    if (!open.ok) throw new Error();
    expect(await registerTeam(s.cap.a, open.id, s.teamId, ids(2), null, late)).toEqual({ ok: false, reason: "closed" });
    await updateTournament(fl, open.id, tourney({ name: "Sen", status: "CANCELLED" }));
    expect(await registerTeam(s.cap.a, open.id, s.teamId, ids(2), null, NOW)).toEqual({ ok: false, reason: "cancelled" });
  });

  it("never oversells the last spot when two captains register at once", async () => {
    const { t, s, ids } = await setup({ maxTeams: "2" });
    const teams = [s, await squad(2, "Lag B"), await squad(2, "Lag C"), await squad(2, "Lag D")];
    const results = await Promise.all(teams.map((x, i) => registerTeam(x.cap.a, t.id, x.teamId, i === 0 ? ids(2) : x.members.map((m) => m.u.id), null, NOW)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await db.tournamentRegistration.count({ where: { tournamentId: t.id } })).toBe(2);
  });

  it("the captain can change the roster and withdraw until the deadline; a moderator any time", async () => {
    const { fl, t, s, ids } = await setup();
    const r = await registerTeam(s.cap.a, t.id, s.teamId, ids(2), null, NOW);
    if (!r.ok) throw new Error();
    expect((await updateRoster(s.cap.a, r.id, [s.members[2]!.u.id, s.members[3]!.u.id], null, NOW)).ok).toBe(true);
    expect((await db.tournamentPlayer.findMany({ where: { registrationId: r.id } })).map((p) => p.userId).sort()).toEqual([s.members[2]!.u.id, s.members[3]!.u.id].sort());
    expect(await updateRoster(s.cap.a, r.id, [s.members[2]!.u.id], null, NOW)).toMatchObject({ ok: false, reason: "rosterSize" });
    expect(await updateRoster(s.members[1]!.a, r.id, ids(2), null, NOW)).toEqual({ ok: false, reason: "notCaptain" });
    const late = new Date("2026-12-11T00:00:00Z");
    expect(await updateRoster(s.cap.a, r.id, ids(2), null, late)).toEqual({ ok: false, reason: "closed" });
    expect(await withdrawRegistration(s.cap.a, r.id, null, late)).toEqual({ ok: false, reason: "closed" });
    expect(await withdrawRegistration(s.members[1]!.a, r.id, null, NOW)).toEqual({ ok: false, reason: "notCaptain" });
    expect((await withdrawRegistration(s.cap.a, r.id, null, NOW)).ok).toBe(true);
    expect(await withdrawRegistration(s.cap.a, r.id, null, NOW)).toEqual({ ok: false, reason: "notFound" });
    expect(await db.tournamentPlayer.count()).toBe(0);

    const again = await registerTeam(s.cap.a, t.id, s.teamId, ids(2), null, NOW);
    if (!again.ok) throw new Error();
    expect((await withdrawRegistration(fl, again.id, null, late)).ok).toBe(true); // moderator, after the deadline
  });

  it("the team size can't change once teams are registered; deleting a tournament removes its registrations", async () => {
    const { fl, t, s, ids } = await setup();
    await registerTeam(s.cap.a, t.id, s.teamId, ids(2), null, NOW);
    expect(await updateTournament(fl, t.id, tourney({ teamSize: "3" }))).toEqual({ ok: false, reason: "hasRegistrations" });
    expect((await updateTournament(fl, t.id, tourney({ description: "ny text" }))).ok).toBe(true);
    await deleteTournament(fl, t.id);
    expect(await db.tournamentRegistration.count()).toBe(0);
    expect(await db.tournamentPlayer.count()).toBe(0);
    expect(await db.team.count()).toBe(1); // the team lives on
  });

  it("leaving or being removed takes a player off the roster; disbanding removes the registrations", async () => {
    const { t, s, ids } = await setup({}, 4);
    const r = await registerTeam(s.cap.a, t.id, s.teamId, ids(3), null, NOW);
    if (!r.ok) throw new Error();
    expect(await leaveTeam(s.members[2]!.a, s.teamId)).toEqual({ ok: true });
    expect(await removeMember(s.cap.a, s.teamId, s.members[1]!.u.id)).toEqual({ ok: true });
    expect((await db.tournamentPlayer.findMany({ where: { registrationId: r.id } })).map((p) => p.userId)).toEqual([s.cap.u.id]);
    await disbandTeam(s.cap.a, s.teamId);
    expect(await db.tournamentRegistration.count()).toBe(0);
  });
});

describe("GDPR", () => {
  it("teams are in the export; anonymising hands the captaincy on or removes a team with nobody else", async () => {
    const s = await squad(2, "Med andra");
    const solo = await squad(1, "Ensam");
    const fl = await leader();
    const t = await createTournament(fl, tourney());
    if (!t.ok) throw new Error();
    await registerTeam(s.cap.a, t.id, s.teamId, s.members.map((m) => m.u.id), null, NOW);
    expect(JSON.stringify(await exportUserData(s.cap.u.id))).toContain("Med andra");

    expect(await anonymizeUser(s.cap.u.id, { password: TEST_PASSWORD })).toEqual({ ok: true });
    expect((await getTeam(s.teamId))!.captainId).toBe(s.members[1]!.u.id); // the other member leads now
    expect((await getTeam(s.teamId))!.members.map((m) => m.userId)).toEqual([s.members[1]!.u.id]);
    expect(await db.tournamentPlayer.count({ where: { userId: s.cap.u.id } })).toBe(0);

    expect(await anonymizeUser(solo.cap.u.id, { password: TEST_PASSWORD })).toEqual({ ok: true });
    expect(await db.team.findUnique({ where: { id: solo.teamId } })).toBeNull();
  });
});

