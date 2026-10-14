import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { PrintButton } from "@/components/small-client";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { kitchenSummary } from "@/lib/food/kitchen";

export default async function KitchenPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("kitchen:view");
  const actor = (await getCurrentUser())!;
  const event = await db.event.findUnique({ where: { id } });
  if (!event) notFound();
  const t = await getTranslations("kitchen");
  const f = await getFormatter();
  const k = await kitchenSummary(actor, id);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
        <PrintButton />
      </div>
      <header>
        <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>
        <p className="text-sm text-slate-600">{t("generated", { when: f.dateTime(new Date(), { dateStyle: "medium", timeStyle: "short" }) })} · {t("purchases", { count: k.purchases })}</p>
      </header>

      <section aria-labelledby="k-meals-h" className="space-y-3">
        <h2 id="k-meals-h" className="text-xl font-semibold">{t("servings")}</h2>
        {k.meals.length === 0 && <p>{t("noMeals")}</p>}
        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
          {k.meals.map((m) => (
            <article key={m.id} className="rounded-lg border border-slate-400 p-4 break-inside-avoid">
              <h3 className="font-semibold">{m.name}</h3>
              <p className="text-sm text-slate-600">{f.dateTime(m.servedAt, { weekday: "long", hour: "2-digit", minute: "2-digit" })}</p>
              <p className="mt-2 text-3xl font-bold" aria-label={t("totalAria", { count: m.total })}>{m.total}</p>
              {m.variants.length > 0 && (
                <table className="mt-2 w-full text-sm">
                  <caption className="sr-only">{m.name}</caption>
                  <tbody>
                    {m.variants.map((v) => (
                      <tr key={v.name} className="border-t border-slate-200"><th scope="row" className="py-1 text-left font-normal">{v.name}</th><td className="py-1 text-right font-semibold">{v.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="k-allergy-h" className="space-y-3">
        <h2 id="k-allergy-h" className="text-xl font-semibold">{t("allergies")}</h2>
        {k.allergies.length === 0 ? (
          <p>{t("noAllergies")}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b-2 border-slate-500">
                <th scope="col" className="p-2">{t("who")}</th>
                <th scope="col" className="p-2">{t("allergy")}</th>
                <th scope="col" className="p-2">{t("dietary")}</th>
                <th scope="col" className="p-2">{t("orders")}</th>
              </tr>
            </thead>
            <tbody>
              {k.allergies.map((a) => (
                <tr key={a.nickname} className="border-b border-slate-300 align-top break-inside-avoid">
                  <td className="p-2"><strong>{a.nickname}</strong><br />{a.realName}</td>
                  <td className="p-2 font-semibold">{a.allergies ?? "–"}</td>
                  <td className="p-2">{a.dietary ?? "–"}</td>
                  <td className="p-2">{a.packages.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
