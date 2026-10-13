import { getTranslations, setRequestLocale } from "next-intl/server";
import { getOrgSettings } from "@/lib/auth/service";

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("privacy");
  const org = await getOrgSettings();
  const sections = [1, 2, 3, 4, 5, 6] as const;
  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="text-sm text-slate-600">{t("version", { version: org.privacyPolicyVersion })}</p>
      <section>
        <h2 className="text-xl font-semibold">{t("controller")}</h2>
        <p>
          {org.name}
          {org.orgNumber ? `, ${org.orgNumber}` : ""}
          {org.address ? `, ${org.address}` : ""}
          {org.contactEmail ? ` · ${org.contactEmail}` : ""}
        </p>
      </section>
      {sections.map((n) => (
        <section key={n}>
          <h2 className="text-xl font-semibold">{t(`s${n}Title`)}</h2>
          <p>{t(`s${n}Body`)}</p>
        </section>
      ))}
    </article>
  );
}
