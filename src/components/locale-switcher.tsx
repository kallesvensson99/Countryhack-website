"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export function LocaleSwitcher() {
  const current = useLocale();
  const pathname = usePathname();
  const t = useTranslations("common");
  return (
    <nav aria-label={t("language")} className="flex gap-2 text-sm">
      {routing.locales.map((l) => (
        <Link
          key={l}
          href={pathname}
          locale={l}
          lang={l}
          hrefLang={l}
          aria-current={l === current ? "true" : undefined}
          className={l === current ? "font-bold underline" : "hover:underline"}
        >
          {l.toUpperCase()}
        </Link>
      ))}
    </nav>
  );
}
