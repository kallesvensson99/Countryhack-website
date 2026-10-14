import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { deleteMealAction, deletePackageAction } from "@/actions/food";
import { MealForm, PackageForm } from "@/components/commerce-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatSek, oreToInput } from "@/lib/money";
import { toStockholmInput } from "@/lib/time";

export default async function ManageFoodPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("foodPackage:manage");
  const event = await db.event.findUnique({
    where: { id },
    include: {
      meals: { orderBy: { servedAt: "asc" } },
      foodPackages: { orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }], include: { variants: { orderBy: { sortOrder: "asc" } }, meals: true, _count: { select: { purchases: true } } } },
    },
  });
  if (!event) notFound();
  const t = await getTranslations("food");
  const f = await getFormatter();
  const cancelled = event.status === "CANCELLED";
  const mealOptions = event.meals.map((m) => ({ id: m.id, label: `${m.name} (${f.dateTime(m.servedAt, { weekday: "short", hour: "2-digit", minute: "2-digit" })})` }));

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>

      <section aria-labelledby="meals-h" className="space-y-4">
        <h2 id="meals-h" className="text-xl font-semibold">{t("mealsTitle")}</h2>
        <p className="text-slate-600">{t("mealsLead")}</p>
        <ul className="space-y-3">
          {event.meals.map((m) => (
            <li key={m.id}>
              <details className="card">
                <summary className="cursor-pointer font-semibold">{m.name} <span className="font-normal text-slate-600">· {f.dateTime(m.servedAt, { dateStyle: "medium", timeStyle: "short" })}</span></summary>
                {!cancelled && (
                  <div className="mt-4 space-y-3">
                    <MealForm eventId={event.id} meal={{ id: m.id, name: m.name, servedAt: toStockholmInput(m.servedAt) }} />
                    <ActionButton action={deleteMealAction} fields={{ id: m.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                  </div>
                )}
              </details>
            </li>
          ))}
        </ul>
        {!cancelled && (
          <div className="card" aria-labelledby="new-meal-h">
            <h3 id="new-meal-h" className="mb-3 font-semibold">{t("newMeal")}</h3>
            <MealForm eventId={event.id} />
          </div>
        )}
      </section>

      <section aria-labelledby="packages-h" className="space-y-4">
        <h2 id="packages-h" className="text-xl font-semibold">{t("packagesTitle")}</h2>
        <ul className="space-y-3">
          {event.foodPackages.map((p) => (
            <li key={p.id}>
              <details className="card">
                <summary className="flex cursor-pointer flex-wrap justify-between gap-2 font-semibold">
                  <span>{p.name} · {formatSek(p.priceOre, locale)}</span>
                  <span className="font-normal text-slate-600">{t("purchases", { count: p._count.purchases })}</span>
                </summary>
                {!cancelled && (
                  <div className="mt-4 space-y-4">
                    <PackageForm
                      eventId={event.id}
                      meals={mealOptions}
                      defaults={{
                        id: p.id, name: p.name, description: p.description, price: oreToInput(p.priceOre), quantity: p.quantity === null ? "" : String(p.quantity),
                        salesEndsAt: toStockholmInput(p.salesEndsAt), sortOrder: String(p.sortOrder), variants: p.variants.map((v) => v.name).join("\n"), mealIds: p.meals.map((m) => m.mealId),
                      }}
                    />
                    <ActionButton action={deletePackageAction} fields={{ id: p.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                  </div>
                )}
              </details>
            </li>
          ))}
        </ul>
        {!cancelled && (
          <div className="card" aria-labelledby="new-pkg-h">
            <h3 id="new-pkg-h" className="mb-3 font-semibold">{t("newPackage")}</h3>
            <PackageForm eventId={event.id} meals={mealOptions} />
          </div>
        )}
      </section>
    </div>
  );
}
