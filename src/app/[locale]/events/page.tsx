import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { listPublicEvents } from "@/lib/events/queries";

export default async function EventsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("events");
  const f = await getFormatter();
  const events = await listPublicEvents();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {events.length === 0 ? (
        <p className="text-slate-600">{t("none")}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {events.map((e) => (
            <li key={e.id} className="card flex flex-col gap-3">
              {e.imagePath && (
                // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, already size-limited
                <img src={e.imagePath} alt="" className="h-40 w-full rounded object-cover" />
              )}
              <h2 className="text-xl font-semibold">
                <Link href={`/events/${e.slug}`} className="hover:underline">{e.name}</Link>
              </h2>
              <p className="text-sm text-slate-700">
                {f.dateTime(e.startsAt, { dateStyle: "long", timeStyle: "short" })} · {e.venueName}
              </p>
              <Link href={`/events/${e.slug}`} className="btn mt-auto self-start">{t("more")}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
