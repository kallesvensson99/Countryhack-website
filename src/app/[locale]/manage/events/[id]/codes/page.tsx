import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { deleteCodeAction } from "@/actions/food";
import { CodeForm } from "@/components/commerce-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { formatSek, oreToInput } from "@/lib/money";
import { toStockholmInput } from "@/lib/time";

export default async function ManageCodesPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("discountCode:manage");
  const event = await db.event.findUnique({
    where: { id },
    include: { ticketTypes: { orderBy: { sortOrder: "asc" } }, discountCodes: { orderBy: { code: "asc" }, include: { ticketTypes: true } } },
  });
  if (!event) notFound();
  const t = await getTranslations("codes");
  const types = event.ticketTypes.map((x) => ({ id: x.id, name: x.name }));
  const cancelled = event.status === "CANCELLED";

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>
      <ul className="space-y-3">
        {event.discountCodes.map((c) => (
          <li key={c.id}>
            <details className="card">
              <summary className="flex cursor-pointer flex-wrap justify-between gap-2 font-semibold">
                <span>{c.code} · {c.kind === "PERCENT" ? `${c.value} %` : formatSek(c.value, locale)}</span>
                <span className="font-normal text-slate-600">{t("used", { used: c.usedCount, max: c.maxUses ?? "∞" })}</span>
              </summary>
              {!cancelled && (
                <div className="mt-4 space-y-4">
                  <CodeForm
                    eventId={event.id}
                    ticketTypes={types}
                    defaults={{
                      id: c.id, code: c.code, kind: c.kind, value: c.kind === "PERCENT" ? String(c.value) : oreToInput(c.value), appliesTo: c.appliesTo,
                      maxUses: c.maxUses === null ? "" : String(c.maxUses), validFrom: c.validFrom ? toStockholmInput(c.validFrom) : "", validUntil: c.validUntil ? toStockholmInput(c.validUntil) : "",
                      ticketTypeIds: c.ticketTypes.map((x) => x.ticketTypeId),
                    }}
                  />
                  <ActionButton action={deleteCodeAction} fields={{ id: c.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                </div>
              )}
            </details>
          </li>
        ))}
      </ul>
      {event.discountCodes.length === 0 && <p className="text-slate-600">{t("none")}</p>}
      {!cancelled && (
        <section className="card" aria-labelledby="new-code-h">
          <h2 id="new-code-h" className="mb-3 text-lg font-semibold">{t("new")}</h2>
          <CodeForm eventId={event.id} ticketTypes={types} />
        </section>
      )}
    </div>
  );
}
