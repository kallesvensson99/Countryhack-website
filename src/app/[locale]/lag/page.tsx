import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { respondInviteAction } from "@/actions/teams";
import { ActionButton } from "@/components/form";
import { TeamForm } from "@/components/team-forms";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/permissions";
import { listTeams, myInvites, myTeams } from "@/lib/teams/service";
import { MAX_TEAMS_PER_CAPTAIN } from "@/lib/validation/teams";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "teams" });
  return { title: t("title"), description: t("lead") };
}

export default async function TeamsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string }> }) {
  const { locale } = await params;
  const { q } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("teams");
  const user = await getCurrentUser();
  const canCreate = can(user, "team:create");
  const [teams, mine, invites] = await Promise.all([listTeams({ q }), user ? myTeams(user.id) : Promise.resolve([]), user ? myInvites(user.id) : Promise.resolve([])]);
  const captained = mine.filter((x) => x.captainId === user?.id).length;

  return (
    <div className="space-y-12">
      <header className="space-y-3">
        <p aria-hidden className="eyebrow text-barn">teams</p>
        <h1 className="disp text-5xl sm:text-6xl">{t("title")}</h1>
        <p className="max-w-2xl text-xl text-slate-700">{t("lead")}</p>
        <p>
          <Link href="/turneringar" className="btn-secondary">{t("toTournaments")}</Link>
        </p>
      </header>

      {invites.length > 0 && (
        <section aria-labelledby="inv-h" className="card-hay space-y-3">
          <h2 id="inv-h" className="disp text-3xl">{t("invitations")}</h2>
          <ul className="space-y-3">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3">
                <span>{t("invitedBy", { team: i.team.name, who: i.invitedBy.nickname })}</span>
                <span className="flex flex-wrap gap-2">
                  <ActionButton action={respondInviteAction} fields={{ id: i.id, answer: "accept" }} label={t("accept")} variant="btn-secondary" />
                  <ActionButton action={respondInviteAction} fields={{ id: i.id, answer: "decline" }} label={t("decline")} variant="btn-secondary" />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {user && mine.length > 0 && (
        <section aria-labelledby="mine-h" className="space-y-4">
          <h2 id="mine-h" className="disp text-3xl">{t("myTeams")}</h2>
          <ul className="grid gap-6 sm:grid-cols-2">
            {mine.map((x) => (
              <li key={x.id} className="card !p-5">
                <p className="text-xl font-extrabold leading-tight">
                  <Link href={`/lag/${x.id}`} className="no-underline hover:underline">{x.name}</Link> {x.tag && <span className="font-mono text-sm text-slate-600">[{x.tag}]</span>}
                </p>
                <p className="font-mono text-xs font-bold text-slate-600">
                  {t("members", { count: x._count.members })} · {x.captainId === user.id ? t("youAreCaptain") : t("youAreMember")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="new-h" className="card space-y-4">
        <h2 id="new-h" className="disp text-3xl">{t("createTitle")}</h2>
        {!user ? (
          <p>
            {t("loginToCreate")} <Link href="/login" className="link font-bold">{t("login")}</Link>
          </p>
        ) : !canCreate ? (
          <p role="note">{t("verifyToCreate")}</p>
        ) : captained >= MAX_TEAMS_PER_CAPTAIN ? (
          <p role="note">{t("tooManyTeams", { count: MAX_TEAMS_PER_CAPTAIN })}</p>
        ) : (
          <>
            <p className="text-slate-700">{t("createLead")}</p>
            <TeamForm />
          </>
        )}
      </section>

      <section aria-labelledby="all-h" className="space-y-4">
        <h2 id="all-h" className="disp text-3xl">{t("allTeams")}</h2>
        <form method="get" role="search" className="flex flex-wrap gap-2">
          <label htmlFor="team-q" className="sr-only">{t("search")}</label>
          <input id="team-q" name="q" defaultValue={q} placeholder={t("search")} className="input mt-0 max-w-sm" />
          <button type="submit" className="btn-secondary">{t("searchButton")}</button>
        </form>
        {teams.length === 0 ? (
          <p className="text-slate-600">{t("none")}</p>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((x) => (
              <li key={x.id} className="card !p-5">
                <p className="text-xl font-extrabold leading-tight">
                  <Link href={`/lag/${x.id}`} className="no-underline hover:underline">{x.name}</Link> {x.tag && <span className="font-mono text-sm text-slate-600">[{x.tag}]</span>}
                </p>
                <p className="font-mono text-xs font-bold text-slate-600">
                  {t("members", { count: x._count.members })} · {t("captain")}: {x.captain.nickname}
                </p>
                {x.description && <p className="mt-2 line-clamp-2 text-sm text-slate-700">{x.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
