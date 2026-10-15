import type { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getCurrentUser } from "@/lib/auth/current-user";
import { logoutAction } from "@/actions/auth";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { getOrgSettings } from "@/lib/auth/service";
import "../globals.css";

// The header shows the logged-in user and the footer reads org settings, so never prerender.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: { default: "Countryhack", template: "%s · Countryhack" } };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const [messages, t, user, org] = await Promise.all([getMessages(), getTranslations("nav"), getCurrentUser(), getOrgSettings()]);
  const isAdmin = user?.tags.includes("ADMIN");
  const isLeader = user?.tags.includes("FESTIVALLEDARE");
  const isCrewStaff = isLeader || user?.tags.includes("ANSVARIG");

  return (
    <html lang={locale}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-3">
          {(await getTranslations("common"))("skipToContent")}
        </a>
        <NextIntlClientProvider messages={messages}>
          <header className="on-dark bg-night text-paper print:hidden">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
              <Link href="/" className="flex min-h-11 items-center gap-3 no-underline">
                <svg viewBox="0 0 40 36" width="40" height="36" aria-hidden="true">
                  <path d="M3 34V16L11 8H29L37 16V34Z" fill="#b83a24" />
                  <path d="M20 8V1" stroke="#f2ead6" strokeWidth="2.5" />
                  <path d="M14 1a6 6 0 0 1 12 0" fill="none" stroke="#e9b73a" strokeWidth="2.5" />
                  <rect x="14" y="20" width="12" height="14" fill="#7d2415" />
                </svg>
                <span className="disp text-2xl">Countryhack</span>
              </Link>
              <nav aria-label={t("main")} className="flex flex-wrap items-center gap-x-5 gap-y-2 text-base font-bold [&_a:not(.btn)]:inline-flex [&_a:not(.btn)]:min-h-11 [&_a:not(.btn)]:items-center [&_button]:min-h-11">
                <Link href="/events" className="hover:underline">{t("events")}</Link>
                <Link href="/faq" className="hover:underline">{t("faq")}</Link>
                <Link href="/crew" className="hover:underline">{t("crew")}</Link>
                {user ? (
                  <>
                    <Link href="/my" className="hover:underline">{t("myPages")}</Link>
                    <Link href="/profile" className="hover:underline">{t("profile")}</Link>
                    {isLeader && <Link href="/manage/events" className="hover:underline">{t("manageEvents")}</Link>}
                    {isCrewStaff && <Link href="/manage/crew" className="hover:underline">{t("manageCrew")}</Link>}
                    {isLeader && <Link href="/manage/faq" className="hover:underline">{t("manageFaq")}</Link>}
                    {isAdmin && <Link href="/admin/users" className="hover:underline">{t("admin")}</Link>}
                    <form action={logoutAction}>
                      <button type="submit" className="hover:underline">{t("logout")}</button>
                    </form>
                  </>
                ) : (
                  <>
                    <Link href="/login" className="hover:underline">{t("login")}</Link>
                    <Link href="/register" className="btn-ghost min-h-11 !py-1 text-base">{t("register")}</Link>
                  </>
                )}
                <LocaleSwitcher />
              </nav>
            </div>
          </header>
          <main id="main" className="mx-auto max-w-5xl px-4 py-8">
            {children}
          </main>
          <footer className="on-dark mt-10 bg-night text-paper print:hidden">
           <div className="mx-auto max-w-5xl space-y-2 px-4 py-10 text-sm text-sage">
            <p>
              {org.name}
              {org.orgNumber ? ` · ${org.orgNumber}` : ""}
              {org.address ? ` · ${org.address}` : ""}
            </p>
            <p>
              <Link href="/privacy" className="link text-hay">{t("privacy")}</Link>
            </p>
           </div>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
