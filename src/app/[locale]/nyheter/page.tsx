import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { NewsCard } from "@/components/news-card";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { countPublishedNews, listPublishedNews } from "@/lib/news/service";
import { can } from "@/lib/permissions";

const PAGE_SIZE = 9;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "news" });
  return { title: t("title"), description: t("lead") };
}

export default async function NewsListPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ page?: string }> }) {
  const { locale } = await params;
  const { page: pageParam } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("news");
  const user = await getCurrentUser();
  const total = await countPublishedNews();
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(lastPage, Math.max(1, Number(pageParam) || 1));
  const posts = await listPublishedNews({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <p aria-hidden className="eyebrow text-barn">news</p>
        <h1 className="disp text-5xl sm:text-6xl">{t("title")}</h1>
        <p className="max-w-xl text-xl text-slate-700">{t("lead")}</p>
        {can(user, "news:manage") && (
          <p>
            <Link href="/manage/news" className="btn-secondary">{t("manage")}</Link>
          </p>
        )}
      </header>

      {posts.length === 0 ? (
        <p className="text-slate-600">{t("none")}</p>
      ) : (
        <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((p) => (
            <li key={p.id} className="flex">
              <div className="w-full">
                <NewsCard post={p} locale={locale} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {lastPage > 1 && (
        <nav aria-label={t("pages")} className="flex items-center gap-4">
          {page > 1 && <Link className="btn-secondary" href={{ pathname: "/nyheter", query: { page: page - 1 } }}>{t("newer")}</Link>}
          <span className="text-sm">{t("pageOf", { page, total: lastPage })}</span>
          {page < lastPage && <Link className="btn-secondary" href={{ pathname: "/nyheter", query: { page: page + 1 } }}>{t("older")}</Link>}
        </nav>
      )}
    </div>
  );
}
