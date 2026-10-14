import { z } from "zod";
import { db } from "../db";
import { writeAudit } from "../audit";
import { LIMITS, rateLimit } from "../auth/rate-limit";
import { enqueueEmail } from "../email/outbox";
import { assertCan, type Actor } from "../permissions";

export const broadcastSchema = z.object({
  subject: z.string().trim().min(1, "validation.required").max(150, "validation.tooLong"),
  body: z.string().trim().min(1, "validation.required").max(5000, "validation.tooLong"),
});

/** Members with an ACTIVE ticket (one per person; unpaid, cancelled and anonymized accounts never receive mail). */
export async function broadcastRecipients(eventId: string) {
  const tickets = await db.ticket.findMany({
    where: { eventId, status: "ACTIVE", user: { anonymizedAt: null } },
    select: { user: { select: { id: true, email: true, locale: true } } },
  });
  return [...new Map(tickets.map((t) => [t.user.id, t.user])).values()];
}

export type BroadcastResult = { ok: true; recipientCount: number; broadcastId: string } | { ok: false; reason: "notFound" | "noRecipients" | "rateLimited" | "eventCancelled" };

/**
 * Queues one email per recipient through the outbox (so sending survives crashes and is retried) and records the
 * mailing in `Broadcast`. Everything happens in one transaction: either all recipients are queued and logged, or nothing.
 */
export async function sendBroadcast(actor: Actor, eventId: string, input: z.output<typeof broadcastSchema>, ip?: string | null): Promise<BroadcastResult> {
  assertCan(actor, "broadcast:send");
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) return { ok: false, reason: "notFound" };
  if (!(await rateLimit(`broadcast:user:${actor.id}`, LIMITS.broadcast)).ok) return { ok: false, reason: "rateLimited" };
  const recipients = await broadcastRecipients(eventId);
  if (recipients.length === 0) return { ok: false, reason: "noRecipients" };

  return db.$transaction(async (tx) => {
    const b = await tx.broadcast.create({ data: { eventId, subject: input.subject, body: input.body, sentById: actor.id, recipientCount: recipients.length } });
    for (const r of recipients) {
      await enqueueEmail(tx, { to: r.email, template: "broadcast", locale: r.locale, payload: { subject: input.subject, body: input.body, eventName: event.name } });
    }
    await writeAudit(tx, { actorId: actor.id, action: "broadcast.send", entityType: "Broadcast", entityId: b.id, eventId, diff: { subject: input.subject, recipients: recipients.length }, ip });
    return { ok: true as const, recipientCount: recipients.length, broadcastId: b.id };
  }, { timeout: 30_000 });
}

export async function listBroadcasts(actor: Actor, eventId: string) {
  assertCan(actor, "broadcast:send");
  return db.broadcast.findMany({ where: { eventId }, orderBy: { sentAt: "desc" }, take: 50, include: { sentBy: { select: { nickname: true } } } });
}
