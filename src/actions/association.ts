"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { createBoardMember, deleteBoardMember, deleteDocument, updateAboutIntro, updateBoardMember, updateDocument, uploadDocument } from "@/lib/association/service";
import { assertCan } from "@/lib/permissions";
import { aboutIntroSchema, boardMemberSchema, documentSchema } from "@/lib/validation/crew";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = {
  notFound: "messages.notFound",
  badFile: "messages.docBadFile",
  tooLarge: "messages.docTooLarge",
  fileRequired: "messages.docFileRequired",
};
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

export async function saveAboutIntroAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "association:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = aboutIntroSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  await updateAboutIntro(actor, parsed.data, await getClientIp());
  refresh();
  return { ok: true, message: "messages.aboutIntroSaved", values };
}

/** Create (no `id` field) or update a board member. */
export async function saveBoardMemberAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "association:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = boardMemberSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  if (raw.id) {
    const r = await updateBoardMember(actor, raw.id, parsed.data, ip);
    if (!r.ok) return fail(r.reason, values);
  } else {
    await createBoardMember(actor, parsed.data, ip);
  }
  refresh();
  return { ok: true, message: "messages.boardSaved", values: raw.id ? values : undefined };
}

export async function deleteBoardMemberAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "association:manage");
  const mid = id.safeParse(fd.get("id"));
  if (!mid.success) return fail("notFound");
  const r = await deleteBoardMember(actor, mid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.boardDeleted" };
}

/** Upload (no `id`; a file is required) or edit the details of (with `id`) a document. The file itself can't be replaced: delete and upload again. */
export async function saveDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "association:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const ip = await getClientIp();
  if (raw.id) {
    const r = await updateDocument(actor, raw.id, parsed.data, ip);
    if (!r.ok) return fail(r.reason, values);
  } else {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return fail("fileRequired", values);
    const r = await uploadDocument(actor, parsed.data, { name: file.name, data: Buffer.from(await file.arrayBuffer()) }, ip);
    if (!r.ok) return fail(r.reason, values);
  }
  refresh();
  return { ok: true, message: "messages.docSaved", values: raw.id ? values : undefined };
}

export async function deleteDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "association:manage");
  const did = id.safeParse(fd.get("id"));
  if (!did.success) return fail("notFound");
  const r = await deleteDocument(actor, did.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.docDeleted" };
}
