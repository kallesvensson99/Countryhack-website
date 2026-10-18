import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ScheduleBoard } from "@/components/schedule-board";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getEventForViewer } from "@/lib/events/queries";
import { can } from "@/lib/permissions";
import { getSchedule } from "@/lib/schedule/service";

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale, slug } = await params;
  const event = await getEventForViewer(slug, await getCurrentUser());
  const t = await getTranslations({ locale, namespace: "schedule" });
  return event ? { title: `${t("title")} · ${event.name}` } : {};
}

/** The programme of an event as blocks. Follows the event's visibility: a draft event's schedule is staff-only. */
export default async function SchedulePage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const user = await getCurrentUser();
  const event = await getEventForViewer(slug, user);
  if (!event) notFound();
  const t = await getTranslations("schedule");
  const { categories, items } = await getSchedule(event.id);

  return (
    <div className="space-y-8">
      <Link href={`/events/${event.slug}`} className="link text-sm">{t("backToEvent", { event: event.name })}</Link>
      <header className="space-y-3">
        <p aria-hidden className="eyebrow text-barn">{event.name}</p>
        <h1 className="disp text-5xl sm:text-6xl">{t("title")}</h1>
        {can(user, "schedule:manage") && (
          <p>
            <Link href={`/manage/events/${event.id}/schedule`} className="btn-secondary">{t("edit")}</Link>
          </p>
        )}
      </header>
      {items.length === 0 ? <p className="text-slate-600">{t("none")}</p> : <ScheduleBoard items={items} categories={categories} locale={locale} />}
    </div>
  );
}
