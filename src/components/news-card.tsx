import type { NewsPost } from "@prisma/client";
import { getFormatter, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { excerpt, localisedPost } from "@/lib/news/service";

/** One news post as a card: picture, date, headline and the first paragraph. Used on the landing page and the news list. */
export async function NewsCard({ post, locale }: { post: NewsPost; locale: string }) {
  const f = await getFormatter();
  const t = await getTranslations("news");
  const text = localisedPost(post, locale);
  return (
    <article className="card flex flex-col gap-3 !p-0 overflow-hidden">
      {post.imagePath && (
        // eslint-disable-next-line @next/next/no-img-element -- uploaded picture, already size-limited
        <img src={post.imagePath} alt="" className="h-44 w-full border-b-2 border-ink object-cover" />
      )}
      <div className="flex grow flex-col gap-2 p-5">
        {post.publishedAt && <p className="font-mono text-xs font-bold text-slate-600">{f.dateTime(post.publishedAt, { dateStyle: "long" })}</p>}
        <h3 className="text-2xl font-extrabold leading-tight">
          <Link href={`/nyheter/${post.slug}`} className="no-underline hover:underline">{text.title}</Link>
        </h3>
        <p className="text-slate-700">{excerpt(text.body)}</p>
        <p className="mt-auto pt-2">
          <Link href={`/nyheter/${post.slug}`} className="link font-bold">{t("readMore")}<span className="sr-only">: {text.title}</span></Link>
        </p>
      </div>
    </article>
  );
}
