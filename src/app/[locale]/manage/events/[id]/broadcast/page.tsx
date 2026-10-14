import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { BroadcastForm } from "@/components/broadcast-form";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { requirePage } from "@/lib/auth/guard";
import { broadcastRecipients, listBroadcasts } from "@/lib/broadcast/service";
import { db } from "@/lib/db";

export default async function BroadcastPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requirePage("broadcast:send");
  const actor = (await getCurrentUser())!;
  const event = await db.event.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!event) notFound();
  const t = await getTranslations("broadcast");
  const f = await getFormatter();
  const recipients = await broadcastRecipients(id);
  const history = await listBroadcasts(actor, id);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>
      <p>{t("lead", { count: recipients.length })}</p>
      {recipients.length === 0 ? (
        <p role="note" className="rounded-md bg-amber-50 p-3 text-amber-900">{t("nobody")}</p>
      ) : (
        <div className="card">
          <BroadcastForm eventId={event.id} recipientCount={recipients.length} />
        </div>
      )}

      <section aria-labelledby="bc-h" className="space-y-3">
        <h2 id="bc-h" className="text-xl font-semibold">{t("history")}</h2>
        {history.length === 0 ? (
          <p className="text-slate-600">{t("noHistory")}</p>
        ) : (
          <ul className="space-y-3">
            {history.map((b) => (
              <li key={b.id}>
                <details className="card">
                  <summary className="cursor-pointer font-semibold">
                    {b.subject} <span className="font-normal text-slate-600">· {f.dateTime(b.sentAt, { dateStyle: "short", timeStyle: "short" })} · {t("recipients", { count: b.recipientCount })} · {b.sentBy.nickname}</span>
                  </summary>
                  <p className="mt-3 whitespace-pre-line">{b.body}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
