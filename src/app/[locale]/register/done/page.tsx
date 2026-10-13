import { getTranslations, setRequestLocale } from "next-intl/server";
import { ResendVerificationForm } from "@/components/auth-forms";
import { getCurrentUser } from "@/lib/auth/current-user";

export default async function RegisterDonePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  const user = await getCurrentUser();
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t("registerDoneTitle")}</h1>
      <p>{t("registerDoneLead")}</p>
      {user && !user.emailVerifiedAt && <ResendVerificationForm />}
    </div>
  );
}
