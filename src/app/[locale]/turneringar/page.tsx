import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/permissions";
import { listPublicTournaments, registrationState } from "@/lib/tournaments/service";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tournaments" });
  return { title: t("title"), description: t("lead") };
}

export default async function TournamentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("tournaments");
  const f = await getFormatter();
  const user = await getCurrentUser();
  const now = new Date();
  const tournaments = await listPublicTournaments();

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p aria-hidden className="eyebrow text-barn">tournaments</p>
        <h1 className="disp text-5xl sm:text-6xl">{t("title")}</h1>
        <p className="max-w-2xl text-xl text-slate-700">{t("lead")}</p>
        <p className="flex flex-wrap gap-3">
          <Link href="/lag" className="btn">{t("toTeams")}</Link>
          {can(user, "tournament:manage") && <Link href="/manage/tournaments" className="btn-secondary">{t("manage")}</Link>}
        </p>
      </header>

      {tournaments.length === 0 ? (
        <p className="text-slate-600">{t("none")}</p>
      ) : (
        <ul className="grid gap-8 md:grid-cols-2">
          {tournaments.map((x) => {
            const state = registrationState(x, x._count.registrations, now);
            return (
              <li key={x.id} className="card flex flex-col gap-3 !p-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="disp text-3xl">
                    <Link href={`/turneringar/${x.slug}`} className="no-underline hover:underline">{x.name}</Link>
                  </h2>
                  <span className={state === "open" ? "tag-sage" : "tag"}>{t(`state_${state}`)}</span>
                </div>
                <p className="font-mono text-sm font-bold text-barn">{x.game}</p>
                <p className="line-clamp-3 text-slate-700">{x.description}</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <dt className="eyebrow text-slate-600">{t("teamSize")}</dt>
                    <dd className="font-bold">{t("teamSizeValue", { size: x.teamSize })}</dd>
                  </div>
                  <div>
                    <dt className="eyebrow text-slate-600">{t("teams")}</dt>
                    <dd className="font-bold">{x.maxTeams === null ? x._count.registrations : `${x._count.registrations} / ${x.maxTeams}`}</dd>
                  </div>
                  <div>
                    <dt className="eyebrow text-slate-600">{t("registrationCloses")}</dt>
                    <dd className="font-bold">{f.dateTime(x.registrationClosesAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
                  </div>
                  {x.startsAt && (
                    <div>
                      <dt className="eyebrow text-slate-600">{t("startsAt")}</dt>
                      <dd className="font-bold">{f.dateTime(x.startsAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
                    </div>
                  )}
                  {x.event && (
                    <div className="col-span-2">
                      <dt className="eyebrow text-slate-600">{t("event")}</dt>
                      <dd className="font-bold">{x.event.name}</dd>
                    </div>
                  )}
                </dl>
                <p className="mt-auto pt-2">
                  <Link href={`/turneringar/${x.slug}`} className="btn">{state === "open" ? t("registerCta") : t("details")}</Link>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
