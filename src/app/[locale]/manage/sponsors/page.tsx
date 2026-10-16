import { getTranslations, setRequestLocale } from "next-intl/server";
import { deleteSponsorAction } from "@/actions/sponsors";
import { SponsorForm } from "@/components/crew-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { groupByTier, listSponsors, TIER_ORDER } from "@/lib/sponsors/service";

export default async function ManageSponsorsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("sponsor:manage");
  const t = await getTranslations("sponsorsManage");
  const ts = await getTranslations("sponsors");
  const groups = groupByTier(await listSponsors());
  const tiers = TIER_ORDER.map((tier) => ({ value: tier, label: ts(`tier_${tier}`) }));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{t("lead")}</p>
        <p className="text-sm">
          <Link href="/" className="link">{t("viewPage")}</Link>
        </p>
      </header>

      <section className="card" aria-labelledby="new-sponsor-h">
        <h2 id="new-sponsor-h" className="disp mb-4 text-3xl">{t("newSponsor")}</h2>
        <SponsorForm tiers={tiers} />
      </section>

      {groups.length === 0 && <p className="text-slate-600">{t("none")}</p>}
      {groups.map((g) => (
        <section key={g.tier} aria-labelledby={`sp-g-${g.tier}`} className="space-y-3">
          <h2 id={`sp-g-${g.tier}`} className="disp text-3xl">{ts(`tier_${g.tier}`)}</h2>
          <ul className="space-y-3">
            {g.sponsors.map((s) => (
              <li key={s.id} className="card !p-4">
                <div className="flex flex-wrap items-center gap-4">
                  {/* eslint-disable-next-line @next/next/no-img-element -- uploaded logo */}
                  <img src={s.logoPath} alt="" className="h-14 w-28 rounded border-2 border-ink bg-white object-contain p-1" />
                  <div className="grow">
                    <p className="font-extrabold">{s.name}</p>
                    {s.url && <p className="break-all text-sm text-slate-600">{s.url}</p>}
                  </div>
                  <span className={s.isActive ? "tag-sage" : "tag"}>{s.isActive ? t("active") : t("hidden")}</span>
                </div>
                <details className="mt-3">
                  <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {s.name}</span></summary>
                  <div className="mt-4 space-y-4">
                    <SponsorForm tiers={tiers} defaults={{ id: s.id, name: s.name, tier: s.tier, url: s.url ?? "", sortOrder: String(s.sortOrder), isActive: s.isActive }} />
                    <ActionButton action={deleteSponsorAction} fields={{ id: s.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
