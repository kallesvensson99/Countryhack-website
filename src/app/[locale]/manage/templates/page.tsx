import { getTranslations, setRequestLocale } from "next-intl/server";
import { deleteTemplateAction } from "@/actions/seating";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { listTemplates } from "@/lib/seating/charts";

export default async function TemplatesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("template:manage");
  const t = await getTranslations("editor");
  const templates = await listTemplates();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">{t("templatesPageTitle")}</h1>
      <p className="text-slate-600">{t("templatesLead")}</p>
      {templates.length === 0 ? (
        <p>{t("noTemplates")}</p>
      ) : (
        <ul className="space-y-3">
          {templates.map((tpl) => (
            <li key={tpl.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">{tpl.name}</p>
                <p className="text-sm text-slate-600">{t("seatCount", { count: tpl._count.seats })}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/manage/templates/${tpl.id}`} className="btn-secondary">{t("editTemplate")}</Link>
                <ActionButton action={deleteTemplateAction} fields={{ id: tpl.id }} label={t("deleteTemplate")} variant="btn-danger" confirm={t("deleteTemplateConfirm")} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
