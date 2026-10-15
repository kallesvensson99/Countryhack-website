import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { HeroScene } from "@/components/hero-scene";
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
  return { title: { absolute: "Countryhack" }, description: t("lead") };
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
    <div className="space-y-16">
      {deleted && <p role="status" className="rounded-md border-2 border-ink bg-sage p-3 font-medium text-ink">{t("deleted")}</p>}
      {eventLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(eventLd) }} />}

      {next ? (
        <>
          {/* Full-bleed night hero with the barn-and-antenna scene */}
          <section aria-labelledby="hero-h" className="on-dark relative left-1/2 -mt-8 w-screen -translate-x-1/2 overflow-hidden bg-night text-paper">
            <HeroScene />
            <div className="relative mx-auto max-w-5xl px-4 pb-56 pt-12 sm:pb-64 sm:pt-16">
              <p className="eyebrow mb-5 text-sage">
                <span className="text-hay">$ </span>
                {t("eyebrow")} <span className="caret" aria-hidden="true" />
              </p>
              <h1 id="hero-h" className="disp max-w-3xl break-words text-6xl text-paper sm:text-8xl">{next.name}</h1>
              <p className="mt-6 max-w-xl text-xl leading-snug sm:text-2xl">
                {day(next.startsAt)}
                {!sameDay(next.startsAt, next.endsAt) && <> – {day(next.endsAt)}</>}
              </p>
              <p className="mt-3 font-mono text-lg font-bold text-hay">{next.venueName}</p>
              <p className="mt-6 line-clamp-3 max-w-xl text-paper/90">{next.description}</p>
              {registration && (
                <p role="status" className={`tag mt-6 normal-case ${registration.key === "registrationOpen" ? "!bg-sage" : ""}`}>
                  {registration.date ? t(registration.key, { when: when(registration.date) }) : t(registration.key)}
                </p>
              )}
              <div className="mt-8 flex flex-wrap gap-4">
                <Link href={`/events/${next.slug}`} className="btn min-h-14 px-7 text-xl">
                  {registration?.key === "registrationOpen" ? t("heroCta") : t("moreAboutEvent")}
                </Link>
                {!user && <Link href="/register" className="btn-ghost min-h-14 px-7 text-xl">{t("cta")}</Link>}
              </div>
            </div>
          </section>

          {next.imagePath && (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, already size-limited
            <img src={next.imagePath} alt="" className="h-56 w-full rounded-[10px] border-2 border-ink object-cover shadow-sticker-lg sm:h-72" />
          )}

          <section aria-labelledby="facts-h" className="relative -mt-28">
            <h2 id="facts-h" className="sr-only">{t("factsTitle")}</h2>
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div className="card">
                <dt className="eyebrow text-slate-600">{t("factWhen")}</dt>
                <dd className="mt-1 text-xl font-extrabold leading-tight">{when(next.startsAt)}</dd>
                <dd className="text-sm text-slate-600">{t("until", { when: when(next.endsAt) })}</dd>
              </div>
              <div className="card">
                <dt className="eyebrow text-slate-600">{t("factWhere")}</dt>
                <dd className="mt-1 text-xl font-extrabold leading-tight">{next.venueName}</dd>
                <dd className="text-sm text-slate-600">{next.address}</dd>
              </div>
              <div className="card">
                <dt className="eyebrow text-slate-600">{t("factAge")}</dt>
                <dd className="mt-1 text-xl font-extrabold leading-tight">{t("ageValue", { minAge: next.minAge })}</dd>
                <dd className="text-sm text-slate-600">{t("ageNote")}</dd>
              </div>
              <div className="card">
                <dt className="eyebrow text-slate-600">{t("factSeats")}</dt>
                <dd className="mt-1 text-xl font-extrabold leading-tight">{seats ? t("seatsValue", { free: seats.free, total: seats.total }) : t("seatsNone")}</dd>
                <dd className="text-sm text-slate-600">{t("seatsNote")}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="tickets-h" className="space-y-6">
            <div className="space-y-2">
              <p aria-hidden className="eyebrow text-barn">01</p>
              <h2 id="tickets-h" className="disp text-4xl sm:text-5xl">{t("ticketsTitle")}</h2>
              <p className="max-w-xl text-slate-600">{t("ticketsLead")}</p>
            </div>
            {next.ticketTypes.length === 0 ? (
              <p className="text-slate-600">{t("noTickets")}</p>
            ) : (
              <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
                {next.ticketTypes.map((tt, idx) => {
                  const taken = sold.get(tt.id) ?? 0;
                  const state = saleState(tt, taken, now);
                  const left = Math.max(0, tt.quantity - taken);
                  const on = tt.quantity > 0 ? Math.round((10 * left) / tt.quantity) : 0;
                  const leftText = te("left", { count: left });
                  return (
                    <li key={tt.id} className={`${idx === 1 ? "card-hay" : "card"} flex flex-col gap-3 !p-7`}>
                      <h3 className="text-2xl font-extrabold leading-tight">{tt.name}</h3>
                      <p className="disp text-5xl">{formatSek(tt.priceOre, locale)}</p>
                      {tt.description && <p>{tt.description}</p>}
                      <p className="mt-auto font-mono text-sm font-bold">
                        {tt.includesSeat ? te("seatIncluded") : te("noSeat")}
                        {tt.requiresDiscountCode && ` · ${te("needsCode")}`}
                      </p>
                      {state === "open" && (
                        <div className={`meter ${on <= 2 ? "low" : ""}`} role="img" aria-label={leftText}>
                          {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < on ? "on" : ""} />)}
                        </div>
                      )}
                      <p className="font-mono text-sm font-bold">
                        {state === "upcoming" ? te("state_upcoming", { date: when(tt.salesStartsAt!) }) : te(`state_${state}`)}
                        {state === "open" && left <= 10 && ` · ${leftText}`}
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
        <section aria-labelledby="hero-h" className="on-dark -mt-2 space-y-4 rounded-[10px] border-2 border-paper bg-night p-8 text-paper shadow-sticker-hay">
          <h1 id="hero-h" className="disp text-5xl sm:text-6xl">{t("title")}</h1>
          <p className="text-lg">{t("lead")}</p>
          <p role="status" className="rounded-md bg-night-2 p-3">{t("noEvents")}</p>
          {!user && <Link href="/register" className="btn">{t("cta")}</Link>}
        </section>
      )}

      <section aria-labelledby="how-h" className="space-y-6">
        <h2 id="how-h" className="disp text-4xl sm:text-5xl">{t("howTitle")}</h2>
        <ol className="grid gap-8 sm:grid-cols-3">
          {[1, 2, 3].map((n) => (
            <li key={n} className="border-t-4 border-ink pt-4">
              <p aria-hidden className="mb-2 font-mono text-lg font-bold text-barn">0{n}</p>
              <h3 className="text-2xl font-extrabold leading-tight">{t(`step${n}Title`)}</h3>
              <p className="mt-2 text-slate-600">{t(`step${n}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label={t("moreTitle")} className="grid gap-8 sm:grid-cols-2">
        <div className="card-hay flex flex-col gap-3 !p-8">
          <h2 className="disp text-4xl">{t("crewTitle")}</h2>
          <p className="text-lg">{t("crewBody")}</p>
          <Link href="/crew" className="btn-secondary mt-auto self-start">{t("crewCta")}</Link>
        </div>
        <div className="card flex flex-col gap-3 !p-8">
          <h2 className="disp text-4xl">{t("faqTitle")}</h2>
          <p className="text-lg">{t("faqBody")}</p>
          <Link href="/faq" className="btn mt-auto self-start">{t("faqCta")}</Link>
        </div>
      </section>

      {others.length > 0 && (
        <section aria-labelledby="others-h" className="space-y-3">
          <h2 id="others-h" className="disp text-3xl">{t("others")}</h2>
          <ul className="space-y-2">
            {others.map((e) => (
              <li key={e.id}>
                <Link href={`/events/${e.slug}`} className="link text-lg font-bold">{e.name}</Link>
                <span className="text-slate-600"> · {day(e.startsAt)} · {e.venueName}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
