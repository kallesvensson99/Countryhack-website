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
      <h1 className="disp text-5xl">{t("title")}</h1>

      <section aria-labelledby="tickets-h" className="space-y-4">
        <h2 id="tickets-h" className="disp text-3xl">{t("ticketsTitle")}</h2>
        {tickets.length === 0 && <p className="text-slate-600">{t("empty")}</p>}
        <div className="grid gap-8 md:grid-cols-2">
        {tickets.map((tk) => (
          <article key={tk.id} className="overflow-hidden rounded-[10px] border-2 border-ink bg-card shadow-sticker-lg" aria-label={`${tk.event.name} – ${tk.ticketType.name}`}>
            <div className="on-dark space-y-2 bg-night p-5 text-paper">
              <p className="eyebrow text-hay">{tk.ticketType.name}</p>
              <h3 className="disp text-3xl">
                <Link href={`/events/${tk.event.slug}`} className="no-underline hover:underline">{tk.event.name}</Link>
              </h3>
              <p className="text-sage">{f.dateTime(tk.event.startsAt, { dateStyle: "long", timeStyle: "short" })}</p>
            </div>
            <div aria-hidden className="border-t-[3px] border-dashed border-ink" />
            <div className="space-y-4 p-5">
              <p className="text-lg">
                {tk.status === "PENDING" ? (
                  <span className="tag-hay normal-case">{t("unpaid")}</span>
                ) : tk.seatClaim ? (
                  <span>{t("seat")}: <strong className="text-2xl font-extrabold">{tk.seatClaim.seat.label}</strong> ({tk.seatClaim.seat.zone.name})</span>
                ) : tk.ticketType.includesSeat ? (
                  <Link href={`/events/${tk.event.slug}`} className="link font-bold">{t("chooseSeat")}</Link>
                ) : (
                  <span className="text-slate-600">{t("noSeat")}</span>
                )}
                {tk.status === "ACTIVE" && tk.seatClaim && <> · <Link href={`/events/${tk.event.slug}`} className="link">{t("changeSeat")}</Link></>}
              </p>
              {tk.checkedInAt && <p className="tag-sage normal-case">{t("checkedIn", { when: f.dateTime(tk.checkedInAt, { timeStyle: "short", dateStyle: "short" }) })}</p>}
              {qrs.has(tk.id) && (
                <figure className="flex flex-col items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
                  <img src={qrs.get(tk.id)} alt={t("qrAlt", { event: tk.event.name })} width={180} height={180} className="rounded-lg border-2 border-ink bg-white p-2" />
                  <figcaption className="text-sm text-slate-600">{t("qrHint")}</figcaption>
                </figure>
              )}
              {tk.foodPurchases.length > 0 && (
                <div className="card-hay !p-4">
                  <h4 className="disp text-xl">{t("food")}</h4>
                  <ul className="mt-2 list-disc pl-5 text-sm">
                    {tk.foodPurchases.map((fp) => (
                      <li key={fp.id}>
                        {fp.package.name} – {fp.variant.name}
                        {fp.status === "PENDING" ? ` (${t("unpaid")})` : ""}
                        <span> · {fp.package.meals.map((m) => m.meal.name).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p><Link href={`/my/orders/${tk.order.number}`} className="link">{t("receipt")} {tk.order.number}</Link></p>
            </div>
          </article>
        ))}
        </div>
      </section>

      <section aria-labelledby="orders-h" className="space-y-3">
        <h2 id="orders-h" className="disp text-3xl">{t("ordersTitle")}</h2>
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
