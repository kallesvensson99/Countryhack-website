import type { NewsPost, Prisma } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { slugify } from "../events/service";
import { can, assertCan, type Actor } from "../permissions";
import { getStorage, MAX_IMAGE_BYTES, sniffImage } from "../storage";
import type { NewsPostInput } from "../validation/news";

type Tx = Prisma.TransactionClient;
type Fail<R extends string> = { ok: false; reason: R };
const FIELDS = ["title", "titleEn", "body", "bodyEn", "publishedAt", "imagePath"] as const;
const keyOf = (p: string) => p.replace(/^\/uploads\//, "");

export const isLive = (p: Pick<NewsPost, "publishedAt">, now = new Date()) => !!p.publishedAt && p.publishedAt <= now;

/** Title / body in the reader's language; an empty English text falls back to Swedish. */
export function localisedPost(p: Pick<NewsPost, "title" | "titleEn" | "body" | "bodyEn">, locale: string) {
  const en = locale === "en";
  return { title: (en && p.titleEn) || p.title, body: (en && p.bodyEn) || p.body };
}

/** First paragraph, cut at a word boundary: what the list and the landing page show. */
export function excerpt(body: string, max = 220): string {
  const first = (body.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30)).trimEnd()}…`;
}

const livePosts = (now: Date): Prisma.NewsPostWhereInput => ({ publishedAt: { not: null, lte: now } });

/** Published posts, newest first. */
export function listPublishedNews(opts: { limit: number; offset?: number; now?: Date }) {
  const now = opts.now ?? new Date();
  return db.newsPost.findMany({ where: livePosts(now), orderBy: { publishedAt: "desc" }, take: opts.limit, skip: opts.offset ?? 0 });
}

export function countPublishedNews(now = new Date()) {
  return db.newsPost.count({ where: livePosts(now) });
}

/** A post by slug, or null when it doesn't exist or the viewer may not see it (drafts and scheduled posts: staff only). */
export async function getNewsForViewer(viewer: Actor | null, slug: string, now = new Date()) {
  const post = await db.newsPost.findUnique({ where: { slug } });
  if (!post) return null;
  if (isLive(post, now) || can(viewer, "news:manage")) return post;
  return null;
}

/** Everything, drafts and scheduled posts included, for the management page. */
export async function listAllNews(actor: Actor) {
  assertCan(actor, "news:manage");
  return db.newsPost.findMany({ orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }] });
}

async function uniqueSlug(tx: Tx, title: string): Promise<string> {
  const base = slugify(title).replace(/^event$/, "nyhet");
  const taken = new Set((await tx.newsPost.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((p) => p.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function storeImage(data: Buffer): Promise<{ ok: true; path: string } | Fail<"badImage" | "tooLarge">> {
  if (data.length > MAX_IMAGE_BYTES) return { ok: false, reason: "tooLarge" };
  const kind = sniffImage(data);
  if (!kind) return { ok: false, reason: "badImage" };
  return { ok: true, path: `/uploads/${await getStorage().save("news", kind.ext, data)}` };
}

/** Ticked + a date = that date (a future date schedules it); ticked + no date = now (or the date it already has); unticked = draft. */
function resolvePublishedAt(input: Pick<NewsPostInput, "published" | "publishedAt">, current: Date | null, now: Date): Date | null {
  if (!input.published) return null;
  return input.publishedAt ?? current ?? now;
}

export async function createPost(actor: Actor, input: NewsPostInput, image?: Buffer, ip?: string | null, now = new Date()): Promise<{ ok: true; id: string; slug: string } | Fail<"badImage" | "tooLarge">> {
  assertCan(actor, "news:manage");
  let imagePath: string | null = null;
  if (image) {
    const stored = await storeImage(image);
    if (!stored.ok) return stored;
    imagePath = stored.path;
  }
  try {
    return await db.$transaction(async (tx) => {
      const post = await tx.newsPost.create({
        data: {
          slug: await uniqueSlug(tx, input.title),
          title: input.title,
          titleEn: input.titleEn,
          body: input.body,
          bodyEn: input.bodyEn,
          imagePath,
          publishedAt: resolvePublishedAt(input, null, now),
          createdById: actor.id,
        },
      });
      await writeAudit(tx, { actorId: actor.id, action: "news.create", entityType: "NewsPost", entityId: post.id, diff: { title: { from: null, to: post.title }, publishedAt: { from: null, to: post.publishedAt?.toISOString() ?? null } }, ip });
      return { ok: true as const, id: post.id, slug: post.slug };
    });
  } catch (e) {
    if (imagePath) await getStorage().delete(keyOf(imagePath));
    throw e;
  }
}

/** `image` replaces the current picture; `input.removeImage` removes it. The slug never changes, so links keep working. */
export async function updatePost(actor: Actor, id: string, input: NewsPostInput, image?: Buffer, ip?: string | null, now = new Date()): Promise<{ ok: true } | Fail<"notFound" | "badImage" | "tooLarge">> {
  assertCan(actor, "news:manage");
  const before = await db.newsPost.findUnique({ where: { id } });
  if (!before) return { ok: false, reason: "notFound" };
  let imagePath = before.imagePath;
  if (image) {
    const stored = await storeImage(image);
    if (!stored.ok) return stored;
    imagePath = stored.path;
  } else if (input.removeImage) {
    imagePath = null;
  }
  await db.$transaction(async (tx) => {
    const after = await tx.newsPost.update({
      where: { id },
      data: { title: input.title, titleEn: input.titleEn, body: input.body, bodyEn: input.bodyEn, imagePath, publishedAt: resolvePublishedAt(input, before.publishedAt, now) },
    });
    await writeAudit(tx, { actorId: actor.id, action: "news.update", entityType: "NewsPost", entityId: id, diff: diffObjects(before, after, FIELDS), ip });
  });
  if (before.imagePath && before.imagePath !== imagePath) await getStorage().delete(keyOf(before.imagePath));
  return { ok: true };
}

export async function deletePost(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "news:manage");
  const before = await db.newsPost.findUnique({ where: { id } });
  if (!before) return { ok: false, reason: "notFound" };
  await db.$transaction(async (tx) => {
    await tx.newsPost.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "news.delete", entityType: "NewsPost", entityId: id, diff: { title: { from: before.title, to: null } }, ip });
  });
  if (before.imagePath) await getStorage().delete(keyOf(before.imagePath));
  return { ok: true };
}
