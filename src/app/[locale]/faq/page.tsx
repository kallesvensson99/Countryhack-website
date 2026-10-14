import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getOrgSettings } from "@/lib/auth/service";
import { FAQ_GROUPS } from "@/lib/content/faq";
import { getNextEvent } from "@/lib/events/queries";
import { jsonLd } from "@/lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "faq" });
  return { title: t("title"), description: t("lead") };
}

export default async function FaqPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("faq");
  const [org, next] = await Promise.all([getOrgSettings(), getNextEvent()]);
  // Answers mention the live age limit and the real contact address instead of hard-coded text.
  const values = { minAge: next?.minAge ?? 14, contact: org.contactEmail ?? t("contactFallback") };

  const groups = FAQ_GROUPS.map((g) => ({ id: g.id, items: g.items.map((id) => ({ id, q: t(`q_${id}`), a: t(`a_${id}`, values) })) }));
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: groups.flatMap((g) => g.items).map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(ld) }} />
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-lg text-slate-700">{t("lead")}</p>
        <nav aria-label={t("jump")} className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-sm">
          {groups.map((g) => (
            <a key={g.id} href={`#faq-${g.id}`} className="link">{t(`group_${g.id}`)}</a>
          ))}
        </nav>
      </header>

      {groups.map((g) => (
        <section key={g.id} id={`faq-${g.id}`} aria-labelledby={`faq-${g.id}-h`} className="space-y-3 scroll-mt-4">
          <h2 id={`faq-${g.id}-h`} className="text-xl font-semibold">{t(`group_${g.id}`)}</h2>
          <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {g.items.map((i) => (
              <details key={i.id} id={`q-${i.id}`} className="group p-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">
                  <span>{i.q}</span>
                  <span aria-hidden className="text-xl text-slate-500 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-2 whitespace-pre-line text-slate-700">{i.a}</p>
              </details>
            ))}
          </div>
        </section>
      ))}

      <section aria-labelledby="faq-more-h" className="card space-y-2">
        <h2 id="faq-more-h" className="text-lg font-semibold">{t("moreTitle")}</h2>
        <p>
          {org.contactEmail ? (
            <>
              {t("moreWrite")} <a className="link" href={`mailto:${org.contactEmail}`}>{org.contactEmail}</a>.
            </>
          ) : (
            t("moreNoContact")
          )}
        </p>
        <p className="text-sm">
          <Link href="/privacy" className="link">{t("privacy")}</Link> · <Link href="/crew" className="link">{t("crew")}</Link>
        </p>
      </section>
    </div>
  );
}
