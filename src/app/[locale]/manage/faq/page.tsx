import { getTranslations, setRequestLocale } from "next-intl/server";
import { deleteFaqAction, importFaqAction } from "@/actions/faq";
import { FaqForm, MoveFaq } from "@/components/crew-forms";
import { ActionButton } from "@/components/form";
import { Link } from "@/i18n/navigation";
import { requirePage } from "@/lib/auth/guard";
import { GROUP_ID, GROUP_ORDER, listFaqItems } from "@/lib/content/faq-store";

export default async function ManageFaqPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePage("faq:manage");
  const t = await getTranslations("faqManage");
  const tf = await getTranslations("faq");
  const items = await listFaqItems();
  const groups = GROUP_ORDER.map((g) => ({ value: g, label: tf(`group_${GROUP_ID[g]}`) }));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="disp text-5xl">{t("title")}</h1>
        <p className="text-slate-700">{t("lead")}</p>
        <p className="flex flex-wrap gap-4 text-sm">
          <Link href="/faq" className="link">{t("viewPage")}</Link>
          <Link href="/manage/crew" className="link">{t("crewLink")}</Link>
        </p>
      </header>

      {items.length === 0 && (
        <section className="card-hay space-y-3" aria-labelledby="builtin-h">
          <h2 id="builtin-h" className="sr-only">{t("import")}</h2>
          <p role="note">{t("builtIn")}</p>
          <ActionButton action={importFaqAction} fields={{}} label={t("import")} variant="btn-secondary" />
        </section>
      )}

      <section className="card" aria-labelledby="new-faq-h">
        <h2 id="new-faq-h" className="disp mb-4 text-3xl">{t("newItem")}</h2>
        <FaqForm groups={groups} />
      </section>

      {groups.map((g) => {
        const inGroup = items.filter((i) => i.group === g.value);
        if (items.length === 0) return null;
        return (
          <section key={g.value} aria-labelledby={`faq-g-${g.value}`} className="space-y-3">
            <h2 id={`faq-g-${g.value}`} className="disp text-3xl">{g.label}</h2>
            {inGroup.length === 0 && <p className="text-sm text-slate-600">{t("emptyGroup")}</p>}
            <ul className="space-y-3">
              {inGroup.map((item, i) => (
                <li key={item.id} className="card !p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-extrabold">{item.questionSv}</p>
                    <div className="flex flex-none gap-2">
                      <MoveFaq id={item.id} direction="up" label={`${t("up")}: ${item.questionSv}`} disabled={i === 0} />
                      <MoveFaq id={item.id} direction="down" label={`${t("down")}: ${item.questionSv}`} disabled={i === inGroup.length - 1} />
                    </div>
                  </div>
                  <details className="mt-3">
                    <summary className="btn-secondary cursor-pointer">{t("edit")}<span className="sr-only">: {item.questionSv}</span></summary>
                    <div className="mt-4 space-y-4">
                      <FaqForm
                        groups={groups}
                        defaults={{ id: item.id, group: item.group, questionSv: item.questionSv, answerSv: item.answerSv, questionEn: item.questionEn, answerEn: item.answerEn }}
                      />
                      <ActionButton action={deleteFaqAction} fields={{ id: item.id }} label={t("delete")} variant="btn-danger" confirm={t("deleteConfirm")} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
