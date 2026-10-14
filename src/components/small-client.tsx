"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/** Re-fetches the page every few seconds (payment confirmation arrives by webhook, a moment after the redirect). */
export function AutoRefresh({ everyMs = 3000, maxTimes = 20 }: { everyMs?: number; maxTimes?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const h = setInterval(() => {
      if (++n > maxTimes) clearInterval(h);
      else router.refresh();
    }, everyMs);
    return () => clearInterval(h);
  }, [router, everyMs, maxTimes]);
  return null;
}

export function PrintButton() {
  const t = useTranslations("common");
  return (
    <button type="button" className="btn-secondary print:hidden" onClick={() => window.print()}>
      {t("print")}
    </button>
  );
}
