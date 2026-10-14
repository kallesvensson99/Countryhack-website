import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChartEditor } from "@/components/chart-editor";
import { CreateChartForm, SaveTemplateForm } from "@/components/chart-forms";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { listTemplates, loadChartData } from "@/lib/seating/charts";

export default async function ManageChartPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("chart:manage");
  const event = await db.event.findUnique({ where: { id }, include: { chart: { select: { id: true } } } });
  if (!event) notFound();
  const t = await getTranslations("editor");
  const chart = event.chart ? await loadChartData(event.chart.id) : null;
  const cancelled = event.status === "CANCELLED";

  return (
    <div className="space-y-6">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("backToEvent")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>
      {!chart ? (
        cancelled ? (
          <p>{t("cancelled")}</p>
        ) : (
          <div className="card max-w-xl">
            <p className="mb-4">{t("noChart")}</p>
            <CreateChartForm eventId={event.id} templates={(await listTemplates()).map((x) => ({ id: x.id, name: x.name, seats: x._count.seats }))} />
          </div>
        )
      ) : (
        <>
          {cancelled ? <p>{t("cancelled")}</p> : <ChartEditor chartId={chart.id} initial={chart} isTemplate={false} />}
          <section className="card max-w-xl" aria-labelledby="tpl-h">
            <h2 id="tpl-h" className="mb-3 font-semibold">{t("templatesTitle")}</h2>
            <SaveTemplateForm eventId={event.id} defaultName={chart.name} />
          </section>
        </>
      )}
    </div>
  );
}
