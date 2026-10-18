import type { ScheduleCategory } from "@prisma/client";
import { getFormatter, getTranslations } from "next-intl/server";
import { buildDays } from "@/lib/schedule/layout";
import { colorOf, NO_CATEGORY_STYLE } from "@/lib/schedule/palette";
import { pick, type ScheduleItemWithCategory } from "@/lib/schedule/service";

const HOUR_PX = 72;
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * The programme as blocks: one time grid per day, each block placed by its start and length and coloured by its category.
 * Overlapping blocks stand side by side. Colour is never the only signal: every block names its category in text.
 * Server component: no JavaScript is needed to read the schedule.
 */
export async function ScheduleBoard({ items, categories, locale }: { items: ScheduleItemWithCategory[]; categories: ScheduleCategory[]; locale: string }) {
  const t = await getTranslations("schedule");
  const f = await getFormatter();
  const days = buildDays(items);
  const usedIds = new Set(items.map((i) => i.categoryId));
  const legend = categories.filter((c) => usedIds.has(c.id));
  const hasUncategorised = items.some((i) => !i.categoryId);
  const descOf = (it: ScheduleItemWithCategory) => pick(it.description, it.descriptionEn, locale);

  return (
    <div className="space-y-10">
      {(legend.length > 0 || hasUncategorised) && (
        <section aria-label={t("legend")}>
          <ul className="flex flex-wrap gap-3">
            {legend.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-full border-2 border-ink bg-card px-3 py-1 text-sm font-bold">
                <span aria-hidden className="h-4 w-4 rounded border-2 border-ink" style={{ background: colorOf(c.color).bg }} />
                {pick(c.name, c.nameEn, locale)}
              </li>
            ))}
            {hasUncategorised && (
              <li className="flex items-center gap-2 rounded-full border-2 border-ink bg-card px-3 py-1 text-sm font-bold">
                <span aria-hidden className="h-4 w-4 rounded border-2 border-ink" style={{ background: NO_CATEGORY_STYLE.bg }} />
                {t("noCategory")}
              </li>
            )}
          </ul>
        </section>
      )}

      {days.map((day) => {
        const hours = day.endHour - day.startHour;
        const heading = f.dateTime(new Date(`${day.date}T12:00:00Z`), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
        return (
          <section key={day.date} aria-labelledby={`day-${day.date}`} className="space-y-3">
            <h2 id={`day-${day.date}`} className="disp text-3xl first-letter:uppercase">{heading}</h2>
            <div className="overflow-x-auto pb-2">
              <div className="relative ml-14 min-w-[520px] border-l-2 border-ink" style={{ height: hours * HOUR_PX }}>
                {Array.from({ length: hours + 1 }, (_, i) => (
                  <div key={i} aria-hidden className="absolute inset-x-0 border-t border-slate-300" style={{ top: i * HOUR_PX }}>
                    <span className="absolute -left-14 -top-3 w-12 text-right font-mono text-xs font-bold text-slate-600">{hhmm((day.startHour + i) * 60)}</span>
                  </div>
                ))}
                <ul aria-label={heading}>
                  {day.blocks.map((b) => {
                    const it = b.item as ScheduleItemWithCategory;
                    const style = colorOf(it.category?.color);
                    const title = pick(it.title, it.titleEn, locale);
                    const where = it.location;
                    const catName = it.category ? pick(it.category.name, it.category.nameEn, locale) : null;
                    const top = ((b.startMin - day.startHour * 60) / 60) * HOUR_PX;
                    const height = Math.max(((b.endMin - b.startMin) / 60) * HOUR_PX, 36);
                    return (
                      <li
                        key={`${it.id}-${b.startMin}`}
                        className="absolute overflow-hidden rounded-md border-2 border-ink px-2 py-1 text-sm leading-tight shadow-[2px_2px_0_#14211a]"
                        style={{
                          top,
                          height: height - 3,
                          left: `calc(${(b.lane / b.lanes) * 100}% + 4px)`,
                          width: `calc(${100 / b.lanes}% - 8px)`,
                          background: style.bg,
                          color: style.fg,
                        }}
                        title={[title, catName, where, descOf(it)].filter(Boolean).join(" · ")}
                      >
                        <p className="font-mono text-[11px] font-bold">
                          {b.fromPrevDay ? "◂ " : ""}
                          {hhmm(b.startMin)}–{hhmm(b.endMin === 1440 ? 0 : b.endMin)}
                          {b.toNextDay ? " ▸" : ""}
                        </p>
                        <p className="font-extrabold">{title}</p>
                        {catName && <p className="text-xs font-bold uppercase tracking-wide">{catName}</p>}
                        {where && <p className="text-xs">{where}</p>}
                        {height >= 120 && descOf(it) && <p className="mt-1 text-xs">{descOf(it)}</p>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer font-bold">{t("showList")}</summary>
              <ol className="mt-2 space-y-2">
                {day.blocks
                  .slice()
                  .sort((a, b) => a.startMin - b.startMin)
                  .map((b) => {
                    const it = b.item as ScheduleItemWithCategory;
                    return (
                      <li key={`${it.id}-${b.startMin}`}>
                        <span className="font-mono font-bold">{hhmm(b.startMin)}–{hhmm(b.endMin === 1440 ? 0 : b.endMin)}</span> <strong>{pick(it.title, it.titleEn, locale)}</strong>
                        {it.category ? ` · ${pick(it.category.name, it.category.nameEn, locale)}` : ""}
                        {it.location ? ` · ${it.location}` : ""}
                        {descOf(it) ? <span className="block text-slate-700">{descOf(it)}</span> : null}
                      </li>
                    );
                  })}
              </ol>
            </details>
          </section>
        );
      })}
    </div>
  );
}
