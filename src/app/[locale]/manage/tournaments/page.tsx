import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { deleteTournamentAction } from "@/actions/tournaments";
import { ActionButton } from "@/components/form";
import { TournamentForm } from "@/components/tournament-forms";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { toStockholmInput } from "@/lib/time";
import { listAllTournaments, registrationState } from "@/lib/tournaments/service";

export default async function ManageTournamentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const actor = await requirePage("tournament:manage");
  const t = await getTranslations("tournamentsManage");
  const tt = await getTranslations("tournaments");
  const f = await getFormatter();
  const [tournaments, events] = await Promise.all([listAllTournaments(actor), db.event.findMany({ orderBy: { startsAt: "desc" }, select: { id: true, name: true } })]);
  const now = new Date();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{t("lead")}</p>
        <p className="text-sm">
          <Link href="/turneringar" className="link">{t("viewPage")}</Link>
        </p>
      </header>

      <section className="card" aria-labelledby="new-t-h">
        <h2 id="new-t-h" className="disp mb-4 text-3xl">{t("newTournament")}</h2>
        <TournamentForm events={events} />
      </section>

      {tournaments.length === 0 && <p className="text-slate-600">{t("none")}</p>}
      <ul className="space-y-4">
        {tournaments.map((x) => (
          <li key={x.id} className="card !p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-xl font-extrabold leading-tight">
                  <Link href={`/turneringar/${x.slug}`} className="no-underline hover:underline">{x.name}</Link>
                </p>
                <p className="font-mono text-xs font-bold text-slate-600">
                  {x.game} · {x._count.registrations}{x.maxTeams ? ` / ${x.maxTeams}` : ""} {t("teams")} · {tt("registrationCloses")} {f.dateTime(x.registrationClosesAt, { dateStyle: "medium", timeStyle: "short" })}
                </p>
              </div>
              <span className={x.status === "PUBLISHED" ? "tag-sage" : "tag-hay"}>{tt(`status_${x.status}`)} · {tt(`state_${registrationState(x, x._count.registrations, now)}`)}</span>
            </div>
            <details className="mt-3">
              <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {x.name}</span></summary>
              <div className="mt-4 space-y-4">
                <TournamentForm
                  events={events}
                  teamSizeLocked={x._count.registrations > 0}
                  defaults={{
                    id: x.id,
                    name: x.name,
                    game: x.game,
                    description: x.description,
                    format: x.format,
                    teamSize: String(x.teamSize),
                    maxSubstitutes: String(x.maxSubstitutes),
                    maxTeams: x.maxTeams === null ? "" : String(x.maxTeams),
                    registrationClosesAt: toStockholmInput(x.registrationClosesAt),
                    startsAt: x.startsAt ? toStockholmInput(x.startsAt) : "",
                    eventId: x.eventId ?? "",
                    status: x.status,
                  }}
                />
                <ActionButton action={deleteTournamentAction} fields={{ id: x.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
