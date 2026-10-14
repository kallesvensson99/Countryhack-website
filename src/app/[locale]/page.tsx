import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOrgSettings } from "@/lib/auth/service";
import { getNextEvent, listUpcomingEvents, saleState, seatAvailability, soldByType } from "@/lib/events/queries";
import { formatSek } from "@/lib/money";
import { jsonLd } from "@/lib/seo";
import { env } from "@/lib/env";
import { stockholmParts } from "@/lib/age";

const sameDay = (a: Date, b: Date) => JSON.stringify(stockholmParts(a)) === JSON.stringify(stockholmParts(b));

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });
  return { title: { absolute: "CCSS LAN" }, description: t("lead") };
}

export default async function HomePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ deleted?: string }> }) {
  const { locale } = await params;
  const { deleted } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const te = await getTranslations("events");
  const f = await getFormatter();
  const user = await getCurrentUser();
  const now = new Date();

  const next = await getNextEvent(now);
  const others = (await listUpcomingEvents(now)).filter((e) => e.id !== next?.id);
  const org = await getOrgSettings();
  const sold = next ? await soldByType(next.id) : new Map<string, number>();
  const seats = next ? await seatAvailability(next.id, now) : null;

  const when = (d: Date) => f.dateTime(d, { dateStyle: "long", timeStyle: "short" });
  const day = (d: Date) => f.dateTime(d, { dateStyle: "long" });

  let registration: { key: "registrationOpens" | "registrationOpen" | "registrationClosed"; date?: Date } | null = null;
  if (next) {
    if (now < next.registrationOpensAt) registration = { key: "registrationOpens", date: next.registrationOpensAt };
    else if (now < next.registrationClosesAt) registration = { key: "registrationOpen", date: next.registrationClosesAt };
    else registration = { key: "registrationClosed" };
  }

  const eventLd = next && {
    "@context": "https://schema.org",
    "@type": "Event",
    name: next.name,
    startDate: next.startsAt.toISOString(),
    endDate: next.endsAt.toISOString(),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    location: { "@type": "Place", name: next.venueName, address: next.address },
    description: next.description.slice(0, 300),
    organizer: { "@type": "Organization", name: org.name },
    offers: next.ticketTypes.map((tt) => ({
      "@type": "Offer",
      name: tt.name,
      price: (tt.priceOre / 100).toFixed(2),
      priceCurrency: "SEK",
      url: `${env().APP_URL.replace(/\/$/, "")}/${locale}/events/${next.slug}`,
      availability: saleState(tt, sold.get(tt.id) ?? 0, now) === "soldOut" ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
    })),
  };

  return (
    <div className="space-y-12">
      {deleted && <p role="status" className="rounded-md bg-green-50 p-3 text-green-900">{t("deleted")}</p>}
      {eventLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(eventLd) }} />}

      {next ? (
        <>
          <section aria-labelledby="hero-h" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {next.imagePath && (
              // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, already size-limited
              <img src={next.imagePath} alt="" className="h-56 w-full object-cover sm:h-72" />
            )}
            <div className="space-y-4 p-6 sm:p-8">
              <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">{t("eyebrow")}</p>
              <h1 id="hero-h" className="text-3xl font-bold sm:text-4xl">{next.name}</h1>
              <p className="text-lg text-slate-700">
                {day(next.startsAt)}
                {!sameDay(next.startsAt, next.endsAt) && <> – {day(next.endsAt)}</>} · {next.venueName}
              </p>
              <p className="line-clamp-4 max-w-3xl whitespace-pre-line text-slate-700">{next.description}</p>
              {registration && (
                <p role="status" className={`inline-block rounded-md px-3 py-1 text-sm font-medium ${registration.key === "registrationOpen" ? "bg-green-100 text-green-900" : "bg-slate-100 text-slate-800"}`}>
                  {registration.date ? t(registration.key, { when: when(registration.date) }) : t(registration.key)}
                </p>
              )}
              <div className="flex flex-wrap gap-3 pt-1">
                <Link href={`/events/${next.slug}`} className="btn min-h-12 px-6 text-base">
                  {registration?.key === "registrationOpen" ? t("heroCta") : t("moreAboutEvent")}
                </Link>
                {!user && <Link href="/register" className="btn-secondary min-h-12 px-6 text-base">{t("cta")}</Link>}
              </div>
            </div>
          </section>

          <section aria-labelledby="facts-h">
            <h2 id="facts-h" className="sr-only">{t("factsTitle")}</h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="card">
                <dt className="text-sm text-slate-600">{t("factWhen")}</dt>
                <dd className="font-semibold">{when(next.startsAt)}</dd>
                <dd className="text-sm text-slate-600">{t("until", { when: when(next.endsAt) })}</dd>
              </div>
              <div className="card">
                <dt className="text-sm text-slate-600">{t("factWhere")}</dt>
                <dd className="font-semibold">{next.venueName}</dd>
                <dd className="text-sm text-slate-600">{next.address}</dd>
              </div>
              <div className="card">
                <dt className="text-sm text-slate-600">{t("factAge")}</dt>
                <dd className="font-semibold">{t("ageValue", { minAge: next.minAge })}</dd>
                <dd className="text-sm text-slate-600">{t("ageNote")}</dd>
              </div>
              <div className="card">
                <dt className="text-sm text-slate-600">{t("factSeats")}</dt>
                <dd className="font-semibold">{seats ? t("seatsValue", { free: seats.free, total: seats.total }) : t("seatsNone")}</dd>
                <dd className="text-sm text-slate-600">{t("seatsNote")}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="tickets-h" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 id="tickets-h" className="text-2xl font-bold">{t("ticketsTitle")}</h2>
              <p className="text-sm text-slate-600">{t("ticketsLead")}</p>
            </div>
            {next.ticketTypes.length === 0 ? (
              <p className="text-slate-600">{t("noTickets")}</p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {next.ticketTypes.map((tt) => {
                  const taken = sold.get(tt.id) ?? 0;
                  const state = saleState(tt, taken, now);
                  const left = Math.max(0, tt.quantity - taken);
                  return (
                    <li key={tt.id} className="card flex flex-col gap-2">
                      <h3 className="text-lg font-semibold">{tt.name}</h3>
                      <p className="text-3xl font-bold">{formatSek(tt.priceOre, locale)}</p>
                      {tt.description && <p className="text-slate-700">{tt.description}</p>}
                      <p className="mt-auto text-sm text-slate-700">
                        {tt.includesSeat ? te("seatIncluded") : te("noSeat")}
                        {tt.requiresDiscountCode && ` · ${te("needsCode")}`}
                      </p>
                      <p className={`text-sm font-medium ${state === "open" ? "text-green-800" : "text-slate-700"}`}>
                        {state === "upcoming" ? te("state_upcoming", { date: when(tt.salesStartsAt!) }) : te(`state_${state}`)}
                        {state === "open" && left <= 10 && ` · ${te("left", { count: left })}`}
                      </p>
                      <Link href={`/events/${next.slug}`} className={state === "open" ? "btn" : "btn-secondary"} aria-label={`${state === "open" ? t("choose") : t("details")}: ${tt.name}`}>
                        {state === "open" ? t("choose") : t("details")}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      ) : (
        <section aria-labelledby="hero-h" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 id="hero-h" className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
          <p className="text-lg text-slate-700">{t("lead")}</p>
          <p role="status" className="rounded-md bg-slate-100 p-3">{t("noEvents")}</p>
          {!user && <Link href="/register" className="btn">{t("cta")}</Link>}
        </section>
      )}

      <section aria-labelledby="how-h" className="space-y-4">
        <h2 id="how-h" className="text-2xl font-bold">{t("howTitle")}</h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((n) => (
            <li key={n} className="card">
              <p aria-hidden className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 font-bold text-white">{n}</p>
              <h3 className="font-semibold">{t(`step${n}Title`)}</h3>
              <p className="text-slate-700">{t(`step${n}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label={t("moreTitle")} className="grid gap-4 sm:grid-cols-2">
        <div className="card space-y-2">
          <h2 className="text-xl font-semibold">{t("crewTitle")}</h2>
          <p className="text-slate-700">{t("crewBody")}</p>
          <Link href="/crew" className="btn-secondary">{t("crewCta")}</Link>
        </div>
        <div className="card space-y-2">
          <h2 className="text-xl font-semibold">{t("faqTitle")}</h2>
          <p className="text-slate-700">{t("faqBody")}</p>
          <Link href="/faq" className="btn-secondary">{t("faqCta")}</Link>
        </div>
      </section>

      {others.length > 0 && (
        <section aria-labelledby="others-h" className="space-y-3">
          <h2 id="others-h" className="text-xl font-semibold">{t("others")}</h2>
          <ul className="space-y-2">
            {others.map((e) => (
              <li key={e.id}>
                <Link href={`/events/${e.slug}`} className="link text-lg">{e.name}</Link>
                <span className="text-slate-600"> · {day(e.startsAt)} · {e.venueName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
