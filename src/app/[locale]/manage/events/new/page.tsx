import { getTranslations, setRequestLocale } from "next-intl/server";
import { EventForm } from "@/components/event-forms";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";

export default async function NewEventPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("event:manage");
  const t = await getTranslations("manage");
  const templates = await db.seatingChart.findMany({ where: { isTemplate: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">{t("newEvent")}</h1>
      <div className="card">
        <EventForm mode="create" templates={templates} />
      </div>
    </div>
  );
}
