import type { AssociationDocument, BoardMember, DocCategory, DocVisibility } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { getOrgSettings } from "../auth/service";
import { can, assertCan, type Actor } from "../permissions";
import { DOC_KEY_PATTERN, getStorage, MAX_DOCUMENT_BYTES, sniffDocument } from "../storage";
import type { AboutIntroInput, BoardMemberInput, DocumentInput } from "../validation/crew";

type Fail<R extends string> = { ok: false; reason: R };
const MEMBER_FIELDS = ["name", "role", "roleEn", "email", "sortOrder"] as const;
const DOC_FIELDS = ["title", "category", "docDate", "visibility", "fileName"] as const;

export const CATEGORY_ORDER: DocCategory[] = ["MINUTES", "BYLAWS", "REPORT", "OTHER"];

// ───────────── intro ─────────────

/** Intro text in the reader's language; an empty English text falls back to Swedish. */
export function localisedIntro(org: { aboutIntroSv: string; aboutIntroEn: string }, locale: string): string {
  return ((locale === "en" && org.aboutIntroEn) || org.aboutIntroSv).trim();
}

export async function updateAboutIntro(actor: Actor, input: AboutIntroInput, ip?: string | null): Promise<{ ok: true }> {
  assertCan(actor, "association:manage");
  const before = await getOrgSettings();
  await db.$transaction(async (tx) => {
    const after = await tx.orgSettings.update({ where: { id: before.id }, data: input });
    await writeAudit(tx, { actorId: actor.id, action: "association.intro.update", entityType: "OrgSettings", entityId: after.id, diff: diffObjects(before, after, ["aboutIntroSv", "aboutIntroEn"]), ip });
  });
  return { ok: true };
}

// ───────────── board ─────────────

export function listBoardMembers(): Promise<BoardMember[]> {
  return db.boardMember.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

export const localisedRole = (m: Pick<BoardMember, "role" | "roleEn">, locale: string) => (locale === "en" && m.roleEn) || m.role;

export async function createBoardMember(actor: Actor, input: BoardMemberInput, ip?: string | null): Promise<{ ok: true; id: string }> {
  assertCan(actor, "association:manage");
  return db.$transaction(async (tx) => {
    const m = await tx.boardMember.create({ data: input });
    await writeAudit(tx, { actorId: actor.id, action: "association.board.create", entityType: "BoardMember", entityId: m.id, diff: { name: { from: null, to: m.name }, role: { from: null, to: m.role } }, ip });
    return { ok: true as const, id: m.id };
  });
}

export async function updateBoardMember(actor: Actor, id: string, input: BoardMemberInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "association:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.boardMember.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    const after = await tx.boardMember.update({ where: { id }, data: input });
    await writeAudit(tx, { actorId: actor.id, action: "association.board.update", entityType: "BoardMember", entityId: id, diff: diffObjects(before, after, MEMBER_FIELDS), ip });
    return { ok: true as const };
  });
}

export async function deleteBoardMember(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "association:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.boardMember.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    await tx.boardMember.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "association.board.delete", entityType: "BoardMember", entityId: id, diff: { name: { from: before.name, to: null } }, ip });
    return { ok: true as const };
  });
}

// ───────────── documents ─────────────

/** May this viewer download this document? PUBLIC: everyone; LOGGED_IN: any logged-in account; STAFF: Festivalledare. */
export function canViewDocument(viewer: Actor | null, doc: Pick<AssociationDocument, "visibility">): boolean {
  if (doc.visibility === "PUBLIC") return true;
  if (!viewer) return false;
  if (doc.visibility === "LOGGED_IN") return true;
  return can(viewer, "association:manage");
}

const VISIBILITIES_FOR = (viewer: Actor | null): DocVisibility[] => (!viewer ? ["PUBLIC"] : can(viewer, "association:manage") ? ["PUBLIC", "LOGGED_IN", "STAFF"] : ["PUBLIC", "LOGGED_IN"]);

/** Documents the viewer may see, newest first within each category's list. `hidden` = how many more exist for someone with more access. */
export async function listDocumentsFor(viewer: Actor | null): Promise<{ docs: AssociationDocument[]; hidden: number }> {
  const all = await db.associationDocument.findMany({ orderBy: [{ docDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] });
  const visible = VISIBILITIES_FOR(viewer);
  const docs = all.filter((d) => visible.includes(d.visibility));
  return { docs, hidden: all.length - docs.length };
}

export function groupDocuments(docs: AssociationDocument[]) {
  return CATEGORY_ORDER.map((category) => ({ category, docs: docs.filter((d) => d.category === category) })).filter((g) => g.docs.length > 0);
}

/** Keeps only a safe, readable file name for headers and downloads. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "dokument";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*\\]+/g, "_").trim().slice(0, 120);
  return cleaned || "dokument";
}

export async function uploadDocument(actor: Actor, input: DocumentInput, file: { name: string; data: Buffer }, ip?: string | null): Promise<{ ok: true; id: string } | Fail<"badFile" | "tooLarge">> {
  assertCan(actor, "association:manage");
  if (file.data.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: "tooLarge" };
  const kind = sniffDocument(file.data, file.name);
  if (!kind) return { ok: false, reason: "badFile" };
  const storageKey = await getStorage().save("documents", kind.ext, file.data);
  try {
    return await db.$transaction(async (tx) => {
      const doc = await tx.associationDocument.create({
        data: { ...input, storageKey, fileName: cleanFileName(file.name), contentType: kind.contentType, sizeBytes: file.data.length, uploadedById: actor.id },
      });
      await writeAudit(tx, { actorId: actor.id, action: "association.document.upload", entityType: "AssociationDocument", entityId: doc.id, diff: { title: { from: null, to: doc.title }, visibility: { from: null, to: doc.visibility } }, ip });
      return { ok: true as const, id: doc.id };
    });
  } catch (e) {
    await getStorage().delete(storageKey); // don't leave an orphan file behind
    throw e;
  }
}

export async function updateDocument(actor: Actor, id: string, input: DocumentInput, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "association:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.associationDocument.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    const after = await tx.associationDocument.update({ where: { id }, data: input });
    await writeAudit(tx, { actorId: actor.id, action: "association.document.update", entityType: "AssociationDocument", entityId: id, diff: diffObjects(before, after, DOC_FIELDS), ip });
    return { ok: true as const };
  });
}

export async function deleteDocument(actor: Actor, id: string, ip?: string | null): Promise<{ ok: true } | Fail<"notFound">> {
  assertCan(actor, "association:manage");
  const before = await db.associationDocument.findUnique({ where: { id } });
  if (!before) return { ok: false, reason: "notFound" };
  await db.$transaction(async (tx) => {
    await tx.associationDocument.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "association.document.delete", entityType: "AssociationDocument", entityId: id, diff: { title: { from: before.title, to: null } }, ip });
  });
  await getStorage().delete(before.storageKey);
  return { ok: true };
}

/** The bytes of a document the viewer may see, or null (missing, not allowed, or file gone). A hidden document looks exactly like a missing one. */
export async function readDocument(viewer: Actor | null, id: string): Promise<{ doc: AssociationDocument; data: Buffer } | null> {
  const doc = await db.associationDocument.findUnique({ where: { id } });
  if (!doc || !canViewDocument(viewer, doc) || !DOC_KEY_PATTERN.test(doc.storageKey)) return null;
  const data = await getStorage().read(doc.storageKey);
  return data ? { doc, data } : null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
