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

export const metadata: Metadata = { title: { default: "CCSS LAN", template: "%s · CCSS LAN" } };

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

  return (
    <html lang={locale}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-3">
          {(await getTranslations("common"))("skipToContent")}
        </a>
        <NextIntlClientProvider messages={messages}>
          <header className="border-b border-slate-200 bg-white print:hidden">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
              <Link href="/" className="text-lg font-bold">CCSS LAN</Link>
              <nav aria-label={t("main")} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <Link href="/events" className="hover:underline">{t("events")}</Link>
                {user ? (
                  <>
                    <Link href="/my" className="hover:underline">{t("myPages")}</Link>
                    <Link href="/profile" className="hover:underline">{t("profile")}</Link>
                    {isLeader && <Link href="/manage/events" className="hover:underline">{t("manageEvents")}</Link>}
                    {isAdmin && <Link href="/admin/users" className="hover:underline">{t("admin")}</Link>}
                    <form action={logoutAction}>
                      <button type="submit" className="hover:underline">{t("logout")}</button>
                    </form>
                  </>
                ) : (
                  <>
                    <Link href="/login" className="hover:underline">{t("login")}</Link>
                    <Link href="/register" className="btn">{t("register")}</Link>
                  </>
                )}
                <LocaleSwitcher />
              </nav>
            </div>
          </header>
          <main id="main" className="mx-auto max-w-5xl px-4 py-8">
            {children}
          </main>
          <footer className="mx-auto max-w-5xl px-4 pb-10 text-sm text-slate-600 print:hidden">
            <p>
              {org.name}
              {org.orgNumber ? ` · ${org.orgNumber}` : ""}
              {org.address ? ` · ${org.address}` : ""}
            </p>
            <p>
              <Link href="/privacy" className="link">{t("privacy")}</Link>
            </p>
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
