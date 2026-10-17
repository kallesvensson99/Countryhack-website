"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { createPost, deletePost, updatePost } from "@/lib/news/service";
import { assertCan } from "@/lib/permissions";
import { newsPostSchema } from "@/lib/validation/news";
import { echoValues, fieldErrors, formToObject, type ActionState } from "@/lib/validation/account";

const id = z.string().min(1).max(60);
const REASONS: Record<string, string> = { notFound: "messages.notFound", badImage: "messages.badImage", tooLarge: "messages.imageTooLarge" };
const fail = (reason: string, values?: Record<string, string>): ActionState => ({ message: REASONS[reason] ?? "messages.invalidInput", values });
const refresh = () => revalidatePath("/", "layout");

/** Create (no `id` field) or update a news post. A picture file is optional. */
export async function saveNewsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "news:manage");
  const raw = formToObject(fd);
  const values = echoValues(raw);
  const parsed = newsPostSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const file = fd.get("image");
  const image = file instanceof File && file.size > 0 ? Buffer.from(await file.arrayBuffer()) : undefined;
  const ip = await getClientIp();
  if (raw.id) {
    const r = await updatePost(actor, raw.id, parsed.data, image, ip);
    if (!r.ok) return fail(r.reason, values);
  } else {
    const r = await createPost(actor, parsed.data, image, ip);
    if (!r.ok) return fail(r.reason, values);
  }
  refresh();
  return { ok: true, message: "messages.newsSaved", values: raw.id ? values : undefined };
}

export async function deleteNewsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await getCurrentUser();
  assertCan(actor, "news:manage");
  const nid = id.safeParse(fd.get("id"));
  if (!nid.success) return fail("notFound");
  const r = await deletePost(actor, nid.data, await getClientIp());
  if (!r.ok) return fail(r.reason);
  refresh();
  return { ok: true, message: "messages.newsDeleted" };
}
