import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOrgSettings } from "@/lib/auth/service";
import { listOpenJobs, localisedJob, myApplications } from "@/lib/crew/service";
import { getNextEvent } from "@/lib/events/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "crew" });
  return { title: t("title"), description: t("lead") };
}

export default async function CrewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("crew");
  const f = await getFormatter();
  const [org, next, user, jobs] = await Promise.all([getOrgSettings(), getNextEvent(), getCurrentUser(), listOpenJobs()]);
  const applied = user ? await myApplications(user.id) : new Map();

  const eventName = next?.name ?? "";
  const when = next ? f.dateTime(next.startsAt, { dateStyle: "long" }) : "";

  return (
    <div className="mx-auto max-w-3xl space-y-12">
      <header className="space-y-4">
        <p aria-hidden className="eyebrow text-barn">crew</p>
        <h1 className="disp text-5xl sm:text-6xl">{t("title")}</h1>
        <p className="text-xl text-slate-700">{t("lead")}</p>
        <p role="note" className="card-hay !p-3 font-bold">
          {next ? t("forEvent", { event: eventName, when }) : t("noEvent")}
        </p>
      </header>

      <section aria-labelledby="why-h" className="space-y-3">
        <h2 id="why-h" className="disp text-3xl">{t("whyTitle")}</h2>
        <ul className="list-disc space-y-1 pl-5 text-slate-700">
          {[1, 2, 3, 4].map((n) => (
            <li key={n}>{t(`why${n}`)}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="roles-h" className="space-y-4">
        <h2 id="roles-h" className="disp text-3xl">{t("rolesTitle")}</h2>
        {jobs.length === 0 ? (
          <p role="note" className="card">{t("jobsNone")}</p>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2">
            {jobs.map((job) => {
              const text = localisedJob(job, locale);
              const status = applied.get(job.id);
              const phases = (["before", "during", "after"] as const).filter((w) => job[w]);
              return (
                <li key={job.id} className="card flex flex-col gap-3">
                  <h3 className="text-2xl font-extrabold leading-tight">{text.title}</h3>
                  <p className="whitespace-pre-line text-slate-700">{text.description}</p>
                  <p className="flex flex-wrap gap-2" aria-label={t("whenLabel")}>
                    {phases.map((w) => (
                      <span key={w} className="tag-sage">{t(`when_${w}`)}</span>
                    ))}
                  </p>
                  {job.spots !== null && <p className="font-mono text-sm font-bold">{t("spots", { count: job.spots })}</p>}
                  <div className="mt-auto pt-1">
                    {status ? (
                      <p role="status" className="tag-hay normal-case">{t("alreadyApplied")} · {t(`status_${status}`)}</p>
                    ) : (
                      <Link href={{ pathname: "/crew/apply", query: { job: job.id } }} className="btn" aria-label={t("applyToJobLabel", { job: text.title })}>
                        {t("applyToJob")}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="apply-h" className="space-y-3">
        <h2 id="apply-h" className="disp text-3xl">{t("applyTitle")}</h2>
        <ol className="list-decimal space-y-2 pl-5 text-slate-700">
          <li>{t("apply1")}</li>
          <li>{t("apply2")}</li>
          <li>{t("apply3")}</li>
        </ol>
        {org.contactEmail && (
          <p className="text-slate-700">{t("mailAlt", { email: org.contactEmail })}</p>
        )}
        {!user && (
          <p className="text-sm text-slate-700">
            {t("needAccount")} <Link href="/register" className="link">{t("register")}</Link>
          </p>
        )}
      </section>

      <p className="text-sm text-slate-600">
        <Link href="/faq" className="link">{t("faqLink")}</Link>
      </p>
    </div>
  );
}
