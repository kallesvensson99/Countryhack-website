import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cancelInviteAction, disbandTeamAction, leaveTeamAction, removeMemberAction, transferCaptainAction } from "@/actions/teams";
import { ActionButton } from "@/components/form";
import { InviteForm, TeamForm } from "@/components/team-forms";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/permissions";
import { getTeam } from "@/lib/teams/service";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const team = await getTeam(id);
  return team ? { title: team.name } : {};
}

export default async function TeamPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const team = await getTeam(id);
  if (!team) notFound();
  const t = await getTranslations("teams");
  const user = await getCurrentUser();
  const isCaptain = user?.id === team.captainId;
  const isMember = !!user && team.members.some((m) => m.userId === user.id);
  const canManage = isCaptain || can(user, "team:moderate");

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <Link href="/lag" className="link text-sm">{t("backToTeams")}</Link>
      <header className="space-y-3">
        <p aria-hidden className="eyebrow text-barn">{t("teamEyebrow")}</p>
        <h1 className="disp break-words text-5xl sm:text-6xl">
          {team.name} {team.tag && <span className="font-mono text-2xl text-slate-600">[{team.tag}]</span>}
        </h1>
        {team.description && <p className="whitespace-pre-line text-lg text-slate-700">{team.description}</p>}
        <p className="font-mono text-sm font-bold text-slate-600">{t("captain")}: {team.captain.nickname}</p>
      </header>

      <section aria-labelledby="members-h" className="space-y-4">
        <h2 id="members-h" className="disp text-3xl">{t("membersTitle", { count: team.members.length })}</h2>
        <ul className="space-y-3">
          {team.members.map((m) => (
            <li key={m.userId} className="card flex flex-wrap items-center justify-between gap-3 !p-4">
              <p className="font-extrabold">
                {m.user.nickname} {m.userId === team.captainId && <span className="tag-hay ml-2">{t("captain")}</span>}
              </p>
              {canManage && m.userId !== team.captainId && (
                <span className="flex flex-wrap gap-2">
                  <ActionButton action={transferCaptainAction} fields={{ teamId: team.id, userId: m.userId }} label={t("makeCaptain")} variant="btn-secondary" confirm={t("makeCaptainConfirm", { name: m.user.nickname })} />
                  <ActionButton action={removeMemberAction} fields={{ teamId: team.id, userId: m.userId }} label={t("removeMember")} variant="btn-secondary" confirm={t("removeMemberConfirm", { name: m.user.nickname })} />
                </span>
              )}
            </li>
          ))}
        </ul>
        {isMember && !isCaptain && (
          <ActionButton action={leaveTeamAction} fields={{ teamId: team.id }} label={t("leave")} variant="btn-secondary" confirm={t("leaveConfirm")} />
        )}
        {isCaptain && <p className="text-sm text-slate-600">{t("captainCannotLeave")}</p>}
      </section>

      {team.registrations.length > 0 && (
        <section aria-labelledby="regs-h" className="space-y-3">
          <h2 id="regs-h" className="disp text-3xl">{t("tournaments")}</h2>
          <ul className="space-y-2">
            {team.registrations.map((r) => (
              <li key={r.id}>
                <Link href={`/turneringar/${r.tournament.slug}`} className="link text-lg font-bold">{r.tournament.name}</Link>
                <span className="text-slate-600"> · {r.tournament.game} · {t("players", { count: r.roster.length })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canManage && (
        <>
          <section className="card space-y-4" aria-labelledby="invite-h">
            <h2 id="invite-h" className="disp text-3xl">{t("inviteTitle")}</h2>
            <InviteForm teamId={team.id} />
            {team.invites.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-extrabold">{t("pendingInvites")}</h3>
                <ul className="space-y-2">
                  {team.invites.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-3">
                      <span>{i.user.nickname}</span>
                      <ActionButton action={cancelInviteAction} fields={{ id: i.id }} label={t("cancelInvite")} variant="btn-secondary" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="card space-y-4" aria-labelledby="edit-h">
            <h2 id="edit-h" className="disp text-3xl">{t("editTitle")}</h2>
            <TeamForm defaults={{ id: team.id, name: team.name, tag: team.tag, description: team.description }} />
            <ActionButton action={disbandTeamAction} fields={{ id: team.id }} label={t("disband")} variant="btn-danger" confirm={t("disbandConfirm")} />
          </section>
        </>
      )}
    </div>
  );
}
