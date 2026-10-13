import { getTranslations, setRequestLocale } from "next-intl/server";
import { VerifyEmailForm } from "@/components/auth-forms";

// Verification happens on a button press (POST) rather than on GET, so link scanners can't consume the token.
export default async function VerifyPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ token?: string }> }) {
  const { locale } = await params;
  const { token } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t("verifyTitle")}</h1>
      <p>{t("verifyLead")}</p>
      <VerifyEmailForm token={token ?? ""} />
    </div>
  );
}
