import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOrgSettings } from "@/lib/auth/service";
import { db } from "@/lib/db";
import { getEventForViewer, saleState, soldByType } from "@/lib/events/queries";
import { listPackagesForSale } from "@/lib/food/service";
import { can } from "@/lib/permissions";
import { formatSek } from "@/lib/money";
import { Link } from "@/i18n/navigation";
import { PurchasePanel, type PanelFood, type PanelTicketType } from "@/components/purchase-panel";
import { SeatMap } from "@/components/seat-map";
import { getSeatMap } from "@/lib/seating/booking";
import { countScheduleItems } from "@/lib/schedule/service";
import { tournamentsForEvent } from "@/lib/tournaments/service";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const event = await getEventForViewer(slug, await getCurrentUser());
  return { title: event?.name ?? "Event" };
}

export default async function EventPage({ params, searchParams }: { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const { locale, slug } = await params;
  const { checkout } = await searchParams;
  setRequestLocale(locale);
  const user = await getCurrentUser();
  const event = await getEventForViewer(slug, user);
  if (!event) notFound();

  const t = await getTranslations("events");
  const tTickets = await getTranslations("tickets");
  const tc = await getTranslations("checkout");
  const f = await getFormatter();
  const now = new Date();
  const sold = await soldByType(event.id);
  const seatMap = event.chart ? await getSeatMap(event.id, user) : null;
  const scheduleItems = await countScheduleItems(event.id);
  const eventTournaments = await tournamentsForEvent(event.id);
  const packages = await listPackagesForSale(event.id, now);
  const isStaff = can(user, "event:manage");
  const dt = (d: Date) => f.dateTime(d, { dateStyle: "long", timeStyle: "short" });
  const dtShort = (d: Date) => f.dateTime(d, { dateStyle: "medium", timeStyle: "short" });

  // Hidden ticket types never show publicly; Festivalledare see them (marked) to check their setup.
  const listed = event.ticketTypes.filter((tt) => !tt.hidden || isStaff);

  // ---- what may this viewer do?
  const registrationOpen = now >= event.registrationOpensAt && now < event.registrationClosesAt;
  let mode: "buy" | "food" | null = null;
  let hasUnpaid = false;
  let purchasedPackages = new Set<string>();
  if (user?.emailVerifiedAt && event.status === "PUBLISHED") {
    const mine = await db.ticket.findFirst({ where: { eventId: event.id, userId: user.id, status: { not: "CANCELLED" } }, include: { foodPurchases: true } });
    if (mine?.status === "ACTIVE") mode = "food";
    else if (registrationOpen) mode = "buy";
    hasUnpaid = mine?.status === "PENDING";
    purchasedPackages = new Set((await db.foodPurchase.findMany({ where: { ticket: { eventId: event.id, userId: user.id }, status: { not: "CANCELLED" } }, select: { packageId: true } })).map((p) => p.packageId));
  }

  const panelTypes: PanelTicketType[] = event.ticketTypes
    .filter((tt) => !tt.hidden)
    .map((tt) => {
      const taken = sold.get(tt.id) ?? 0;
      return {
        id: tt.id, name: tt.name, description: tt.description, priceOre: tt.priceOre, includesSeat: tt.includesSeat, zoneIds: tt.zones.map((z) => z.zoneId),
        state: saleState(tt, taken, now), startsLabel: tt.salesStartsAt ? t("state_upcoming", { date: dt(tt.salesStartsAt) }) : null, left: Math.max(0, tt.quantity - taken),
        needsCode: tt.requiresDiscountCode,
      };
    });
  const panelFood: PanelFood[] = packages.map((p) => ({
    id: p.id, name: p.name, description: p.description, priceOre: p.priceOre, state: p.state, left: p.left, deadlineLabel: dtShort(p.salesEndsAt),
    meals: p.meals.map((m) => ({ name: m.name, whenLabel: f.dateTime(m.servedAt, { weekday: "short", hour: "2-digit", minute: "2-digit" }) })),
    variants: p.variants.map((v) => ({ id: v.id, name: v.name })), alreadyBought: purchasedPackages.has(p.id),
  }));
  const showFoodInPanel = mode === "food" ? panelFood.some((p) => !p.alreadyBought && p.state === "open") : mode === "buy";
  const org = await getOrgSettings();
  const showPanel = mode === "buy" || (mode === "food" && showFoodInPanel);
  // In buy mode the seat map lives inside the panel (checkout mode); otherwise it's shown on its own.
  const showStandaloneMap = !!seatMap && mode !== "buy";

  return (
    <article className="space-y-8">
      {event.status === "DRAFT" && <p role="note" className="rounded-md border border-amber-400 bg-amber-50 p-3">{t("draftNotice")}</p>}
      {event.status === "CANCELLED" && <p role="note" className="rounded-md border border-red-400 bg-red-50 p-3">{t("cancelledNotice")}</p>}
      {event.status === "CLOSED" && <p role="note" className="rounded-md border border-slate-400 bg-slate-100 p-3">{t("closedNotice")}</p>}

      <header className="space-y-3">
        <h1 className="text-3xl font-bold">{event.name}</h1>
        {event.imagePath && (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, already size-limited
          <img src={event.imagePath} alt={t("imageAlt", { name: event.name })} className="max-h-96 w-full rounded-lg object-cover" />
        )}
        {isStaff && <Link href={`/manage/events/${event.id}`} className="link">{(await getTranslations("manage"))("edit")}</Link>}
      </header>

      <section aria-labelledby="when-h" className="grid gap-4 sm:grid-cols-2">
        <div>
          <h2 id="when-h" className="font-semibold">{t("when")}</h2>
          <p>{dt(event.startsAt)} – {dt(event.endsAt)}</p>
        </div>
        <div>
          <h2 className="font-semibold">{t("where")}</h2>
          <p>{event.venueName}, {event.address}</p>
        </div>
        <p className="text-sm text-slate-700 sm:col-span-2">
          {t("minAgeInfo", { minAge: event.minAge })} {t("registration", { opens: dt(event.registrationOpensAt), closes: dt(event.registrationClosesAt) })}
        </p>
      </section>

      <section aria-labelledby="about-h">
        <h2 id="about-h" className="text-xl font-semibold">{t("about")}</h2>
        <p className="mt-2 whitespace-pre-line">{event.description}</p>
        {eventTournaments.length > 0 && (
          <div className="mt-4">
            <h3 className="font-semibold">{t("tournamentsTitle")}</h3>
            <ul className="mt-1 list-disc pl-5">
              {eventTournaments.map((x) => (
                <li key={x.id}>
                  <Link href={`/turneringar/${x.slug}`} className="link font-bold">{x.name}</Link> <span className="text-slate-600">· {x.game}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {scheduleItems > 0 && (
          <p className="mt-4">
            <Link href={`/events/${event.slug}/schema`} className="btn-secondary">{t("scheduleLink")}</Link>
          </p>
        )}
      </section>

      {showPanel && (
        <PurchasePanel
          eventId={event.id}
          locale={locale}
          mode={mode!}
          ticketTypes={panelTypes}
          food={panelFood}
          seatMap={seatMap}
          hasUnpaid={hasUnpaid}
          flash={checkout === "cancelled" ? "cancelled" : null}
          org={{ name: org.name, orgNumber: org.orgNumber, address: org.address }}
        />
      )}
      {!showPanel && event.status === "PUBLISHED" && (
        <p role="note" className="rounded-md border border-slate-300 bg-white p-3">
          {!user ? (
            <>
              {tc("loginToBuy")} <Link href="/login" className="link">{tc("login")}</Link> · <Link href="/register" className="link">{tc("register")}</Link>
            </>
          ) : !user.emailVerifiedAt ? (
            tc("verifyToBuy")
          ) : mode === "food" ? (
            tc("hasTicketNoFood")
          ) : now < event.registrationOpensAt ? (
            tc("notOpenYet")
          ) : (
            tc("registrationClosed")
          )}
        </p>
      )}

      {!(showPanel && mode === "buy") && (
        <section aria-labelledby="tickets-h" className="space-y-3">
          <h2 id="tickets-h" className="text-xl font-semibold">{t("ticketsTitle")}</h2>
          {listed.length === 0 ? (
            <p className="text-slate-600">{t("noTickets")}</p>
          ) : (
            <ul className="space-y-3">
              {listed.map((tt) => {
                const taken = sold.get(tt.id) ?? 0;
                const state = saleState(tt, taken, now);
                const left = Math.max(0, tt.quantity - taken);
                return (
                  <li key={tt.id} className="card">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-lg font-semibold">
                        {tt.name}
                        {tt.hidden && <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-xs">{tTickets("hiddenBadge")}</span>}
                      </h3>
                      <p className="text-lg font-bold">{formatSek(tt.priceOre, locale)}</p>
                    </div>
                    {tt.description && <p className="mt-1 text-slate-700">{tt.description}</p>}
                    <p className="mt-2 text-sm text-slate-700">
                      {tt.includesSeat ? t("seatIncluded") : t("noSeat")}
                      {tt.requiresDiscountCode && ` · ${t("needsCode")}`}
                      {" · "}
                      {state === "upcoming" ? t("state_upcoming", { date: dt(tt.salesStartsAt!) }) : t(`state_${state}`)}
                      {state === "open" && ` · ${t("left", { count: left })}`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {packages.length > 0 && !(showPanel && showFoodInPanel) && (
        <section aria-labelledby="food-h" className="space-y-3">
          <h2 id="food-h" className="text-xl font-semibold">{t("foodTitle")}</h2>
          <ul className="space-y-3">
            {packages.map((p) => (
              <li key={p.id} className="card">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg font-semibold">{p.name}</h3>
                  <p className="text-lg font-bold">{formatSek(p.priceOre, locale)}</p>
                </div>
                {p.description && <p className="mt-1 text-slate-700">{p.description}</p>}
                {p.meals.length > 0 && <p className="mt-1 text-sm text-slate-700">{p.meals.map((m) => `${m.name} (${f.dateTime(m.servedAt, { weekday: "short", hour: "2-digit", minute: "2-digit" })})`).join(" · ")}</p>}
                <p className="mt-1 text-sm text-slate-600">
                  {p.variants.map((v) => v.name).join(" / ")} · {t("foodOrderBy", { when: dtShort(p.salesEndsAt) })}
                  {p.state === "soldOut" && ` · ${t("state_soldOut")}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showStandaloneMap && seatMap && <SeatMap data={seatMap} viewer={user ? "member" : "visitor"} />}
    </article>
  );
}
