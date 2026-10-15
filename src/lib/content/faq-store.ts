import type { FaqGroup, FaqItem } from "@prisma/client";
import { db } from "../db";
import { diffObjects, writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import type { FaqItemInput } from "../validation/crew";
import sv from "../../../messages/sv.json";
import en from "../../../messages/en.json";
import { FAQ_GROUPS } from "./faq";

/** The page uses lower-case group ids (they key translations), the database uses an enum. */
export const GROUP_ENUM: Record<(typeof FAQ_GROUPS)[number]["id"], FaqGroup> = {
  tickets: "TICKETS",
  seatsFood: "SEATS_FOOD",
  onSite: "ON_SITE",
  account: "ACCOUNT",
};
export const GROUP_ID = Object.fromEntries(Object.entries(GROUP_ENUM).map(([k, v]) => [v, k])) as Record<FaqGroup, (typeof FAQ_GROUPS)[number]["id"]>;
export const GROUP_ORDER: FaqGroup[] = FAQ_GROUPS.map((g) => GROUP_ENUM[g.id]);

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: "notFound" | "alreadyImported" };

/** Fill the {minAge} / {contact} placeholders that answers may contain. */
export function fillPlaceholders(text: string, values: { minAge: number; contact: string }): string {
  return text.replaceAll("{minAge}", String(values.minAge)).replaceAll("{contact}", values.contact);
}

/** Question / answer in the reader's language; an empty English text falls back to Swedish. */
export function localised(item: Pick<FaqItem, "questionSv" | "answerSv" | "questionEn" | "answerEn">, locale: string) {
  const en = locale === "en";
  return { q: (en && item.questionEn) || item.questionSv, a: (en && item.answerEn) || item.answerSv };
}

export async function listFaqItems(): Promise<FaqItem[]> {
  return db.faqItem.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

/** Has anyone customised the FAQ? If not, the page shows the built-in texts from the translation files. */
export async function hasCustomFaq(): Promise<boolean> {
  return (await db.faqItem.count()) > 0;
}

/** The FAQ as the public page shows it: custom items by group, or null to use the built-in texts. */
export async function loadCustomFaq(locale: string, values: { minAge: number; contact: string }) {
  const items = await listFaqItems();
  if (items.length === 0) return null;
  return FAQ_GROUPS.map((g) => ({
    id: g.id,
    items: items
      .filter((i) => i.group === GROUP_ENUM[g.id])
      .map((i) => {
        const { q, a } = localised(i, locale);
        return { id: i.id, q: fillPlaceholders(q, values), a: fillPlaceholders(a, values) };
      }),
  })).filter((g) => g.items.length > 0);
}

const nextOrder = async (group: FaqGroup) => ((await db.faqItem.aggregate({ where: { group }, _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;

export async function createFaqItem(actor: Actor, input: FaqItemInput, ip?: string | null): Promise<Result<{ id: string }>> {
  assertCan(actor, "faq:manage");
  const sortOrder = await nextOrder(input.group);
  return db.$transaction(async (tx) => {
    const item = await tx.faqItem.create({ data: { ...input, sortOrder } });
    await writeAudit(tx, { actorId: actor.id, action: "faq.create", entityType: "FaqItem", entityId: item.id, diff: { questionSv: { from: null, to: item.questionSv } }, ip });
    return { ok: true as const, id: item.id };
  });
}

export async function updateFaqItem(actor: Actor, id: string, input: FaqItemInput, ip?: string | null): Promise<Result> {
  assertCan(actor, "faq:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.faqItem.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    // Moving to another group puts the item last there.
    const sortOrder = before.group === input.group ? before.sortOrder : await nextOrder(input.group);
    const after = await tx.faqItem.update({ where: { id }, data: { ...input, sortOrder } });
    await writeAudit(tx, { actorId: actor.id, action: "faq.update", entityType: "FaqItem", entityId: id, diff: diffObjects(before, after, ["group", "questionSv", "answerSv", "questionEn", "answerEn"]), ip });
    return { ok: true as const };
  });
}

export async function deleteFaqItem(actor: Actor, id: string, ip?: string | null): Promise<Result> {
  assertCan(actor, "faq:manage");
  return db.$transaction(async (tx) => {
    const before = await tx.faqItem.findUnique({ where: { id } });
    if (!before) return { ok: false as const, reason: "notFound" as const };
    await tx.faqItem.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, action: "faq.delete", entityType: "FaqItem", entityId: id, diff: { questionSv: { from: before.questionSv, to: null } }, ip });
    return { ok: true as const };
  });
}

/** Swap an item with its neighbour inside the same group. */
export async function moveFaqItem(actor: Actor, id: string, direction: "up" | "down", ip?: string | null): Promise<Result> {
  assertCan(actor, "faq:manage");
  return db.$transaction(async (tx) => {
    const item = await tx.faqItem.findUnique({ where: { id } });
    if (!item) return { ok: false as const, reason: "notFound" as const };
    const siblings = await tx.faqItem.findMany({ where: { group: item.group }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const i = siblings.findIndex((s) => s.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return { ok: true as const };
    // Renumber the whole group so equal sort orders can never leave the swap a no-op.
    const order = siblings.map((s) => s.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (const [n, sid] of order.entries()) await tx.faqItem.update({ where: { id: sid }, data: { sortOrder: n } });
    await writeAudit(tx, { actorId: actor.id, action: "faq.move", entityType: "FaqItem", entityId: id, diff: { direction: { from: null, to: direction } }, ip });
    return { ok: true as const };
  });
}

/** Copy the built-in Swedish and English texts into the database so they can be edited. Only when it is still empty. */
export async function importDefaultFaq(actor: Actor, ip?: string | null): Promise<Result<{ count: number }>> {
  assertCan(actor, "faq:manage");
  return db.$transaction(async (tx) => {
    if ((await tx.faqItem.count()) > 0) return { ok: false as const, reason: "alreadyImported" as const };
    const svT = sv.faq as Record<string, string>;
    const enT = en.faq as Record<string, string>;
    let n = 0;
    for (const g of FAQ_GROUPS) {
      for (const [order, id] of g.items.entries()) {
        await tx.faqItem.create({
          data: {
            group: GROUP_ENUM[g.id],
            questionSv: svT[`q_${id}`]!,
            answerSv: svT[`a_${id}`]!,
            questionEn: enT[`q_${id}`] ?? "",
            answerEn: enT[`a_${id}`] ?? "",
            sortOrder: order,
          },
        });
        n++;
      }
    }
    await writeAudit(tx, { actorId: actor.id, action: "faq.import", entityType: "FaqItem", entityId: "defaults", diff: { count: { from: 0, to: n } }, ip });
    return { ok: true as const, count: n };
  });
}
