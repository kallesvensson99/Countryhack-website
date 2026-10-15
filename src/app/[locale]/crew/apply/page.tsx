import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ApplyForm, WithdrawButton } from "@/components/crew-forms";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listOpenJobs, localisedJob, myApplications } from "@/lib/crew/service";
import { db } from "@/lib/db";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crew" });
  return { title: t("formTitle") };
}

export default async function CrewApplyPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ job?: string }> }) {
  const { locale } = await params;
  const { job: jobParam } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("crew");
  const user = await getCurrentUser();
  const [open, applied] = await Promise.all([listOpenJobs(), user ? myApplications(user.id) : Promise.resolve(new Map())]);
  const jobs = open.filter((j) => !applied.has(j.id)).map((j) => ({ id: j.id, title: localisedJob(j, locale).title }));
  const mine = user
    ? await db.crewApplication.findMany({ where: { userId: user.id }, include: { job: true }, orderBy: { createdAt: "desc" } })
    : [];
  const profile = user ? await db.user.findUnique({ where: { id: user.id }, select: { realName: true, nickname: true, email: true, phone: true } }) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <Link href="/crew" className="link text-sm">{t("backToCrew")}</Link>
      <header className="space-y-3">
        <h1 className="disp text-5xl">{t("formTitle")}</h1>
        <p className="text-lg text-slate-700">{t("formLead")}</p>
      </header>

      {!user ? (
        <div className="card space-y-3">
          <p>{t("loginToApply")}</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/login" className="btn">{t("login")}</Link>
            <Link href="/register" className="btn-secondary">{t("register")}</Link>
          </div>
        </div>
      ) : !user.emailVerifiedAt ? (
        <p role="note" className="card-hay">{t("verifyToApply")}</p>
      ) : (
        <>
          {profile && (
            <p className="text-sm text-slate-700">
              {t("formContact", { name: profile.realName, nickname: profile.nickname, email: profile.email, phone: profile.phone })}{" "}
              <Link href="/profile" className="link">{t("formEditProfile")}</Link>
            </p>
          )}
          {jobs.length > 0 ? (
            <section className="card" aria-labelledby="apply-form-h">
              <h2 id="apply-form-h" className="sr-only">{t("formTitle")}</h2>
              <ApplyForm jobs={jobs} defaultJobId={jobs.some((j) => j.id === jobParam) ? jobParam : undefined} />
            </section>
          ) : (
            <p role="note" className="card">{mine.length > 0 ? t("alreadyApplied") : t("noJobsOpen")}</p>
          )}
        </>
      )}

      {mine.length > 0 && (
        <section aria-labelledby="mine-h" className="space-y-3">
          <h2 id="mine-h" className="disp text-3xl">{t("yourApplication")}</h2>
          <ul className="space-y-3">
            {mine.map((a) => (
              <li key={a.id} className="card flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-extrabold">{localisedJob(a.job, locale).title}</p>
                  <p className="tag-hay mt-1 normal-case">{t(`status_${a.status}`)}</p>
                </div>
                <WithdrawButton jobId={a.jobId} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
