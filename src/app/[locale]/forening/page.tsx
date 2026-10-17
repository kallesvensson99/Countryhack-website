import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { formatSize, groupDocuments, listBoardMembers, listDocumentsFor, localisedIntro, localisedRole } from "@/lib/association/service";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getOrgSettings } from "@/lib/auth/service";
import { can } from "@/lib/permissions";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "association" });
  return { title: t("title") };
}

export default async function AssociationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("association");
  const f = await getFormatter();
  const user = await getCurrentUser();
  const [org, board, { docs, hidden }] = await Promise.all([getOrgSettings(), listBoardMembers(), listDocumentsFor(user)]);
  const intro = localisedIntro(org, locale);
  const isStaff = can(user, "association:manage");
  const groups = groupDocuments(docs);

  return (
    <div className="mx-auto max-w-3xl space-y-14">
      <header className="space-y-4">
        <p aria-hidden className="eyebrow text-barn">{t("eyebrow")}</p>
        <h1 className="disp text-5xl sm:text-6xl">{org.name}</h1>
        {intro ? <p className="whitespace-pre-line text-xl text-slate-700">{intro}</p> : isStaff ? <p role="note" className="card-hay !p-3">{t("noIntroStaff")}</p> : null}
        <p className="font-mono text-sm font-bold text-slate-600">
          {[org.orgNumber, org.address].filter(Boolean).join(" · ")}
          {org.contactEmail && (
            <>
              {org.orgNumber || org.address ? " · " : ""}
              <a href={`mailto:${org.contactEmail}`} className="link">{org.contactEmail}</a>
            </>
          )}
        </p>
        {isStaff && (
          <p>
            <Link href="/manage/association" className="btn-secondary">{t("edit")}</Link>
          </p>
        )}
      </header>

      <section aria-labelledby="board-h" className="space-y-5">
        <h2 id="board-h" className="disp text-3xl sm:text-4xl">{t("boardTitle")}</h2>
        {board.length === 0 ? (
          <p className="text-slate-600">{t("noBoard")}</p>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2">
            {board.map((m) => (
              <li key={m.id} className="card !p-5">
                <p className="text-xl font-extrabold leading-tight">{m.name}</p>
                <p className="font-mono text-sm font-bold text-barn">{localisedRole(m, locale)}</p>
                {m.email && (
                  <p className="mt-2 break-all text-sm">
                    <a href={`mailto:${m.email}`} className="link">{m.email}</a>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="docs-h" className="space-y-6">
        <h2 id="docs-h" className="disp text-3xl sm:text-4xl">{t("docsTitle")}</h2>
        {groups.length === 0 && <p className="text-slate-600">{t("noDocs")}</p>}
        {groups.map((g) => (
          <div key={g.category} className="space-y-3">
            <h3 className="eyebrow text-slate-600">{t(`category_${g.category}`)}</h3>
            <ul className="space-y-3">
              {g.docs.map((d) => (
                <li key={d.id} className="card flex flex-wrap items-center justify-between gap-3 !p-4">
                  <div className="min-w-0">
                    <a href={`/api/documents/${d.id}`} className="link break-words text-lg font-extrabold" download>{d.title}</a>
                    <p className="font-mono text-xs font-bold text-slate-600">
                      {d.docDate ? `${f.dateTime(d.docDate, { dateStyle: "long", timeZone: "UTC" })} · ` : ""}
                      {d.fileName.split(".").pop()?.toUpperCase()} · {formatSize(d.sizeBytes)}
                    </p>
                  </div>
                  {d.visibility !== "PUBLIC" && <span className="tag">{t(`visibility_${d.visibility}`)}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {hidden > 0 && !user && (
          <p role="note" className="card-hay !p-3">
            {t("moreWhenLoggedIn")} <Link href="/login" className="link font-bold">{t("login")}</Link>
          </p>
        )}
      </section>
    </div>
  );
}
