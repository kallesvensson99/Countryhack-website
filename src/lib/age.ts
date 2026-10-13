const TZ = "Europe/Stockholm";

/** Calendar parts of an instant in Europe/Stockholm. */
export function stockholmParts(d: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Birth dates are stored as DATE (UTC midnight), so read them with UTC getters. */
export function birthParts(birthDate: Date) {
  return { year: birthDate.getUTCFullYear(), month: birthDate.getUTCMonth() + 1, day: birthDate.getUTCDate() };
}

/** Actual age in whole years on a given day (Stockholm calendar). */
export function ageOn(birthDate: Date, on: Date = new Date()): number {
  const b = birthParts(birthDate);
  const n = stockholmParts(on);
  let age = n.year - b.year;
  if (n.month < b.month || (n.month === b.month && n.day < b.day)) age--;
  return age;
}

export function isMinor(birthDate: Date, on: Date = new Date()): boolean {
  return ageOn(birthDate, on) < 18;
}

/**
 * Event age rule: year(event.startsAt) − year(user.birthDate) ≥ event.minAge.
 * Anyone turning minAge during the year of the event may attend.
 */
export function meetsEventMinAge(birthDate: Date, eventStartsAt: Date, minAge: number): boolean {
  return stockholmParts(eventStartsAt).year - birthParts(birthDate).year >= minAge;
}
