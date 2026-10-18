import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { withdrawRegistrationAction } from "@/actions/tournaments";
import { ActionButton } from "@/components/form";
import { RegisterTeamForm, RosterForm } from "@/components/tournament-forms";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/permissions";
import { db } from "@/lib/db";
import { getTournamentForViewer, registrationState, rosterBounds } from "@/lib/tournaments/service";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const x = await getTournamentForViewer(await getCurrentUser(), slug);
  return x ? { title: x.name, description: x.description.slice(0, 160) || x.game } : {};
}

export default async function TournamentPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const user = await getCurrentUser();
  const x = await getTournamentForViewer(user, slug);
  if (!x) notFound();
  const t = await getTranslations("tournaments");
  const f = await getFormatter();
  const now = new Date();
  const state = registrationState(x, x.registrations.length, now);
  const { min, max } = rosterBounds(x);
  const isModerator = can(user, "team:moderate");

  // The viewer's own teams, for the registration panel: teams they captain (with members) that are not entered yet.
  const captained = user
    ? await db.team.findMany({ where: { captainId: user.id }, orderBy: { name: "asc" }, include: { members: { orderBy: { joinedAt: "asc" }, include: { user: { select: { id: true, nickname: true } } } } } })
    : [];
  const enteredIds = new Set(x.registrations.map((r) => r.teamId));
  const free = captained.filter((tm) => !enteredIds.has(tm.id) && tm.members.length >= min);
  const tooSmall = captained.filter((tm) => !enteredIds.has(tm.id) && tm.members.length < min);
  const mine = x.registrations.filter((r) => r.team.captainId === user?.id);
  const verified = can(user, "team:create");

  return (
    <article className="mx-auto max-w-4xl space-y-10">
      <Link href="/turneringar" className="link text-sm">{t("back")}</Link>
      {x.status === "DRAFT" && <p role="note" className="card-hay !p-3 font-bold">{t("draftNote")}</p>}
      {x.status === "CANCELLED" && <p role="note" className="card-hay !p-3 font-bold">{t("cancelledNote")}</p>}

      <header className="space-y-3">
        <p className="font-mono text-sm font-bold text-barn">{x.game}</p>
        <h1 className="disp break-words text-5xl sm:text-6xl">{x.name}</h1>
        {x.description && <p className="whitespace-pre-line text-lg text-slate-700">{x.description}</p>}
        {can(user, "tournament:manage") && (
          <p>
            <Link href="/manage/tournaments" className="btn-secondary">{t("manage")}</Link>
          </p>
        )}
      </header>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [t("format"), x.format || "–"],
          [t("teamSize"), t("teamSizeValue", { size: x.teamSize })],
          [t("rosterSize"), min === max ? String(min) : `${min}–${max}`],
          [t("teams"), x.maxTeams === null ? String(x.registrations.length) : `${x.registrations.length} / ${x.maxTeams}`],
          [t("registrationCloses"), f.dateTime(x.registrationClosesAt, { dateStyle: "medium", timeStyle: "short" })],
          [t("startsAt"), x.startsAt ? f.dateTime(x.startsAt, { dateStyle: "medium", timeStyle: "short" }) : "–"],
          [t("event"), x.event?.name ?? "–"],
          [t("status"), t(`state_${state}`)],
        ].map(([k, v]) => (
          <div key={k} className="card !p-4">
            <dt className="eyebrow text-slate-600">{k}</dt>
            <dd className="font-bold">{v}</dd>
          </div>
        ))}
      </dl>
      {x.event && (
        <p>
          <Link href={`/events/${x.event.slug}`} className="link font-bold">{t("toEvent", { event: x.event.name })}</Link>
        </p>
      )}

      <section aria-labelledby="enter-h" className="card space-y-4">
        <h2 id="enter-h" className="disp text-3xl">{t("enterTitle")}</h2>
        {state !== "open" ? (
          <p role="status">{t(`closedNote_${state}`)}</p>
        ) : !user ? (
          <p>
            {t("loginToEnter")} <Link href="/login" className="link font-bold">{t("login")}</Link>
          </p>
        ) : !verified ? (
          <p role="note">{t("verifyToEnter")}</p>
        ) : captained.length === 0 ? (
          <p>
            {t("needTeam")} <Link href="/lag" className="link font-bold">{t("createTeam")}</Link>
          </p>
        ) : free.length === 0 ? (
          <p role="note">{mine.length > 0 ? t("allEntered") : t("teamTooSmall", { size: min })}</p>
        ) : (
          <>
            <p className="text-slate-700">{t("enterLead", { min, max })}</p>
            <RegisterTeamForm
              tournamentId={x.id}
              min={min}
              max={max}
              teams={free.map((tm) => ({ id: tm.id, name: tm.name, members: tm.members.map((m) => ({ id: m.user.id, nickname: m.user.nickname })) }))}
            />
            {tooSmall.length > 0 && <p className="text-sm text-slate-600">{t("someTooSmall", { names: tooSmall.map((tm) => tm.name).join(", "), size: min })}</p>}
          </>
        )}
      </section>

      {mine.length > 0 && (
        <section aria-labelledby="mine-h" className="space-y-4">
          <h2 id="mine-h" className="disp text-3xl">{t("yourEntries")}</h2>
          {mine.map((r) => {
            const team = captained.find((tm) => tm.id === r.teamId);
            const incomplete = r.roster.length < min;
            return (
              <div key={r.id} className="card space-y-3">
                <p className="text-xl font-extrabold">
                  {r.team.name} {incomplete && <span className="tag-barn ml-2">{t("incomplete")}</span>}
                </p>
                {state === "open" && team && (
                  <details>
                    <summary className="btn-secondary cursor-pointer">{t("changeRoster")}<span className="sr-only">: {r.team.name}</span></summary>
                    <div className="mt-4 space-y-4">
                      <RosterForm registrationId={r.id} min={min} max={max} members={team.members.map((m) => ({ id: m.user.id, nickname: m.user.nickname }))} chosen={r.roster.map((p) => p.userId)} />
                    </div>
                  </details>
                )}
                {state === "open" && <ActionButton action={withdrawRegistrationAction} fields={{ registrationId: r.id }} label={t("withdraw")} variant="btn-secondary" confirm={t("withdrawConfirm", { team: r.team.name })} />}
              </div>
            );
          })}
        </section>
      )}

      <section aria-labelledby="teams-h" className="space-y-4">
        <h2 id="teams-h" className="disp text-3xl">{t("registeredTeams", { count: x.registrations.length })}</h2>
        {x.registrations.length === 0 ? (
          <p className="text-slate-600">{t("noTeams")}</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {x.registrations.map((r) => (
              <li key={r.id} className="card !p-4">
                <p className="font-extrabold">
                  <Link href={`/lag/${r.team.id}`} className="no-underline hover:underline">{r.team.name}</Link> {r.team.tag && <span className="font-mono text-sm text-slate-600">[{r.team.tag}]</span>}
                </p>
                <p className="text-sm text-slate-700">{r.roster.map((p) => p.user.nickname).join(", ")}</p>
                {isModerator && <ActionButton action={withdrawRegistrationAction} fields={{ registrationId: r.id }} label={t("removeEntry")} variant="btn-secondary" confirm={t("removeEntryConfirm", { team: r.team.name })} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
