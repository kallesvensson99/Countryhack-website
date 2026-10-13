import { getTranslations, setRequestLocale } from "next-intl/server";
import { requirePage } from "@/lib/auth/guard";

export default async function MyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage();
  const t = await getTranslations("my");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p>{t("lead")}</p>
      <p className="text-slate-600">{t("empty")}</p>
    </div>
  );
}
