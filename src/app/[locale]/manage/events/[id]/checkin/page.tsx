import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CheckinClient } from "@/components/checkin-client";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";

export default async function CheckinPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("checkin:perform");
  const event = await db.event.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
  if (!event) notFound();
  const t = await getTranslations("checkin");
  const open = event.status === "PUBLISHED" || event.status === "CLOSED";
  return (
    <div className="space-y-4">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-center text-2xl font-bold">{t("title")} – {event.name}</h1>
      {open ? <CheckinClient eventId={event.id} /> : <p role="alert" className="mx-auto max-w-xl rounded-md bg-amber-50 p-4 text-amber-900">{t("err_eventNotOpen")}</p>}
    </div>
  );
}
