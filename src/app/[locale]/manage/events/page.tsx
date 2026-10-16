import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";

export default async function ManageEventsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("event:manage");
  const t = await getTranslations("manage");
  const te = await getTranslations("events");
  const f = await getFormatter();
  const events = await db.event.findMany({ orderBy: { startsAt: "desc" } });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/manage/crew" className="btn-secondary">{t("crewLink")}</Link>
          <Link href="/manage/faq" className="btn-secondary">{t("faqLink")}</Link>
          <Link href="/manage/sponsors" className="btn-secondary">{t("sponsorsLink")}</Link>
          <Link href="/manage/templates" className="btn-secondary">{t("templatesLink")}</Link>
          <Link href="/manage/events/new" className="btn">{t("newEvent")}</Link>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="text-slate-600">{t("noEvents")}</p>
      ) : (
        <ul className="space-y-3">
          {events.map((e) => (
            <li key={e.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">
                  <Link href={`/manage/events/${e.id}`} className="hover:underline">{e.name}</Link>
                </p>
                <p className="text-sm text-slate-600">{f.dateTime(e.startsAt, { dateStyle: "medium", timeStyle: "short" })} · {e.venueName}</p>
              </div>
              <span className="rounded bg-slate-200 px-2 py-1 text-sm">{te(`status_${e.status}`)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
