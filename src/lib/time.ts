const TZ = "Europe/Stockholm";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function parts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** Offset of Europe/Stockholm from UTC at an instant, in minutes (60 winter, 120 summer). */
function offsetMinutes(at: Date): number {
  const p = parts(at);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** UTC instant → "YYYY-MM-DDTHH:mm" in Stockholm time (for <input type="datetime-local">). */
export function toStockholmInput(d: Date): string {
  const p = parts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/**
 * "YYYY-MM-DDTHH:mm" read as Stockholm wall-clock time → UTC instant.
 * Returns null for malformed input and for times that don't exist (spring-forward gap).
 * For the repeated autumn hour the first (summer-time) occurrence wins.
 */
export function parseStockholmLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - offsetMinutes(new Date(wall)) * 60000;
  const t = new Date(wall - offsetMinutes(new Date(first)) * 60000);
  return toStockholmInput(t) === s ? t : null;
}
