import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { deleteScheduleCategoryAction, deleteScheduleItemAction } from "@/actions/schedule";
import { ActionButton } from "@/components/form";
import { ScheduleBoard } from "@/components/schedule-board";
import { ScheduleCategoryForm, ScheduleItemForm } from "@/components/schedule-forms";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { colorOf } from "@/lib/schedule/palette";
import { getSchedule, pick } from "@/lib/schedule/service";
import { toStockholmInput } from "@/lib/time";

export default async function ManageSchedulePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("schedule:manage");
  const event = await db.event.findUnique({ where: { id } });
  if (!event) notFound();
  const t = await getTranslations("scheduleManage");
  const f = await getFormatter();
  const { categories, items } = await getSchedule(event.id);
  const catOptions = categories.map((c) => ({ id: c.id, label: pick(c.name, c.nameEn, locale) }));
  // a handy starting time for new blocks: the event's start
  const defaultStart = toStockholmInput(event.startsAt);

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{t("lead", { event: event.name })}</p>
        <p className="text-sm">
          <Link href={`/events/${event.slug}/schema`} className="link">{t("viewPage")}</Link>
        </p>
      </header>

      {items.length > 0 && (
        <section aria-labelledby="preview-h" className="space-y-4">
          <h2 id="preview-h" className="disp text-3xl">{t("preview")}</h2>
          <ScheduleBoard items={items} categories={categories} locale={locale} />
        </section>
      )}

      <section className="space-y-4" aria-labelledby="cats-h">
        <h2 id="cats-h" className="disp text-3xl">{t("categories")}</h2>
        <p className="text-sm text-slate-600">{t("categoriesHint")}</p>
        <div className="card" role="group" aria-labelledby="new-cat-h">
          <h3 id="new-cat-h" className="mb-3 text-xl font-extrabold">{t("newCategory")}</h3>
          <ScheduleCategoryForm eventId={event.id} />
        </div>
        <ul className="space-y-3">
          {categories.map((c) => (
            <li key={c.id} className="card !p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span aria-hidden className="h-6 w-6 rounded border-2 border-ink" style={{ background: colorOf(c.color).bg }} />
                <p className="font-extrabold">{c.name}</p>
                <span className="font-mono text-xs font-bold text-slate-600">{items.filter((i) => i.categoryId === c.id).length} {t("blocks")}</span>
              </div>
              <details className="mt-3">
                <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {c.name}</span></summary>
                <div className="mt-4 space-y-4">
                  <ScheduleCategoryForm eventId={event.id} defaults={{ id: c.id, name: c.name, nameEn: c.nameEn, color: c.color }} />
                  <ActionButton action={deleteScheduleCategoryAction} fields={{ id: c.id }} label={t("deleteCategory")} variant="btn-danger" confirm={t("deleteCategoryConfirm")} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4" aria-labelledby="items-h">
        <h2 id="items-h" className="disp text-3xl">{t("items")}</h2>
        <div className="card" role="group" aria-labelledby="new-item-h">
          <h3 id="new-item-h" className="mb-3 text-xl font-extrabold">{t("newItem")}</h3>
          <ScheduleItemForm eventId={event.id} categories={catOptions} defaultStart={defaultStart} />
        </div>
        {items.length === 0 && <p className="text-slate-600">{t("noItems")}</p>}
        <ul className="space-y-3">
          {items.map((it) => (
            <li key={it.id} className="card !p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-extrabold">{it.title}</p>
                  <p className="font-mono text-xs font-bold text-slate-600">
                    {f.dateTime(it.startsAt, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} – {f.dateTime(it.endsAt, { hour: "2-digit", minute: "2-digit" })}
                    {it.location ? ` · ${it.location}` : ""}
                  </p>
                </div>
                <span className="tag" style={{ background: colorOf(it.category?.color).bg, color: colorOf(it.category?.color).fg }}>{it.category ? pick(it.category.name, it.category.nameEn, locale) : t("noCategory")}</span>
              </div>
              <details className="mt-3">
                <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {it.title}</span></summary>
                <div className="mt-4 space-y-4">
                  <ScheduleItemForm
                    eventId={event.id}
                    categories={catOptions}
                    defaults={{
                      id: it.id,
                      title: it.title,
                      titleEn: it.titleEn,
                      description: it.description,
                      descriptionEn: it.descriptionEn,
                      location: it.location,
                      categoryId: it.categoryId ?? "",
                      startsAt: toStockholmInput(it.startsAt),
                      endsAt: toStockholmInput(it.endsAt),
                    }}
                  />
                  <ActionButton action={deleteScheduleItemAction} fields={{ id: it.id }} label={t("deleteItem")} variant="btn-danger" confirm={t("deleteItemConfirm")} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
