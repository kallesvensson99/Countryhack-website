import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { deleteTicketTypeAction } from "@/actions/events";
import { TicketTypeForm } from "@/components/event-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { soldByType } from "@/lib/events/queries";
import { formatSek, oreToInput } from "@/lib/money";
import { toStockholmInput } from "@/lib/time";

export default async function ManageTicketsPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("ticketType:manage");
  const event = await db.event.findUnique({
    where: { id },
    include: { ticketTypes: { orderBy: [{ sortOrder: "asc" }, { priceOre: "asc" }], include: { zones: true } }, chart: { include: { zones: { orderBy: { name: "asc" } } } } },
  });
  if (!event) notFound();
  const t = await getTranslations("tickets");
  const tm = await getTranslations("manage");
  const sold = await soldByType(id);
  const zones = event.chart?.zones ?? [];
  const cancelled = event.status === "CANCELLED";

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>

      <ul className="space-y-4">
        {event.ticketTypes.map((tt) => (
          <li key={tt.id}>
            <details className="card" open={false}>
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 font-semibold">
                <span>
                  {tt.name} · {formatSek(tt.priceOre, locale)}
                  {tt.hidden && <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-xs font-normal">{t("hiddenBadge")}</span>}
                  {tt.requiresDiscountCode && <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 text-xs font-normal">{t("codeBadge")}</span>}
                </span>
                <span className="text-sm font-normal text-slate-600">{tm("sold", { sold: sold.get(tt.id) ?? 0, total: tt.quantity })}</span>
              </summary>
              {!cancelled && (
                <div className="mt-4 space-y-4">
                  <TicketTypeForm
                    eventId={event.id}
                    zones={zones}
                    defaults={{
                      id: tt.id,
                      name: tt.name,
                      description: tt.description,
                      price: oreToInput(tt.priceOre),
                      quantity: String(tt.quantity),
                      salesStartsAt: tt.salesStartsAt ? toStockholmInput(tt.salesStartsAt) : "",
                      salesEndsAt: tt.salesEndsAt ? toStockholmInput(tt.salesEndsAt) : "",
                      includesSeat: tt.includesSeat,
                      requiresDiscountCode: tt.requiresDiscountCode,
                      hidden: tt.hidden,
                      sortOrder: String(tt.sortOrder),
                      zoneIds: tt.zones.map((z) => z.zoneId),
                    }}
                  />
                  <ActionButton action={deleteTicketTypeAction} fields={{ id: tt.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                </div>
              )}
            </details>
          </li>
        ))}
      </ul>

      {!cancelled && (
        <section className="card" aria-labelledby="new-h">
          <h2 id="new-h" className="mb-4 text-lg font-semibold">{t("new")}</h2>
          <TicketTypeForm eventId={event.id} zones={zones} />
        </section>
      )}
    </div>
  );
}
