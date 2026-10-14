import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { mockCancelAction, mockPayAction } from "@/actions/mock-pay";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { formatSek } from "@/lib/money";

/** Stand-in for Stripe's hosted checkout page, only when PAYMENT_PROVIDER=mock (development / tests). */
export default async function MockPayPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ order?: string; success?: string; cancel?: string }> }) {
  const { locale } = await params;
  const { order: orderId, success, cancel } = await searchParams;
  setRequestLocale(locale);
  if (env().PAYMENT_PROVIDER !== "mock" || !orderId || !success || !cancel) notFound();
  const order = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) notFound();
  const t = await getTranslations("mockPay");
  return (
    <div className="mx-auto max-w-md space-y-4">
      <p role="note" className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm">{t("warning")}</p>
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <div className="card space-y-2">
        <p className="text-sm text-slate-600">{order.number}</p>
        <ul>
          {order.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-3"><span>{i.description}</span><span>{formatSek(i.unitPriceOre, locale)}</span></li>
          ))}
        </ul>
        {order.discountOre > 0 && <p className="flex justify-between"><span>{t("discount")}</span><span>−{formatSek(order.discountOre, locale)}</span></p>}
        <p className="flex justify-between border-t pt-2 text-lg font-bold"><span>{t("total")}</span><span>{formatSek(order.totalOre, locale)}</span></p>
        <p className="text-sm text-slate-600">{t("status")}: {order.status}</p>
      </div>
      <div className="flex gap-3">
        <form action={mockPayAction}>
          <input type="hidden" name="order" value={order.id} />
          <input type="hidden" name="success" value={success} />
          <button type="submit" className="btn">{t("pay")}</button>
        </form>
        <form action={mockCancelAction}>
          <input type="hidden" name="cancel" value={cancel} />
          <button type="submit" className="btn-secondary">{t("cancel")}</button>
        </form>
      </div>
    </div>
  );
}
