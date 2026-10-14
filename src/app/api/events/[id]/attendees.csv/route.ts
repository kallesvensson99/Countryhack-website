import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getClientIp } from "@/lib/auth/request";
import { attendeeCsvRows, listAttendees, parseFilters } from "@/lib/attendees/query";
import { toCsv, type Delimiter } from "@/lib/attendees/csv";
import { can } from "@/lib/permissions";
import { stockholmParts } from "@/lib/age";

export const dynamic = "force-dynamic";

/**
 * Attendee list as CSV (UTF-8 + BOM). Festivalledare only. Contains personal data, so every export is audited.
 * Read-only GET: a cross-site page can trigger it but can't read the response.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getCurrentUser();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  if (!can(actor, "attendees:view")) return new Response("Forbidden", { status: 403 });
  const event = await db.event.findUnique({ where: { id }, select: { id: true, slug: true } });
  if (!event) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  const filters = parseFilters(Object.fromEntries(url.searchParams));
  const delimiter: Delimiter = url.searchParams.get("delimiter") === "comma" ? "," : ";";
  const rows = await listAttendees(actor, id, filters);

  await writeAudit(db, { actorId: actor.id, action: "attendees.export", entityType: "Event", entityId: id, eventId: id, diff: { rows: rows.length, filters: JSON.parse(JSON.stringify(filters)), delimiter }, ip: await getClientIp() });

  const d = stockholmParts(new Date());
  const stamp = `${d.year}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
  return new Response(toCsv(attendeeCsvRows(rows), delimiter), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendees-${event.slug}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
