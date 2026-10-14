import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChartEditor } from "@/components/chart-editor";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { loadChartData } from "@/lib/seating/charts";

export default async function EditTemplatePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("template:manage");
  const tpl = await db.seatingChart.findFirst({ where: { id, isTemplate: true }, select: { id: true } });
  if (!tpl) notFound();
  const chart = (await loadChartData(tpl.id))!;
  const t = await getTranslations("editor");
  return (
    <div className="space-y-6">
      <Link href="/manage/templates" className="link text-sm">{t("backToTemplates")}</Link>
      <h1 className="text-2xl font-bold">{t("editTemplate")} – {chart.name}</h1>
      <ChartEditor chartId={chart.id} initial={chart} isTemplate />
    </div>
  );
}
