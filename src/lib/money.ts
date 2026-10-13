/** All money is integer öre. Format only at the display edge. */
export function formatSek(ore: number, locale = "sv"): string {
  return new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-SE", {
    style: "currency",
    currency: "SEK",
    minimumFractionDigits: ore % 100 === 0 ? 0 : 2,
  }).format(ore / 100);
}
