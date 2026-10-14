import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOrgSettings } from "@/lib/auth/service";
import { getNextEvent } from "@/lib/events/queries";

const ROLES = [
  { id: "checkin", when: ["during"] },
  { id: "kitchen", when: ["before", "during"] },
  { id: "tech", when: ["before", "during", "after"] },
  { id: "hosts", when: ["during"] },
  { id: "build", when: ["before", "after"] },
] as const;

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
  const [org, next, user] = await Promise.all([getOrgSettings(), getNextEvent(), getCurrentUser()]);

  const eventName = next?.name ?? "";
  const when = next ? f.dateTime(next.startsAt, { dateStyle: "long" }) : "";
  // A ready-to-send application mail: the subject names the event, the body lists what we need to know.
  const mailto = org.contactEmail
    ? `mailto:${org.contactEmail}?subject=${encodeURIComponent(t("mailSubject", { event: eventName || org.name }))}&body=${encodeURIComponent(t("mailBody"))}`
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-lg text-slate-700">{t("lead")}</p>
        <p role="note" className="rounded-md bg-brand-50 p-3 font-medium text-brand-900">
          {next ? t("forEvent", { event: eventName, when }) : t("noEvent")}
        </p>
        {mailto && <a href={mailto} className="btn inline-flex min-h-12 px-6 text-base">{t("applyButton")}</a>}
      </header>

      <section aria-labelledby="why-h" className="space-y-3">
        <h2 id="why-h" className="text-xl font-semibold">{t("whyTitle")}</h2>
        <ul className="list-disc space-y-1 pl-5 text-slate-700">
          {[1, 2, 3, 4].map((n) => (
            <li key={n}>{t(`why${n}`)}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="roles-h" className="space-y-4">
        <h2 id="roles-h" className="text-xl font-semibold">{t("rolesTitle")}</h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {ROLES.map((r) => (
            <li key={r.id} className="card space-y-2">
              <h3 className="text-lg font-semibold">{t(`role_${r.id}_title`)}</h3>
              <p className="text-slate-700">{t(`role_${r.id}_desc`)}</p>
              <p className="flex flex-wrap gap-2" aria-label={t("whenLabel")}>
                {r.when.map((w) => (
                  <span key={w} className="rounded bg-slate-100 px-2 py-0.5 text-sm text-slate-800">{t(`when_${w}`)}</span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="apply-h" className="space-y-3">
        <h2 id="apply-h" className="text-xl font-semibold">{t("applyTitle")}</h2>
        <ol className="list-decimal space-y-2 pl-5 text-slate-700">
          <li>{org.contactEmail ? t("apply1", { email: org.contactEmail }) : t("apply1NoMail")}</li>
          <li>{t("apply2")}</li>
          <li>{t("apply3")}</li>
        </ol>
        {mailto ? (
          <a href={mailto} className="btn-secondary inline-flex">{t("applyButton")}</a>
        ) : (
          <p role="note" className="rounded-md bg-amber-50 p-3 text-amber-900">{t("noContact")}</p>
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
