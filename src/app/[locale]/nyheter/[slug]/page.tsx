import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { excerpt, getNewsForViewer, isLive, localisedPost } from "@/lib/news/service";
import { can } from "@/lib/permissions";

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = await getNewsForViewer(await getCurrentUser(), slug);
  if (!post) return {};
  const text = localisedPost(post, locale);
  return { title: text.title, description: excerpt(text.body, 160) };
}

export default async function NewsPostPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const user = await getCurrentUser();
  const post = await getNewsForViewer(user, slug);
  if (!post) notFound();
  const t = await getTranslations("news");
  const f = await getFormatter();
  const text = localisedPost(post, locale);
  const live = isLive(post);

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <Link href="/nyheter" className="link text-sm">{t("back")}</Link>
      {!live && (
        <p role="note" className="card-hay !p-3 font-bold">
          {post.publishedAt ? t("scheduledNote", { when: f.dateTime(post.publishedAt, { dateStyle: "long", timeStyle: "short" }) }) : t("draftNote")}
        </p>
      )}
      <header className="space-y-3">
        {post.publishedAt && <p className="font-mono text-sm font-bold text-slate-600">{f.dateTime(post.publishedAt, { dateStyle: "long" })}</p>}
        <h1 className="disp text-4xl sm:text-5xl">{text.title}</h1>
      </header>
      {post.imagePath && (
        // eslint-disable-next-line @next/next/no-img-element -- uploaded picture, already size-limited
        <img src={post.imagePath} alt="" className="w-full rounded-[10px] border-2 border-ink object-cover shadow-sticker-lg" />
      )}
      <div className="space-y-4 whitespace-pre-line text-lg leading-relaxed">{text.body}</div>
      {can(user, "news:manage") && (
        <p>
          <Link href="/manage/news" className="btn-secondary">{t("manage")}</Link>
        </p>
      )}
    </article>
  );
}
