import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { removeImageAction, duplicateEventAction, setStatusAction } from "@/actions/events";
import { EventForm, ImageForm } from "@/components/event-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { STATUS_FLOW } from "@/lib/events/service";
import { toStockholmInput } from "@/lib/time";

export default async function ManageEventPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("event:manage");
  const event = await db.event.findUnique({ where: { id } });
  if (!event) notFound();
  const t = await getTranslations("manage");
  const te = await getTranslations("events");
  const next = STATUS_FLOW[event.status];
  const cancelled = event.status === "CANCELLED";

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{event.name}</h1>
        <span className="rounded bg-slate-200 px-2 py-1 text-sm">{te(`status_${event.status}`)}</span>
      </div>
      <nav className="flex flex-wrap gap-4 text-sm" aria-label={event.name}>
        <Link href={`/events/${event.slug}`} className="link">{t("viewPublic")}</Link>
        <Link href={`/manage/events/${event.id}/tickets`} className="link">{t("ticketsLink")}</Link>
        <Link href={`/manage/events/${event.id}/chart`} className="link">{t("chartLink")}</Link>
        <Link href={`/manage/events/${event.id}/schedule`} className="link">{t("scheduleLink")}</Link>
        <Link href={`/manage/events/${event.id}/food`} className="link">{t("foodLink")}</Link>
        <Link href={`/manage/events/${event.id}/codes`} className="link">{t("codesLink")}</Link>
        <Link href={`/manage/events/${event.id}/orders`} className="link">{t("ordersLink")}</Link>
        <Link href={`/manage/events/${event.id}/kitchen`} className="link">{t("kitchenLink")}</Link>
        <Link href={`/manage/events/${event.id}/checkin`} className="link font-semibold">{t("checkinLink")}</Link>
        <Link href={`/manage/events/${event.id}/attendees`} className="link">{t("attendeesLink")}</Link>
        <Link href={`/manage/events/${event.id}/stats`} className="link">{t("statsLink")}</Link>
        <Link href={`/manage/events/${event.id}/broadcast`} className="link">{t("broadcastLink")}</Link>
      </nav>

      <section className="card space-y-3" aria-labelledby="status-h">
        <h2 id="status-h" className="text-lg font-semibold">{t("statusTitle")}</h2>
        <div className="flex flex-wrap gap-3">
          {next.includes("PUBLISHED") && <ActionButton action={setStatusAction} fields={{ id: event.id, status: "PUBLISHED" }} label={t("publish")} variant="btn" />}
          {next.includes("CLOSED") && <ActionButton action={setStatusAction} fields={{ id: event.id, status: "CLOSED" }} label={t("close")} />}
          {next.includes("CANCELLED") && <ActionButton action={setStatusAction} fields={{ id: event.id, status: "CANCELLED" }} label={t("cancel")} variant="btn-danger" confirm={t("cancelConfirm")} />}
          <ActionButton action={duplicateEventAction} fields={{ id: event.id }} label={t("duplicate")} />
        </div>
      </section>

      <section className="card space-y-3" aria-labelledby="img-h">
        <h2 id="img-h" className="text-lg font-semibold">{t("imageTitle")}</h2>
        {event.imagePath && (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded, already size-limited */}
            <img src={event.imagePath} alt={te("imageAlt", { name: event.name })} className="max-h-48 rounded" />
            {!cancelled && <ActionButton action={removeImageAction} fields={{ id: event.id }} label={te("removeImage")} />}
          </div>
        )}
        {!cancelled && <ImageForm eventId={event.id} />}
      </section>

      <section className="card" aria-labelledby="details-h">
        <h2 id="details-h" className="mb-4 text-lg font-semibold">{t("detailsTitle")}</h2>
        {cancelled ? (
          <p>{te("cancelledNotice")}</p>
        ) : (
          <EventForm
            mode="edit"
            defaults={{
              id: event.id,
              name: event.name,
              description: event.description,
              venueName: event.venueName,
              address: event.address,
              startsAt: toStockholmInput(event.startsAt),
              endsAt: toStockholmInput(event.endsAt),
              registrationOpensAt: toStockholmInput(event.registrationOpensAt),
              registrationClosesAt: toStockholmInput(event.registrationClosesAt),
              seatChangeDeadline: event.seatChangeDeadline ? toStockholmInput(event.seatChangeDeadline) : "",
              minAge: String(event.minAge),
              showNicknamesOnMap: event.showNicknamesOnMap,
            }}
          />
        )}
      </section>
    </div>
  );
}
