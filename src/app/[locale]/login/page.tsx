import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LoginForm } from "@/components/auth-forms";

export default async function LoginPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ reset?: string }> }) {
  const { locale } = await params;
  const { reset } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t("loginTitle")}</h1>
      <div className="card">
        <LoginForm resetDone={!!reset} />
      </div>
      <p className="text-sm">
        {t("noAccount")}{" "}
        <Link href="/register" className="link">{t("registerTitle")}</Link>
      </p>
    </div>
  );
}
