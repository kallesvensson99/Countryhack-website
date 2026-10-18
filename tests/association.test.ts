import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  canViewDocument, cleanFileName, createBoardMember, deleteBoardMember, deleteDocument, groupDocuments, listBoardMembers, listDocumentsFor,
  localisedIntro, localisedRole, readDocument, updateAboutIntro, updateBoardMember, updateDocument, uploadDocument,
} from "@/lib/association/service";
import { ForbiddenError } from "@/lib/permissions";
import { DOC_KEY_PATTERN, KEY_PATTERN, LocalDiskStorage, setStorage, sniffDocument } from "@/lib/storage";
import { aboutIntroSchema, boardMemberSchema, documentSchema } from "@/lib/validation/crew";
import { asActor, makeUser, resetDb } from "./helpers";

const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
const doc = (over: Record<string, string> = {}) => documentSchema.parse({ title: "Styrelsemöte 1", category: "MINUTES", visibility: "LOGGED_IN", ...over });
const member = (over: Record<string, string> = {}) => boardMemberSchema.parse({ name: "Eva Ordförande", role: "Ordförande", ...over });

let dir: string;
const files = async () => (await readdir(path.join(dir, "documents")).catch(() => [])).sort();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ccss-docs-"));
  setStorage(new LocalDiskStorage(dir));
});
afterAll(async () => {
  setStorage(undefined);
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb();
  await rm(path.join(dir, "documents"), { recursive: true, force: true });
});

const leader = async () => asActor(await makeUser({ tags: ["FESTIVALLEDARE"] }));

describe("who may edit the association page", () => {
  it("Festivalledare and Admin; not Ansvarig or members", async () => {
    const fl = await leader();
    expect((await createBoardMember(fl, member())).ok).toBe(true);
    expect((await createBoardMember(asActor(await makeUser({ tags: ["ADMIN"] })), member())).ok).toBe(true);
    for (const tags of [["ANSVARIG"], []] as const) {
      const who = asActor(await makeUser({ tags: [...tags] }));
      await expect(createBoardMember(who, member())).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateAboutIntro(who, aboutIntroSchema.parse({ aboutIntroSv: "x" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(uploadDocument(who, doc(), { name: "a.pdf", data: pdf })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.boardMember.count()).toBe(2);
    expect(await db.associationDocument.count()).toBe(0);
  });
});

describe("intro", () => {
  it("is saved, audited and shown in the reader's language with a Swedish fallback", async () => {
    const fl = await leader();
    await db.orgSettings.findFirstOrThrow(); // created by resetDb
    await updateAboutIntro(fl, aboutIntroSchema.parse({ aboutIntroSv: "Hej från föreningen", aboutIntroEn: "" }), "1.2.3.4");
    const org = await db.orgSettings.findFirstOrThrow();
    expect(localisedIntro(org, "sv")).toBe("Hej från föreningen");
    expect(localisedIntro(org, "en")).toBe("Hej från föreningen"); // no English text: fall back
    await updateAboutIntro(fl, aboutIntroSchema.parse({ aboutIntroSv: "Hej", aboutIntroEn: "Hello" }));
    expect(localisedIntro(await db.orgSettings.findFirstOrThrow(), "en")).toBe("Hello");
    const logs = await db.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["association.intro.update", "association.intro.update"]);
    expect(logs[0]).toMatchObject({ actorId: fl.id, ip: "1.2.3.4" });
  });

  it("rejects an intro that is far too long", () => {
    expect(aboutIntroSchema.safeParse({ aboutIntroSv: "x".repeat(5001) }).success).toBe(false);
    expect(aboutIntroSchema.parse({})).toEqual({ aboutIntroSv: "", aboutIntroEn: "" });
  });
});

describe("board members", () => {
  it("creates, orders, edits and deletes with audit rows", async () => {
    const fl = await leader();
    const b = await createBoardMember(fl, member({ name: "B", role: "Kassör", sortOrder: "2" }));
    await createBoardMember(fl, member({ name: "A", role: "Ordförande", roleEn: "Chair", sortOrder: "1" }));
    expect((await listBoardMembers()).map((m) => m.name)).toEqual(["A", "B"]);
    if (!b.ok) throw new Error();
    expect((await updateBoardMember(fl, b.id, member({ name: "B2", role: "Kassör", sortOrder: "0" }))).ok).toBe(true);
    expect((await listBoardMembers()).map((m) => m.name)).toEqual(["B2", "A"]);
    expect(await updateBoardMember(fl, "nope", member())).toEqual({ ok: false, reason: "notFound" });
    expect((await deleteBoardMember(fl, b.id)).ok).toBe(true);
    expect(await deleteBoardMember(fl, b.id)).toEqual({ ok: false, reason: "notFound" });
    expect((await db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((l) => l.action)).toEqual([
      "association.board.create", "association.board.create", "association.board.update", "association.board.delete",
    ]);
  });

  it("shows the English role when there is one, else the Swedish", () => {
    expect(localisedRole({ role: "Ordförande", roleEn: "Chair" }, "en")).toBe("Chair");
    expect(localisedRole({ role: "Ordförande", roleEn: "" }, "en")).toBe("Ordförande");
    expect(localisedRole({ role: "Ordförande", roleEn: "Chair" }, "sv")).toBe("Ordförande");
  });

  it("validates name, role and the optional public email", () => {
    expect(boardMemberSchema.safeParse({ name: "", role: "x" }).success).toBe(false);
    expect(boardMemberSchema.safeParse({ name: "x", role: "" }).success).toBe(false);
    expect(boardMemberSchema.safeParse({ name: "x", role: "y", email: "not-an-email" }).success).toBe(false);
    expect(boardMemberSchema.parse({ name: "x", role: "y", email: "  Eva@Example.SE " }).email).toBe("eva@example.se");
    expect(boardMemberSchema.parse({ name: "x", role: "y" }).email).toBeNull();
  });
});

describe("document files", () => {
  it("recognises PDF and office files by their bytes, and nothing else", () => {
    expect(sniffDocument(pdf, "protokoll.pdf")).toMatchObject({ ext: "pdf", contentType: "application/pdf" });
    expect(sniffDocument(pdf, "protokoll.txt")).toMatchObject({ ext: "pdf" }); // the bytes decide for PDF
    expect(sniffDocument(zip, "Protokoll.DOCX")).toMatchObject({ ext: "docx" });
    expect(sniffDocument(zip, "a.odt")).toMatchObject({ ext: "odt" });
    expect(sniffDocument(ole, "gammalt.doc")).toMatchObject({ ext: "doc" });
    expect(sniffDocument(zip, "a.exe")).toBeNull(); // a zip is only accepted with an office extension
    expect(sniffDocument(zip, "a.zip")).toBeNull();
    expect(sniffDocument(Buffer.from("<html><script>alert(1)</script></html>"), "a.pdf")).toBeNull();
    expect(sniffDocument(Buffer.from("MZ\x90\x00 exe"), "virus.docx")).toBeNull();
    expect(sniffDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]), "scan.png")).toBeNull();
  });

  it("document keys can never be served by the public image route", () => {
    expect(DOC_KEY_PATTERN.test("documents/" + "a".repeat(32) + ".pdf")).toBe(true);
    expect(KEY_PATTERN.test("documents/" + "a".repeat(32) + ".pdf")).toBe(false);
    expect(DOC_KEY_PATTERN.test("documents/../x.pdf")).toBe(false);
    expect(DOC_KEY_PATTERN.test("events/" + "a".repeat(32) + ".pdf")).toBe(false);
    expect(DOC_KEY_PATTERN.test("documents/" + "a".repeat(32) + ".png")).toBe(false);
  });

  it("uploads, stores privately, records metadata and audits without file contents", async () => {
    const fl = await leader();
    const r = await uploadDocument(fl, doc({ docDate: "2026-09-12" }), { name: "../../Styrelsemöte sep.pdf", data: pdf }, "9.9.9.9");
    if (!r.ok) throw new Error(JSON.stringify(r));
    const row = await db.associationDocument.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ title: "Styrelsemöte 1", category: "MINUTES", visibility: "LOGGED_IN", contentType: "application/pdf", sizeBytes: pdf.length, uploadedById: fl.id });
    expect(row.fileName).toBe("Styrelsemöte sep.pdf"); // no path parts
    expect(row.docDate?.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(row.storageKey).toMatch(DOC_KEY_PATTERN);
    expect(await files()).toHaveLength(1);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "association.document.upload" } });
    expect(log).toMatchObject({ actorId: fl.id, ip: "9.9.9.9" });
  });

  it("refuses wrong or oversized files and leaves nothing behind", async () => {
    const fl = await leader();
    expect(await uploadDocument(fl, doc(), { name: "x.pdf", data: Buffer.from("not a pdf") })).toEqual({ ok: false, reason: "badFile" });
    expect(await uploadDocument(fl, doc(), { name: "x.pdf", data: Buffer.concat([pdf, Buffer.alloc(15 * 1024 * 1024)]) })).toEqual({ ok: false, reason: "tooLarge" });
    expect(await db.associationDocument.count()).toBe(0);
    expect(await files()).toHaveLength(0);
  });

  it("edits the details, and deleting removes the file", async () => {
    const fl = await leader();
    const r = await uploadDocument(fl, doc(), { name: "a.pdf", data: pdf });
    if (!r.ok) throw new Error();
    expect((await updateDocument(fl, r.id, doc({ title: "Nytt namn", visibility: "PUBLIC" }))).ok).toBe(true);
    expect(await db.associationDocument.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ title: "Nytt namn", visibility: "PUBLIC" });
    expect(await updateDocument(fl, "nope", doc())).toEqual({ ok: false, reason: "notFound" });
    expect((await deleteDocument(fl, r.id)).ok).toBe(true);
    expect(await files()).toHaveLength(0);
    expect(await deleteDocument(fl, r.id)).toEqual({ ok: false, reason: "notFound" });
  });

  it("validates title, category, visibility and date", () => {
    expect(documentSchema.safeParse({ title: "", category: "MINUTES", visibility: "PUBLIC" }).success).toBe(false);
    expect(documentSchema.safeParse({ title: "x", category: "NOPE", visibility: "PUBLIC" }).success).toBe(false);
    expect(documentSchema.safeParse({ title: "x", category: "MINUTES", visibility: "EVERYONE" }).success).toBe(false);
    expect(documentSchema.safeParse({ title: "x", category: "MINUTES", visibility: "PUBLIC", docDate: "2026-02-30" }).success).toBe(false);
    expect(documentSchema.safeParse({ title: "x", category: "MINUTES", visibility: "PUBLIC", docDate: "12/09/2026" }).success).toBe(false);
    expect(documentSchema.parse({ title: "x", category: "MINUTES", visibility: "PUBLIC" }).docDate).toBeNull();
  });

  it("sanitises file names", () => {
    expect(cleanFileName("C:\\temp\\a b.pdf")).toBe("a b.pdf");
    expect(cleanFileName('x"<>:|?*y.pdf')).toBe("x_y.pdf");
    expect(cleanFileName("")).toBe("dokument");
    expect(cleanFileName("a".repeat(300) + ".pdf").length).toBeLessThanOrEqual(120);
  });
});

describe("who may see and download a document", () => {
  async function setup() {
    const fl = await leader();
    const mk = async (title: string, visibility: string) => {
      const r = await uploadDocument(fl, doc({ title, visibility }), { name: `${title}.pdf`, data: pdf });
      if (!r.ok) throw new Error();
      return r.id;
    };
    const ids = { pub: await mk("Offentligt", "PUBLIC"), login: await mk("Inloggade", "LOGGED_IN"), staff: await mk("Ledare", "STAFF") };
    return { fl, ids, member: asActor(await makeUser()) };
  }

  it("lists by viewer: visitors see public only, members public + logged-in, Festivalledare everything", async () => {
    const { fl, member } = await setup();
    const names = async (v: Parameters<typeof listDocumentsFor>[0]) => (await listDocumentsFor(v)).docs.map((d) => d.title).sort();
    expect(await names(null)).toEqual(["Offentligt"]);
    expect((await listDocumentsFor(null)).hidden).toBe(2);
    expect(await names(member)).toEqual(["Inloggade", "Offentligt"]);
    expect((await listDocumentsFor(member)).hidden).toBe(1);
    expect(await names(fl)).toEqual(["Inloggade", "Ledare", "Offentligt"]);
    expect(await names(asActor(await makeUser({ tags: ["ADMIN"] })))).toEqual(["Inloggade", "Ledare", "Offentligt"]); // an Admin holds every right, staff documents included
  });

  it("downloads are enforced per document; a hidden one looks exactly like a missing one", async () => {
    const { fl, ids, member } = await setup();
    expect((await readDocument(null, ids.pub))?.data.equals(pdf)).toBe(true);
    expect(await readDocument(null, ids.login)).toBeNull();
    expect(await readDocument(null, ids.staff)).toBeNull();
    expect(await readDocument(member, ids.login)).not.toBeNull();
    expect(await readDocument(member, ids.staff)).toBeNull();
    expect(await readDocument(fl, ids.staff)).not.toBeNull();
    expect(await readDocument(fl, "missing")).toBeNull();
  });

  it("a file that has gone missing from storage gives null, not an error", async () => {
    const { fl, ids } = await setup();
    await rm(path.join(dir, "documents"), { recursive: true, force: true });
    expect(await readDocument(fl, ids.pub)).toBeNull();
  });

  it("canViewDocument mirrors the rules", async () => {
    const fl = await leader();
    const member = asActor(await makeUser());
    expect(canViewDocument(null, { visibility: "PUBLIC" })).toBe(true);
    expect(canViewDocument(null, { visibility: "LOGGED_IN" })).toBe(false);
    expect(canViewDocument(member, { visibility: "LOGGED_IN" })).toBe(true);
    expect(canViewDocument(member, { visibility: "STAFF" })).toBe(false);
    expect(canViewDocument(fl, { visibility: "STAFF" })).toBe(true);
  });

  it("groups by category in a fixed order", async () => {
    const fl = await leader();
    for (const [title, category] of [["Övrigt 1", "OTHER"], ["Protokoll 1", "MINUTES"], ["Stadgar", "BYLAWS"], ["Protokoll 2", "MINUTES"]] as const) {
      await uploadDocument(fl, doc({ title, category, visibility: "PUBLIC" }), { name: "a.pdf", data: pdf });
    }
    const groups = groupDocuments((await listDocumentsFor(null)).docs);
    expect(groups.map((g) => [g.category, g.docs.length])).toEqual([["MINUTES", 2], ["BYLAWS", 1], ["OTHER", 1]]);
  });
});
