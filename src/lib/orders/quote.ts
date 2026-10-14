import type { DiscountCode, Event, FoodPackage, FoodVariant, Prisma, TicketType, User } from "@prisma/client";
import { meetsEventMinAge } from "../age";
import { computeTotals, type DiscountRule } from "./pricing";

type Tx = Prisma.TransactionClient;

export type QuoteError =
  | "eventNotOpen" | "registrationClosed" | "emptyCart"
  | "ticketTypeInvalid" | "ticketNotOnSale" | "soldOut" | "needsCode" | "alreadyHasTicket" | "tooYoung"
  | "seatNeedsTicket" | "seatInvalid"
  | "noTicketForFood" | "foodInvalid" | "foodNotOnSale" | "foodSoldOut" | "foodDuplicate"
  | "codeUnknown" | "codeNotYetValid" | "codeExpired" | "codeExhausted";

export interface QuoteInput {
  eventId: string;
  ticketTypeId?: string | null;
  seatId?: string | null;
  discountCode?: string | null;
  food: { packageId: string; variantId: string }[];
}

export interface QuoteLine {
  kind: "TICKET" | "FOOD";
  description: string;
  priceOre: number;
  ticketTypeId?: string;
  foodPackageId?: string;
  foodVariantId?: string;
}

export interface Quote {
  event: Event;
  user: User;
  ticketType: TicketType | null;
  /** The member's ACTIVE ticket (food-only orders attach to it). */
  activeTicketId: string | null;
  food: { pkg: FoodPackage; variant: FoodVariant }[];
  code: DiscountCode | null;
  /** Ticket types this code unlocks (for the UI). */
  unlockedTypeIds: string[];
  lines: QuoteLine[];
  subtotalOre: number;
  discountOre: number;
  totalOre: number;
  netPerLine: number[];
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; reason: QuoteError; detail?: string };

const bad = (reason: QuoteError, detail?: string): QuoteResult => ({ ok: false, reason, detail });

/**
 * Validates a purchase request against every rule and prices it. Pure reads — used both for the live
 * preview (plain client) and inside the checkout transaction (after row locks), so both agree.
 * PENDING tickets/food of this same member are ignored: starting a new checkout replaces them.
 */
export async function buildQuote(tx: Tx, userId: string, input: QuoteInput, opts: { now?: Date; allowEmpty?: boolean } = {}): Promise<QuoteResult> {
  const now = opts.now ?? new Date();
  const event = await tx.event.findUnique({ where: { id: input.eventId }, include: { chart: { select: { id: true } } } });
  if (!event || event.status !== "PUBLISHED") return bad("eventNotOpen");
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

  // ---- discount code
  let code: DiscountCode | null = null;
  let unlockedTypeIds: string[] = [];
  const rawCode = input.discountCode?.trim();
  if (rawCode) {
    const found = await tx.discountCode.findFirst({ where: { eventId: event.id, code: { equals: rawCode, mode: "insensitive" } }, include: { ticketTypes: true } });
    if (!found) return bad("codeUnknown");
    if (found.validFrom && now < found.validFrom) return bad("codeNotYetValid");
    if (found.validUntil && now >= found.validUntil) return bad("codeExpired");
    if (found.maxUses !== null) {
      const pending = await tx.order.count({ where: { discountCodeId: found.id, status: "PENDING", expiresAt: { gt: now }, userId: { not: userId } } });
      if (found.usedCount + pending >= found.maxUses) return bad("codeExhausted");
    }
    code = found;
    unlockedTypeIds = found.ticketTypes.map((t) => t.ticketTypeId);
  }

  const lines: QuoteLine[] = [];
  const activeTicket = await tx.ticket.findFirst({ where: { eventId: event.id, userId, status: "ACTIVE" }, select: { id: true } });
  const pendingTicket = await tx.ticket.findFirst({ where: { eventId: event.id, userId, status: "PENDING" }, select: { id: true } });

  // ---- ticket
  let ticketType: TicketType | null = null;
  if (input.ticketTypeId) {
    if (now < event.registrationOpensAt || now >= event.registrationClosesAt) return bad("registrationClosed");
    ticketType = await tx.ticketType.findFirst({ where: { id: input.ticketTypeId, eventId: event.id }, include: { zones: true } });
    if (!ticketType) return bad("ticketTypeInvalid");
    if ((ticketType.salesStartsAt && now < ticketType.salesStartsAt) || (ticketType.salesEndsAt && now >= ticketType.salesEndsAt)) return bad("ticketNotOnSale");
    if ((ticketType.hidden || ticketType.requiresDiscountCode) && !unlockedTypeIds.includes(ticketType.id)) return bad("needsCode");
    if (!meetsEventMinAge(user.birthDate, event.startsAt, event.minAge)) return bad("tooYoung");
    if (activeTicket) return bad("alreadyHasTicket");
    const sold = await tx.ticket.count({ where: { ticketTypeId: ticketType.id, status: { not: "CANCELLED" }, userId: { not: userId } } });
    if (sold >= ticketType.quantity) return bad("soldOut");

    if (input.seatId) {
      if (!ticketType.includesSeat) return bad("seatNeedsTicket");
      const seat = await tx.seat.findFirst({ where: { id: input.seatId, chartId: event.chart?.id ?? "-" } });
      if (!seat) return bad("seatInvalid", "notFound");
      if (seat.blocked) return bad("seatInvalid", "blocked");
      const allowed = (ticketType as TicketType & { zones: { zoneId: string }[] }).zones.map((z) => z.zoneId);
      if (allowed.length && !allowed.includes(seat.zoneId)) return bad("seatInvalid", "zoneNotAllowed");
      if (seat.reservedForUserId && seat.reservedForUserId !== userId) return bad("seatInvalid", "reservedForOther");
    }
    lines.push({ kind: "TICKET", description: ticketType.name, priceOre: ticketType.priceOre, ticketTypeId: ticketType.id });
  } else if (input.seatId) {
    return bad("seatNeedsTicket");
  }

  // ---- food
  const hasTicket = !!ticketType || !!activeTicket || !!pendingTicket;
  const food: Quote["food"] = [];
  const seenPackages = new Set<string>();
  for (const f of input.food) {
    if (seenPackages.has(f.packageId)) return bad("foodDuplicate");
    seenPackages.add(f.packageId);
    const pkg = await tx.foodPackage.findFirst({ where: { id: f.packageId, eventId: event.id }, include: { variants: true } });
    const variant = pkg?.variants.find((v) => v.id === f.variantId);
    if (!pkg || !variant) return bad("foodInvalid");
    if (now >= pkg.salesEndsAt) return bad("foodNotOnSale");
    if (!hasTicket) return bad("noTicketForFood");
    if (!ticketType) {
      // attaching to an existing ticket: no second purchase of the same package
      const dupe = await tx.foodPurchase.count({ where: { packageId: pkg.id, status: { not: "CANCELLED" }, ticket: { userId, eventId: event.id }, NOT: { status: "PENDING" } } });
      if (dupe > 0) return bad("foodDuplicate");
    }
    if (pkg.quantity !== null) {
      const taken = await tx.foodPurchase.count({ where: { packageId: pkg.id, status: { not: "CANCELLED" }, NOT: { status: "PENDING", ticket: { userId } } } });
      if (taken >= pkg.quantity) return bad("foodSoldOut");
    }
    const { variants: _v, ...pkgOnly } = pkg;
    void _v;
    food.push({ pkg: pkgOnly, variant });
    lines.push({ kind: "FOOD", description: `${pkg.name} – ${variant.name}`, priceOre: pkg.priceOre, foodPackageId: pkg.id, foodVariantId: variant.id });
  }

  if (lines.length === 0 && !opts.allowEmpty) return bad("emptyCart");

  const rule: DiscountRule | null = code ? { kind: code.kind, value: code.value, appliesTo: code.appliesTo } : null;
  const totals = computeTotals(lines, rule);
  return {
    ok: true,
    quote: {
      event, user, ticketType, activeTicketId: activeTicket?.id ?? null, food, code, unlockedTypeIds, lines,
      subtotalOre: totals.subtotalOre, discountOre: totals.discountOre, totalOre: totals.totalOre, netPerLine: totals.netPerLine,
    },
  };
}
