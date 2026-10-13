import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { TagToggle } from "@/components/admin-forms";
import { listUsers } from "@/lib/admin/service";
import { requirePage } from "@/lib/auth/guard";
import { AdminNav } from "../nav";

export default async function AdminUsersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const { locale } = await params;
  const { q, page } = await searchParams;
  setRequestLocale(locale);
  const actor = await requirePage("user:manage");
  const t = await getTranslations("admin");
  const f = await getFormatter();
  const { users, total, page: p, pageSize } = await listUsers(actor, { q, page: Number(page) || 1 });
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <AdminNav active="users" />
      <h1 className="text-2xl font-bold">{t("usersTitle")}</h1>
      <form method="get" role="search" className="flex gap-2">
        <label htmlFor="q" className="sr-only">{t("searchPlaceholder")}</label>
        <input id="q" name="q" defaultValue={q} placeholder={t("searchPlaceholder")} className="input mt-0 max-w-md" />
        <button className="btn-secondary" type="submit">{(await getTranslations("common"))("search")}</button>
      </form>
      <p className="text-sm text-slate-600">{t("total", { count: total })}</p>
      {users.length === 0 ? (
        <p>{t("noUsers")}</p>
      ) : (
        <ul className="space-y-3">
          {users.map((u) => {
            const tags = u.tags.map((x) => x.tag);
            return (
              <li key={u.id} className="card">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-semibold">
                      {u.nickname} <span className="font-normal text-slate-600">· {u.realName}</span>
                    </p>
                    <p className="text-sm text-slate-600">{u.anonymizedAt ? t("anonymized") : u.email}</p>
                    <p className="text-sm text-slate-600">
                      {t("verified")}: {u.emailVerifiedAt ? "✓" : "–"} · {t("created")}: {f.dateTime(u.createdAt, { dateStyle: "medium" })}
                    </p>
                    <p className="mt-1 text-sm">
                      {t("roles")}: {tags.length ? tags.map((x) => t(`tag_${x}`)).join(", ") : "–"}
                    </p>
                  </div>
                  {!u.anonymizedAt && (
                    <div className="flex flex-wrap gap-2">
                      {(["FESTIVALLEDARE", "ADMIN"] as const).map((tag) => (
                        <TagToggle key={tag} userId={u.id} tag={tag} enabled={tags.includes(tag)} userLabel={u.nickname} />
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <nav className="flex items-center gap-4" aria-label="pagination">
        {p > 1 && <Link className="link" href={{ pathname: "/admin/users", query: { q, page: p - 1 } }}>{(await getTranslations("common"))("previous")}</Link>}
        <span className="text-sm">{t("pageOf", { page: p })}</span>
        {p < lastPage && <Link className="link" href={{ pathname: "/admin/users", query: { q, page: p + 1 } }}>{(await getTranslations("common"))("next")}</Link>}
      </nav>
    </div>
  );
}
