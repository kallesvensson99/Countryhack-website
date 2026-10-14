import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { CancelOrderForm } from "@/components/commerce-forms";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatSek } from "@/lib/money";

export default async function ManageOrdersPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ status?: string }> }) {
  const { locale, id } = await params;
  const { status } = await searchParams;
  setRequestLocale(locale);
  await requirePage("order:cancel");
  const event = await db.event.findUnique({ where: { id } });
  if (!event) notFound();
  const t = await getTranslations("orders");
  const to = await getTranslations("my");
  const f = await getFormatter();
  const statuses = ["PAID", "PENDING", "EXPIRED", "CANCELLED", "REFUNDED"] as const;
  const filter = statuses.find((s) => s === status);
  const orders = await db.order.findMany({
    where: { eventId: id, ...(filter ? { status: filter } : {}) },
    orderBy: { createdAt: "desc" },
    take: 300,
    include: { user: { select: { nickname: true, realName: true, email: true } }, items: true, payments: true, tickets: { include: { seatClaim: { include: { seat: true } } } } },
  });
  const money = (o: number) => formatSek(o, locale);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>
      <nav aria-label={t("filter")} className="flex flex-wrap gap-3 text-sm">
        <Link href={`/manage/events/${id}/orders`} className={!filter ? "font-bold underline" : "link"}>{t("all")}</Link>
        {statuses.map((s) => (
          <Link key={s} href={{ pathname: `/manage/events/${id}/orders`, query: { status: s } }} className={filter === s ? "font-bold underline" : "link"}>{to(`status_${s}`)}</Link>
        ))}
      </nav>
      {orders.length === 0 && <p className="text-slate-600">{t("none")}</p>}
      <ul className="space-y-3">
        {orders.map((o) => {
          const refunded = o.payments.filter((p) => p.kind === "REFUND" && p.status === "succeeded").reduce((s, p) => s + p.amountOre, 0);
          return (
            <li key={o.id}>
              <details className="card">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{o.number} <span className="font-normal text-slate-600">· {o.user.nickname} ({o.user.realName})</span></span>
                  <span>{to(`status_${o.status}`)} · {money(o.totalOre)}</span>
                </summary>
                <div className="mt-4 space-y-3 text-sm">
                  <p>{o.user.email} · {f.dateTime(o.createdAt, { dateStyle: "medium", timeStyle: "short" })}</p>
                  <ul className="list-disc pl-5">
                    {o.items.map((i) => <li key={i.id}>{i.description} – {money(i.unitPriceOre)}</li>)}
                  </ul>
                  {o.discountOre > 0 && <p>{t("discount")}: −{money(o.discountOre)}</p>}
                  {o.tickets.some((x) => x.seatClaim) && <p>{t("seat")}: {o.tickets.map((x) => x.seatClaim?.seat.label).filter(Boolean).join(", ")}</p>}
                  {refunded > 0 && <p>{t("refunded")}: {money(refunded)}</p>}
                  <p><Link href={`/my/orders/${o.number}`} className="link">{t("receipt")}</Link></p>
                  {o.status === "PAID" && (
                    <div className="rounded-md border border-red-300 p-3">
                      <h3 className="mb-2 font-semibold">{t("cancelTitle")}</h3>
                      <CancelOrderForm orderId={o.id} totalLabel={money(o.totalOre - refunded)} />
                    </div>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
