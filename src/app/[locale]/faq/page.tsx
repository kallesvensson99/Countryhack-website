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
    <div className="space-y-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(ld) }} />
      <header className="space-y-3">
        <p aria-hidden className="eyebrow text-barn">man countryhack</p>
        <h1 className="disp text-5xl sm:text-7xl">{t("title")}</h1>
        <p className="max-w-xl text-xl text-slate-700">{t("lead")}</p>
        <nav aria-label={t("jump")} className="flex flex-wrap gap-3 pt-3">
          {groups.map((g) => (
            <a key={g.id} href={`#faq-${g.id}`} className="btn-secondary">{t(`group_${g.id}`)}</a>
          ))}
        </nav>
      </header>

      {groups.map((g, gi) => (
        <section key={g.id} id={`faq-${g.id}`} aria-labelledby={`faq-${g.id}-h`} className="scroll-mt-4 grid items-start gap-6 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:gap-12">
          <div>
            <p aria-hidden className="font-mono text-base font-bold text-barn">0{gi + 1}</p>
            <h2 id={`faq-${g.id}-h`} className="disp text-3xl sm:text-4xl">{t(`group_${g.id}`)}</h2>
          </div>
          <div className="space-y-4">
            {g.items.map((i) => (
              <details key={i.id} id={`q-${i.id}`} className="group rounded-[10px] border-2 border-ink bg-card shadow-sticker">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 text-lg font-extrabold leading-snug [&::-webkit-details-marker]:hidden">
                  <span>{i.q}</span>
                  <span aria-hidden className="flex h-9 w-9 flex-none items-center justify-center rounded-full border-2 border-ink bg-hay font-mono text-2xl font-bold leading-none group-open:before:content-['−'] before:content-['+']" />
                </summary>
                <p className="max-w-2xl whitespace-pre-line px-5 pb-5">{i.a}</p>
              </details>
            ))}
          </div>
        </section>
      ))}

      <section aria-labelledby="faq-more-h" className="card-hay space-y-3 !p-8">
        <h2 id="faq-more-h" className="disp text-3xl">{t("moreTitle")}</h2>
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
