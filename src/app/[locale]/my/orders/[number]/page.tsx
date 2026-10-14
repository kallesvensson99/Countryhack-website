import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { AutoRefresh, PrintButton } from "@/components/small-client";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatSek } from "@/lib/money";
import { loadReceipt } from "@/lib/orders/receipt";
import { can } from "@/lib/permissions";
import { qrDataUrl } from "@/lib/tickets/qr";

export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ locale: string; number: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const { locale, number } = await params;
  const { checkout } = await searchParams;
  setRequestLocale(locale);
  const user = await requirePage();
  const order = await db.order.findUnique({ where: { number }, select: { id: true, userId: true } });
  // Someone else's order looks exactly like a missing one.
  if (!order || !can(user, "order:view", { ownerId: order.userId })) notFound();
  const r = (await loadReceipt(db, order.id))!;

  const t = await getTranslations("receipt");
  const f = await getFormatter();
  const money = (o: number) => formatSek(o, locale);
  const qrs = await Promise.all(r.tickets.map((x) => qrDataUrl(x.qrToken)));
  const waiting = r.status === "PENDING" && checkout === "success";

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      {waiting && (
        <div role="status" className="rounded-md border border-amber-400 bg-amber-50 p-4 print:hidden">
          <AutoRefresh />
          {t("waiting")}
        </div>
      )}
      {r.status === "PAID" && checkout === "success" && <p role="status" className="rounded-md border border-green-400 bg-green-50 p-4 print:hidden">{t("thanks")}</p>}
      {r.status === "PENDING" && checkout !== "success" && <p role="note" className="rounded-md border border-amber-400 bg-amber-50 p-4 print:hidden">{t("pendingNote")}</p>}
      {(r.status === "EXPIRED" || r.status === "CANCELLED" || r.status === "REFUNDED") && <p role="note" className="rounded-md border border-red-300 bg-red-50 p-4 print:hidden">{t(`note_${r.status}`)}</p>}

      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("title")} {r.number}</h1>
        <p className="text-slate-700">{r.eventName} · {f.dateTime(r.eventStartsAt, { dateStyle: "long", timeStyle: "short" })}</p>
        <p className="text-sm text-slate-600">
          {t("status")}: <strong>{t(`status_${r.status}`)}</strong> · {t("date")}: {f.dateTime(r.paidAt ?? r.createdAt, { dateStyle: "medium", timeStyle: "short" })}
        </p>
        <p className="text-sm text-slate-600">{t("buyer")}: {r.buyerName}</p>
      </header>

      <table className="w-full text-left">
        <caption className="sr-only">{t("items")}</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className="py-2">{t("item")}</th>
            <th scope="col" className="py-2 text-right">{t("amount")}</th>
          </tr>
        </thead>
        <tbody>
          {r.items.map((i, n) => (
            <tr key={n} className="border-b border-slate-200">
              <td className="py-2">{i.description}</td>
              <td className="py-2 text-right">{money(i.priceOre)}</td>
            </tr>
          ))}
          {r.discountOre > 0 && (
            <tr className="border-b border-slate-200">
              <td className="py-2">{t("discount")}{r.discountCode ? ` (${r.discountCode})` : ""}</td>
              <td className="py-2 text-right">−{money(r.discountOre)}</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="py-2 text-lg">{t("total")}</th>
            <td className="py-2 text-right text-lg font-bold">{money(r.totalOre)}</td>
          </tr>
          {r.refundedOre > 0 && (
            <tr>
              <th scope="row" className="py-1 font-normal">{t("refunded")}</th>
              <td className="py-1 text-right">−{money(r.refundedOre)}</td>
            </tr>
          )}
        </tfoot>
      </table>

      <section aria-label={t("seller")} className="rounded-md border border-slate-300 bg-white p-4 text-sm">
        <p className="font-semibold">{r.org.name}</p>
        {r.org.orgNumber && <p>{t("orgNumber")}: {r.org.orgNumber}</p>}
        {r.org.address && <p>{r.org.address}</p>}
        <p className="mt-2">{(await getTranslations("common"))("notVatRegistered")}</p>
      </section>

      {r.tickets.length > 0 && (
        <section aria-labelledby="rt-h" className="space-y-3">
          <h2 id="rt-h" className="text-lg font-semibold">{t("tickets")}</h2>
          {r.tickets.map((tk, n) => (
            <div key={tk.id} className="card flex flex-wrap items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
              <img src={qrs[n]} alt={t("qrAlt", { ticket: tk.typeName })} width={140} height={140} />
              <div>
                <p className="font-semibold">{tk.typeName}</p>
                <p className="text-sm">{tk.seat ? `${t("seat")}: ${tk.seat}` : t("noSeatYet")}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="flex flex-wrap gap-3 print:hidden">
        <PrintButton />
        <Link href="/my" className="btn-secondary">{t("back")}</Link>
      </div>
    </article>
  );
}
