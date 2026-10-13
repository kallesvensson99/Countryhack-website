import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeleteAccountForm, ProfileForm, ResendVerificationForm } from "@/components/auth-forms";
import { requirePage } from "@/lib/auth/guard";
import { db } from "@/lib/db";

export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requirePage("profile:edit");
  const user = await db.user.findUniqueOrThrow({ where: { id: session.id } });
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-xl space-y-8">
      <h1 className="text-2xl font-bold">{t("profile.title")}</h1>
      {!user.emailVerifiedAt && (
        <div className="space-y-3 rounded-md border border-amber-400 bg-amber-50 p-4">
          <p>{t("auth.unverifiedBanner")}</p>
          <ResendVerificationForm />
        </div>
      )}
      <section className="card">
        <p className="mb-4 text-sm text-slate-600">{user.email}</p>
        <ProfileForm
          locale={locale}
          defaults={{
            realName: user.realName,
            nickname: user.nickname,
            birthDate: user.birthDate.toISOString().slice(0, 10),
            phone: user.phone,
            allergies: user.allergies ?? "",
            dietaryPreferences: user.dietaryPreferences ?? "",
            guardianName: user.guardianName ?? "",
            guardianPhone: user.guardianPhone ?? "",
            locale: user.locale,
          }}
        />
      </section>
      <section className="card space-y-4" aria-labelledby="gdpr-h">
        <h2 id="gdpr-h" className="text-xl font-semibold">{t("profile.privacyTitle")}</h2>
        <p>{t("profile.exportLead")}</p>
        {/* Plain link: the route sets Content-Disposition: attachment. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- file download, not a page */}
        <a href="/api/account/export" className="btn-secondary">{t("profile.exportButton")}</a>
        <hr />
        <h3 className="text-lg font-semibold">{t("profile.deleteTitle")}</h3>
        <p className="text-sm">{t("profile.deleteLead")}</p>
        <DeleteAccountForm />
      </section>
    </div>
  );
}
