import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { deleteBoardMemberAction, deleteDocumentAction } from "@/actions/association";
import { AboutIntroForm, BoardMemberForm, DocumentForm } from "@/components/association-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { CATEGORY_ORDER, formatSize, listBoardMembers, listDocumentsFor } from "@/lib/association/service";
import { requirePage } from "@/lib/auth/guard";
import { getOrgSettings } from "@/lib/auth/service";

const VISIBILITIES = ["PUBLIC", "LOGGED_IN", "STAFF"] as const;

export default async function ManageAssociationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const actor = await requirePage("association:manage");
  const t = await getTranslations("associationManage");
  const ta = await getTranslations("association");
  const f = await getFormatter();
  const [org, board, { docs }] = await Promise.all([getOrgSettings(), listBoardMembers(), listDocumentsFor(actor)]);
  const categories = CATEGORY_ORDER.map((c) => ({ value: c, label: ta(`category_${c}`) }));
  const visibilities = VISIBILITIES.map((v) => ({ value: v, label: ta(`visibility_${v}`) }));

  return (
    <div className="mx-auto max-w-3xl space-y-12">
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{t("lead")}</p>
        <p className="text-sm">
          <Link href="/forening" className="link">{t("viewPage")}</Link>
        </p>
      </header>

      <section className="card" aria-labelledby="intro-h">
        <h2 id="intro-h" className="disp mb-4 text-3xl">{t("introTitle")}</h2>
        <AboutIntroForm defaults={{ sv: org.aboutIntroSv, en: org.aboutIntroEn }} />
      </section>

      <section className="space-y-4" aria-labelledby="board-h">
        <h2 id="board-h" className="disp text-3xl">{t("boardTitle")}</h2>
        <div className="card" role="group" aria-labelledby="new-member-h">
          <h3 id="new-member-h" className="mb-3 text-xl font-extrabold">{t("newMember")}</h3>
          <BoardMemberForm />
        </div>
        {board.length === 0 && <p className="text-slate-600">{t("noMembers")}</p>}
        <ul className="space-y-3">
          {board.map((m) => (
            <li key={m.id} className="card !p-4">
              <p className="font-extrabold">{m.name} <span className="font-normal text-slate-600">· {m.role}</span></p>
              <details className="mt-3">
                <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {m.name}</span></summary>
                <div className="mt-4 space-y-4">
                  <BoardMemberForm defaults={{ id: m.id, name: m.name, role: m.role, roleEn: m.roleEn, email: m.email ?? "", sortOrder: String(m.sortOrder) }} />
                  <ActionButton action={deleteBoardMemberAction} fields={{ id: m.id }} label={t("deleteMember")} variant="btn-danger" confirm={t("deleteMemberConfirm")} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4" aria-labelledby="docs-h">
        <h2 id="docs-h" className="disp text-3xl">{t("docsTitle")}</h2>
        <div className="card" role="group" aria-labelledby="new-doc-h">
          <h3 id="new-doc-h" className="mb-3 text-xl font-extrabold">{t("newDoc")}</h3>
          <DocumentForm categories={categories} visibilities={visibilities} />
        </div>
        {docs.length === 0 && <p className="text-slate-600">{t("noDocs")}</p>}
        <ul className="space-y-3">
          {docs.map((d) => (
            <li key={d.id} className="card !p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <a href={`/api/documents/${d.id}`} className="link break-words font-extrabold" download>{d.title}</a>
                  <p className="font-mono text-xs font-bold text-slate-600">
                    {ta(`category_${d.category}`)} · {d.docDate ? `${f.dateTime(d.docDate, { dateStyle: "medium", timeZone: "UTC" })} · ` : ""}
                    {d.fileName} · {formatSize(d.sizeBytes)}
                  </p>
                </div>
                <span className="tag">{ta(`visibility_${d.visibility}`)}</span>
              </div>
              <details className="mt-3">
                <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {d.title}</span></summary>
                <div className="mt-4 space-y-4">
                  <DocumentForm
                    categories={categories}
                    visibilities={visibilities}
                    defaults={{ id: d.id, title: d.title, category: d.category, docDate: d.docDate ? d.docDate.toISOString().slice(0, 10) : "", visibility: d.visibility }}
                  />
                  <ActionButton action={deleteDocumentAction} fields={{ id: d.id }} label={t("deleteDoc")} variant="btn-danger" confirm={t("deleteDocConfirm")} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
