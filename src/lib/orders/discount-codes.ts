import { Prisma } from "@prisma/client";
import { db } from "../db";
import { writeAudit } from "../audit";
import { assertCan, type Actor } from "../permissions";
import type { DiscountCodeInput } from "../validation/commerce";

export type CodeError = "notFound" | "duplicate" | "badTicketTypes" | "eventCancelled" | "inUse";
export type CodeResult = { ok: true; id: string } | { ok: false; reason: CodeError };

async function ticketTypesBelong(eventId: string, ids: string[]) {
  if (ids.length === 0) return true;
  return (await db.ticketType.count({ where: { id: { in: ids }, eventId } })) === new Set(ids).size;
}

const data = (i: DiscountCodeInput) => ({ code: i.code, kind: i.kind, value: i.value, appliesTo: i.appliesTo, maxUses: i.maxUses ?? null, validFrom: i.validFrom ?? null, validUntil: i.validUntil ?? null });

export async function createDiscountCode(actor: Actor, eventId: string, input: DiscountCodeInput, ticketTypeIds: string[], ip?: string | null): Promise<CodeResult> {
  assertCan(actor, "discountCode:manage");
  const ev = await db.event.findUnique({ where: { id: eventId } });
  if (!ev) return { ok: false, reason: "notFound" };
  if (ev.status === "CANCELLED") return { ok: false, reason: "eventCancelled" };
  if (!(await ticketTypesBelong(eventId, ticketTypeIds))) return { ok: false, reason: "badTicketTypes" };
  try {
    return await db.$transaction(async (tx) => {
      const c = await tx.discountCode.create({ data: { eventId, ...data(input), ticketTypes: { create: [...new Set(ticketTypeIds)].map((ticketTypeId) => ({ ticketTypeId })) } } });
      await writeAudit(tx, { actorId: actor.id, action: "discountCode.create", entityType: "DiscountCode", entityId: c.id, eventId, diff: { code: c.code, kind: c.kind, value: c.value, appliesTo: c.appliesTo, unlocks: ticketTypeIds.length }, ip });
      return { ok: true as const, id: c.id };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "duplicate" };
    if (e instanceof Error && /DiscountCode_eventId_code_lower_key|unique/i.test(e.message)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateDiscountCode(actor: Actor, codeId: string, input: DiscountCodeInput, ticketTypeIds: string[], ip?: string | null): Promise<CodeResult> {
  assertCan(actor, "discountCode:manage");
  const before = await db.discountCode.findUnique({ where: { id: codeId }, include: { ticketTypes: true } });
  if (!before) return { ok: false, reason: "notFound" };
  if (!(await ticketTypesBelong(before.eventId, ticketTypeIds))) return { ok: false, reason: "badTicketTypes" };
  try {
    return await db.$transaction(async (tx) => {
      await tx.discountCode.update({ where: { id: codeId }, data: data(input) });
      await tx.discountCodeTicketType.deleteMany({ where: { codeId } });
      await tx.discountCodeTicketType.createMany({ data: [...new Set(ticketTypeIds)].map((ticketTypeId) => ({ codeId, ticketTypeId })) });
      await writeAudit(tx, { actorId: actor.id, action: "discountCode.update", entityType: "DiscountCode", entityId: codeId, eventId: before.eventId, diff: { code: { from: before.code, to: input.code }, value: { from: before.value, to: input.value }, kind: { from: before.kind, to: input.kind }, unlocks: ticketTypeIds.length }, ip });
      return { ok: true as const, id: codeId };
    });
  } catch (e) {
    if (e instanceof Error && /unique/i.test(e.message)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

/** Codes that were ever used by an order stay (for the bookkeeping trail); end their validity instead. */
export async function deleteDiscountCode(actor: Actor, codeId: string, ip?: string | null): Promise<CodeResult> {
  assertCan(actor, "discountCode:manage");
  const c = await db.discountCode.findUnique({ where: { id: codeId } });
  if (!c) return { ok: false, reason: "notFound" };
  if (c.usedCount > 0 || (await db.order.count({ where: { discountCodeId: codeId } })) > 0) return { ok: false, reason: "inUse" };
  await db.$transaction(async (tx) => {
    await tx.discountCode.delete({ where: { id: codeId } });
    await writeAudit(tx, { actorId: actor.id, action: "discountCode.delete", entityType: "DiscountCode", entityId: codeId, eventId: c.eventId, diff: { code: c.code }, ip });
  });
  return { ok: true, id: codeId };
}
