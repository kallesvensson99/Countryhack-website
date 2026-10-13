/** All money is integer öre. Format only at the display edge. */
export function formatSek(ore: number, locale = "sv"): string {
  return new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-SE", {
    style: "currency",
    currency: "SEK",
    minimumFractionDigits: ore % 100 === 0 ? 0 : 2,
  }).format(ore / 100);
}

/** "150", "150,50", "150.5" → öre. Returns null for anything else (no thousands separators, max 2 decimals). */
export function parseSekToOre(input: string): number | null {
  const m = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** öre → "150" or "150,50" for form inputs. */
export function oreToInput(ore: number): string {
  const kr = Math.floor(ore / 100);
  const rest = ore % 100;
  return rest === 0 ? String(kr) : `${kr},${String(rest).padStart(2, "0")}`;
}
