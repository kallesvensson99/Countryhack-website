import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { deleteCrewJobAction } from "@/actions/crew";
import { ApplicationStatus, CrewJobForm } from "@/components/crew-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { ageOn } from "@/lib/age";
import { requirePage } from "@/lib/auth/guard";
import { listManagedJobs } from "@/lib/crew/service";
import { can } from "@/lib/permissions";

export default async function ManageCrewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const actor = await requirePage("crewJob:create");
  const t = await getTranslations("crewManage");
  const tc = await getTranslations("crew");
  const f = await getFormatter();
  const jobs = await listManagedJobs(actor);
  const isLeader = can(actor, "faq:manage");

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{isLeader ? t("leaderLead") : t("ansvarigLead")}</p>
        {isLeader && (
          <p className="text-sm">
            <Link href="/manage/faq" className="link">{t("faqLink")}</Link>
          </p>
        )}
      </header>

      <section className="card" aria-labelledby="new-job-h">
        <h2 id="new-job-h" className="disp mb-4 text-3xl">{t("newJob")}</h2>
        <CrewJobForm />
      </section>

      {jobs.length === 0 ? (
        <p className="text-slate-600">{t("none")}</p>
      ) : (
        <ul className="space-y-6">
          {jobs.map((job) => (
            <li key={job.id} className="card space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-extrabold leading-tight">{job.title}</h2>
                  <p className="text-sm text-slate-600">{job.createdBy ? t("postedBy", { name: job.createdBy.nickname }) : null}</p>
                </div>
                <span className={job.isOpen ? "tag-sage" : "tag"}>{job.isOpen ? t("isOpen") : t("closed")}</span>
              </div>

              <section aria-label={t("applications", { count: job.applications.length })} className="space-y-3">
                <h3 className="font-extrabold">{t("applications", { count: job.applications.length })}</h3>
                {job.applications.length === 0 ? (
                  <p className="text-sm text-slate-600">{t("noApplications")}</p>
                ) : (
                  <ul className="space-y-3">
                    {job.applications.map((a) => (
                      <li key={a.id} className="rounded-lg border-2 border-ink bg-paper p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="font-extrabold">
                            {a.user.anonymizedAt ? "–" : a.user.realName} <span className="font-normal text-slate-600">· {a.user.nickname}</span>
                          </p>
                          <span className="tag-hay normal-case">{tc(`status_${a.status}`)}</span>
                        </div>
                        {!a.user.anonymizedAt && (
                          <p className="text-sm text-slate-700">
                            {a.user.email} · {a.user.phone} · {t("age", { age: ageOn(a.user.birthDate) })}
                          </p>
                        )}
                        <p className="mt-2 whitespace-pre-line">{a.message}</p>
                        <p className="mt-2 text-sm"><strong>{t("availability")}:</strong> {a.availability}</p>
                        <p className="mt-1 text-xs text-slate-600">{t("appliedAt", { when: f.dateTime(a.createdAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
                        <div className="mt-3">
                          <ApplicationStatus id={a.id} status={a.status} label={a.user.nickname} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <details>
                <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {job.title}</span></summary>
                <div className="mt-4 space-y-4">
                  <CrewJobForm
                    defaults={{
                      id: job.id,
                      title: job.title,
                      description: job.description,
                      titleEn: job.titleEn,
                      descriptionEn: job.descriptionEn,
                      before: job.before,
                      during: job.during,
                      after: job.after,
                      spots: job.spots === null ? "" : String(job.spots),
                      isOpen: job.isOpen,
                    }}
                  />
                  <ActionButton action={deleteCrewJobAction} fields={{ id: job.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
