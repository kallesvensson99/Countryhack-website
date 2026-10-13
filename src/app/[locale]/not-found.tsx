import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export default function NotFound() {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">404</h1>
      <p>{t("errors.notFound")}</p>
      <Link href="/" className="link">{t("nav.home")}</Link>
    </div>
  );
}
