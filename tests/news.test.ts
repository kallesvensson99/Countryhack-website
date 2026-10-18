import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { countPublishedNews, createPost, deletePost, excerpt, getNewsForViewer, isLive, listAllNews, listPublishedNews, localisedPost, updatePost } from "@/lib/news/service";
import { ForbiddenError } from "@/lib/permissions";
import { LocalDiskStorage, setStorage } from "@/lib/storage";
import { newsPostSchema } from "@/lib/validation/news";
import { asActor, makeUser, resetDb } from "./helpers";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const NOW = new Date("2026-10-17T12:00:00Z");
const post = (over: Record<string, string> = {}) => newsPostSchema.parse({ title: "Biljetterna är släppta", body: "Första stycket.\n\nAndra stycket.", published: "on", ...over });

let dir: string;
const files = async () => (await readdir(path.join(dir, "news")).catch(() => [])).sort();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ccss-news-"));
  setStorage(new LocalDiskStorage(dir));
});
afterAll(async () => {
  setStorage(undefined);
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb();
  await rm(path.join(dir, "news"), { recursive: true, force: true });
});

const leader = async () => asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));

describe("who may write news", () => {
  it("Festivalledare and Admin; not Ansvarig or members", async () => {
    const fl = await leader();
    expect((await createPost(fl, post(), undefined, null, NOW)).ok).toBe(true);
    expect((await createPost(asActor(await makeUser({ tags: ["ADMIN"] })), post(), undefined, null, NOW)).ok).toBe(true);
    for (const tags of [["ANSVARIG"], []] as const) {
      const who = asActor(await makeUser({ tags: [...tags] }));
      await expect(createPost(who, post())).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listAllNews(who)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.newsPost.count()).toBe(2);
  });
});

describe("publishing", () => {
  it("a ticked post without a date is published now; unticked is a draft; a future date schedules it", async () => {
    const fl = await leader();
    const live = await createPost(fl, post({ title: "Nu" }), undefined, null, NOW);
    const draft = await createPost(fl, post({ title: "Utkast", published: "" }), undefined, null, NOW);
    const later = await createPost(fl, post({ title: "Senare", publishedAt: "2026-12-01T09:00" }), undefined, null, NOW);
    if (!live.ok || !draft.ok || !later.ok) throw new Error();
    const rows = Object.fromEntries((await db.newsPost.findMany()).map((p) => [p.title, p]));
    expect(rows["Nu"]!.publishedAt?.toISOString()).toBe(NOW.toISOString());
    expect(rows["Utkast"]!.publishedAt).toBeNull();
    expect(rows["Senare"]!.publishedAt?.toISOString()).toBe("2026-12-01T08:00:00.000Z"); // 09:00 Stockholm (winter time)

    const visible = async () => (await listPublishedNews({ limit: 10, now: NOW })).map((p) => p.title);
    expect(await visible()).toEqual(["Nu"]);
    expect(await countPublishedNews(NOW)).toBe(1);
    expect(isLive(rows["Senare"]!, NOW)).toBe(false);
    expect(isLive(rows["Senare"]!, new Date("2026-12-01T08:00:01Z"))).toBe(true);
    expect((await listPublishedNews({ limit: 10, now: new Date("2027-01-01T00:00:00Z") })).map((p) => p.title).sort()).toEqual(["Nu", "Senare"]);
  });

  it("lists newest first and pages", async () => {
    const fl = await leader();
    for (const [title, at] of [["A", "2026-01-01T10:00"], ["B", "2026-03-01T10:00"], ["C", "2026-02-01T10:00"]] as const) {
      await createPost(fl, post({ title, publishedAt: at }), undefined, null, NOW);
    }
    expect((await listPublishedNews({ limit: 10, now: NOW })).map((p) => p.title)).toEqual(["B", "C", "A"]);
    expect((await listPublishedNews({ limit: 1, offset: 1, now: NOW })).map((p) => p.title)).toEqual(["C"]);
  });

  it("editing keeps the date of an already published post, unpublishing makes it a draft, republishing sets a new time", async () => {
    const fl = await leader();
    const r = await createPost(fl, post({ publishedAt: "2026-05-01T10:00" }), undefined, null, NOW);
    if (!r.ok) throw new Error();
    const at = (await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).publishedAt!.toISOString();
    await updatePost(fl, r.id, post({ title: "Ändrad rubrik" }), undefined, null, new Date("2026-10-20T00:00:00Z")); // ticked, no date: keep
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).publishedAt!.toISOString()).toBe(at);
    await updatePost(fl, r.id, post({ published: "" }), undefined, null, NOW);
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).publishedAt).toBeNull();
    await updatePost(fl, r.id, post(), undefined, null, NOW); // ticked again with no date: now
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).publishedAt!.toISOString()).toBe(NOW.toISOString());
  });
});

describe("who can read a post", () => {
  it("drafts and scheduled posts are staff-only; others get null", async () => {
    const fl = await leader();
    const member = asActor(await makeUser());
    const live = await createPost(fl, post({ title: "Live" }), undefined, null, NOW);
    const draft = await createPost(fl, post({ title: "Utkast", published: "" }), undefined, null, NOW);
    const sched = await createPost(fl, post({ title: "Planerad", publishedAt: "2099-01-01T10:00" }), undefined, null, NOW);
    if (!live.ok || !draft.ok || !sched.ok) throw new Error();
    for (const viewer of [null, member]) {
      expect((await getNewsForViewer(viewer, live.slug, NOW))?.title).toBe("Live");
      expect(await getNewsForViewer(viewer, draft.slug, NOW)).toBeNull();
      expect(await getNewsForViewer(viewer, sched.slug, NOW)).toBeNull();
    }
    expect((await getNewsForViewer(fl, draft.slug, NOW))?.title).toBe("Utkast");
    expect((await getNewsForViewer(fl, sched.slug, NOW))?.title).toBe("Planerad");
    expect(await getNewsForViewer(fl, "finns-inte", NOW)).toBeNull();
  });
});

describe("slugs", () => {
  it("come from the title, are unique, and stay put when the title changes", async () => {
    const fl = await leader();
    const a = await createPost(fl, post({ title: "Åsa & Örjan öppnar kök!" }), undefined, null, NOW);
    const b = await createPost(fl, post({ title: "Åsa & Örjan öppnar kök!" }), undefined, null, NOW);
    const c = await createPost(fl, post({ title: "!!!" }), undefined, null, NOW);
    if (!a.ok || !b.ok || !c.ok) throw new Error();
    expect(a.slug).toBe("asa-orjan-oppnar-kok");
    expect(b.slug).toBe("asa-orjan-oppnar-kok-2");
    expect(c.slug).toBe("nyhet");
    await updatePost(fl, a.id, post({ title: "Helt ny rubrik" }), undefined, null, NOW);
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: a.id } })).slug).toBe("asa-orjan-oppnar-kok");
  });
});

describe("pictures", () => {
  it("stores, replaces, removes and deletes the file together with the post", async () => {
    const fl = await leader();
    const r = await createPost(fl, post(), png, null, NOW);
    if (!r.ok) throw new Error();
    const first = (await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).imagePath!;
    expect(first).toMatch(/^\/uploads\/news\/[a-f0-9]{32}\.png$/);
    expect(await files()).toHaveLength(1);

    await updatePost(fl, r.id, post({ title: "Ny rubrik" }), undefined, null, NOW); // no new picture: kept
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).imagePath).toBe(first);

    await updatePost(fl, r.id, post(), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]), null, NOW); // replaced
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).imagePath).toMatch(/\.jpg$/);
    expect(await files()).toHaveLength(1);

    await updatePost(fl, r.id, post({ removeImage: "on" }), undefined, null, NOW);
    expect((await db.newsPost.findUniqueOrThrow({ where: { id: r.id } })).imagePath).toBeNull();
    expect(await files()).toHaveLength(0);

    const r2 = await createPost(fl, post({ title: "Med bild" }), png, null, NOW);
    if (!r2.ok) throw new Error();
    expect(await files()).toHaveLength(1);
    expect((await deletePost(fl, r2.id)).ok).toBe(true);
    expect(await files()).toHaveLength(0);
  });

  it("refuses anything that is not an image or is too large, and creates nothing", async () => {
    const fl = await leader();
    expect(await createPost(fl, post(), Buffer.from("<svg onload=alert(1)>"))).toEqual({ ok: false, reason: "badImage" });
    expect(await createPost(fl, post(), Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).toEqual({ ok: false, reason: "tooLarge" });
    expect(await db.newsPost.count()).toBe(0);
    expect(await files()).toHaveLength(0);
  });
});

describe("edit and delete", () => {
  it("audits changes, reports unknown ids, and deletes", async () => {
    const fl = await leader();
    const r = await createPost(fl, post(), undefined, "1.2.3.4", NOW);
    if (!r.ok) throw new Error();
    expect((await updatePost(fl, r.id, post({ body: "Nytt innehåll." }))).ok).toBe(true);
    expect(await updatePost(fl, "nope", post())).toEqual({ ok: false, reason: "notFound" });
    expect((await deletePost(fl, r.id)).ok).toBe(true);
    expect(await deletePost(fl, r.id)).toEqual({ ok: false, reason: "notFound" });
    const logs = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["news.create", "news.update", "news.delete"]);
    expect(logs[0]).toMatchObject({ actorId: fl.id, ip: "1.2.3.4" });
  });
});

describe("text helpers and validation", () => {
  it("shows English when present, Swedish otherwise", () => {
    const p = { title: "Rubrik", titleEn: "", body: "Text", bodyEn: "" };
    expect(localisedPost(p, "en")).toEqual({ title: "Rubrik", body: "Text" });
    expect(localisedPost({ ...p, titleEn: "Headline", bodyEn: "Body" }, "en")).toEqual({ title: "Headline", body: "Body" });
    expect(localisedPost({ ...p, titleEn: "Headline", bodyEn: "Body" }, "sv")).toEqual({ title: "Rubrik", body: "Text" });
  });

  it("the summary is the first paragraph, cut at a word", () => {
    expect(excerpt("Kort.\n\nAndra stycket.")).toBe("Kort.");
    const long = `${"ord ".repeat(100)}slut`;
    const e = excerpt(long, 50);
    expect(e.length).toBeLessThanOrEqual(51);
    expect(e.endsWith("…")).toBe(true);
    expect(e).not.toMatch(/\sor…$/); // no half word before the ellipsis
    expect(excerpt("  \n  ")).toBe("");
  });

  it("validates headline, text, and the publish time", () => {
    expect(newsPostSchema.safeParse({ title: "", body: "x" }).success).toBe(false);
    expect(newsPostSchema.safeParse({ title: "x", body: "" }).success).toBe(false);
    expect(newsPostSchema.safeParse({ title: "x".repeat(151), body: "y" }).success).toBe(false);
    expect(newsPostSchema.safeParse({ title: "x", body: "y", publishedAt: "i morgon" }).success).toBe(false);
    const parsed = newsPostSchema.parse({ title: "x", body: "y" });
    expect(parsed).toMatchObject({ published: false, removeImage: false });
    expect(parsed.publishedAt).toBeUndefined();
  });
});
