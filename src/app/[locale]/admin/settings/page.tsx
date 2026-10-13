import { getTranslations, setRequestLocale } from "next-intl/server";
import { OrgSettingsForm } from "@/components/admin-forms";
import { requirePage } from "@/lib/auth/guard";
import { getOrgSettings } from "@/lib/auth/service";
import { AdminNav } from "../nav";

export default async function AdminSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("orgSettings:edit");
  const t = await getTranslations("admin");
  const org = await getOrgSettings();
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <AdminNav active="settings" />
      <h1 className="text-2xl font-bold">{t("settingsTitle")}</h1>
      <p className="text-slate-600">{t("settingsLead")}</p>
      <div className="card">
        <OrgSettingsForm
          defaults={{
            name: org.name,
            orgNumber: org.orgNumber ?? "",
            address: org.address ?? "",
            contactEmail: org.contactEmail ?? "",
            privacyPolicyVersion: org.privacyPolicyVersion,
          }}
        />
      </div>
    </div>
  );
}
