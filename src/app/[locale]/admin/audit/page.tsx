import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { AdminNav } from "../nav";

export default async function AdminAuditPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("audit:view");
  const t = await getTranslations("admin");
  const f = await getFormatter();
  const rows = await db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { nickname: true } } } });
  return (
    <div className="space-y-6">
      <AdminNav active="audit" />
      <h1 className="text-2xl font-bold">{t("auditTitle")}</h1>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th scope="col" className="p-2">{t("when")}</th>
              <th scope="col" className="p-2">{t("actor")}</th>
              <th scope="col" className="p-2">{t("action")}</th>
              <th scope="col" className="p-2">{t("entity")}</th>
              <th scope="col" className="p-2">{t("changes")}</th>
              <th scope="col" className="p-2">{t("ip")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b align-top">
                <td className="p-2 whitespace-nowrap">{f.dateTime(r.createdAt, { dateStyle: "short", timeStyle: "medium" })}</td>
                <td className="p-2">{r.actor?.nickname ?? "–"}</td>
                <td className="p-2">{r.action}</td>
                <td className="p-2">{r.entityType} <span className="text-slate-500">{r.entityId.slice(-6)}</span></td>
                <td className="p-2"><code className="break-all text-xs">{JSON.stringify(r.diff)}</code></td>
                <td className="p-2">{r.ip ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
