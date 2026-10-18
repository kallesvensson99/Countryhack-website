import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { db } from "@/lib/db";
import { listPublicEvents, saleState, seatAvailability, soldByType } from "@/lib/events/queries";
import { countScheduleItems } from "@/lib/schedule/service";
import { formatSek } from "@/lib/money";
import { stockholmParts } from "@/lib/age";

const sameDay = (a: Date, b: Date) => JSON.stringify(stockholmParts(a)) === JSON.stringify(stockholmParts(b));

export default async function EventsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("events");
  const th = await getTranslations("home");
  const f = await getFormatter();
  const now = new Date();
  const events = await listPublicEvents();
  // Everything a visitor needs to decide, without opening the event: public ticket types, stock and free seats.
  const details = await Promise.all(
    events.map(async (e) => ({
      event: e,
      ticketTypes: await db.ticketType.findMany({ where: { eventId: e.id, hidden: false }, orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }] }),
      sold: await soldByType(e.id),
      seats: await seatAvailability(e.id, now),
      scheduleItems: await countScheduleItems(e.id),
    })),
  );

  const when = (d: Date) => f.dateTime(d, { dateStyle: "long", timeStyle: "short" });
  const day = (d: Date) => f.dateTime(d, { dateStyle: "long" });

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <p aria-hidden className="eyebrow text-barn">events</p>
        <h1 className="disp text-5xl sm:text-6xl">{t("title")}</h1>
      </header>
      {events.length === 0 ? (
        <p className="text-slate-600">{t("none")}</p>
      ) : (
        <ul className="space-y-10">
          {details.map(({ event: e, ticketTypes, sold, seats, scheduleItems }) => {
            const over = e.endsAt <= now;
            const open = now >= e.registrationOpensAt && now < e.registrationClosesAt;
            const reg = now < e.registrationOpensAt ? th("registrationOpens", { when: when(e.registrationOpensAt) }) : open ? th("registrationOpen", { when: when(e.registrationClosesAt) }) : th("registrationClosed");
            return (
              <li key={e.id} className="card grid gap-6 !p-0 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                <div className="space-y-4 p-6">
                  {e.imagePath && (
                    // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, already size-limited
                    <img src={e.imagePath} alt="" className="h-48 w-full rounded-lg border-2 border-ink object-cover" />
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="disp text-3xl sm:text-4xl">
                      <Link href={`/events/${e.slug}`} className="no-underline hover:underline">{e.name}</Link>
                    </h2>
                    {over && <span className="tag">{t("past")}</span>}
                  </div>
                  <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    <div>
                      <dt className="eyebrow text-slate-600">{th("factWhen")}</dt>
                      <dd className="font-bold">
                        {when(e.startsAt)}
                        {!sameDay(e.startsAt, e.endsAt) ? <> – {day(e.endsAt)}</> : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="eyebrow text-slate-600">{th("factWhere")}</dt>
                      <dd className="font-bold">{e.venueName}</dd>
                      <dd className="text-sm text-slate-600">{e.address}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow text-slate-600">{th("factAge")}</dt>
                      <dd className="font-bold">{th("ageValue", { minAge: e.minAge })}</dd>
                    </div>
                    {seats && (
                      <div>
                        <dt className="eyebrow text-slate-600">{th("factSeats")}</dt>
                        <dd className="font-bold">{th("seatsValue", { free: seats.free, total: seats.total })}</dd>
                      </div>
                    )}
                  </dl>
                  <p className="line-clamp-6 whitespace-pre-line text-slate-700">{e.description}</p>
                  {!over && <p role="status" className={open ? "tag-sage normal-case" : "tag normal-case"}>{reg}</p>}
                </div>

                <div className="flex flex-col gap-4 border-t-2 border-ink bg-paper p-6 md:rounded-r-[8px] md:border-l-2 md:border-t-0">
                  <h3 className="disp text-2xl">{t("ticketsHeading")}</h3>
                  {ticketTypes.length === 0 ? (
                    <p className="text-slate-600">{th("noTickets")}</p>
                  ) : (
                    <ul className="space-y-3">
                      {ticketTypes.map((tt) => {
                        const taken = sold.get(tt.id) ?? 0;
                        const state = saleState(tt, taken, now);
                        const left = Math.max(0, tt.quantity - taken);
                        return (
                          <li key={tt.id} className="border-b-2 border-ink pb-3 last:border-b-0 last:pb-0">
                            <p className="flex flex-wrap justify-between gap-2 font-extrabold">
                              <span>{tt.name}</span>
                              <span>{formatSek(tt.priceOre, locale)}</span>
                            </p>
                            <p className="font-mono text-xs font-bold">
                              {tt.includesSeat ? t("seatIncluded") : t("noSeat")}
                              {tt.requiresDiscountCode && ` · ${t("needsCode")}`}
                            </p>
                            <p className="font-mono text-xs font-bold text-slate-700">
                              {state === "upcoming" ? t("state_upcoming", { date: when(tt.salesStartsAt!) }) : t(`state_${state}`)}
                              {state === "open" && left <= 10 && ` · ${t("left", { count: left })}`}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="mt-auto flex flex-wrap gap-3 pt-2">
                    <Link href={`/events/${e.slug}`} className="btn">{!over && open ? th("heroCta") : t("more")}</Link>
                    {scheduleItems > 0 && <Link href={`/events/${e.slug}/schema`} className="btn-secondary">{t("scheduleLink")}</Link>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
