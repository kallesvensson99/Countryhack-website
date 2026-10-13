import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { getEmailSender } from "./sender";
import { renderTemplate, type Locale, type TemplateName, type TemplatePayloads } from "./templates";

type Client = Prisma.TransactionClient | typeof db;

const MAX_ATTEMPTS = 5;

/** Queue an email. Pass the transaction client to commit it atomically with the cause. */
export async function enqueueEmail<K extends TemplateName>(
  client: Client,
  args: { to: string; template: K; locale: string; payload: TemplatePayloads[K] },
): Promise<void> {
  await client.emailOutbox.create({
    data: {
      to: args.to,
      template: args.template,
      locale: args.locale === "en" ? "en" : "sv",
      payload: args.payload as Prisma.InputJsonValue,
    },
  });
}

/** Worker entry point: send up to `batch` pending emails. Safe to run concurrently (SKIP LOCKED). */
export async function processOutbox(batch = 20): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const sender = getEmailSender();
  for (let i = 0; i < batch; i++) {
    const done = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "EmailOutbox"
        WHERE "status" = 'PENDING' AND "attempts" < ${MAX_ATTEMPTS}
        ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const id = rows[0]?.id;
      if (!id) return null;
      const mail = await tx.emailOutbox.findUniqueOrThrow({ where: { id } });
      try {
        const r = renderTemplate(mail.template as TemplateName, mail.locale as Locale, mail.payload as never);
        await sender.send({ to: mail.to, subject: r.subject, html: r.html, text: r.text });
        await tx.emailOutbox.update({ where: { id }, data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, error: null } });
        return "sent" as const;
      } catch (err) {
        const attempts = mail.attempts + 1;
        await tx.emailOutbox.update({
          where: { id },
          data: { attempts, status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING", error: String(err).slice(0, 500) },
        });
        return "failed" as const;
      }
    }, { timeout: 30_000 }); // the row stays locked while the provider call is in flight
    if (done === null) break;
    if (done === "sent") sent++;
    else failed++;
  }
  return { sent, failed };
}
