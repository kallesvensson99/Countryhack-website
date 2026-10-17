import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { deleteNewsAction } from "@/actions/news";
import { ActionButton } from "@/components/form";
import { NewsForm } from "@/components/news-forms";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { isLive, listAllNews } from "@/lib/news/service";
import { toStockholmInput } from "@/lib/time";

export default async function ManageNewsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const actor = await requirePage("news:manage");
  const t = await getTranslations("newsManage");
  const f = await getFormatter();
  const posts = await listAllNews(actor);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{t("lead")}</p>
        <p className="text-sm">
          <Link href="/nyheter" className="link">{t("viewPage")}</Link>
        </p>
      </header>

      <section className="card" aria-labelledby="new-news-h">
        <h2 id="new-news-h" className="disp mb-4 text-3xl">{t("newPost")}</h2>
        <NewsForm />
      </section>

      {posts.length === 0 && <p className="text-slate-600">{t("none")}</p>}
      <ul className="space-y-4">
        {posts.map((p) => {
          const live = isLive(p);
          return (
            <li key={p.id} className="card !p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-xl font-extrabold leading-tight">
                    <Link href={`/nyheter/${p.slug}`} className="no-underline hover:underline">{p.title}</Link>
                  </p>
                  {p.publishedAt && <p className="font-mono text-xs font-bold text-slate-600">{f.dateTime(p.publishedAt, { dateStyle: "medium", timeStyle: "short" })}</p>}
                </div>
                <span className={live ? "tag-sage" : "tag-hay"}>{live ? t("statusLive") : p.publishedAt ? t("statusScheduled") : t("statusDraft")}</span>
              </div>
              <details className="mt-3">
                <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {p.title}</span></summary>
                <div className="mt-4 space-y-4">
                  <NewsForm
                    defaults={{
                      id: p.id,
                      title: p.title,
                      titleEn: p.titleEn,
                      body: p.body,
                      bodyEn: p.bodyEn,
                      published: !!p.publishedAt,
                      publishedAt: p.publishedAt ? toStockholmInput(p.publishedAt) : "",
                      hasImage: !!p.imagePath,
                    }}
                  />
                  <ActionButton action={deleteNewsAction} fields={{ id: p.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
