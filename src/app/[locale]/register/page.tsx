import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { RegisterForm } from "@/components/auth-forms";

export default async function RegisterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t("registerTitle")}</h1>
      <div className="card">
        <RegisterForm locale={locale} />
      </div>
      <p className="text-sm">
        {t("haveAccount")} <Link href="/login" className="link">{t("loginTitle")}</Link>
      </p>
    </div>
  );
}
