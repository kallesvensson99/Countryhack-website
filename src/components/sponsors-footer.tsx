import { getTranslations } from "next-intl/server";
import { groupByTier, listSponsors } from "@/lib/sponsors/service";

const SIZE = { MAIN: "h-28 max-w-[22rem]", LARGE: "h-20 max-w-[16rem]", REGULAR: "h-14 max-w-[11rem]" } as const;

/** Sponsor logos grouped by tier, shown in the footer of every page. Renders nothing while there are no visible sponsors. */
export async function SponsorsFooter() {
  const groups = groupByTier(await listSponsors({ onlyActive: true }));
  if (groups.length === 0) return null;
  const t = await getTranslations("sponsors");
  return (
    <section aria-labelledby="sponsors-h" className="space-y-6 border-b-2 border-sage/40 pb-10">
      <h2 id="sponsors-h" className="disp text-3xl text-paper sm:text-4xl">{t("title")}</h2>
      {groups.map((g) => (
        <div key={g.tier} className="space-y-3">
          <h3 className="eyebrow text-sage">{t(`tier_${g.tier}`)}</h3>
          <ul className="flex flex-wrap items-center gap-5">
            {g.sponsors.map((s) => {
              // eslint-disable-next-line @next/next/no-img-element -- uploaded logo
              const img = <img src={s.logoPath} alt={s.name} className={`${SIZE[g.tier]} w-auto object-contain`} />;
              return (
                <li key={s.id} className="flex items-center rounded-lg border-2 border-paper bg-white p-3">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer sponsored" className="flex min-h-11 items-center">{img}</a>
                  ) : (
                    img
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
