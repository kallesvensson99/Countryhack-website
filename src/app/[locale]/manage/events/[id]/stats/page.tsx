import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatSek } from "@/lib/money";
import { getEventStats } from "@/lib/stats/event-stats";

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div role="img" aria-label={label} className="h-3 w-full overflow-hidden rounded bg-slate-200">
      <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default async function StatsPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("sales:view");
  const actor = (await getCurrentUser())!;
  const event = await db.event.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!event) notFound();
  const t = await getTranslations("stats");
  const s = await getEventStats(actor, id);
  const money = (o: number) => formatSek(o, locale);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>

      <section aria-label={t("overview")} className="grid gap-4 sm:grid-cols-4">
        {[
          [t("sold"), `${s.ticketTotals.active}`, t("ofCapacity", { capacity: s.ticketTotals.capacity })],
          [t("checkedIn"), `${s.ticketTotals.checkedIn}`, t("ofSold", { sold: s.ticketTotals.active })],
          [t("revenue"), money(s.revenue.netOre), t("netNote")],
          [t("unpaid"), `${s.ticketTotals.pending}`, t("unpaidNote")],
        ].map(([label, value, note]) => (
          <div key={label} className="card">
            <p className="text-sm text-slate-600">{label}</p>
            <p className="text-3xl font-bold">{value}</p>
            <p className="text-xs text-slate-600">{note}</p>
          </div>
        ))}
      </section>

      <section aria-labelledby="st-tickets" className="space-y-3">
        <h2 id="st-tickets" className="text-xl font-semibold">{t("ticketsTitle")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="p-2">{t("type")}</th>
                <th scope="col" className="p-2 text-right">{t("sold")}</th>
                <th scope="col" className="p-2 text-right">{t("unpaid")}</th>
                <th scope="col" className="p-2 text-right">{t("checkedIn")}</th>
                <th scope="col" className="p-2 text-right">{t("capacity")}</th>
                <th scope="col" className="w-40 p-2"><span className="sr-only">{t("fill")}</span></th>
              </tr>
            </thead>
            <tbody>
              {s.tickets.map((x) => (
                <tr key={x.typeId} className="border-b">
                  <th scope="row" className="p-2 font-medium">{x.name}</th>
                  <td className="p-2 text-right">{x.active}</td>
                  <td className="p-2 text-right">{x.pending}</td>
                  <td className="p-2 text-right">{x.checkedIn}</td>
                  <td className="p-2 text-right">{x.quantity}</td>
                  <td className="p-2"><Bar value={x.active + x.pending} max={x.quantity} label={t("fillLabel", { name: x.name, used: x.active + x.pending, total: x.quantity })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {s.seats && (
        <section aria-labelledby="st-seats" className="space-y-3">
          <h2 id="st-seats" className="text-xl font-semibold">{t("seatsTitle")}</h2>
          <p>{t("seatsSummary", { taken: s.seats.taken, held: s.seats.held, free: s.seats.free, total: s.seats.total, blocked: s.seats.blocked })}</p>
          <ul className="space-y-2">
            {s.seats.byZone.map((z) => (
              <li key={z.name} className="space-y-1">
                <p className="flex items-center gap-2 text-sm"><span aria-hidden className="inline-block h-4 w-4 rounded border border-slate-700" style={{ background: z.color }} /> {z.name}: {z.taken} / {z.total}</p>
                <Bar value={z.taken} max={z.total} label={t("zoneFill", { name: z.name, taken: z.taken, total: z.total })} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="st-money" className="space-y-2">
        <h2 id="st-money" className="text-xl font-semibold">{t("moneyTitle")}</h2>
        <dl className="grid max-w-md grid-cols-2 gap-1">
          <dt>{t("charged")}</dt><dd className="text-right">{money(s.revenue.chargedOre)}</dd>
          <dt>{t("refunded")}</dt><dd className="text-right">−{money(s.revenue.refundedOre)}</dd>
          <dt className="border-t font-bold">{t("net")}</dt><dd className="border-t text-right font-bold">{money(s.revenue.netOre)}</dd>
        </dl>
        <p className="text-sm text-slate-600">{t("ordersSummary", { paid: s.revenue.orders.paid, pending: s.revenue.orders.pending, cancelled: s.revenue.orders.cancelled, refunded: s.revenue.orders.refunded, expired: s.revenue.orders.expired })}</p>
      </section>

      <section aria-labelledby="st-food" className="space-y-3">
        <h2 id="st-food" className="text-xl font-semibold">{t("foodTitle")}</h2>
        {s.food.length === 0 ? (
          <p className="text-slate-600">{t("noFood")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="p-2">{t("package")}</th>
                  <th scope="col" className="p-2">{t("variants")}</th>
                  <th scope="col" className="p-2 text-right">{t("orders")}</th>
                  <th scope="col" className="p-2 text-right">{t("listValue")}</th>
                </tr>
              </thead>
              <tbody>
                {s.food.map((p) => (
                  <tr key={p.packageId} className="border-b align-top">
                    <th scope="row" className="p-2 font-medium">{p.name}{p.quantity !== null && <span className="font-normal text-slate-600"> ({t("max", { max: p.quantity })})</span>}</th>
                    <td className="p-2">{p.variants.map((v) => `${v.name}: ${v.count}`).join(" · ")}</td>
                    <td className="p-2 text-right">{p.total}</td>
                    <td className="p-2 text-right">{money(p.valueOre)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
