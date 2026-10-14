import type { DiscountAppliesTo, DiscountKind } from "@prisma/client";

/** Pure pricing. All amounts are integer öre. */

export interface PricedLine {
  kind: "TICKET" | "FOOD";
  /** Full price (before discount) of this line, quantity is always 1. */
  priceOre: number;
}

export interface DiscountRule {
  kind: DiscountKind;
  value: number; // percent 1–100, or öre
  appliesTo: DiscountAppliesTo;
}

export interface DiscountResult {
  /** Total discount. */
  discountOre: number;
  /** Discount allocated to each input line (same order); sums exactly to discountOre. */
  perLine: number[];
}

export function isEligible(line: PricedLine, appliesTo: DiscountAppliesTo): boolean {
  return appliesTo === "ALL" || (appliesTo === "TICKETS" && line.kind === "TICKET") || (appliesTo === "FOOD" && line.kind === "FOOD");
}

/**
 * PERCENT: floor(eligible × value / 100). FIXED: min(value, eligible). Never more than the eligible amount.
 * The discount is spread over the eligible lines proportionally, using largest remainder so the parts add up exactly.
 */
export function computeDiscount(lines: PricedLine[], rule: DiscountRule | null): DiscountResult {
  const perLine = lines.map(() => 0);
  if (!rule) return { discountOre: 0, perLine };
  const eligibleIdx = lines.map((l, i) => (isEligible(l, rule.appliesTo) ? i : -1)).filter((i) => i >= 0);
  const eligible = eligibleIdx.reduce((s, i) => s + lines[i]!.priceOre, 0);
  if (eligible <= 0) return { discountOre: 0, perLine };

  const discountOre = rule.kind === "PERCENT" ? Math.floor((eligible * Math.min(rule.value, 100)) / 100) : Math.min(rule.value, eligible);
  if (discountOre <= 0) return { discountOre: 0, perLine };

  // proportional shares with largest-remainder rounding
  const shares = eligibleIdx.map((i) => {
    const exact = (discountOre * lines[i]!.priceOre) / eligible;
    return { i, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let remainder = discountOre - shares.reduce((s, x) => s + x.floor, 0);
  for (const s of [...shares].sort((a, b) => b.frac - a.frac || a.i - b.i)) {
    if (remainder <= 0) break;
    s.floor += 1;
    remainder -= 1;
  }
  for (const s of shares) perLine[s.i] = Math.min(s.floor, lines[s.i]!.priceOre);
  return { discountOre: perLine.reduce((a, b) => a + b, 0), perLine };
}

export interface Totals {
  subtotalOre: number;
  discountOre: number;
  totalOre: number;
  /** price − allocated discount, per line */
  netPerLine: number[];
}

export function computeTotals(lines: PricedLine[], rule: DiscountRule | null): Totals {
  const subtotalOre = lines.reduce((s, l) => s + l.priceOre, 0);
  const d = computeDiscount(lines, rule);
  return {
    subtotalOre,
    discountOre: d.discountOre,
    totalOre: subtotalOre - d.discountOre,
    netPerLine: lines.map((l, i) => l.priceOre - d.perLine[i]!),
  };
}
