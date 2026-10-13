import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";

export default async function HomePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ deleted?: string }> }) {
  const { locale } = await params;
  const { deleted } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const user = await getCurrentUser();
  return (
    <div className="space-y-6">
      {deleted && <p role="status" className="rounded-md bg-green-50 p-3 text-green-900">{t("deleted")}</p>}
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="text-lg text-slate-700">{t("lead")}</p>
      <p className="text-slate-600">{t("noEvents")}</p>
      {!user && (
        <Link href="/register" className="btn">
          {t("cta")}
        </Link>
      )}
    </div>
  );
}
