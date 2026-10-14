import { db } from "../db";
import { ageOn, isMinor } from "../age";
import { assertCan, type Actor } from "../permissions";

export interface AttendeeFilters {
  q?: string;
  ticketTypeId?: string;
  checkedIn?: "yes" | "no";
  food?: "yes" | "no";
  minors?: "yes";
}

export interface AttendeeRow {
  ticketId: string;
  realName: string;
  nickname: string;
  email: string;
  phone: string;
  birthDate: string;
  age: number;
  minor: boolean;
  guardianName: string | null;
  guardianPhone: string | null;
  allergies: string | null;
  dietary: string | null;
  ticketType: string;
  ticketTypeId: string;
  seat: string | null;
  orderNumber: string;
  checkedInAt: Date | null;
  checkedInBy: string | null;
  food: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * All holders of an ACTIVE ticket, with the filters applied. Events have 50–120 attendees, so this filters in
 * memory — which keeps "minor" identical to the rest of the app (actual date of birth, Stockholm calendar).
 */
export async function listAttendees(actor: Actor, eventId: string, filters: AttendeeFilters = {}, now = new Date()): Promise<AttendeeRow[]> {
  assertCan(actor, "attendees:view");
  const tickets = await db.ticket.findMany({
    where: { eventId, status: "ACTIVE", user: { anonymizedAt: null } },
    include: {
      user: true,
      order: { select: { number: true } },
      ticketType: { select: { name: true } },
      checkedInBy: { select: { nickname: true } },
      seatClaim: { include: { seat: { select: { label: true } } } },
      foodPurchases: { where: { status: "ACTIVE" }, include: { package: { select: { name: true } }, variant: { select: { name: true } } } },
    },
  });

  let rows: AttendeeRow[] = tickets.map((t) => ({
    ticketId: t.id,
    realName: t.user.realName,
    nickname: t.user.nickname,
    email: t.user.email,
    phone: t.user.phone,
    birthDate: t.user.birthDate.toISOString().slice(0, 10),
    age: ageOn(t.user.birthDate, now),
    minor: isMinor(t.user.birthDate, now),
    guardianName: t.user.guardianName,
    guardianPhone: t.user.guardianPhone,
    allergies: t.user.allergies?.trim() || null,
    dietary: t.user.dietaryPreferences?.trim() || null,
    ticketType: t.ticketType.name,
    ticketTypeId: t.ticketTypeId,
    seat: t.seatClaim?.seat.label ?? null,
    orderNumber: t.order.number,
    checkedInAt: t.checkedInAt,
    checkedInBy: t.checkedInBy?.nickname ?? null,
    food: t.foodPurchases.map((f) => `${f.package.name} (${f.variant.name})`),
  }));

  const q = filters.q ? norm(filters.q) : "";
  if (q) rows = rows.filter((r) => [r.realName, r.nickname, r.email, r.orderNumber, r.seat ?? ""].some((v) => norm(v).includes(q)));
  if (filters.ticketTypeId) rows = rows.filter((r) => r.ticketTypeId === filters.ticketTypeId);
  if (filters.checkedIn) rows = rows.filter((r) => (filters.checkedIn === "yes") === !!r.checkedInAt);
  if (filters.food) rows = rows.filter((r) => (filters.food === "yes") === r.food.length > 0);
  if (filters.minors) rows = rows.filter((r) => r.minor);

  return rows.sort((a, b) => a.nickname.localeCompare(b.nickname, "sv", { sensitivity: "base" }));
}

export function parseFilters(sp: Record<string, string | string[] | undefined>): AttendeeFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) || undefined;
  const yn = (k: string) => (one(k) === "yes" ? "yes" : one(k) === "no" ? "no" : undefined);
  return {
    q: one("q")?.slice(0, 100),
    ticketTypeId: one("type")?.slice(0, 60),
    checkedIn: yn("checkedIn"),
    food: yn("food"),
    minors: one("minors") === "yes" ? "yes" : undefined,
  };
}

export const CSV_HEADER = [
  "Namn", "Nickname", "E-post", "Telefon", "Födelsedatum", "Ålder", "Under 18", "Målsman", "Målsmans telefon",
  "Allergier", "Kostpreferenser", "Biljett", "Plats", "Ordernummer", "Incheckad", "Incheckad av", "Mat",
];

export function attendeeCsvRows(rows: AttendeeRow[]) {
  return [
    CSV_HEADER,
    ...rows.map((r) => [
      r.realName, r.nickname, r.email, r.phone, r.birthDate, r.age, r.minor ? "Ja" : "Nej", r.guardianName ?? "", r.guardianPhone ?? "",
      r.allergies ?? "", r.dietary ?? "", r.ticketType, r.seat ?? "", r.orderNumber, r.checkedInAt ? r.checkedInAt.toISOString() : "", r.checkedInBy ?? "", r.food.join("; "),
    ]),
  ];
}
