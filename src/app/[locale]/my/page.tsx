import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatSek } from "@/lib/money";
import { qrDataUrl, signTicketToken } from "@/lib/tickets/qr";

export default async function MyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePage();
  const t = await getTranslations("my");
  const f = await getFormatter();

  const tickets = await db.ticket.findMany({
    where: { userId: user.id, status: { in: ["ACTIVE", "PENDING"] } },
    orderBy: { createdAt: "desc" },
    include: {
      event: true,
      ticketType: true,
      order: true,
      seatClaim: { include: { seat: { include: { zone: true } } } },
      foodPurchases: { where: { status: { in: ["ACTIVE", "PENDING"] } }, include: { package: { include: { meals: { include: { meal: true } } } }, variant: true } },
    },
  });
  const orders = await db.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, include: { event: { select: { name: true } } } });
  const qrs = new Map(await Promise.all(tickets.filter((x) => x.status === "ACTIVE").map(async (x) => [x.id, await qrDataUrl(signTicketToken(x))] as const)));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      <section aria-labelledby="tickets-h" className="space-y-4">
        <h2 id="tickets-h" className="text-xl font-semibold">{t("ticketsTitle")}</h2>
        {tickets.length === 0 && <p className="text-slate-600">{t("empty")}</p>}
        {tickets.map((tk) => (
          <article key={tk.id} className="card grid gap-4 sm:grid-cols-[1fr_auto]" aria-label={`${tk.event.name} – ${tk.ticketType.name}`}>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">
                <Link href={`/events/${tk.event.slug}`} className="hover:underline">{tk.event.name}</Link>
              </h3>
              <p>{tk.ticketType.name} · {f.dateTime(tk.event.startsAt, { dateStyle: "long", timeStyle: "short" })}</p>
              <p>
                {tk.status === "PENDING" ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-900">{t("unpaid")}</span>
                ) : tk.seatClaim ? (
                  <span>{t("seat")}: <strong>{tk.seatClaim.seat.label}</strong> ({tk.seatClaim.seat.zone.name})</span>
                ) : tk.ticketType.includesSeat ? (
                  <Link href={`/events/${tk.event.slug}`} className="link">{t("chooseSeat")}</Link>
                ) : (
                  <span className="text-slate-600">{t("noSeat")}</span>
                )}
                {tk.status === "ACTIVE" && tk.seatClaim && <> · <Link href={`/events/${tk.event.slug}`} className="link">{t("changeSeat")}</Link></>}
              </p>
              {tk.checkedInAt && <p className="text-green-800">{t("checkedIn", { when: f.dateTime(tk.checkedInAt, { timeStyle: "short", dateStyle: "short" }) })}</p>}
              {tk.foodPurchases.length > 0 && (
                <div>
                  <h4 className="font-semibold">{t("food")}</h4>
                  <ul className="list-disc pl-5 text-sm">
                    {tk.foodPurchases.map((fp) => (
                      <li key={fp.id}>
                        {fp.package.name} – {fp.variant.name}
                        {fp.status === "PENDING" ? ` (${t("unpaid")})` : ""}
                        <span className="text-slate-600"> · {fp.package.meals.map((m) => m.meal.name).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p><Link href={`/my/orders/${tk.order.number}`} className="link">{t("receipt")} {tk.order.number}</Link></p>
            </div>
            {qrs.has(tk.id) && (
              <figure className="text-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
                <img src={qrs.get(tk.id)} alt={t("qrAlt", { event: tk.event.name })} width={180} height={180} className="mx-auto rounded border border-slate-300" />
                <figcaption className="mt-1 text-xs text-slate-600">{t("qrHint")}</figcaption>
              </figure>
            )}
          </article>
        ))}
      </section>

      <section aria-labelledby="orders-h" className="space-y-3">
        <h2 id="orders-h" className="text-xl font-semibold">{t("ordersTitle")}</h2>
        {orders.length === 0 ? (
          <p className="text-slate-600">{t("noOrders")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="p-2">{t("orderNumber")}</th>
                  <th scope="col" className="p-2">{t("event")}</th>
                  <th scope="col" className="p-2">{t("date")}</th>
                  <th scope="col" className="p-2">{t("status")}</th>
                  <th scope="col" className="p-2 text-right">{t("total")}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b">
                    <td className="p-2"><Link href={`/my/orders/${o.number}`} className="link">{o.number}</Link></td>
                    <td className="p-2">{o.event.name}</td>
                    <td className="p-2 whitespace-nowrap">{f.dateTime(o.createdAt, { dateStyle: "short", timeStyle: "short" })}</td>
                    <td className="p-2">{t(`status_${o.status}`)}</td>
                    <td className="p-2 text-right">{formatSek(o.totalOre, locale)}</td>
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
