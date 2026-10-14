import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { requirePage } from "@/lib/auth/guard";
import { listAttendees, parseFilters } from "@/lib/attendees/query";
import { db } from "@/lib/db";

const PAGE_SIZE = 50;

export default async function AttendeesPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale, id } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  await requirePage("attendees:view");
  const actor = (await getCurrentUser())!;
  const event = await db.event.findUnique({ where: { id }, include: { ticketTypes: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true } } } });
  if (!event) notFound();
  const t = await getTranslations("attendees");
  const f = await getFormatter();

  const filters = parseFilters(sp);
  const all = await listAttendees(actor, id, filters);
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);
  const lastPage = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const rows = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.ticketTypeId) p.set("type", filters.ticketTypeId);
    if (filters.checkedIn) p.set("checkedIn", filters.checkedIn);
    if (filters.food) p.set("food", filters.food);
    if (filters.minors) p.set("minors", filters.minors);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const sel = (name: string, label: string, value: string | undefined, options: [string, string][]) => (
    <div>
      <label htmlFor={`f-${name}`} className="block text-sm font-medium">{label}</label>
      <select id={`f-${name}`} name={name} defaultValue={value ?? ""} className="input mt-1 w-auto">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  const csvBase = `/api/events/${id}/attendees.csv${qs()}`;
  const csvHref = (delimiter?: string) => `${csvBase}${csvBase.includes("?") ? "&" : "?"}${delimiter ? `delimiter=${delimiter}` : ""}`;

  return (
    <div className="space-y-6">
      <Link href={`/manage/events/${event.id}`} className="link text-sm">{t("back")}</Link>
      <h1 className="text-2xl font-bold">{t("title")} – {event.name}</h1>

      {/* keyed by the active filters: uncontrolled defaultValue would otherwise keep stale values after "Rensa" */}
      <form key={qs()} method="get" role="search" className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="f-q" className="block text-sm font-medium">{t("search")}</label>
          <input id="f-q" name="q" defaultValue={filters.q} className="input mt-1 w-56" placeholder={t("searchPlaceholder")} />
        </div>
        {sel("type", t("ticketType"), filters.ticketTypeId, [["", t("all")], ...event.ticketTypes.map((x) => [x.id, x.name] as [string, string])])}
        {sel("checkedIn", t("checkedIn"), filters.checkedIn, [["", t("all")], ["yes", t("yes")], ["no", t("no")]])}
        {sel("food", t("hasFood"), filters.food, [["", t("all")], ["yes", t("yes")], ["no", t("no")]])}
        {sel("minors", t("minors"), filters.minors, [["", t("all")], ["yes", t("onlyMinors")]])}
        <button type="submit" className="btn">{t("filter")}</button>
        <Link href={`/manage/events/${id}/attendees`} className="link pb-3">{t("clear")}</Link>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="font-medium">{t("count", { count: all.length })}</p>
        {/* plain links: the route sets Content-Disposition: attachment */}
        <a href={csvHref()} className="btn-secondary">{t("exportExcel")}</a>
        <a href={csvHref("comma")} className="btn-secondary">{t("exportComma")}</a>
      </div>
      <p className="text-sm text-slate-600">{t("exportHint")}</p>

      {rows.length === 0 ? (
        <p>{t("none")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b-2 border-slate-400">
                <th scope="col" className="p-2">{t("name")}</th>
                <th scope="col" className="p-2">{t("ticketType")}</th>
                <th scope="col" className="p-2">{t("seat")}</th>
                <th scope="col" className="p-2">{t("checkedIn")}</th>
                <th scope="col" className="p-2">{t("food")}</th>
                <th scope="col" className="p-2">{t("notes")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticketId} className="border-b align-top">
                  <th scope="row" className="p-2 text-left font-normal">
                    <strong>{r.nickname}</strong> {r.realName}
                    <span className="block text-slate-600">{r.email} · {r.phone}</span>
                  </th>
                  <td className="p-2">{r.ticketType}</td>
                  <td className="p-2">{r.seat ?? "–"}</td>
                  <td className="p-2">{r.checkedInAt ? <span>✓ {f.dateTime(r.checkedInAt, { timeStyle: "short", dateStyle: "short" })}</span> : "–"}</td>
                  <td className="p-2">{r.food.length ? r.food.join(", ") : "–"}</td>
                  <td className="p-2">
                    {r.minor && <span className="mb-1 block rounded bg-red-100 px-2 py-1 text-red-900">{t("minorBadge", { age: r.age })}: {r.guardianName ?? "?"} {r.guardianPhone ?? ""}</span>}
                    {r.allergies && <span className="block rounded bg-amber-100 px-2 py-1 text-amber-950">{r.allergies}</span>}
                    {r.dietary && <span className="block text-slate-700">{r.dietary}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 && (
        <nav className="flex items-center gap-4" aria-label={t("pages")}>
          {page > 1 && <Link className="link" href={`/manage/events/${id}/attendees${qs({ page: String(page - 1) })}`}>{t("previous")}</Link>}
          <span className="text-sm">{t("pageOf", { page, last: lastPage })}</span>
          {page < lastPage && <Link className="link" href={`/manage/events/${id}/attendees${qs({ page: String(page + 1) })}`}>{t("next")}</Link>}
        </nav>
      )}
    </div>
  );
}
